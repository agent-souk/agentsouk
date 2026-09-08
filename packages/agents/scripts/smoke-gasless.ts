/**
 * The ADR-30 benchmark, run for real: an agent that knows only the base URL sends and receives a payment in the
 * sandbox without a human and without ETH. Two throwaway agents with fresh wallets: the seller lists a 0.01 USDC
 * service and delivers sealed; the buyer claims 1 testnet USDC from the platform faucet, fetches the gas-free terms,
 * signs the EIP-3009 typed data with its own key, lets the public facilitator broadcast it and submits the hash.
 * The delivery is revealed, the buyer accepts and reviews. Prints every step with timings; exit code 1 on failure.
 *
 *   npx tsx scripts/smoke-gasless.ts [--base https://api.agentsouk.dev] [--listing lst_...]
 *   npx tsx scripts/smoke-gasless.ts --verify-live      # signs a 0.01 USDC authorization (valid 60 s) from the operator wallet
 *                                                       # and asks the Base mainnet facilitator to VERIFY it; nothing should move
 *                                                       # (worst case: 0.01 USDC to our own souk-services wallet)
 *   npx tsx scripts/smoke-gasless.ts --settle-live      # REAL MONEY, one cent: settles 0.01 USDC operator -> souk-services wallet
 *                                                       # through the Base mainnet facilitator and waits for the receipt
 *
 * The signer here is deliberately independent of the API: it rebuilds the EIP-712 digest from the typed data with
 * the pinned implementation in src/operator/usdc.ts and refuses if the domain the API sent differs from the USDC
 * contract of the network.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js'
import { AgentSouk, walletMessage, type TransferAuthorizationTypedData } from 'agentsouk'
import { authorizationDigest, CHAINS, privateKeyToAddress, sameAddress, signAuthorization, usdcDomain, UsdcWallet, x402SettleBody, type Authorization } from '../src/operator/usdc.js'

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith('--') ? process.argv[i + 1]! : fallback
}
const flag = (name: string) => process.argv.includes(`--${name}`)
const base = (arg('base', process.env.AGENTSOUK_BASE_URL ?? 'https://api.agentsouk.dev') as string).replace(/\/$/, '')
const t0 = Date.now()
const step = (msg: string, extra?: unknown) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}${extra !== undefined ? ' ' + JSON.stringify(extra) : ''}`)
const fail = (msg: string, extra?: unknown): never => {
  console.error(`FAIL ${msg}${extra !== undefined ? ' ' + JSON.stringify(extra) : ''}`)
  process.exit(1)
}

function randomPrivateKey(): string {
  const b = new Uint8Array(32)
  globalThis.crypto.getRandomValues(b)
  return '0x' + bytesToHex(b)
}

/** EIP-191 personal_sign (what the wallet binding needs). */
function personalSign(message: string, privateKey: string): string {
  const msg = new TextEncoder().encode(message)
  const digest = keccak_256(concatBytes(new TextEncoder().encode(`\x19Ethereum Signed Message:\n${msg.length}`), msg))
  const sig = secp256k1.sign(digest, hexToBytes(privateKey.slice(2)), { prehash: false, format: 'recovered', lowS: true })
  return '0x' + bytesToHex(concatBytes(sig.slice(1, 65), Uint8Array.of(27 + sig[0]!)))
}

/** Signs the API's typed data with the pinned EIP-3009 implementation, after checking the domain is the real USDC contract. */
function signTypedDataWith(privateKey: string, env: 'live' | 'test') {
  const chain = CHAINS[env]
  return (td: TransferAuthorizationTypedData): string => {
    const d = usdcDomain(chain)
    const ok = td.primaryType === 'TransferWithAuthorization' && td.domain.name === d.name && td.domain.version === d.version && td.domain.chainId === chain.chainId && sameAddress(td.domain.verifyingContract, chain.usdc)
    if (!ok) fail('typed data domain is not the USDC contract of this network', td.domain)
    const auth: Authorization = { from: td.message.from, to: td.message.to, value: BigInt(td.message.value), validAfter: BigInt(td.message.validAfter), validBefore: BigInt(td.message.validBefore), nonce: td.message.nonce }
    if (!sameAddress(auth.from, privateKeyToAddress(privateKey))) fail('typed data asks another wallet to sign', { from: auth.from })
    step('signing EIP-3009 authorization', { to: auth.to, value: auth.value.toString(), validBefore: new Date(Number(auth.validBefore) * 1000).toISOString(), digest: '0x' + bytesToHex(authorizationDigest(chain, auth)).slice(0, 16) + '…' })
    return signAuthorization(chain, auth, privateKey)
  }
}

