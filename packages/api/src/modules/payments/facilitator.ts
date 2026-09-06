import { base64urlnopad } from '@scure/base'
import { bytesToHex } from '@noble/hashes/utils.js'
import { config } from '../../config.js'
import type { Env } from '../../db/schema.js'
import { ApiError } from '../../lib/errors.js'
import { randomHex, sign } from '../../lib/crypto.js'
import { log } from '../../lib/log.js'
import { networkFor, type PaymentPayload, type RequirementsV1, type RequirementsV2, type SettleResponse } from './x402.js'

/**
 * Facilitator client (ADR-21 §5/§6). A facilitator is a third party that verifies the buyer's signed EIP-3009
 * authorization and broadcasts it; it cannot change payee or amount. We never run one ourselves.
 */

export type FacilitatorFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; json: () => Promise<unknown> }>

export type FacilitatorStatus = { url: string; available: boolean; supports_network: boolean; network: string; checked_at: string; error?: string }
const cache = new Map<Env, { at: number; status: FacilitatorStatus }>()
const CACHE_MS = 10 * 60_000

const realFetch: FacilitatorFetch = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(45_000) })
let testFetch: FacilitatorFetch | undefined
/** Test hook: route every facilitator call through a fake. */
export function _setFacilitatorFetchForTests(f?: FacilitatorFetch) {
  testFetch = f
  cache.clear()
}
const defaultFetch: FacilitatorFetch = (url, init) => (testFetch ?? realFetch)(url, init)

export function facilitatorUrl(env: Env): string {
  return (env === 'live' ? config().X402_FACILITATOR_URL_LIVE : config().X402_FACILITATOR_URL_TEST).replace(/\/$/, '')
}

export function isCdpFacilitator(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith('cdp.coinbase.com')
  } catch {
    return false
  }
}

/**
 * Coinbase CDP bearer JWT (EdDSA). Shape verified against the official cdp-sdk source on 2026-09-06:
 * header {alg, kid, typ, nonce}, claims {sub, iss:'cdp', aud:['cdp_service'], nbf, exp(+120s), uris:['METHOD host/path']}.
 * The secret is base64 of the 64-byte Ed25519 key; the first 32 bytes are the seed.
 */
export function cdpJwt(opts: { keyId: string; secretBase64: string; method: string; url: string; now?: number }): string {
  const u = new URL(opts.url)
  const raw = Buffer.from(opts.secretBase64, 'base64')
  if (raw.length !== 64 && raw.length !== 32) throw new Error('CDP_API_KEY_SECRET must be the base64 Ed25519 secret (64 or 32 bytes)')
  const seedHex = bytesToHex(new Uint8Array(raw.subarray(0, 32)))
  const now = Math.floor((opts.now ?? Date.now()) / 1000)
  const header = { alg: 'EdDSA', kid: opts.keyId, typ: 'JWT', nonce: randomHex(8) }
  const claims = { sub: opts.keyId, iss: 'cdp', aud: ['cdp_service'], nbf: now, exp: now + 120, uris: [`${opts.method.toUpperCase()} ${u.host}${u.pathname}`] }
  const enc = (v: unknown) => base64urlnopad.encode(new TextEncoder().encode(JSON.stringify(v)))
  const signingInput = `${enc(header)}.${enc(claims)}`
  const sigHex = sign(signingInput, seedHex)
  const sig = base64urlnopad.encode(Buffer.from(sigHex, 'hex'))
  return `${signingInput}.${sig}`
}

function authHeaders(method: string, url: string): Record<string, string> {
  const { CDP_API_KEY_ID, CDP_API_KEY_SECRET } = config()
  if (isCdpFacilitator(url) && CDP_API_KEY_ID && CDP_API_KEY_SECRET) {
    return { authorization: `Bearer ${cdpJwt({ keyId: CDP_API_KEY_ID, secretBase64: CDP_API_KEY_SECRET, method, url })}` }
  }
  return {}
}

