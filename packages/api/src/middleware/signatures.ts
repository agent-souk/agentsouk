import { base64 } from '@scure/base'
import { or, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { agents } from '../db/schema.js'
import { publicKeyFromDidKey, sha256Hex, verify } from '../lib/crypto.js'
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js'
import { jwkThumbprint } from '../lib/server-keys.js'
import { config } from '../config.js'
import { ApiError } from '../lib/errors.js'
import type { Agent } from './auth.js'

/**
 * RFC 9421 HTTP Message Signatures with Ed25519 (ADR-8). Compatible with the Web Bot Auth profile:
 *
 *   Content-Digest: sha-256=:<base64 sha256 of body>:            (only when there is a body)
 *   Signature-Input: sig1=("@method" "@target-uri" "content-digest");created=1725600000;expires=1725600300;keyid="agt_...";alg="ed25519";nonce="..."
 *   Signature: sig1=:<base64 ed25519 signature>:
 *
 * keyid may be the agent id, handle, did:key or the JWK thumbprint of the agent's public key.
 * Covered components must include "@method" and either "@target-uri" or both "@authority" and "@path".
 * created must be within ±5 minutes; expires (if present) must be in the future; nonces (if present)
 * are single-use for 10 minutes. The signature base follows RFC 9421 §2.5.
 */

export const MAX_SKEW_SECONDS = 300
const NONCE_TTL_MS = 10 * 60_000
const seenNonces = new Map<string, number>()

function sweepNonces(now: number) {
  if (seenNonces.size < 1000) return
  for (const [k, exp] of seenNonces) if (exp <= now) seenNonces.delete(k)
}

export type ParsedSignatureInput = {
  label: string
  components: string[]
  params: Record<string, string | number>
  /** the raw value after "label=" — needed verbatim for the signature base */
  raw: string
}

const SIG_INPUT_RE = /^\s*([A-Za-z0-9_-]+)=(\((?:"[^"]*"\s*)*\)(?:;[^,]*)?)\s*$/

export function parseSignatureInput(header: string): ParsedSignatureInput {
  const m = SIG_INPUT_RE.exec(header)
  if (!m) throw sigError('Malformed Signature-Input header.')
  const label = m[1]!
  const raw = m[2]!
  const closeIdx = raw.indexOf(')')
  const inner = raw.slice(1, closeIdx)
  const components = [...inner.matchAll(/"([^"]*)"/g)].map((x) => x[1]!)
  const params: Record<string, string | number> = {}
  for (const part of raw.slice(closeIdx + 1).split(';')) {
    if (!part) continue
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const k = part.slice(0, eq).trim()
    let v: string | number = part.slice(eq + 1).trim()
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
    else if (/^\d+$/.test(v)) v = Number(v)
    params[k] = v
  }
  return { label, components, params, raw }
}

export function parseSignature(header: string, label: string): Uint8Array {
  const re = new RegExp(`(?:^|,)\\s*${label.replace(/[-_]/g, '\\$&')}=:([A-Za-z0-9+/=]+):`)
  const m = re.exec(header)
  if (!m) throw sigError(`Signature header has no entry for label "${label}".`)
  try {
    return base64.decode(m[1]!)
  } catch {
    throw sigError('Signature is not valid base64.')
  }
}

function sigError(message: string, hint?: string): ApiError {
  return new ApiError('authentication_error', 'invalid_signature', message, {
    hint: hint ?? 'Sign per RFC 9421 with your Ed25519 key: components "@method" "@target-uri" (and "content-digest" when sending a body), params created, keyid=<agent id|did>, alg="ed25519". Or use Authorization: Bearer <api_key>.',
  })
}

export type SignedRequestContext = { method: string; url: string; headers: Headers; bodyText: string }

export function buildSignatureBase(ctx: SignedRequestContext, parsed: ParsedSignatureInput, targetUri: string): string {
  const u = new URL(targetUri)
  const lines: string[] = []
  for (const comp of parsed.components) {
    let value: string
    switch (comp) {
      case '@method':
        value = ctx.method.toUpperCase()
        break
      case '@target-uri':
        value = targetUri
        break
      case '@authority':
        value = u.host.toLowerCase()
        break
      case '@scheme':
        value = u.protocol.replace(':', '')
        break
      case '@path':
        value = u.pathname
        break
      case '@query':
        value = u.search || '?'
        break
      case '@request-target':
        value = u.pathname + u.search
        break
      default: {
        if (comp.startsWith('@')) throw sigError(`Unsupported derived component ${comp}.`)
        const hv = ctx.headers.get(comp)
        if (hv == null) throw sigError(`Covered header "${comp}" is missing from the request.`)
        value = hv.trim().replace(/\s+/g, ' ')
      }
    }
    lines.push(`"${comp}": ${value}`)
  }
  lines.push(`"@signature-params": ${parsed.raw}`)
  return lines.join('\n')
}

export function contentDigestFor(bodyText: string): string {
  return `sha-256=:${base64.encode(hexToBytes(sha256Hex(bodyText)))}:`
}

async function resolveAgentByKeyId(keyid: string): Promise<Agent | undefined> {
  if (keyid.startsWith('did:key:')) {
    const pk = publicKeyFromDidKey(keyid)
    return pk ? db().query.agents.findFirst({ where: eq(agents.publicKey, pk) }) : undefined
  }
  const direct = await db().query.agents.findFirst({ where: or(eq(agents.id, keyid), eq(agents.handle, keyid.toLowerCase())) })
  if (direct) return direct
  // JWK thumbprint (43 chars base64url): scan is fine for now (indexed lookup later).
  if (/^[A-Za-z0-9_-]{43}$/.test(keyid)) {
    const rows = await db().query.agents.findMany({ columns: { id: true, publicKey: true }, limit: 5000 })
    const hit = rows.find((r) => jwkThumbprint(r.publicKey) === keyid)
    return hit ? db().query.agents.findFirst({ where: eq(agents.id, hit.id) }) : undefined
  }
  return undefined
}

/**
 * Verify a signed request. Returns the agent on success; throws ApiError (401) otherwise.
 */
export async function verifySignedRequest(ctx: SignedRequestContext, now = Date.now()): Promise<{ agent: Agent; keyid: string }> {
  const sigInput = ctx.headers.get('signature-input')
  const sig = ctx.headers.get('signature')
  if (!sigInput || !sig) throw sigError('Missing Signature-Input or Signature header.')
  const parsed = parseSignatureInput(sigInput)
  const signature = parseSignature(sig, parsed.label)
  const { keyid, alg, created, expires, nonce } = parsed.params
  if (typeof keyid !== 'string' || !keyid) throw sigError('Signature-Input must carry keyid=<agent id|handle|did:key|jwk thumbprint>.')
  if (alg !== undefined && String(alg).toLowerCase() !== 'ed25519') throw sigError(`Unsupported alg "${alg}"; use ed25519.`)
  if (typeof created !== 'number') throw sigError('Signature-Input must carry created=<unix seconds>.')
  const nowSec = Math.floor(now / 1000)
  if (Math.abs(nowSec - created) > MAX_SKEW_SECONDS) throw sigError(`Signature created=${created} is outside the allowed ±${MAX_SKEW_SECONDS}s window (server time ${nowSec}).`, 'Check your clock and re-sign with a fresh created timestamp.')
  if (expires !== undefined && (typeof expires !== 'number' || expires <= nowSec)) throw sigError('Signature has expired.', 'Re-sign with a fresh created/expires.')
  if (!parsed.components.includes('@method')) throw sigError('Covered components must include "@method".')
  if (!parsed.components.includes('@target-uri') && !(parsed.components.includes('@authority') && parsed.components.includes('@path'))) throw sigError('Covered components must include "@target-uri" (or "@authority" and "@path").')

  if (ctx.bodyText.length > 0) {
    if (!parsed.components.includes('content-digest')) throw sigError('Requests with a body must cover "content-digest".')
    const cd = ctx.headers.get('content-digest')
    if (!cd || cd.trim() !== contentDigestFor(ctx.bodyText)) throw sigError('Content-Digest does not match the request body.', 'Compute sha-256 over the exact bytes you send: Content-Digest: sha-256=:<base64>:')
  }

  if (typeof nonce === 'string' && nonce) {
    sweepNonces(now)
    const key = `${keyid}:${nonce}`
    if ((seenNonces.get(key) ?? 0) > now) throw sigError('Nonce already used.', 'Use a fresh random nonce per request.')
    seenNonces.set(key, now + NONCE_TTL_MS)
  }

  const agent = await resolveAgentByKeyId(keyid)
  if (!agent || agent.status !== 'active') throw sigError(`Unknown keyid "${keyid}".`, 'keyid must be your agent id (agt_...), handle, did:key or JWK thumbprint.')

  // The client may have signed the public URL (behind a proxy) or the URL as we see it.
  const seen = new URL(ctx.url)
  const candidates = new Set<string>([ctx.url, `${config().PUBLIC_BASE_URL.replace(/\/$/, '')}${seen.pathname}${seen.search}`])
  for (const target of candidates) {
    const base = buildSignatureBase(ctx, parsed, target)
    if (verify(bytesToHex(signature), base, agent.publicKey)) return { agent, keyid }
  }
  throw sigError('Signature verification failed.', 'Make sure you sign exactly the RFC 9421 signature base (components in the covered order, then "@signature-params"), using the raw 32-byte Ed25519 secret you got at registration.')
}

/** Test helper. */
export function _resetNonces() {
  seenNonces.clear()
}
