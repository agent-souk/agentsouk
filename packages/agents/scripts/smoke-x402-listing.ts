/**
 * Buy ONE sandbox x402 listing the way an outside agent does (ADR-48/50), with an input of your choice: a fresh
 * wallet with no account and no ETH, funded by the bounty desk on Base Sepolia (the platform faucet allows three
 * claims per IP and day, which the gasless smoke test uses up), the 402 read from the PAYMENT-REQUIRED header, an
 * EIP-3009 authorization signed locally, the work delivered before settlement, then settled by the public
 * facilitator. The account the endpoint hands the wallet is flagged platform-operated and deactivated on the way
 * out (ADR-46/63), so nothing of this run counts as outside demand.
 *
 *   cd packages/agents && npx tsx scripts/smoke-x402-listing.ts --listing lst_... [--input '{"...":...}' | --input-file x.json] [--base https://api.agentsouk.dev]
 *
 * Costs: the listing price in Sepolia USDC from the desk wallet plus a little Sepolia ETH for the funding transfer.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js'
import { CHAINS, formatUsdc, privateKeyToAddress, UsdcWallet } from '../src/operator/usdc.js'

const args = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const base = (flag('--base') ?? 'https://api.agentsouk.dev').replace(/\/$/, '')
const listingId = flag('--listing')
if (!listingId) {
  console.error('usage: --listing lst_... [--input JSON | --input-file path] [--base URL]')
  process.exit(1)
}
const inputText = flag('--input') ?? (flag('--input-file') ? readFileSync(flag('--input-file')!, 'utf8') : '{}')
/** --wallet-key 0x... reuses a wallet (a repeat buyer, e.g. a second url-diff check); --keep leaves its account active for that next run */
const walletKeyArg = flag('--wallet-key')
const keep = args.includes('--keep')
const input = JSON.parse(inputText) as Record<string, unknown>

