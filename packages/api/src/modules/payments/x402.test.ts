import { secp256k1 } from '@noble/curves/secp256k1.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'
import { authorizationNonceFor, CHAINS, gaslessPayment, paymentTerms, randomAuthorizationNonce, SIGNATURE_PLACEHOLDER, TRANSFER_WITH_AUTHORIZATION_TYPES, type TransferAuthorizationTypedData } from './x402.js'

/**
 * The gas-free terms hand agents EIP-712 typed data to sign. These tests pin that typed data to what viem signs:
 * the same vector as packages/agents/src/operator/usdc.test.ts (viem 2.56.3 signTypedData for the Base Sepolia
 * USDC domain). A small independent EIP-712 hasher here turns the typed data into the digest; if the API ever
 * changed a field name, type or the domain, the signature would drift from the vector.
 */

const PK = '0x' + '11'.repeat(32)
const FROM = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A' // privateKeyToAccount(PK).address
const TO = '0xA0a2494006B72109137630bC026434a809731c07'
const NONCE = '0x' + 'ab'.repeat(32)
const VIEM_SIGNATURE = '0xe1520c0d91b4e7a4123d76df591f18b8d71d4f30cdeda7dc5bf9684a976f74ad195632e6522d7c39fb6608e3574db203db3b325216899f1f60e41bd2786db5021c'

const utf8 = (s: string) => new TextEncoder().encode(s)
const word = (v: bigint) => hexToBytes(v.toString(16).padStart(64, '0'))
const addressWord = (a: string) => hexToBytes(a.slice(2).toLowerCase().padStart(64, '0'))
const typeString = (name: string, fields: readonly { name: string; type: string }[]) => `${name}(${fields.map((f) => `${f.type} ${f.name}`).join(',')})`

/** Generic enough for the two structs we use: string, uint256, address, bytes32. */
function hashTypedData(td: TransferAuthorizationTypedData): Uint8Array {
  const encodeField = (type: string, value: unknown): Uint8Array => {
    if (type === 'string') return keccak_256(utf8(String(value)))
    if (type === 'uint256') return word(BigInt(value as number | string))
    if (type === 'address') return addressWord(String(value))
    if (type === 'bytes32') return hexToBytes(String(value).slice(2))
    throw new Error(`unsupported type ${type}`)
  }
  const hashStruct = (name: 'EIP712Domain' | 'TransferWithAuthorization', data: Record<string, unknown>) => {
    const fields = td.types[name]
    return keccak_256(concatBytes(keccak_256(utf8(typeString(name, fields))), ...fields.map((f) => encodeField(f.type, data[f.name]))))
  }
  return keccak_256(concatBytes(Uint8Array.of(0x19, 0x01), hashStruct('EIP712Domain', td.domain), hashStruct(td.primaryType, td.message)))
}

function signDigest(digest: Uint8Array, pk: string): string {
  const sig = secp256k1.sign(digest, hexToBytes(pk.slice(2)), { prehash: false, format: 'recovered', lowS: true })
  return '0x' + bytesToHex(concatBytes(sig.slice(1, 65), Uint8Array.of(27 + sig[0]!)))
}

function termsFor(env: 'live' | 'test', amount = 1_000_000) {
  return paymentTerms({ env, amount, payTo: TO, resourceUrl: 'https://api.agentsouk.dev/v1/jobs/job_1/pay', description: 'Agent Souk job job_1: test' })
}

