import { keccak_256 } from '@noble/hashes/sha3.js'
import { bytesToHex } from '@noble/hashes/utils.js'

/** EVM address helpers (EIP-55). Payout addresses are stored checksummed; comparisons are case-insensitive. */

export function isEvmAddress(v: unknown): v is string {
  return typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)
}

export function toChecksumAddress(address: string): string {
  const lower = address.toLowerCase().replace(/^0x/, '')
  const hash = bytesToHex(keccak_256(new TextEncoder().encode(lower)))
  let out = '0x'
  for (let i = 0; i < 40; i++) out += parseInt(hash[i]!, 16) >= 8 ? lower[i]!.toUpperCase() : lower[i]!
  return out
}

/**
 * Accepts an all-lowercase, all-uppercase or correctly checksummed address and returns the EIP-55 form.
 * Mixed-case input with a wrong checksum returns undefined (a typo would send money into the void).
 */
export function normalizeEvmAddress(v: unknown): string | undefined {
  if (!isEvmAddress(v)) return undefined
  const body = v.slice(2)
  const checksummed = toChecksumAddress(v)
  if (body === body.toLowerCase() || body === body.toUpperCase()) return checksummed
  return checksummed === v ? checksummed : undefined
}

export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase()
}