const t0 = Date.now()
const step = (msg: string, extra?: unknown) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}${extra !== undefined ? ' ' + JSON.stringify(extra) : ''}`)
const fail = (msg: string, extra?: unknown): never => {
  throw new Error(`${msg}${extra !== undefined ? ' ' + JSON.stringify(extra) : ''}`)
}
const readEnv = (file: string): Record<string, string> => {
  const p = join(homedir(), '.agentsouk-ops', file)
  if (!existsSync(p)) throw new Error(`${p} missing`)
  const out: Record<string, string> = {}
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (m) out[m[1]] = m[2]
  }
  return out
}
const admin = readEnv('agentsouk-api.env').ADMIN_TOKEN
const operatorKey = readEnv('operator.env').OPERATOR_PRIVATE_KEY
if (!admin || !operatorKey) throw new Error('ADMIN_TOKEN or OPERATOR_PRIVATE_KEY missing')

const json = async (res: Response) => {
  const text = await res.text()
  try {
    return JSON.parse(text) as Record<string, any>
  } catch {
    return { raw: text.slice(0, 300) }
  }
}

// --- EIP-712 signing of the EIP-3009 authorization, the way a spec client does it (copied from packages/api/scripts/smoke-x402.ts) ---
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
  const sig = secp256k1.sign(digest, hexToBytes(pk.replace(/^0x/, '')), { prehash: false, format: 'recovered', lowS: true })
  return '0x' + bytesToHex(concatBytes(sig.slice(1, 65), Uint8Array.of(27 + sig[0]!)))
}

let buyerAgentId: string | null = null
const buyerKey = walletKeyArg ?? '0x' + randomBytes(32).toString('hex')
const buyer = privateKeyToAddress(buyerKey)
const desk = new UsdcWallet(operatorKey, CHAINS.test, { log: (m, e) => step(`  desk: ${m}`, e) })

async function main() {
  step('listing', { base, listingId, buyer, reused_wallet: walletKeyArg != null, keep })
  if (!walletKeyArg) step('buyer key (pass as --wallet-key to buy again as the same buyer)', buyerKey)
  const url = `${base}/v1/x402/${listingId}?env=test`
  const body = JSON.stringify(input)

  // 1. the 402
  const first = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
  if (first.status !== 402) fail(`expected 402, got ${first.status}`, await json(first))
  const prHeader = first.headers.get('payment-required')
  if (!prHeader) fail('no PAYMENT-REQUIRED header', await json(first))
  const terms = JSON.parse(Buffer.from(prHeader!, 'base64').toString('utf8'))
  const req = terms.accepts?.[0]
  if (terms.x402Version !== 2 || !req) fail('PAYMENT-REQUIRED is not x402 v2', terms)
  await first.text().catch(() => '')
  step('402', { amount: req.amount, payTo: req.payTo, network: req.network, description: terms.resource?.description?.slice(0, 80) })
  if (req.network !== `eip155:${CHAINS.test.chainId}`) fail('the sandbox 402 is not for Base Sepolia', req.network)

  // 2. an empty wallet is refused before any work (ADR-66)
  const validBefore = String(Math.floor(Date.now() / 1000) + Number(req.maxTimeoutSeconds ?? 900))
  const sign = () => {
    const authorization = { from: buyer, to: req.payTo, value: String(req.amount), validAfter: '0', validBefore, nonce: '0x' + randomBytes(32).toString('hex') }
    const signature = signAuthorization(buyerKey, { name: req.extra.name, version: req.extra.version, chainId: CHAINS.test.chainId, verifyingContract: req.asset }, authorization)
    return Buffer.from(JSON.stringify({ x402Version: 2, scheme: 'exact', network: req.network, payload: { signature, authorization } })).toString('base64')
  }
  if (!walletKeyArg) {
    const empty = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'payment-signature': sign() }, body })
    const emptyBody = await json(empty)
    step(`empty wallet -> HTTP ${empty.status}`, { code: emptyBody.error?.code ?? emptyBody.code ?? emptyBody.error })
    if (empty.status !== 409) fail('an empty wallet should be refused with 409 before any work', emptyBody)
  }

  // 3. the desk funds the wallet with exactly the price (plus nothing: the endpoint checks balance >= value)
  const amount = BigInt(req.amount)
  const before = await desk.usdcBalance()
  step('desk balance', { usdc: formatUsdc(before), eth_wei: (await desk.ethBalance()).toString() })
  if (before < amount) fail('the desk has less test USDC than the price', formatUsdc(before))
  const sent = await desk.transfer(buyer, amount)
  step('funding sent', { hash: sent.hash, explorer: sent.explorer })
  const receipt = await desk.waitForReceipt(sent.hash, { timeoutMs: 120_000 })
  if (receipt.status !== 'success') fail('funding transfer reverted', receipt)
  for (let i = 0; ; i++) {
    const bal = await desk.usdcBalance(buyer)
    if (bal >= amount) break
    if (i > 30) fail('the buyer balance never showed up', bal.toString())
    await new Promise((r) => setTimeout(r, 2000))
  }
  step('buyer funded', { usdc: formatUsdc(amount) })

  // 4. the purchase: work first, then settlement by the facilitator
  const t1 = Date.now()
  const paid = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'payment-signature': sign() }, body })
  const result = await json(paid)
  const secs = ((Date.now() - t1) / 1000).toFixed(1)
  if (paid.status !== 200) fail(`purchase failed with HTTP ${paid.status} after ${secs}s`, result)
  if (!paid.headers.get('payment-response')) fail('paid, but no PAYMENT-RESPONSE header', Object.fromEntries(paid.headers))
  buyerAgentId = result.account?.agent_id ?? null
  step(`PAID and delivered in ${secs}s`, { job: result.job_id, transaction: result.paid?.transaction, buyer_agent: buyerAgentId, message: result.message?.slice(0, 300) })
  console.log('OUTPUT:', JSON.stringify(result.output).slice(0, 3000))
  if (!result.output) fail('no output', result)
  if (!result.paid?.transaction?.startsWith('0x')) fail('no settlement transaction', result.paid)
  if (!buyerAgentId) {
    // the endpoint names the account in the body; if the shape changed, find it by wallet
    const found = await json(await fetch(`${base}/v1/agents?q=${buyer.slice(2, 10).toLowerCase()}&env=test`))
    buyerAgentId = found.data?.[0]?.id ?? null
  }
  console.log(`SMOKE-X402-LISTING PASSED in ${((Date.now() - t0) / 1000).toFixed(1)}s (${listingId}, ${formatUsdc(amount)}, tx ${result.paid?.transaction})`)
}

/** The wallet's own account was created by the purchase: flag it as ours and deactivate it (ADR-46/63). */
async function cleanup(): Promise<void> {
  if (keep) {
    step('account kept active for a repeat purchase (run again with --wallet-key, without --keep, to clean up)', { agent: buyerAgentId })
    return
  }
  if (!buyerAgentId) {
    step('WARNING: buyer account id unknown; flag and deactivate it by hand (x402-buyer-' + buyer.slice(2, 10).toLowerCase() + ')')
    return
  }
  try {
    const f = await fetch(`${base}/v1/admin/agents/${buyerAgentId}/first-party`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': admin }, body: JSON.stringify({ first_party: true }) })
    const d = await fetch(`${base}/v1/admin/agents/${buyerAgentId}/status`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': admin }, body: JSON.stringify({ status: 'deleted' }) })
    step('buyer account flagged and deactivated', { agent: buyerAgentId, flagged: f.ok, deleted: d.ok })
  } catch (e) {
    step(`WARNING: could not clean up ${buyerAgentId}`, String(e))
  }
}

main().then(cleanup, async (e) => {
  await cleanup()
  console.error(`FAIL ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
