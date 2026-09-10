/**
 * Does the LIVE facilitator accept our x402 terms - without moving a cent and without creating any record?
 *
 * Usage (from packages/api):  npx tsx scripts/verify-live-terms.ts [listing_id]
 *
 * It fetches the real 402 from the live endpoint, reads the terms out of the PAYMENT-REQUIRED header the way a
 * client does, signs an EIP-3009 authorization with the operator wallet, and sends it to the facilitator's
 * /verify - which validates signature, balance and requirements against Base mainnet and BROADCASTS NOTHING.
 * The authorization expires in five minutes on its own. If it were broadcast anyway, the 0.02 USDC would move
 * between two of our own wallets: no job, no settlement, no reputation, nothing to clean up.
 *
 * Why this exists (ADR-50): the settle half of the live path had never run, and the only ways to prove it looked
 * like either a real purchase - which pollutes our own figures exactly the way ADR-43/44/46 were caused - or
 * nothing. This is the third way. `isValid: true` means a real buyer's payment would go through today.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js'

const TYPES = [
  { name: 'from', type: 'address' },
  { name: 'to', type: 'address' },
  { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' },
  { name: 'validBefore', type: 'uint256' },
  { name: 'nonce', type: 'bytes32' },
]
const pad32 = (hex: string) => hexToBytes(hex.replace(/^0x/, '').padStart(64, '0'))
const uint = (v: string | number) => pad32(BigInt(v).toString(16))
const addr = (a: string) => pad32(a.replace(/^0x/, '').toLowerCase())
const hashType = (name: string, fields: { name: string; type: string }[]) => keccak_256(new TextEncoder().encode(`${name}(${fields.map((f) => `${f.type} ${f.name}`).join(',')})`))

function signAuthorization(pk: string, domain: { name: string; version: string; chainId: number; verifyingContract: string }, m: Record<string, string>) {
  const domainType = hashType('EIP712Domain', [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
  ])
  const domainHash = keccak_256(concatBytes(domainType, keccak_256(new TextEncoder().encode(domain.name)), keccak_256(new TextEncoder().encode(domain.version)), uint(domain.chainId), addr(domain.verifyingContract)))
  const structHash = keccak_256(concatBytes(hashType('TransferWithAuthorization', TYPES), addr(m.from!), addr(m.to!), uint(m.value!), uint(m.validAfter!), uint(m.validBefore!), pad32(m.nonce!)))
  const digest = keccak_256(concatBytes(hexToBytes('1901'), domainHash, structHash))
  const sig = secp256k1.sign(digest, hexToBytes(pk.replace(/^0x/, '')), { prehash: false, format: 'recovered', lowS: true })
  return '0x' + bytesToHex(concatBytes(sig.slice(1, 65), Uint8Array.of(27 + sig[0]!)))
}

const env = Object.fromEntries(
  readFileSync(join(homedir(), '.agentsouk-ops', 'operator.env'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
) as Record<string, string>

const listingId = process.argv[2] ?? 'lst_01M1YBDYN9SGHWYGE92CGXMA74'
const base = 'https://api.agentsouk.dev'

const res = await fetch(`${base}/v1/x402/${listingId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hello', target_language: 'de' }) })
if (res.status !== 402) throw new Error(`expected 402, got ${res.status}`)
const pr = JSON.parse(Buffer.from(res.headers.get('payment-required')!, 'base64').toString('utf8'))
const req = pr.accepts[0]
console.log('terms:', { amount: req.amount, payTo: req.payTo, network: req.network, resource: pr.resource.url })

const validBefore = String(Math.floor(Date.now() / 1000) + 300)
const authorization = { from: env.OPERATOR_WALLET_ADDRESS!, to: req.payTo, value: String(req.amount), validAfter: '0', validBefore, nonce: '0x' + randomBytes(32).toString('hex') }
const signature = signAuthorization(env.OPERATOR_PRIVATE_KEY!, { name: req.extra.name, version: req.extra.version, chainId: Number(String(req.network).split(':')[1]), verifyingContract: req.asset }, authorization)

const body = {
  x402Version: 2,
  paymentPayload: { x402Version: 2, resource: pr.resource, accepted: req, payload: { signature, authorization } },
  paymentRequirements: req,
}
const v = await fetch('https://facilitator.payai.network/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
console.log('verify:', v.status, (await v.text()).slice(0, 400))
console.log('NOTHING WAS BROADCAST: the authorization expires at', new Date(Number(validBefore) * 1000).toISOString())
