import { config } from '../../../config.js'
import { errors, ApiError } from '../../../lib/errors.js'
import type { Env } from '../../../db/schema.js'
import { CRD_PER_USD } from '../service.js'

/**
 * x402 deposit rail (ADR-10): the agent pays USDC to top up credits, using the standard HTTP 402
 * flow so every x402 client library works unchanged:
 *
 *   1. POST /v1/wallet/deposits {rail:"x402", amount} -> deposit (pending) with external_request =
 *      x402 PaymentRequirements and resource = /v1/wallet/deposits/{id}/pay
 *   2. POST /v1/wallet/deposits/{id}/pay without X-PAYMENT -> 402 + requirements (what x402 clients expect)
 *   3. POST /v1/wallet/deposits/{id}/pay with X-PAYMENT -> facilitator verify + settle -> credits
 *
 * 1000 CRD = 1 USD = 1_000_000 USDC atomic units, so 1 CRD = 1000 atomic units.
 */

export const USDC = {
  base: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', name: 'USD Coin', version: '2' },
  'base-sepolia': { address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', name: 'USDC', version: '2' },
} as const

export type X402Network = keyof typeof USDC

export type PaymentRequirements = {
  scheme: 'exact'
  network: X402Network
  maxAmountRequired: string
  resource: string
  description: string
  mimeType: string
  payTo: string
  maxTimeoutSeconds: number
  asset: string
  extra: { name: string; version: string }
}

export type PaymentRequired = { x402Version: 1; error?: string; accepts: PaymentRequirements[] }

export function x402Configured(): boolean {
  return !!config().X402_PAY_TO
}

export function networkFor(env: Env): X402Network {
  return env === 'live' ? config().X402_NETWORK : 'base-sepolia'
}

export function atomicUsdcForCrd(amountCrd: number): string {
  // 1 USD = 1000 CRD = 1e6 atomic USDC -> 1 CRD = 1000 atomic
  return String(BigInt(amountCrd) * BigInt(1_000_000 / CRD_PER_USD))
}

export function buildRequirements(env: Env, depositId: string, amountCrd: number): PaymentRequired {
  const payTo = config().X402_PAY_TO
  if (!payTo) throw errors.notImplemented('x402 deposits')
  const network = networkFor(env)
  const asset = USDC[network]
  const base = config().PUBLIC_BASE_URL.replace(/\/$/, '')
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: 'exact',
        network,
        maxAmountRequired: atomicUsdcForCrd(amountCrd),
        resource: `${base}/v1/wallet/deposits/${depositId}/pay`,
        description: `Top up ${amountCrd} CRD on Agent World (${env})`,
        mimeType: 'application/json',
        payTo,
        maxTimeoutSeconds: 600,
        asset: asset.address,
        extra: { name: asset.name, version: asset.version },
      },
    ],
  }
}

export type FacilitatorFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; json: () => Promise<unknown> }>

export type SettlementResult = { success: boolean; transaction?: string; network?: string; payer?: string; errorReason?: string }

/** Verify then settle a payment header against the facilitator. Throws a 402 ApiError with the reason on failure. */
export async function verifyAndSettle(paymentHeader: string, requirements: PaymentRequirements, fetchImpl: FacilitatorFetch = fetch as unknown as FacilitatorFetch): Promise<SettlementResult> {
  const facilitator = config().X402_FACILITATOR_URL.replace(/\/$/, '')
  const body = JSON.stringify({ x402Version: 1, paymentHeader, paymentRequirements: requirements })
  const post = async (path: string): Promise<Record<string, unknown>> => {
    const res = await fetchImpl(`${facilitator}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (res.status >= 500) throw new ApiError('payment_error', 'facilitator_unavailable', 'The payment facilitator is unavailable.', { hint: 'Retry in a minute with the same X-PAYMENT header; nothing was settled.', status: 502 })
    return json
  }
  const v = await post('/verify')
  if (!v.isValid) {
    throw new ApiError('payment_error', 'payment_invalid', `Payment rejected: ${String(v.invalidReason ?? 'invalid')}.`, {
      hint: 'Sign a fresh EIP-3009 authorization for exactly maxAmountRequired to payTo on the stated network, then retry with the X-PAYMENT header.',
      details: { invalidReason: v.invalidReason },
    })
  }
  const s = await post('/settle')
  if (!s.success) {
    throw new ApiError('payment_error', 'settlement_failed', `Settlement failed: ${String(s.errorReason ?? s.error ?? 'unknown')}.`, { hint: 'Retry with a fresh authorization; if it persists report the request_id via POST /v1/support/reports.', details: s })
  }
  return { success: true, transaction: s.transaction as string | undefined, network: s.network as string | undefined, payer: s.payer as string | undefined }
}

export function encodeSettlementHeader(result: SettlementResult): string {
  return Buffer.from(JSON.stringify({ success: result.success, transaction: result.transaction ?? null, network: result.network ?? null, payer: result.payer ?? null })).toString('base64')
}
