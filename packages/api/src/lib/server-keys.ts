import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { base64urlnopad } from '@scure/base'
import { hexToBytes } from '@noble/hashes/utils.js'
import { config } from '../config.js'
import { canonicalJson, didKeyFromPublicKey, generateKeyPair, publicKeyFromSecret, sha256Hex, sign } from './crypto.js'
import { log } from './log.js'

/**
 * The platform's own Ed25519 signing key. Used for signed receipts, the platform's A2A card / JWKS,
 * and webhook payload provenance. In production set SERVER_SIGNING_SEED; in development a key is
 * generated once and persisted next to the database.
 */

let cached: { secretKey: string; publicKey: string; did: string; kid: string } | undefined

function keyFilePath(): string {
  const url = config().DATABASE_URL
  const base = url.startsWith('file:') && !url.includes(':memory:') ? dirname(url.slice('file:'.length)) : './data'
  return `${base}/server-key.json`
}

export function serverKey() {
  if (cached) return cached
  let secretKey = config().SERVER_SIGNING_SEED
  if (!secretKey) {
    if (config().NODE_ENV === 'test') {
      secretKey = generateKeyPair().secretKey
    } else {
      const file = keyFilePath()
      if (existsSync(file)) {
        secretKey = (JSON.parse(readFileSync(file, 'utf8')) as { secretKey: string }).secretKey
      } else {
        secretKey = generateKeyPair().secretKey
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, JSON.stringify({ secretKey, note: 'Platform Ed25519 signing seed (dev). Set SERVER_SIGNING_SEED in production.' }, null, 2))
        log.warn({ file }, 'generated a development server signing key; set SERVER_SIGNING_SEED in production')
      }
    }
  }
  const publicKey = publicKeyFromSecret(secretKey)
  cached = { secretKey, publicKey, did: didKeyFromPublicKey(publicKey), kid: jwkThumbprint(publicKey) }
  return cached
}

/**
 * ADR-34 key history: public keys the platform signed with before a rotation (config SERVER_PREVIOUS_PUBLIC_KEYS,
 * comma-separated hex). They stay in the JWKS and POST /v1/receipts/verify keeps accepting their kids, so a receipt
 * or attestation signed before a rotation still verifies through the platform, not only through its embedded did:key.
 */
export function previousKeys(): { publicKey: string; kid: string; did: string }[] {
  const raw = config().SERVER_PREVIOUS_PUBLIC_KEYS ?? ''
  const current = serverKey().publicKey.toLowerCase()
  const seen = new Set<string>([current])
  const out: { publicKey: string; kid: string; did: string }[] = []
  for (const part of raw.split(',')) {
    const pk = part.trim().toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(pk) || seen.has(pk)) continue
    seen.add(pk)
    out.push({ publicKey: pk, kid: jwkThumbprint(pk), did: didKeyFromPublicKey(pk) })
  }
  return out
}

/** Current key first, then retired keys (ADR-34), for the JWKS and the signature directory. */
export function allKeyJwks(): Record<string, unknown>[] {
  const k = serverKey()
  return [ed25519Jwk(k.publicKey), ...previousKeys().map((p) => ed25519Jwk(p.publicKey, { 'dev.agentsouk/retired': true }))]
}

/** The key (current or retired) behind a kid, for verification. */
export function keyByKid(kid: string): { publicKey: string; did: string; retired: boolean } | null {
  const k = serverKey()
  if (kid === k.kid) return { publicKey: k.publicKey, did: k.did, retired: false }
  const p = previousKeys().find((x) => x.kid === kid)
  return p ? { publicKey: p.publicKey, did: p.did, retired: true } : null
}

/** RFC 8037 OKP JWK for an Ed25519 public key. */
export function ed25519Jwk(publicKeyHex: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { kty: 'OKP', crv: 'Ed25519', x: base64urlnopad.encode(hexToBytes(publicKeyHex)), kid: jwkThumbprint(publicKeyHex), use: 'sig', alg: 'EdDSA', ...extra }
}

/** RFC 7638 JWK thumbprint (base64url of sha256 over the canonical required members). */
export function jwkThumbprint(publicKeyHex: string): string {
  const canonical = canonicalJson({ crv: 'Ed25519', kty: 'OKP', x: base64urlnopad.encode(hexToBytes(publicKeyHex)) })
  return base64urlnopad.encode(hexToBytes(sha256Hex(canonical)))
}

/**
 * Sign an arbitrary JSON object with the platform key. Returns a detached signature envelope that any
 * party can verify offline with the platform JWKS (GET /.well-known/jwks.json).
 */
export function signReceipt(payload: Record<string, unknown>): { payload: Record<string, unknown>; signature: { alg: 'EdDSA'; kid: string; did: string; sig: string; canonical: 'json-sorted-keys' } } {
  const k = serverKey()
  const sig = sign(canonicalJson(payload), k.secretKey)
  return { payload, signature: { alg: 'EdDSA', kid: k.kid, did: k.did, sig, canonical: 'json-sorted-keys' } }
}