async function verifyLive() {
  const envFile = join(homedir(), '.agentsouk-ops', 'operator.env')
  if (!existsSync(envFile)) fail(`${envFile} missing`)
  const pk = readFileSync(envFile, 'utf8').match(/^OPERATOR_PRIVATE_KEY=(.+)$/m)?.[1]?.trim()
  if (!pk) fail('OPERATOR_PRIVATE_KEY missing in operator.env')
  const chain = CHAINS.live
  const w = new UsdcWallet(pk!, chain)
  const info = (await (await fetch(`${base}/v1/payments?env=live`)).json()) as { gasless?: { facilitator: string; settle_url: string }; network: { asset: { address: string; eip712_domain: { name: string; version: string } } } }
  if (!sameAddress(info.network.asset.address, chain.usdc) || info.network.asset.eip712_domain.name !== usdcDomain(chain).name) fail('live payments info disagrees with the pinned chain constants', info.network)
  if (info.gasless && info.gasless.facilitator !== chain.facilitator) fail('live facilitator differs', { api: info.gasless.facilitator, pinned: chain.facilitator })
  if (!info.gasless) step('note: this API version has no gasless block yet; using the pinned facilitator', { facilitator: chain.facilitator })
  const to = SOUK_SERVICES_WALLET
  const nonce = randomPrivateKey()
  // a short validity: the facilitator holds a real signed transfer while it verifies; 60 s bounds what it could do with it
  const auth: Authorization = { from: w.address, to, value: 10_000n, validAfter: 0n, validBefore: BigInt(Math.floor(Date.now() / 1000) + 60), nonce }
  const body = x402SettleBody(chain, auth, signAuthorization(chain, auth, pk!), { url: `${base}/v1/payments`, description: 'Agent Souk gas-free path check (verify only)' })
  const before = await w.usdcBalance(to)
  step('asking the Base mainnet facilitator to verify a 0.01 USDC authorization from the operator wallet (valid 60 s)', { facilitator: chain.facilitator, from: w.address })
  const res = await fetch(`${chain.facilitator}/verify`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) })
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
  step('facilitator /verify answered', { status: res.status, ...json })
  if (res.status !== 200 || json.isValid !== true) fail('the mainnet facilitator did not accept the authorization', json)
  const after = await w.usdcBalance(to)
  if (after !== before) step('NOTE: the recipient balance changed during the probe', { before: before.toString(), after: after.toString() })
  console.log('VERIFY-LIVE PASSED: the Base mainnet facilitator accepts our EIP-3009 authorization shape (verify only; nothing should have moved, worst case 0.01 USDC between our own wallets).')
}

const SOUK_SERVICES_WALLET = '0xA0a2494006B72109137630bC026434a809731c07' // first-party seller wallet (ADR-23)

/** Real money, one cent, between two wallets we operate: proves that /settle on Base mainnet broadcasts and pays the gas. */
async function settleLive() {
  const envFile = join(homedir(), '.agentsouk-ops', 'operator.env')
  if (!existsSync(envFile)) fail(`${envFile} missing`)
  const pk = readFileSync(envFile, 'utf8').match(/^OPERATOR_PRIVATE_KEY=(.+)$/m)?.[1]?.trim()
  if (!pk) fail('OPERATOR_PRIVATE_KEY missing in operator.env')
  const chain = CHAINS.live
  const w = new UsdcWallet(pk!, chain, { maxPerTransfer: 10_000n })
  const before = await w.usdcBalance(SOUK_SERVICES_WALLET)
  step('settling 0.01 USDC operator -> souk-services through the Base mainnet facilitator (real money, one cent, our own wallets)', { facilitator: chain.facilitator, from: w.address, to: SOUK_SERVICES_WALLET })
  const r = await w.transferGasless(SOUK_SERVICES_WALLET, 10_000n, { validForSeconds: 300, resource: { url: `${base}/v1/payments`, description: 'Agent Souk gas-free path check on Base mainnet (0.01 USDC between first-party wallets)' } })
  step('facilitator broadcast', { hash: r.hash, explorer: r.explorer })
  const receipt = await w.waitForReceipt(r.hash, { timeoutMs: 180_000 })
  // public RPC endpoints are load-balanced; a balance read right after the receipt can hit a node that is a block behind
  let after = before
  for (let i = 0; i < 10 && after - before !== 10_000n; i++) {
    if (i) await new Promise((res) => setTimeout(res, 2000))
    after = await w.usdcBalance(SOUK_SERVICES_WALLET)
  }
  step('receipt', { status: receipt.status, block: receipt.blockNumber.toString(), recipient_delta: (after - before).toString() })
  if (receipt.status !== 'success' || after - before !== 10_000n) fail('the mainnet settle did not land as expected', { status: receipt.status, delta: (after - before).toString() })
  console.log(`SETTLE-LIVE PASSED: ${chain.facilitator} broadcast an EIP-3009 transfer on Base mainnet and paid the gas; ${r.explorer}`)
}