async function post(env: Env, path: '/verify' | '/settle', body: unknown, fetchImpl: FacilitatorFetch): Promise<Record<string, unknown>> {
  const url = `${facilitatorUrl(env)}${path}`
  let res: Awaited<ReturnType<FacilitatorFetch>>
  try {
    res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', ...authHeaders('POST', url) }, body: JSON.stringify(body) })
  } catch (e) {
    log.error({ err: e, url }, 'facilitator unreachable')
    throw new ApiError('payment_error', 'facilitator_unavailable', 'The payment facilitator could not be reached.', { status: 502, hint: 'Nothing was settled. Retry in a minute with the same payment header.' })
  }
  const json = ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown>
  if (res.status >= 500) {
    log.error({ status: res.status, url, json }, 'facilitator error')
    throw new ApiError('payment_error', 'facilitator_unavailable', 'The payment facilitator is unavailable.', { status: 502, hint: 'Nothing was settled. Retry in a minute with the same payment header.' })
  }
  if (res.status === 401 || res.status === 403) {
    log.error({ status: res.status, url }, 'facilitator rejected our credentials')
    throw new ApiError('payment_error', 'facilitator_unavailable', 'The payment facilitator rejected the platform credentials.', { status: 502, hint: 'This is an operator problem, not yours. Report it via POST /v1/support/reports; nothing was settled.' })
  }
  return json
}

export type VerifyAndSettleInput = { env: Env; version: 1 | 2; payload: PaymentPayload; requirements: RequirementsV1 | RequirementsV2; fetchImpl?: FacilitatorFetch }

/** verify, then settle. Throws a 402 ApiError with the facilitator's reason when the payment is rejected. */
export async function verifyAndSettle(input: VerifyAndSettleInput): Promise<SettleResponse> {
  const fetchImpl = input.fetchImpl ?? defaultFetch
  const body = { x402Version: input.version, paymentPayload: input.payload, paymentRequirements: input.requirements }
  const v = await post(input.env, '/verify', body, fetchImpl)
  if (!v.isValid) {
    const reason = String(v.invalidReason ?? v.error ?? 'invalid')
    throw new ApiError('payment_error', 'payment_invalid', `Payment rejected by the facilitator: ${reason}.`, {
      hint: 'Sign a fresh EIP-3009 authorization for exactly `amount` to `payTo` on the stated network (check your USDC balance and validBefore), then retry with the payment header.',
      details: { invalidReason: reason, payer: v.payer ?? null },
    })
  }
  const s = await post(input.env, '/settle', body, fetchImpl)
  if (!s.success) {
    const reason = String(s.errorReason ?? s.error ?? 'unknown')
    throw new ApiError('payment_error', 'settlement_failed', `Settlement failed: ${reason}.`, { hint: 'Nothing was charged. Retry with a fresh authorization (new nonce). If it keeps failing, report the request_id via POST /v1/support/reports.', details: { errorReason: reason, payer: s.payer ?? null } })
  }
  return { success: true, transaction: typeof s.transaction === 'string' ? s.transaction : undefined, network: typeof s.network === 'string' ? s.network : undefined, payer: typeof s.payer === 'string' ? s.payer : undefined }
}

// --- /supported probe (cached) ---------------------------------------------------------------

export async function facilitatorStatus(env: Env, fetchImpl: FacilitatorFetch = defaultFetch, now = Date.now()): Promise<FacilitatorStatus> {
  const hit = cache.get(env)
  if (hit && now - hit.at < CACHE_MS) return hit.status
  const url = facilitatorUrl(env)
  const network = networkFor(env)
  let status: FacilitatorStatus
  try {
    const res = await fetchImpl(`${url}/supported`, { method: 'GET', headers: { accept: 'application/json', ...authHeaders('GET', `${url}/supported`) } })
    const json = (await res.json().catch(() => ({}))) as { kinds?: { scheme?: string; network?: string }[] }
    const kinds = Array.isArray(json.kinds) ? json.kinds : []
    const v1Name = network === 'eip155:8453' ? 'base' : 'base-sepolia'
    const supports = kinds.some((k) => k.scheme === 'exact' && (k.network === network || k.network === v1Name))
    status = { url, available: res.status < 400, supports_network: supports, network, checked_at: new Date(now).toISOString(), ...(res.status >= 400 ? { error: `HTTP ${res.status}` } : {}) }
  } catch (e) {
    status = { url, available: false, supports_network: false, network, checked_at: new Date(now).toISOString(), error: (e as Error).message }
  }
  cache.set(env, { at: now, status })
  return status
}

export function _resetFacilitatorCache() {
  cache.clear()
}
