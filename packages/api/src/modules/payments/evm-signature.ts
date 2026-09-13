import { secp256k1 } from '@noble/curves/secp256k1.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import type { Env } from '../../db/schema.js'
import { sameAddress, toChecksumAddress } from './address.js'
import { isValidContractSignature } from './chain.js'

/**
 * Proof of wallet control (ADR-22 §2, review finding H1). An agent may only register a wallet address it can
 * sign for: an EIP-191 `personal_sign` over the wallet message, verified by ecrecover (EOA) or, for smart-contract
 * wallets, by a read-only EIP-1271 `isValidSignature` call. Without this, an attacker could register a stranger's
 * address and claim that stranger's transfers to a seller as its own payment.
 */

/** keccak256("\x19Ethereum Signed Message:\n" + len + message) */
export function eip191Hash(message: string): Uint8Array {
  const msg = new TextEncoder().encode(message)
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${msg.length}`)
  const buf = new Uint8Array(prefix.length + msg.length)
  buf.set(prefix)
  buf.set(msg, prefix.length)
  return keccak_256(buf)
}

export function publicKeyToAddress(uncompressed: Uint8Array): string {
  const body = uncompressed.length === 65 ? uncompressed.slice(1) : uncompressed
  return toChecksumAddress('0x' + bytesToHex(keccak_256(body).slice(-20)))
}

export function privateKeyToAddress(privateKeyHex: string): string {
  return publicKeyToAddress(secp256k1.getPublicKey(hexToBytes(privateKeyHex.replace(/^0x/, '')), false))
}

/** 65-byte r||s||v signature (v = 27/28 or 0/1), hex with or without 0x. */
export function parseSignature(hex: unknown): { rs: Uint8Array; recovery: number } | undefined {
  if (typeof hex !== 'string') return undefined
  const clean = hex.trim().replace(/^0x/, '')
  if (!/^[0-9a-fA-F]{130}$/.test(clean)) return undefined
  const bytes = hexToBytes(clean)
  let v = bytes[64]!
  if (v >= 27) v -= 27
  if (v !== 0 && v !== 1) return undefined
  return { rs: bytes.slice(0, 64), recovery: v }
}

/** Address that produced an EIP-191 signature over `message`, or undefined when the signature is malformed. */
export function recoverAddress(message: string, signatureHex: unknown): string | undefined {
  const parsed = parseSignature(signatureHex)
  if (!parsed) return undefined
  try {
    const sig = secp256k1.Signature.fromBytes(parsed.rs, 'compact').addRecoveryBit(parsed.recovery)
    const point = sig.recoverPublicKey(eip191Hash(message))
    return publicKeyToAddress(point.toBytes(false))
  } catch {
    return undefined
  }
}

/** Address that produced a secp256k1 signature over a 32-byte digest (EIP-712 typed data), or undefined when malformed. */
export function recoverDigestSigner(digest: Uint8Array, signatureHex: unknown): string | undefined {
  const parsed = parseSignature(signatureHex)
  if (!parsed) return undefined
  try {
    const sig = secp256k1.Signature.fromBytes(parsed.rs, 'compact').addRecoveryBit(parsed.recovery)
    return publicKeyToAddress(sig.recoverPublicKey(digest).toBytes(false))
  } catch {
    return undefined
  }
}

/**
 * Whether `address` signed `digest` (ADR-58): ecrecover for an EOA, and for a smart-contract wallet a read-only
 * EIP-1271 isValidSignature call - the same two answers verifyWalletSignature accepts for EIP-191 messages.
 */
export async function verifyDigestSignature(env: Env, address: string, digest: Uint8Array, signatureHex: unknown): Promise<boolean> {
  const signer = recoverDigestSigner(digest, signatureHex)
  if (signer && sameAddress(signer, address)) return true
  if (typeof signatureHex !== 'string') return false
  const clean = signatureHex.trim().replace(/^0x/, '')
  if (!/^[0-9a-fA-F]+$/.test(clean) || clean.length % 2) return false
  try {
    return await isValidContractSignature(env, address, digest, hexToBytes(clean))
  } catch {
    return false
  }
}

/** Test/SDK helper: EIP-191 personal_sign with a raw secp256k1 private key. Returns 0x + 65 bytes hex (v = 27/28). */
export function signMessage(message: string, privateKeyHex: string): string {
  const priv = hexToBytes(privateKeyHex.replace(/^0x/, ''))
  const sig = secp256k1.sign(eip191Hash(message), priv, { prehash: false, format: 'recovered' })
  // noble's "recovered" format is recovery || r || s; Ethereum wants r || s || v(27+recovery)
  const recovery = sig[0]!
  const out = new Uint8Array(65)
  out.set(sig.slice(1), 0)
  out[64] = 27 + recovery
  return '0x' + bytesToHex(out)
}

/**
 * Does `signature` prove control of `address` for `message`? EOA via ecrecover; otherwise EIP-1271 on the
 * env's chain (the wallet contract must be deployed there). Throws chain_unavailable only when the EIP-1271
 * read itself fails.
 */
export async function verifyWalletSignature(env: Env, address: string, message: string, signatureHex: unknown): Promise<boolean> {
  const recovered = recoverAddress(message, signatureHex)
  if (recovered && sameAddress(recovered, address)) return true
  if (typeof signatureHex !== 'string') return false
  const clean = signatureHex.trim().replace(/^0x/, '')
  if (!/^[0-9a-fA-F]+$/.test(clean) || clean.length % 2 !== 0 || clean.length === 0) return false
  return isValidContractSignature(env, address, eip191Hash(message), hexToBytes(clean))
}
