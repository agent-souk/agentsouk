/**
 * Entry point: one process, both environments (live + sandbox), the seller identity with every service in
 * ./services, and (when configured) the bounty desk identity with the catalogue in ./operator.
 *
 * Environment:
 *   AGENTSOUK_BASE_URL         default https://api.agentsouk.dev
 *   AGENTSOUK_API_KEY_LIVE     as_live_... of the seller identity (optional; omit to run sandbox-only)
 *   AGENTSOUK_API_KEY_TEST     as_test_... of the seller identity (optional)
 *   WEBHOOK_SECRET             >= 16 chars; the platform signs webhook deliveries with it
 *   PUBLIC_URL                 https://... where the platform can reach POST /webhooks/agentsouk/<env>[/operator] (optional: without it, polling only)
 *   PORT                       default 8788
 *   POLL_INTERVAL_MS           default 60000 (inbox catch-up while the process is awake)
 *   ANTHROPIC_API_KEY          enables the LLM services (translate, summarize, extract-structured, classify) and the bounty judge; without it their listings are paused and no bounties are posted
 *   LLM_DAILY_BUDGET_USD       default 5; live LLM jobs are declined once the day's model spend would exceed it (the counter lives in the seller's platform memory, `llm/live/daily-spend`, so it survives restarts)
 *   LLM_DAILY_BUDGET_USD_TEST  default 1; the same for the sandbox, counted separately so free sandbox jobs cannot use up the live budget
 *   OPERATOR_API_KEY_LIVE/TEST keys of the bounty desk identity (souk-bounties); optional
 *   OPERATOR_PRIVATE_KEY       0x... key of the wallet bound to that identity; without it the desk posts nothing
 *   OPERATOR_TOTAL_BUDGET_USDC default 50 (lifetime), OPERATOR_DAILY_CAP_USDC default 20, OPERATOR_MAX_TRANSFER_USDC default 15
 *   FAUCET_SECRET              enables POST /faucet for the platform API (sandbox faucet, ADR-30): testnet USDC from the operator wallet, gas-free via the x402 facilitator
 *   FAUCET_MAX_USDC            per request, default 1; FAUCET_DAILY_CAP_USDC default 50
 *   FIRSTBUY_ENABLED           default true: the desk hires new outside listings once (ADR-31), paid gas-free, graded and reviewed
 *   FIRSTBUY_MAX_USDC_LIVE/TEST  highest listing price bought (default 1 / 0.1); FIRSTBUY_DAILY_USDC_LIVE/TEST programme cap per day (default 5 / 1); FIRSTBUY_PER_SELLER default 2
 *   FIRSTBUY_SCREEN            default true: the judge screens each listing first (ADR-35: only work a buyer could not do alone, each function once); false buys unscreened
 *   CDP_API_KEY_ID/SECRET      optional (ADR-65): a Coinbase Developer Platform API key; with it the live x402 services are also registered in Coinbase's
 *                              x402 catalogue (the "Bazaar") once a day, next to PayAI's, which needs no key. Registration signs with the operator wallet and settles nothing.
 */
import { serve } from '@hono/node-server'
import { randomBytes } from 'node:crypto'
import { AgentSouk } from 'agentsouk'
import { Llm, llmSpendKey, type DailySpend } from './llm.js'
import { CATALOG } from './operator/catalog.js'
import { Judge } from './operator/judge.js'
import { DEFAULT_FIRSTBUY, FirstBuyer } from './operator/firstbuy.js'
import { DEFAULT_CONFIG, OperatorRuntime } from './operator/runtime.js'
import { CHAINS, typedDataSigner, UsdcWallet } from './operator/usdc.js'
import { CatalogRegistrar, cdpFacilitator, platformMemoryStore, type Facilitator } from './operator/bazaar.js'
import { SellerRuntime, type Env } from './runner.js'
import { createServer, KEEPALIVE_MAX_MS, type Operators, type Runtimes } from './server.js'
import { allServices } from './services/index.js'

const log = (msg: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), msg, ...extra }))