describe('gasless payment terms (EIP-3009 typed data + x402 settle body)', () => {
  it('produces typed data whose signature equals viem signTypedData for the Base Sepolia USDC domain', () => {
    const t = termsFor('test')
    // validBefore = now/1000 + maxTimeoutSeconds (900): pick `now` so it lands on the vector's 1_800_000_000
    const g = gaslessPayment({ env: 'test', requirements: t.x402.accepts[0]!, resource: t.x402.resource, payFrom: FROM, now: (1_800_000_000 - 900) * 1000, nonce: NONCE })
    expect(g.typed_data.domain).toEqual({ name: 'USDC', version: '2', chainId: 84532, verifyingContract: CHAINS['eip155:84532'].usdc })
    expect(g.typed_data.message).toEqual({ from: FROM, to: TO, value: 1_000_000, validAfter: 0, validBefore: 1_800_000_000, nonce: NONCE })
    expect(g.typed_data.types).toBe(TRANSFER_WITH_AUTHORIZATION_TYPES)
    expect(signDigest(hashTypedData(g.typed_data), PK)).toBe(VIEM_SIGNATURE)
    expect(g.valid_before).toBe('2027-01-15T08:00:00.000Z')
  })

  it('ships the complete x402 v2 settle body: accepted = requirements = the advertised terms, signature left to the agent', () => {
    const t = termsFor('test', 250_000)
    const g = gaslessPayment({ env: 'test', requirements: t.x402.accepts[0]!, resource: t.x402.resource, payFrom: FROM, now: 1_800_000_000_000, nonce: NONCE })
    expect(g.settle_url).toBe('https://x402.org/facilitator/settle')
    expect(g.facilitator).toBe(CHAINS['eip155:84532'].facilitator)
    expect(g.settle_body).toEqual({
      x402Version: 2,
      paymentPayload: {
        x402Version: 2,
        resource: { url: 'https://api.agentsouk.dev/v1/jobs/job_1/pay', description: 'Agent Souk job job_1: test', mimeType: 'application/json' },
        accepted: t.x402.accepts[0],
        payload: { signature: SIGNATURE_PLACEHOLDER, authorization: { from: FROM, to: TO, value: '250000', validAfter: '0', validBefore: String(1_800_000_000 + 900), nonce: NONCE } },
      },
      paymentRequirements: t.x402.accepts[0],
    })
    // the strings in the authorization and the numbers in the typed data describe the same transfer
    const a = g.settle_body.paymentPayload.payload.authorization
    expect([Number(a.value), Number(a.validAfter), Number(a.validBefore)]).toEqual([g.typed_data.message.value, g.typed_data.message.validAfter, g.typed_data.message.validBefore])
    expect(g.steps).toHaveLength(3)
    expect(g.sign_with.viem).toContain('signTypedData')
    expect(g.fallback).toContain(TO)
    expect(g.summary).toContain('never sees your signature')
  })

  it('uses the Base mainnet domain and the mainnet facilitator for live terms', () => {
    const t = termsFor('live', 5_000_000)
    const g = gaslessPayment({ env: 'live', requirements: t.x402.accepts[0]!, resource: t.x402.resource, payFrom: FROM })
    expect(g.typed_data.domain).toEqual({ name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' })
    expect(g.settle_url).toBe('https://facilitator.payai.network/settle')
    expect(g.settle_body.paymentPayload.accepted.network).toBe('eip155:8453')
    expect(g.fallback).toContain('Base')
  })

  it('derives job nonces deterministically: same job, payer, amount and sequence -> same nonce; anything else -> another', () => {
    const n = authorizationNonceFor({ jobId: 'job_1', payFrom: FROM, amount: 250_000, sequence: 0 })
    expect(n).toMatch(/^0x[0-9a-f]{64}$/)
    expect(authorizationNonceFor({ jobId: 'job_1', payFrom: FROM.toLowerCase(), amount: 250_000, sequence: 0 })).toBe(n) // address case does not matter
    expect(authorizationNonceFor({ jobId: 'job_2', payFrom: FROM, amount: 250_000, sequence: 0 })).not.toBe(n)
    expect(authorizationNonceFor({ jobId: 'job_1', payFrom: TO, amount: 250_000, sequence: 0 })).not.toBe(n)
    expect(authorizationNonceFor({ jobId: 'job_1', payFrom: FROM, amount: 150_000, sequence: 1 })).not.toBe(n)
    const t = termsFor('test', 250_000)
    const g = gaslessPayment({ env: 'test', requirements: t.x402.accepts[0]!, resource: t.x402.resource, payFrom: FROM, nonce: n })
    expect(g.typed_data.message.nonce).toBe(n)
    expect(g.settle_body.paymentPayload.payload.authorization.nonce).toBe(n)
  })

  it('draws a fresh 32-byte nonce per call when none is given, and refuses malformed ones', () => {
    const t = termsFor('test')
    const a = gaslessPayment({ env: 'test', requirements: t.x402.accepts[0]!, resource: t.x402.resource, payFrom: FROM })
    const b = gaslessPayment({ env: 'test', requirements: t.x402.accepts[0]!, resource: t.x402.resource, payFrom: FROM })
    expect(a.typed_data.message.nonce).toMatch(/^0x[0-9a-f]{64}$/)
    expect(a.typed_data.message.nonce).not.toBe(b.typed_data.message.nonce)
    expect(a.typed_data.message.validBefore * 1000).toBeGreaterThan(Date.now() + 14 * 60_000)
    expect(a.typed_data.message.validBefore * 1000).toBeLessThanOrEqual(Date.now() + 15 * 60_000 + 1000)
    expect(randomAuthorizationNonce()).toMatch(/^0x[0-9a-f]{64}$/)
    expect(() => gaslessPayment({ env: 'test', requirements: t.x402.accepts[0]!, resource: t.x402.resource, payFrom: FROM, nonce: '0x12' })).toThrow(/nonce/)
  })
})
