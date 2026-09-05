import * as ed from '@noble/ed25519'
import { sha512, sha256 } from '@noble/hashes/sha2.js'
import { hmac } from '@noble/hashes/hmac.js'
import { randomBytes, bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { base58, base64urlnopad } from '@scure/base'

// enable sync ed25519
ed.hashes.sha512 = sha512

export type KeyPairHex = { publicKey: string; secretKey: string }

/** Generate an Ed25519 keypair (hex encoded, 32-byte seed as secretKey). */
export function generateKeyPair(): KeyPairHex {
  const { secretKey, publicKey } = ed.keygen()
  return { publicKey: bytesToHex(publicKey), secretKey: bytesToHex(secretKey) }
}

export function publicKeyFromSecret(secretKeyHex: string): string {
  return bytesToHex(ed.getPublicKey(hexToBytes(secretKeyHex)))
}

export function sign(message: Uint8Array | string, secretKeyHex: string): string {
  const msg = typeof message === 'string' ? new TextEncoder().encode(message) : message
  return bytesToHex(ed.sign(msg, hexToBytes(secretKeyHex)))
}

export function verify(signatureHex: string, message: Uint8Array | string, publicKeyHex: string): boolean {
  try {
    const msg = typeof message === 'string' ? new TextEncoder().encode(message) : message
    return ed.verify(hexToBytes(signatureHex), msg, hexToBytes(publicKeyHex))
  } catch {
    return false
  }
}

/** did:key for an Ed25519 public key (multicodec 0xed01, base58btc, 'z' prefix). */
export function didKeyFromPublicKey(publicKeyHex: string): string {
  const pk = hexToBytes(publicKeyHex)
  const prefixed = new Uint8Array(2 + pk.length)
  prefixed[0] = 0xed
  prefixed[1] = 0x01
  prefixed.set(pk, 2)
  return `did:key:z${base58.encode(prefixed)}`
}

export function publicKeyFromDidKey(did: string): string | undefined {
  if (!did.startsWith('did:key:z')) return undefined
  try {
    const bytes = base58.decode(did.slice('did:key:z'.length))
    if (bytes[0] !== 0xed || bytes[1] !== 0x01 || bytes.length !== 34) return undefined
    return bytesToHex(bytes.slice(2))
  } catch {
    return undefined
  }
}

/** Validates a hex-encoded 32-byte Ed25519 public key. */
export function isValidPublicKeyHex(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{64}$/i.test(v)
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
function randomToken(len: number): string {
  const bytes = randomBytes(len)
  let out = ''
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i]! % ALPHABET.length]
  return out
}

/**
 * API keys: `aw_live_<40 chars>` / `aw_test_<40 chars>`. We store only sha256(pepper||key)
 * plus a display prefix (first 12 chars), so a leaked DB is useless and agents can still
 * recognise which key is which.
 */
export function generateApiKey(env: 'live' | 'test' = 'live'): { key: string; prefix: string } {
  const key = `aw_${env}_${randomToken(40)}`
  return { key, prefix: key.slice(0, 12) }
}

export function hashSecret(secret: string, pepper: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(pepper + ' ' + secret)))
}

export function sha256Hex(data: Uint8Array | string): string {
  const d = typeof data === 'string' ? new TextEncoder().encode(data) : data
  return bytesToHex(sha256(d))
}

export function hmacSha256Hex(key: string, data: string): string {
  return bytesToHex(hmac(sha256, new TextEncoder().encode(key), new TextEncoder().encode(data)))
}

export function randomHex(bytes = 32): string {
  return bytesToHex(randomBytes(bytes))
}

export function randomBase64Url(bytes = 32): string {
  return base64urlnopad.encode(randomBytes(bytes))
}

/** Constant-time string compare. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let r = 0
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return r === 0
}

/** Canonical JSON (sorted keys, no whitespace) for signing receipts and webhooks. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as object).sort()) out[k] = sortKeys((v as Record<string, unknown>)[k])
    return out
  }
  return v
}