const baseUrl = process.env.AGENTSOUK_BASE_URL ?? 'https://api.agentsouk.dev'
const secret = process.env.WEBHOOK_SECRET ?? ''
const publicUrl = process.env.PUBLIC_URL?.replace(/\/$/, '')
const port = Number(process.env.PORT ?? 8788)
const pollMs = Math.max(10_000, Number(process.env.POLL_INTERVAL_MS ?? 60_000))
if (secret.length < 16) {
  console.error('WEBHOOK_SECRET must be at least 16 characters')
  process.exit(1)
}
const VERSION = '0.2.17'
const clientFor = (key: string) => new AgentSouk({ apiKey: key, baseUrl, userAgent: `agentsouk-agents/${VERSION}` })

// One model budget per environment (ADR-66), each counted in the seller identity's platform memory under its own key
// (memory is shared between live and test, so the environment is in the key).
// The machine stops when idle, and a counter held only in the process started at 0 on every wake-up (15.09.: four
// starts in 27 minutes), which made LLM_DAILY_BUDGET_USD a cap per wake-up. Separate, because sandbox jobs cost
// nothing to order: with one shared day counter, free sandbox traffic could close the paid live services until midnight.
const llms = {} as Record<Env, Llm>
for (const env of ['live', 'test'] as Env[]) {
  const key = process.env[`AGENTSOUK_API_KEY_${env.toUpperCase()}`]
  llms[env] = new Llm({
    apiKey: process.env.ANTHROPIC_API_KEY,
    dailyBudgetUsd: Number((env === 'live' ? process.env.LLM_DAILY_BUDGET_USD : process.env.LLM_DAILY_BUDGET_USD_TEST) ?? (env === 'live' ? 5 : 1)),
    store: key ? platformMemoryStore<DailySpend>(clientFor(key).memory, llmSpendKey(env)) : undefined,
    log: (msg, extra) => log(msg, { env, ...extra }),
  })
}

const runtimes: Runtimes = {}
for (const env of ['live', 'test'] as Env[]) {
  const key = process.env[`AGENTSOUK_API_KEY_${env.toUpperCase()}`]
  if (!key) continue
  runtimes[env] = new SellerRuntime(clientFor(key), allServices(llms[env]), env, log)
}

const usdc = (v: string | undefined, dflt: bigint) => (v && Number.isFinite(Number(v)) ? BigInt(Math.round(Number(v) * 1e6)) : dflt)
const operators: Partial<Record<Env, OperatorRuntime>> = {}
const operatorKey = process.env.OPERATOR_PRIVATE_KEY
const operatorConfig = { ...DEFAULT_CONFIG, totalBudget: usdc(process.env.OPERATOR_TOTAL_BUDGET_USDC, DEFAULT_CONFIG.totalBudget), dailyCap: usdc(process.env.OPERATOR_DAILY_CAP_USDC, DEFAULT_CONFIG.dailyCap) }
for (const env of ['live', 'test'] as Env[]) {
  const key = process.env[`OPERATOR_API_KEY_${env.toUpperCase()}`]
  if (!key) continue
  const wallet = operatorKey && llms[env].enabled ? new UsdcWallet(operatorKey, CHAINS[env], { maxPerTransfer: usdc(process.env.OPERATOR_MAX_TRANSFER_USDC, 15_000_000n), log }) : null
  const judge = new Judge(llms[env])
  const op = new OperatorRuntime(clientFor(key), wallet, judge, CATALOG, env, log, operatorConfig)
  if (wallet && operatorKey && process.env.FIRSTBUY_ENABLED !== 'false') {
    const E = env.toUpperCase()
    const perSeller = Number.parseInt(process.env.FIRSTBUY_PER_SELLER ?? '', 10)
    const cfg = { ...DEFAULT_FIRSTBUY[env], maxPrice: usdc(process.env[`FIRSTBUY_MAX_USDC_${E}`], DEFAULT_FIRSTBUY[env].maxPrice), dailyCap: usdc(process.env[`FIRSTBUY_DAILY_USDC_${E}`], DEFAULT_FIRSTBUY[env].dailyCap), perSeller: Number.isInteger(perSeller) && perSeller >= 0 ? perSeller : DEFAULT_FIRSTBUY[env].perSeller, screen: process.env.FIRSTBUY_SCREEN !== 'false' }
    if (cfg.maxPrice <= 0n || cfg.dailyCap <= 0n) cfg.enabled = false
    op.firstBuyer = new FirstBuyer(op.client, wallet, typedDataSigner(operatorKey, CHAINS[env]), judge, env, log, cfg, () => op.me, { canSpend: (a) => op.canSpend(a), recordSpend: (e) => op.recordSpend(e) })
  }
  // ADR-65: the live services go into the public x402 catalogues through the facilitators' /verify - PayAI without a
  // key, Coinbase with one. The sandbox facilitator (x402.org) keeps no catalogue, and a sandbox entry would only
  // advertise testnet prices, so the sandbox registers nowhere.
  if (operatorKey && env === 'live') {
    const facilitators: Facilitator[] = CHAINS.live.facilitator ? [{ name: 'payai', url: CHAINS.live.facilitator }] : []
    if (process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET) facilitators.push(cdpFacilitator(process.env.CDP_API_KEY_ID, process.env.CDP_API_KEY_SECRET))
    // the schedule lives in platform memory (the machine sleeps and every webhook starts a fresh process), and every
    // request names us, so the discovery statistic does not count our own reads of the 402s as outside reach
    op.registrar = new CatalogRegistrar({ baseUrl, env, chain: CHAINS.live, privateKey: operatorKey, facilitators, log, store: platformMemoryStore(op.client.memory, `operator/${env}/catalogues`), userAgent: `agentsouk-agents/${VERSION} catalogue-registrar` })
  }
  operators[env] = op
}

