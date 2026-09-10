/**
 * ADR-48 end to end, against a deployed API and the real public facilitator: an agent that knows only a listing URL
 * buys one job with an x402 payment and no account of its own.
 *
 *   cd packages/api && npx tsx scripts/smoke-x402.ts [https://api.agentsouk.dev] [listing_id]
 *
 * Runs in the sandbox: the throwaway wallet is funded from the platform faucet, so it costs nothing. The wallet it
 * pays from is the identity the platform records; there is no registration step in the x402 flow itself. The
 * helper agent that claims the faucet is ours and is marked platform-operated (ADR-46), so it cannot show up in
 * any published figure as an outsider.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js'
import { privateKeyToAddress, signMessage } from '../src/modules/payments/evm-signature.js'

const base = (process.argv[2] ?? 'https://api.agentsouk.dev').replace(/\/$/, '')
const listingArg = process.argv[3]
const t0 = Date.now()
const step = (msg: string, extra?: unknown) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}${extra !== undefined ? ' ' + JSON.stringify(extra) : ''}`)
const fail = (msg: string, extra?: unknown): never => {
  console.error(`FAIL ${msg}${extra !== undefined ? ' ' + JSON.stringify(extra) : ''}`)
  process.exit(1)
}

const adminFile = join(homedir(), '.agentsouk-ops', 'agentsouk-api.env')
if (!existsSync(adminFile)) fail(`${adminFile} missing: the faucet helper agent must be marked platform-operated (ADR-46)`)
const admin = readFileSync(adminFile, 'utf8').match(/^ADMIN_TOKEN=(.+)$/m)?.[1]?.trim()
if (!admin) fail(`ADMIN_TOKEN missing in ${adminFile}`)

const json = async (res: Response) => {
  const text = await res.text()
  try {
    return JSON.parse(text) as Record<string, any>
  } catch {
    return { raw: text.slice(0, 300) }
  }
}

// --- EIP-712 signing of the EIP-3009 authorization, independent of the API's own helpers ------------------------
const TYPES = { TransferWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] }
const pad32 = (hex: string) => hexToBytes(hex.replace(/^0x/, '').padStart(64, '0'))
const uint = (v: string | number) => pad32(BigInt(v).toString(16))
const addr = (a: string) => pad32(a.replace(/^0x/, '').toLowerCase())
const hashType = (name: string, fields: { name: string; type: string }[]) => keccak_256(new TextEncoder().encode(`${name}(${fields.map((f) => `${f.type} ${f.name}`).join(',')})`))

function signAuthorization(pk: string, domain: { name: string; version: string; chainId: number; verifyingContract: string }, m: { from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: string }) {
  const domainType = hashType('EIP712Domain', [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }])
  const domainHash = keccak_256(concatBytes(domainType, keccak_256(new TextEncoder().encode(domain.name)), keccak_256(new TextEncoder().encode(domain.version)), uint(domain.chainId), addr(domain.verifyingContract)))
  const structHash = keccak_256(concatBytes(hashType('TransferWithAuthorization', TYPES.TransferWithAuthorization), addr(m.from), addr(m.to), uint(m.value), uint(m.validAfter), uint(m.validBefore), pad32(m.nonce)))
  const digest = keccak_256(concatBytes(hexToBytes('1901'), domainHash, structHash))
  // noble's "recovered" format is recovery || r || s; Ethereum wants r || s || v(27+recovery)
  const sig = secp256k1.sign(digest, hexToBytes(pk.replace(/^0x/, '')), { prehash: false, format: 'recovered', lowS: true })
  return '0x' + bytesToHex(concatBytes(sig.slice(1, 65), Uint8Array.of(27 + sig[0]!)))
}

const wallet = () => {
  const privateKey = '0x' + randomBytes(32).toString('hex')
  return { privateKey, address: privateKeyToAddress(privateKey) }
}

async function main() {
  step('base url', base)
  const listings = await json(await fetch(`${base}/v1/listings?env=test&seller=souk-services&limit=20`))
  const listing = listingArg ? { id: listingArg } : (listings.data ?? []).find((l: any) => l.tags?.includes('souk:translate'))
  if (!listing) fail('no souk:translate listing in the sandbox', listings.data?.map((l: any) => l.id))
  step('listing', listing.id)

  // 1. the 402: everything the buyer needs, before it has an account anywhere
  const first = await fetch(`${base}/v1/x402/${listing.id}?env=test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Hello world', target_language: 'de' }) })
  if (first.status !== 402) fail(`expected 402, got ${first.status}`, await json(first))
  // Read the terms exactly where a real x402 v2 client reads them (ADR-50): base64 in the PAYMENT-REQUIRED
  // response header. Reading the body instead is what hid the bug - the body used to carry a v2 object, which
  // no client of either generation accepts, and this smoke test passed anyway because it read our own shape.
  const prHeader = first.headers.get('payment-required')
  if (!prHeader) fail('the 402 carried no PAYMENT-REQUIRED header: no x402 client can pay this', await json(first))
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(prHeader)) fail('PAYMENT-REQUIRED is not standard base64 (the client rejects base64url)', prHeader.slice(0, 80))
  const terms = JSON.parse(Buffer.from(prHeader, 'base64').toString('utf8'))
  if (terms.x402Version !== 2) fail('PAYMENT-REQUIRED does not declare x402Version 2', terms)
  const req = terms.accepts?.[0]
  if (!req) fail('PAYMENT-REQUIRED carried no accepts[]', terms)
  const v1 = await json(first)
  if (v1.x402Version !== 1 || !v1.accepts?.[0]?.maxAmountRequired) fail('the body is not the v1 shape the older client generation reads', v1)
  step('402 received', { amount: req.amount, payTo: req.payTo, network: req.network, v1_body: v1.accepts[0].network })

  // 2. a fresh wallet, funded from the platform faucet through a helper agent that is ours
  const w = wallet()
  const reg = await json(await fetch(`${base}/v1/agents`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x402 Smoke Helper', description: 'Claims the sandbox faucet for the ADR-48 smoke test (operated by Agent Souk).', framework: 'smoke' }) }))
  if (!reg.agent?.id) fail('could not register the faucet helper', reg)
  const flagged = await fetch(`${base}/v1/admin/agents/${reg.agent.id}/first-party`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': admin! }, body: JSON.stringify({ first_party: true }) })
  if (!flagged.ok) fail('could not mark the helper as platform-operated (ADR-46)', await flagged.text())
  const key = reg.api_keys.test
  const bind = await json(await fetch(`${base}/v1/agents/me/wallet-address`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ address: w.address, signature: signMessage(`agentsouk:wallet:${reg.agent.id}:${w.address.toLowerCase()}`, w.privateKey) }) }))
  if (!bind.wallet_address) fail('could not bind the wallet', bind)
  const claim = await json(await fetch(`${base}/v1/sandbox/faucet`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: '{}' }))
  if (!claim.transaction) fail('faucet did not pay out', claim)
  step('faucet funded the wallet', { wallet: w.address, amount: claim.amount })
  // Wait for the money to actually be there, not for a guess: an authorization executed against an unconfirmed
  // balance reverts at the facilitator, which looks like an endpoint fault and is not one.
  for (let i = 0; ; i++) {
    const me = await json(await fetch(`${base}/v1/agents/me`, { headers: { authorization: `Bearer ${key}` } }))
    if (Number(me.funding?.wallet_usdc ?? 0) >= Number(req.amount)) break
    if (i > 30) fail('the faucet USDC never confirmed', { wallet: w.address, seen: me.funding?.wallet_usdc })
    await new Promise((r) => setTimeout(r, 3000))
  }
  step(`wallet confirmed with at least ${req.amount} USDC minor units`)

  // 3. sign the authorization the 402 described, and retry with it
  const validBefore = String(Math.floor(Date.now() / 1000) + Number(req.maxTimeoutSeconds ?? 900))
  const authorization = { from: w.address, to: req.payTo, value: String(req.amount), validAfter: '0', validBefore, nonce: '0x' + randomBytes(32).toString('hex') }
  const chainId = Number(String(req.network).split(':')[1])
  const signature = signAuthorization(w.privateKey, { name: req.extra.name, version: req.extra.version, chainId, verifyingContract: req.asset }, authorization)
  const header = Buffer.from(JSON.stringify({ x402Version: 2, scheme: 'exact', network: req.network, payload: { signature, authorization } })).toString('base64')
  step('authorization signed; the work runs before anything is submitted')

  // PAYMENT-SIGNATURE is the header a v2 client sends (X-PAYMENT was v1); the endpoint takes both since ADR-50.
  const paid = await fetch(`${base}/v1/x402/${listing.id}?env=test`, { method: 'POST', headers: { 'content-type': 'application/json', 'payment-signature': header }, body: JSON.stringify({ text: 'Hello world', target_language: 'de' }) })
  const result = await json(paid)
  if (paid.status === 200 && !paid.headers.get('payment-response')) fail('paid, but no PAYMENT-RESPONSE header came back', Object.fromEntries(paid.headers))
  if (paid.status !== 200) fail(`x402 purchase failed with ${paid.status}`, result)
  step('PAID and delivered', { job: result.job_id, transaction: result.paid?.transaction, output: result.output })
  if (!result.output) fail('no output returned', result)
  if (!result.paid?.transaction?.startsWith('0x')) fail('no settlement transaction returned', result.paid)

  const receipt = await fetch(result.receipt_url)
  step('receipt', { status: receipt.status })
  console.log(`SMOKE-X402 PASSED in ${((Date.now() - t0) / 1000).toFixed(1)}s: 402 -> signed authorization -> work delivered -> settled by the public facilitator -> output, with no account and no ETH.`)
}

main().catch((e) => fail(String((e as Error).message ?? e)))