async function sandboxRoundTrip() {
  step('base url', base)
  const info = (await (await fetch(`${base}/v1/payments?env=test`)).json()) as { gasless?: { settle_url: string }; network: { platform_faucet: string | null } }
  if (!info.gasless?.settle_url) fail('GET /v1/payments has no gasless block', info)
  if (!info.network.platform_faucet) fail('no platform faucet for env=test', info.network)

  // --- two throwaway agents with fresh wallets ---------------------------------------------------
  const mk = async (name: string) => {
    const reg = await AgentSouk.register({ name, description: 'Agent Souk gas-free payment smoke test (throwaway)', capabilities: ['ops'] }, { baseUrl: base })
    const pk = randomPrivateKey()
    const address = privateKeyToAddress(pk)
    const c = new AgentSouk({ baseUrl: base, apiKey: reg.api_keys.test, userAgent: 'agentsouk-smoke-gasless/1' })
    await c.agents.setWalletAddress(address, personalSign(walletMessage(reg.agent.id, address), pk))
    return { reg, pk, address, c }
  }
  const buyer = await mk('Gasless Smoke Buyer')
  step('buyer registered and wallet bound', { agent: buyer.reg.agent.id, wallet: buyer.address })
  const listingArg = arg('listing')
  let seller: Awaited<ReturnType<typeof mk>> | undefined
  let listingId = listingArg
  if (!listingId) {
    seller = await mk('Gasless Smoke Seller')
    const l = await seller.c.listings.create({ title: 'Echo (gas-free payment smoke test)', description: 'Returns {echo: input.text}. Exists to prove the gas-free payment path end to end.', category: 'ops', pricing_model: 'fixed', price: 10_000, input_schema: { type: 'object', required: ['text'] }, example_input: { text: 'hi' }, turnaround_seconds: 600 })
    listingId = l.id
    step('seller registered, listing created', { agent: seller.reg.agent.id, wallet: seller.address, listing: listingId })
  }

  // --- faucet: 1 testnet USDC, no captcha ----------------------------------------------------------
  const claim = (await buyer.c.sandbox.faucet()) as { transaction: string; amount: number }
  step('faucet sent testnet USDC', { transaction: claim.transaction, amount: claim.amount })
  const bw = new UsdcWallet(buyer.pk, CHAINS.test)
  for (let i = 0; ; i++) {
    const bal = await bw.usdcBalance()
    if (bal >= 10_000n) {
      step('buyer wallet funded', { usdc_minor: bal.toString(), eth_wei: (await bw.ethBalance()).toString() })
      break
    }
    if (i > 40) fail('faucet USDC never arrived')
    await new Promise((r) => setTimeout(r, 3000))
  }

  // --- hire, deliver sealed ------------------------------------------------------------------------
  const job = await buyer.c.jobs.create({ listing_id: listingId!, input: listingArg ? { schema: { type: 'object' }, data: {} } : { text: 'hello' } })
  step('job created', { job: job.id, status: job.status })
  if (seller) {
    await seller.c.jobs.accept(job.id)
    await seller.c.jobs.deliver(job.id, { echo: 'hello' }, 'done', { preview: 'he…' })
    step('seller accepted and delivered sealed')
  }
  const delivered = await buyer.c.waitForJob(job.id, { until: ['delivered', 'declined', 'cancelled', 'expired'], intervalMs: 3000, timeoutMs: 240_000 })
  if (delivered.status !== 'delivered') fail('job did not reach delivered', delivered)
  if (delivered.output !== null) fail('delivery was not sealed', delivered)
  step('delivery is sealed', { output_hash: delivered.output_hash, output_bytes: delivered.output_bytes })

  // --- gas-free payment: terms -> sign -> facilitator -> hash -> verified --------------------------
  const terms = await buyer.c.jobs.paymentRequired(job.id)
  if (!terms?.gasless) fail('terms carry no gasless block', terms)
  step('terms received', { amount: terms!.amount, pay_to: terms!.pay_to, settle_url: terms!.gasless!.settle_url, valid_before: terms!.gasless!.valid_before })
  const paid = await buyer.c.jobs.payGasless(job.id, signTypedDataWith(buyer.pk, 'test'), { intervalMs: 3000 })
  const stl = paid.payment.settlement
  if (paid.payment.status !== 'paid' || !stl) fail('job not paid', paid.payment)
  step('PAID gas-free; delivery revealed', { transaction: stl!.transaction, explorer: stl!.explorer_url, output: paid.output })
  if (Number((await bw.ethBalance()).toString()) !== 0) step('note: the buyer wallet holds ETH; the point was that it needs none')

  // --- close the loop ------------------------------------------------------------------------------
  const done = await buyer.c.jobs.accept(job.id)
  await buyer.c.jobs.review(job.id, 5, 'gas-free payment smoke test')
  step('job completed and reviewed', { status: done.status })
  if (seller) {
    const got = await seller.c.payments.settlements()
    step('seller sees the settlement', { direction: got.data[0]?.direction, amount: got.data[0]?.amount })
    await seller.c.listings.update(listingId!, { status: 'paused' }).catch(() => undefined)
  }
  console.log(`SMOKE-GASLESS PASSED in ${((Date.now() - t0) / 1000).toFixed(1)}s: faucet -> sealed delivery -> EIP-3009 signature -> facilitator -> verified on-chain -> revealed, no ETH, no human.`)
}

try {
  if (flag('verify-live')) await verifyLive()
  else if (flag('settle-live')) await settleLive()
  else await sandboxRoundTrip()
} catch (e) {
  fail(String((e as Error).message ?? e), (e as { body?: unknown }).body)
}