// Sandbox faucet (ADR-30): the operator wallet on Base Sepolia gives sandbox agents testnet USDC so they can practise paying without a human.
let faucet: import('./server.js').Faucet | undefined
const faucetSecret = process.env.FAUCET_SECRET
if (faucetSecret && faucetSecret.length >= 16 && operatorKey) {
  const maxPer = usdc(process.env.FAUCET_MAX_USDC, 1_000_000n)
  const dailyCap = usdc(process.env.FAUCET_DAILY_CAP_USDC, 50_000_000n)
  const wallet = new UsdcWallet(operatorKey, CHAINS.test, { maxPerTransfer: maxPer, log })
  let day = ''
  let sentToday = 0n
  const roll = () => {
    const d = new Date().toISOString().slice(0, 10)
    if (d !== day) {
      day = d
      sentToday = 0n
    }
  }
  faucet = {
    secret: faucetSecret,
    send: async (to, amount) => {
      roll()
      if (amount > maxPer) throw new Error(`amount exceeds the faucet cap of ${maxPer} minor units`)
      if (sentToday + amount > dailyCap) throw new Error('faucet daily cap reached; try again after 00:00 UTC')
      const r = await wallet.transferGasless(to, amount)
      sentToday += amount
      return { hash: r.hash, explorer: r.explorer }
    },
    status: () => {
      roll()
      return { enabled: true, wallet: wallet.address, network: 'eip155:84532', max_per_request: maxPer.toString(), daily_cap: dailyCap.toString(), sent_today: sentToday.toString(), facilitator: CHAINS.test.facilitator }
    },
  }
}

if (!Object.keys(runtimes).length && !Object.keys(operators).length) {
  console.error('Set AGENTSOUK_API_KEY_LIVE/TEST (seller) and/or OPERATOR_API_KEY_LIVE/TEST (bounty desk)')
  process.exit(1)
}

// Read before the first job; a read that fails here is retried by every budget check, which declines until it succeeds.
await Promise.all(Object.values(llms).map((l) => l.restore()))

// Identities and hooks first, then the listener, and only then the work that may take minutes (ADR-67 audit): the
// startup catch-up now resumes the long job that outlived the last process, and while it ran nothing listened - the
// webhook that woke the machine failed and the keep-alive below had nothing to call.
const ready: SellerRuntime[] = []
for (const [env, rt] of Object.entries(runtimes) as [Env, SellerRuntime][]) {
  try {
    await rt.init()
    log('runtime ready', { env, agent: rt.me?.handle, listings: rt.listingIds() })
    if (publicUrl) await rt.ensureWebhook(`${publicUrl}/webhooks/agentsouk/${env}`, secret)
    ready.push(rt)
  } catch (e) {
    log('runtime init failed', { env, error: String(e) })
  }
}

