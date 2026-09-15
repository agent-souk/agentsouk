/**
 * One-off, run locally (Nick's decision of 2026-09-15, Nachtrag ADR-65): Coinbase's x402 Bazaar lists a resource only
 * after a payment for it has been SETTLED through the CDP facilitator ("Complete a successful paid call through the CDP
 * Facilitator", docs.cdp.coinbase.com/x402/seller/get-discovered) - the /verify the desk sends daily is not enough
 * there, unlike at PayAI. So the desk wallet pays each first-party x402 service exactly once, through CDP, to our own
 * seller wallet. This is a self-payment and is declared as one: it bypasses the platform API (no job, no x402:paid,
 * no figure in /v1/stats moves), the money stays with us, and every transfer is written to the desk's ledger so it
 * counts against the desk's lifetime budget. Coinbase drops a resource after 30 days without a settlement; this script
 * does not refresh (that would be a monthly self-payment, a separate decision).
 *
 * Safety: the payee is pinned to the souk-services wallet from ~/.agentsouk-ops/agents.env, the amount must equal the
 * index price, at most 0.05 USDC per service and 0.2 USDC in total; the 402 must be on the platform origin and
 * describe the listing the index names; no request follows a redirect. Idempotence: before each /settle a pending
 * record (listing, nonce, amount, validBefore) is written to memory key operator/live/cdp-catalogue-settled; a run
 * first resolves every pending record on-chain by its authorization nonce (settled -> ledger; expired unused ->
 * cleared; still valid -> stop and wait), so a lost facilitator answer, a timeout or `settlement_pending` can never
 * lead to a second payment. Any memory read other than 404 aborts. Any doubt after a settle stops the run.
 * Without --send it only calls CDP /verify (nothing moves). Run it while the desk machine is idle (ledger has no CAS).
 *
 *   cd packages/agents && npx tsx scripts/cdp-catalogue-settle-once.ts [--only lst_...] [--send]
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { AgentSouk } from 'agentsouk'
import { bazaarOutcome, cdpJwt } from '../src/operator/bazaar.js'
import { CHAINS, formatUsdc, privateKeyToAddress, signAuthorization, UsdcWallet, type Authorization } from '../src/operator/usdc.js'

const BASE = 'https://api.agentsouk.dev'
const CDP_HOST = 'api.cdp.coinbase.com'
const CDP_PATH = '/platform/v2/x402'
const UA = 'agentsouk-ops/cdp-catalogue-settle-once'
const MAX_PER_SERVICE = 50_000n // 0.05 USDC
const MAX_TOTAL = 200_000n // 0.2 USDC
const DONE_KEY = 'operator/live/cdp-catalogue-settled'
const LEDGER_KEY = 'operator/live/ledger'

type Record_ = { state: 'pending' | 'settled'; nonce: string; amount: string; valid_before: number; hash?: string; at: string }
type Ledger = { sent: { job_id: string; amount: string; hash: string; at: string; replaced?: boolean }[] }

// --- arguments -------------------------------------------------------------------------------------------------
const send = process.argv.includes('--send')
const onlyIdx = process.argv.findIndex((a) => a === '--only' || a.startsWith('--only='))
let only: string | undefined
if (onlyIdx >= 0) {
  const a = process.argv[onlyIdx]!
  only = a.includes('=') ? a.slice(a.indexOf('=') + 1) : process.argv[onlyIdx + 1]
  if (!only || !/^lst_[0-9A-Z]{26}$/.test(only)) {
    console.error('--only needs a listing id (lst_ + 26 characters)')
    process.exit(1)
  }
}
const unknown = process.argv.slice(2).filter((a, i, all) => !['--send', '--only'].includes(a) && !a.startsWith('--only=') && all[i - 1] !== '--only')
if (unknown.length) {
  console.error(`unknown arguments: ${unknown.join(' ')}`)
  process.exit(1)
}

// --- identities --------------------------------------------------------------------------------------------------
const ops = join(homedir(), '.agentsouk-ops')
const envOf = (file: string) => Object.fromEntries(readFileSync(join(ops, file), 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]))
const operator = envOf('operator.env')
const agents = envOf('agents.env')
const pk = operator.OPERATOR_PRIVATE_KEY ?? ''
const deskAddress = privateKeyToAddress(pk)
if (!operator.OPERATOR_WALLET_ADDRESS || deskAddress.toLowerCase() !== operator.OPERATOR_WALLET_ADDRESS.toLowerCase()) throw new Error('OPERATOR_PRIVATE_KEY does not belong to OPERATOR_WALLET_ADDRESS')
const PAYEE = agents.WALLET_ADDRESS ?? ''
if (!/^0x[0-9a-fA-F]{40}$/.test(PAYEE)) throw new Error('no souk-services WALLET_ADDRESS in agents.env')
const cdpFile = join(ops, 'cdp_api_key.json')
if (!existsSync(cdpFile)) throw new Error('~/.agentsouk-ops/cdp_api_key.json is missing')
const cdp = JSON.parse(readFileSync(cdpFile, 'utf8')) as { id: string; privateKey: string }
if (!operator.OPERATOR_API_KEY_LIVE) throw new Error('no OPERATOR_API_KEY_LIVE in operator.env')
const desk = new AgentSouk({ apiKey: operator.OPERATOR_API_KEY_LIVE, baseUrl: BASE, userAgent: UA })
const wallet = new UsdcWallet(pk, CHAINS.live)
const me = await desk.agents.me()
if (me.handle !== 'souk-bounties' || String(me.wallet_address).toLowerCase() !== deskAddress.toLowerCase()) throw new Error(`the live key belongs to ${me.handle} with wallet ${me.wallet_address}, not souk-bounties with ${deskAddress}`)

// --- memory: only a key that was never written reads as empty ------------------------------------------------------
const readKey = async <T>(key: string, empty: T): Promise<T> => {
  try {
    return ((await desk.memory.get<T>(key)).value ?? empty) as T
  } catch (e) {
    if ((e as { status?: number }).status === 404) return empty
    throw new Error(`cannot read memory ${key}: ${String((e as Error).message ?? e)} - aborting before any payment`)
  }
}
const done = await readKey<Record<string, Record_>>(DONE_KEY, {})
const saveDone = () => desk.memory.set(DONE_KEY, done)
const appendLedger = async (listingId: string, amount: string, hash: string, at: string) => {
  const ledger = await readKey<Ledger>(LEDGER_KEY, { sent: [] })
  if (!Array.isArray(ledger.sent)) throw new Error('ledger has no sent[]')
  if (ledger.sent.some((e) => e.hash.toLowerCase() === hash.toLowerCase())) return
  ledger.sent = [...ledger.sent, { job_id: `cdp-catalogue:${listingId}`, amount, hash, at }].slice(-200)
  await desk.memory.set(LEDGER_KEY, ledger)
}
await readKey<Ledger>(LEDGER_KEY, { sent: [] }) // readable before anything is paid

// --- resolve what an earlier run left pending -----------------------------------------------------------------------
for (const [listingId, r] of Object.entries(done)) {
  if (r.state !== 'pending') continue
  // an authorization can only have landed before valid_before: search from shortly before the record was written
  const blocksBack = Math.ceil((Date.now() - Date.parse(r.at)) / 2000) + 300
  if (!r.hash && blocksBack > 5000) {
    console.error(`${listingId}: pending since ${r.at}, too far back to search by RPC - check nonce ${r.nonce} of ${deskAddress} on basescan and fix ${DONE_KEY} by hand`)
    process.exit(1)
  }
  const hash = r.hash ?? (await wallet.findAuthorizationUse(r.nonce, blocksBack))
  if (hash) {
    const receipt = await wallet.waitForReceipt(hash, { timeoutMs: 60_000 })
    if (receipt.status === 'success') {
      await appendLedger(listingId, r.amount, hash, r.at)
      done[listingId] = { ...r, state: 'settled', hash }
      await saveDone()
      console.log(`${listingId}: earlier pending settlement found on-chain ${hash} - recorded`)
      continue
    }
  }
  if (Date.now() / 1000 > r.valid_before + 60) {
    delete done[listingId]
    await saveDone()
    console.log(`${listingId}: earlier authorization expired unused - cleared, may be paid in this run`)
    continue
  }
  console.error(`${listingId}: an authorization is still valid until ${new Date(r.valid_before * 1000).toISOString()} and not yet on-chain - run again after that`)
  process.exit(1)
}

// --- network ---------------------------------------------------------------------------------------------------
const get = (url: string, init: RequestInit = {}, timeoutMs = 30_000) => fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': UA, ...((init.headers as Record<string, string>) ?? {}) } })
const cdpCall = async (op: 'verify' | 'settle', body: unknown) => {
  const path = `${CDP_PATH}/${op}`
  const res = await get(`https://${CDP_HOST}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', Authorization: `Bearer ${cdpJwt({ keyId: cdp.id, keySecret: cdp.privateKey, method: 'POST', host: CDP_HOST, path })}` }, body: JSON.stringify(body) }, op === 'settle' ? 90_000 : 30_000)
  const text = await res.text()
  let json: Record<string, unknown> = {}
  try {
    json = JSON.parse(text) as Record<string, unknown>
  } catch {
    json = { raw: text.slice(0, 300) }
  }
  const why = [json.invalidReason, json.errorReason, json.errorType, json.errorMessage, json.raw].filter(Boolean).map(String).join(' / ')
  return { status: res.status, json, why, ext: bazaarOutcome(res.headers.get('extension-responses')) }
}

type Service = { listing_id: string; url: string; price: number; pay_to: string; title: string; example_input?: unknown }
const index = (await (await get(`${BASE}/v1/x402?env=live`, { headers: { accept: 'application/json' } })).json()) as { services: Service[] }
const services = index.services.filter((s) => (!only || s.listing_id === only) && !done[s.listing_id])
if (only && !index.services.some((s) => s.listing_id === only)) throw new Error(`${only} is not in the live x402 index`)
console.log(`desk ${deskAddress}: ${formatUsdc(await wallet.usdcBalance())}; payee (souk-services) ${PAYEE}; already settled: ${Object.keys(done).length}; to do: ${services.length}; ${send ? 'SEND' : 'dry run (verify only)'}`)

let total = 0n
const settledNow: string[] = []
for (const s of services) {
  const tag = `${s.listing_id} (${s.title.slice(0, 40)})`
  let body: Record<string, unknown>
  let amount: bigint
  let auth: Authorization
  try {
    if (new URL(s.url).origin !== BASE) throw new Error(`url ${s.url} is not on ${BASE}`)
    const res = await get(s.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(s.example_input ?? {}) })
    await res.text()
    if (res.status !== 402) throw new Error(`expected 402, got ${res.status}`)
    const pr = JSON.parse(Buffer.from(res.headers.get('payment-required') ?? '', 'base64').toString('utf8')) as { x402Version: number; resource: { url: string }; accepts: { network: string; asset: string; payTo: string; amount: string; scheme: string }[]; extensions?: { bazaar?: unknown } }
    const req = pr.accepts?.[0]
    if (pr.x402Version !== 2 || !req || !pr.resource || !pr.extensions?.bazaar) throw new Error('not an x402 v2 402 with a bazaar extension')
    if (pr.resource.url !== s.url) throw new Error(`402 describes ${pr.resource.url}`)
    if (req.scheme !== 'exact' || req.network !== 'eip155:8453' || req.asset.toLowerCase() !== CHAINS.live.usdc.toLowerCase()) throw new Error(`terms ${req.scheme}/${req.network}/${req.asset}`)
    if (req.payTo.toLowerCase() !== PAYEE.toLowerCase() || s.pay_to.toLowerCase() !== PAYEE.toLowerCase()) throw new Error(`payee ${req.payTo} / index ${s.pay_to} is not souk-services ${PAYEE}`)
    amount = BigInt(req.amount)
    if (amount !== BigInt(s.price) || amount <= 0n || amount > MAX_PER_SERVICE) throw new Error(`amount ${req.amount} (index ${s.price}, cap ${MAX_PER_SERVICE})`)
    if (total + amount > MAX_TOTAL) throw new Error(`would exceed the total cap of ${formatUsdc(MAX_TOTAL)}`)
    auth = { from: deskAddress, to: req.payTo, value: amount, validAfter: 0n, validBefore: BigInt(Math.floor(Date.now() / 1000) + 300), nonce: '0x' + randomBytes(32).toString('hex') }
    const signature = signAuthorization(CHAINS.live, auth, pk)
    const authorization = { from: auth.from, to: auth.to, value: amount.toString(), validAfter: '0', validBefore: auth.validBefore.toString(), nonce: auth.nonce }
    body = { x402Version: 2, paymentPayload: { x402Version: 2, resource: pr.resource, accepted: req, payload: { signature, authorization }, extensions: pr.extensions }, paymentRequirements: req }
    const v = await cdpCall('verify', body)
    console.log(`${tag}: verify ${v.status} isValid=${String(v.json.isValid)} ${v.why} bazaar=${JSON.stringify(v.ext)}`)
    if (v.status !== 200 || v.json.isValid !== true) continue
  } catch (e) {
    console.log(`${tag}: skipped before signing for settlement - ${String((e as Error).message ?? e)}`)
    continue
  }
  if (!send) continue

  // from here on money may move: record first, and stop at the first doubt
  const at = new Date().toISOString()
  done[s.listing_id] = { state: 'pending', nonce: auth.nonce, amount: amount.toString(), valid_before: Number(auth.validBefore), at }
  try {
    await saveDone()
  } catch (e) {
    console.error(`${tag}: could not record the pending settlement (${String((e as Error).message ?? e)}) - nothing was sent, stopping`)
    break
  }
  total += amount
  let st: Awaited<ReturnType<typeof cdpCall>>
  try {
    st = await cdpCall('settle', body)
  } catch (e) {
    console.error(`${tag}: settle call failed (${String((e as Error).message ?? e)}) - the payment may still land; pending record kept (nonce ${auth.nonce}); run again after ${new Date(Number(auth.validBefore) * 1000 + 60_000).toISOString()} to resolve it. Stopping.`)
    break
  }
  const hash = typeof st.json.transaction === 'string' && /^0x[0-9a-fA-F]{64}$/.test(st.json.transaction) ? st.json.transaction : ''
  console.log(`${tag}: settle ${st.status} success=${String(st.json.success)} tx=${hash || '-'} ${st.why} bazaar=${JSON.stringify(st.ext)}`)
  if (hash) {
    done[s.listing_id] = { ...done[s.listing_id]!, hash }
  }
  if (st.status !== 200 || st.json.success !== true || !hash) {
    await saveDone().catch(() => undefined)
    console.error(`${tag}: not confirmed as settled${hash ? ` (tx ${hash} may still land)` : ''} - pending record kept; run again after ${new Date(Number(auth.validBefore) * 1000 + 60_000).toISOString()} to resolve it. Stopping.`)
    break
  }
  try {
    await appendLedger(s.listing_id, amount.toString(), hash, at) // the ledger first: over-counting the budget is the safe side
    done[s.listing_id] = { ...done[s.listing_id]!, state: 'settled', hash }
    await saveDone()
    settledNow.push(hash)
    const receipt = await wallet.waitForReceipt(hash)
    console.log(`${tag}: receipt ${receipt.status} in block ${receipt.blockNumber} https://basescan.org/tx/${hash}`)
    if (receipt.status !== 'success') {
      console.error(`${tag}: reverted - stopping`)
      break
    }
  } catch (e) {
    console.error(`${tag}: SETTLED as ${hash} (${formatUsdc(amount)}) but recording or confirming failed: ${String((e as Error).message ?? e)}. Stopping; a rerun resolves it from the pending record.`)
    break
  }
}

// the desk writes the same ledger without a version check: make sure nothing of this run was lost
if (settledNow.length) {
  const ledger = await readKey<Ledger>(LEDGER_KEY, { sent: [] })
  const missing = settledNow.filter((h) => !ledger.sent.some((e) => e.hash.toLowerCase() === h.toLowerCase()))
  for (const h of missing) {
    const [listingId, r] = Object.entries(done).find(([, x]) => x.hash?.toLowerCase() === h.toLowerCase())!
    await appendLedger(listingId, r.amount, h, r.at)
  }
  console.log(`ledger check: ${settledNow.length} settled in this run, ${missing.length} re-appended`)
}
console.log(`sent for settlement: ${formatUsdc(total)}; desk now ${formatUsdc(await wallet.usdcBalance())}`)
