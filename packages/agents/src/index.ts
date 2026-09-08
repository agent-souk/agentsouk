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
 *   LLM_DAILY_BUDGET_USD       default 5; LLM jobs are declined once the day's model spend would exceed it
 *   OPERATOR_API_KEY_LIVE/TEST keys of the bounty desk identity (souk-bounties); optional
 *   OPERATOR_PRIVATE_KEY       0x... key of the wallet bound to that identity; without it the desk posts nothing
 *   OPERATOR_TOTAL_BUDGET_USDC default 50 (lifetime), OPERATOR_DAILY_CAP_USDC default 20, OPERATOR_MAX_TRANSFER_USDC default 15
 *   FAUCET_SECRET              enables POST /faucet for the platform API (sandbox faucet, ADR-30): testnet USDC from the operator wallet, gas-free via the x402 facilitator
 *   FAUCET_MAX_USDC            per request, default 1; FAUCET_DAILY_CAP_USDC default 50
 *   FIRSTBUY_ENABLED           default true: the desk hires every new outside listing once (ADR-31), paid gas-free, graded and reviewed
 *   FIRSTBUY_MAX_USDC_LIVE/TEST  highest listing price bought (default 1 / 0.1); FIRSTBUY_DAILY_USDC_LIVE/TEST programme cap per day (default 5 / 1); FIRSTBUY_PER_SELLER default 2
 */
import { serve } from '@hono/node-server'
import { AgentSouk } from 'agentsouk'
import { Llm } from './llm.js'
import { CATALOG } from './operator/catalog.js'
import { Judge } from './operator/judge.js'
import { DEFAULT_FIRSTBUY, FirstBuyer } from './operator/firstbuy.js'
import { DEFAULT_CONFIG, OperatorRuntime } from './operator/runtime.js'
import { CHAINS, typedDataSigner, UsdcWallet } from './operator/usdc.js'
import { SellerRuntime, type Env } from './runner.js'
import { createServer, type Operators, type Runtimes } from './server.js'
import { allServices } from './services/index.js'

const log = (msg: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), msg, ...extra }))

const baseUrl = process.env.AGENTSOUK_BASE_URL ?? 'https://api.agentsouk.dev'
const secret = process.env.WEBHOOK_SECRET ?? ''
const publicUrl = process.env.PUBLIC_URL?.replace(/\/$/, '')
const port = Number(process.env.PORT ?? 8788)
const pollMs = Math.max(10_000, Number(process.env.POLL_INTERVAL_MS ?? 60_000))
const llm = new Llm({ apiKey: process.env.ANTHROPIC_API_KEY, dailyBudgetUsd: Number(process.env.LLM_DAILY_BUDGET_USD ?? 5) })
if (secret.length < 16) {
  console.error('WEBHOOK_SECRET must be at least 16 characters')
  process.exit(1)
}
const clientFor = (key: string) => new AgentSouk({ apiKey: key, baseUrl, userAgent: 'agentsouk-agents/0.2.0' })

const runtimes: Runtimes = {}
for (const env of ['live', 'test'] as Env[]) {
  const key = process.env[`AGENTSOUK_API_KEY_${env.toUpperCase()}`]
  if (!key) continue
  runtimes[env] = new SellerRuntime(clientFor(key), allServices(llm), env, log)
}

const usdc = (v: string | undefined, dflt: bigint) => (v && Number.isFinite(Number(v)) ? BigInt(Math.round(Number(v) * 1e6)) : dflt)
const operators: Partial<Record<Env, OperatorRuntime>> = {}
const operatorKey = process.env.OPERATOR_PRIVATE_KEY
const operatorConfig = { ...DEFAULT_CONFIG, totalBudget: usdc(process.env.OPERATOR_TOTAL_BUDGET_USDC, DEFAULT_CONFIG.totalBudget), dailyCap: usdc(process.env.OPERATOR_DAILY_CAP_USDC, DEFAULT_CONFIG.dailyCap) }
for (const env of ['live', 'test'] as Env[]) {
  const key = process.env[`OPERATOR_API_KEY_${env.toUpperCase()}`]
  if (!key) continue
  const wallet = operatorKey && llm.enabled ? new UsdcWallet(operatorKey, CHAINS[env], { maxPerTransfer: usdc(process.env.OPERATOR_MAX_TRANSFER_USDC, 15_000_000n), log }) : null
  const judge = new Judge(llm)
  const op = new OperatorRuntime(clientFor(key), wallet, judge, CATALOG, env, log, operatorConfig)
  if (wallet && operatorKey && process.env.FIRSTBUY_ENABLED !== 'false') {
    const E = env.toUpperCase()
    const cfg = { ...DEFAULT_FIRSTBUY[env], maxPrice: usdc(process.env[`FIRSTBUY_MAX_USDC_${E}`], DEFAULT_FIRSTBUY[env].maxPrice), dailyCap: usdc(process.env[`FIRSTBUY_DAILY_USDC_${E}`], DEFAULT_FIRSTBUY[env].dailyCap), perSeller: Number(process.env.FIRSTBUY_PER_SELLER ?? DEFAULT_FIRSTBUY[env].perSeller) }
    op.firstBuyer = new FirstBuyer(op.client, wallet, typedDataSigner(operatorKey, CHAINS[env]), judge, env, log, cfg, () => op.me, { canSpend: (a) => op.canSpend(a) })
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

for (const [env, rt] of Object.entries(runtimes) as [Env, SellerRuntime][]) {
  try {
    await rt.init()
    log('runtime ready', { env, agent: rt.me?.handle, listings: rt.listingIds() })
    if (publicUrl) await rt.ensureWebhook(`${publicUrl}/webhooks/agentsouk/${env}`, secret)
    const n = await rt.catchUp()
    if (n) log('catch-up processed jobs', { env, jobs: n })
  } catch (e) {
    log('runtime init failed', { env, error: String(e) })
  }
}

for (const [env, op] of Object.entries(operators) as [Env, OperatorRuntime][]) {
  try {
    await op.init()
    log('operator ready', { env, agent: op.me?.handle, payments_enabled: op.paymentsEnabled, wallet: op.wallet?.address ?? null })
    if (publicUrl) await op.ensureWakeups(publicUrl, secret)
    await op.tick()
  } catch (e) {
    log('operator init failed', { env, error: String(e) })
  }
}

setInterval(() => {
  for (const [env, rt] of Object.entries(runtimes) as [Env, SellerRuntime][]) rt.catchUp().then((n) => n && log('poll processed jobs', { env, jobs: n })).catch((e: unknown) => log('poll failed', { env, error: String(e) }))
}, pollMs).unref()
setInterval(() => {
  for (const [env, op] of Object.entries(operators) as [Env, OperatorRuntime][]) op.tick().catch((e: unknown) => log('operator tick failed', { env, error: String(e) }))
}, Math.max(pollMs * 10, 600_000)).unref()

const server = createServer(runtimes, secret, log, { version: '0.2.0', llm: () => llm.status(), operators: operators as Operators, faucet })
serve({ fetch: server.fetch, port, hostname: '0.0.0.0' }, (info) => log('agentsouk-agents listening', { port: info.port, base_url: baseUrl, public_url: publicUrl ?? null, envs: Object.keys(runtimes), operator_envs: Object.keys(operators), llm: llm.status() }))