const readyOps: OperatorRuntime[] = []
for (const [env, op] of Object.entries(operators) as [Env, OperatorRuntime][]) {
  try {
    await op.init()
    log('operator ready', { env, agent: op.me?.handle, payments_enabled: op.paymentsEnabled, wallet: op.wallet?.address ?? null })
    if (publicUrl) await op.ensureWakeups(publicUrl, secret)
    readyOps.push(op)
  } catch (e) {
    log('operator init failed', { env, error: String(e) })
  }
}

setInterval(() => {
  for (const [env, rt] of Object.entries(runtimes) as [Env, SellerRuntime][]) rt.catchUp().then((n) => n && log('poll processed jobs', { env, jobs: n })).catch((e: unknown) => log('poll failed', { env, error: String(e) }))
}, pollMs).unref()
setInterval(() => {
  for (const [env, op] of Object.entries(operators) as [Env, OperatorRuntime][]) {
    // ADR-61: a hook the platform disabled while this process was running is replaced on the next timer tick, not
    // only at the next start - and a host that is stopped has no timer, which is what the operator alert is for.
    const wake = publicUrl ? op.ensureWakeups(publicUrl, secret).catch((e: unknown) => log('operator wake-up check failed', { env, error: String(e) })) : Promise.resolve()
    wake.then(() => op.tick()).catch((e: unknown) => log('operator tick failed', { env, error: String(e) }))
  }
}, Math.max(pollMs * 10, 600_000)).unref()

// ADR-67: while a job runs, the process keeps requests to itself open through the host's proxy (fly.toml stops the
// machine when it sees no traffic for a few minutes, and a long translation can run longer than that). The webhook
// that brought the job was answered at once, so without this the machine looks idle while it works. Two holds
// overlap (a new one every KEEPALIVE_OVERLAP_MS, each up to KEEPALIVE_MAX_MS), so the count in flight never drops to 0
// between them; a hold that gets no answer is cut after KEEPALIVE_MAX_MS + 10 s so one stuck request cannot silence
// the loop for undici's five-minute default.
const working = () => Object.values(runtimes).reduce((n, rt) => n + rt.working, 0)
const keepaliveToken = randomBytes(24).toString('hex')
const KEEPALIVE_OVERLAP_MS = 15_000
if (publicUrl) {
  let holds = 0
  let lastStart = 0
  setInterval(() => {
    if (working() === 0 || holds >= 2 || Date.now() - lastStart < KEEPALIVE_OVERLAP_MS) return
    holds++
    lastStart = Date.now()
    fetch(`${publicUrl}/keepalive?ms=${KEEPALIVE_MAX_MS}`, { headers: { 'user-agent': `agentsouk-agents/${VERSION} keepalive`, 'x-keepalive': keepaliveToken }, signal: AbortSignal.timeout(KEEPALIVE_MAX_MS + 10_000) })
      .then((res) => res.arrayBuffer())
      .catch((e: unknown) => log('keepalive failed', { error: String(e) }))
      .finally(() => {
        holds--
      })
  }, 1_000).unref()
}

// the top level stays the live budget, as /health has always shown it; the sandbox budget sits beside it
const llmStatus = () => ({ ...llms.live.status(), test: llms.test.status() })
const server = createServer(runtimes, secret, log, { version: VERSION, llm: llmStatus, operators: operators as Operators, faucet, working, keepaliveToken })
serve({ fetch: server.fetch, port, hostname: '0.0.0.0' }, (info) => {
  log('agentsouk-agents listening', { port: info.port, base_url: baseUrl, public_url: publicUrl ?? null, envs: Object.keys(runtimes), operator_envs: Object.keys(operators), llm: llmStatus() })
  // the startup catch-up and the desk's first tick run behind the listener, not before it
  for (const rt of ready) rt.catchUp().then((n) => n && log('catch-up processed jobs', { env: rt.env, jobs: n })).catch((e: unknown) => log('catch-up failed', { env: rt.env, error: String(e) }))
  for (const op of readyOps) op.tick().catch((e: unknown) => log('operator tick failed', { env: op.env, error: String(e) }))
})
