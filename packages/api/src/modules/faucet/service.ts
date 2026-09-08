import { createHash } from 'node:crypto'
import { and, eq, gte, sql } from 'drizzle-orm'
import { config } from '../../config.js'
import { db } from '../../db/client.js'
import { faucetClaims, type Env } from '../../db/schema.js'
import { emit } from '../../events/bus.js'
import { ApiError, errors } from '../../lib/errors.js'
import { newId } from '../../lib/ids.js'
import type { Agent } from '../../middleware/auth.js'
import { assertWalletAddress } from '../agents/service.js'
import { chainFor, formatUsdc, networkFor } from '../payments/x402.js'

/**
 * Sandbox faucet (ADR-30): a sandbox agent with a bound wallet asks for testnet USDC once a day and the platform's
 * own desk sends it, gas-free through a public x402 facilitator, so any agent can practise the whole payment path
 * without a human clicking a captcha. The API keeps the ledger of claims and enforces the limits (per agent, per
 * source address, global per day); the desk (packages/agents, POST /faucet, shared secret) holds the key and the
 * money limits. Nothing here touches a private key.
 */

export const FAUCET_CLAIMS_PER_AGENT_PER_DAY = 1
export const FAUCET_CLAIMS_PER_IP_PER_DAY = 3

export type FaucetFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; json: () => Promise<unknown> }>
const realFetch: FaucetFetch = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(90_000) })
let testFetch: FaucetFetch | undefined
/** Test hook: route the call to the desk through a fake. */
export function _setFaucetFetchForTests(f?: FaucetFetch) {
  testFetch = f
}

const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10)
const nextUtcMidnight = (now: number) => new Date(`${dayOf(now)}T00:00:00.000Z`).getTime() + 86_400_000
const ipHash = (ip: string) => createHash('sha256').update(`${config().SECRET_PEPPER}:${ip}`).digest('hex').slice(0, 32)

export function faucetEnabled(): boolean {
  const c = config()
  return !!(c.FAUCET_URL && c.FAUCET_SECRET)
}

export type FaucetClaimView = {
  object: 'faucet_claim'
  amount: number
  display: string
  address: string
  network: string
  asset: string
  transaction: string
  explorer: string
  next_claim_at: string
  hint: string
}

export type FaucetStatusView = {
  object: 'faucet'
  enabled: boolean
  env: Env
  amount: number
  display: string
  network: string
  asset: string
  claims_per_day: number
  last_claim: { transaction: string; explorer: string; amount: number; at: string } | null
  next_claim_at: string | null
  how: string[]
  hint: string
}

function unavailable(reason: string): ApiError {
  return new ApiError('state_error', 'faucet_unavailable', 'The sandbox faucet is not available right now.', {
    status: 503,
    hint: `${reason} Testnet USDC is also free at ${chainFor('test').faucet} (Base Sepolia, a human solves the captcha) and any USDC on Base Sepolia works for the sandbox.`,
  })
}

async function claimsToday(where: ReturnType<typeof and>, now: number): Promise<number> {
  const rows = await db()
    .select({ n: sql<number>`count(*)` })
    .from(faucetClaims)
    .where(and(eq(faucetClaims.day, dayOf(now)), where))
  return rows[0]?.n ?? 0
}

/** Where a sandbox agent stands with the faucet: last claim, when it may claim again, how to use the USDC. */
export async function faucetStatus(env: Env, agent: Agent, now = Date.now()): Promise<FaucetStatusView> {
  const chain = chainFor('test')
  const c = config()
  const last = await db().query.faucetClaims.findFirst({ where: eq(faucetClaims.agentId, agent.id), orderBy: (t, { desc }) => [desc(t.createdAt)] })
  const claimedToday = last ? last.day === dayOf(now) : false
  return {
    object: 'faucet',
    enabled: faucetEnabled(),
    env,
    amount: c.FAUCET_AMOUNT_MINOR,
    display: formatUsdc(c.FAUCET_AMOUNT_MINOR),
    network: networkFor('test'),
    asset: chain.usdc,
    claims_per_day: FAUCET_CLAIMS_PER_AGENT_PER_DAY,
    last_claim: last ? { transaction: last.transaction, explorer: chain.explorerTx + last.transaction, amount: last.amount, at: new Date(last.createdAt).toISOString() } : null,
    next_claim_at: claimedToday ? new Date(nextUtcMidnight(now)).toISOString() : null,
    how: [
      'Bind the wallet you control: POST /v1/agents/me/wallet-address (test key).',
      'POST /v1/sandbox/faucet with your as_test_ key: the platform desk sends testnet USDC to that wallet, gas-free, and answers with the transaction hash.',
      'Hire a listing (POST /v1/jobs), then pay the sealed delivery gas-free: POST /v1/jobs/{id}/pay without a body, sign gasless.typed_data with that wallet, POST gasless.settle_body to gasless.settle_url (the facilitator pays the gas), then POST the returned transaction hash to /v1/jobs/{id}/pay. No ETH needed (see GET /v1/payments).',
    ],
    hint: env === 'test' ? 'One claim per agent per UTC day. Real money never comes from the faucet; live keys pay with real USDC on Base.' : 'Use your as_test_ key: the faucet only serves the sandbox (Base Sepolia).',
  }
}

/**
 * One claim: checks (sandbox key, bound wallet, limits), asks the desk to send, records the claim. A claim that
 * the desk refused is not recorded, so the agent may try again once the faucet is refilled.
 */
export async function claimFaucet(env: Env, agent: Agent, clientIp: string, now = Date.now()): Promise<FaucetClaimView> {
  if (env !== 'test') throw errors.state('faucet_test_only', 'The faucet gives testnet USDC to sandbox agents only.', 'Call it with your as_test_ key. Live jobs are paid with real USDC on Base from a wallet the operator funded.')
  const c = config()
  if (!faucetEnabled()) throw unavailable('The platform has no faucet configured.')
  const address = assertWalletAddress(agent, 'receive faucet USDC (it is sent to your bound wallet)')
  const mine = await claimsToday(eq(faucetClaims.agentId, agent.id), now)
  if (mine >= FAUCET_CLAIMS_PER_AGENT_PER_DAY) {
    const next = new Date(nextUtcMidnight(now)).toISOString()
    throw new ApiError('state_error', 'faucet_claimed_today', 'You already received faucet USDC today.', { hint: `One claim per agent per UTC day. Next claim at ${next}. GET /v1/sandbox/faucet shows your last transaction.`, details: { next_claim_at: next } })
  }
  const sameIp = await claimsToday(eq(faucetClaims.ipHash, ipHash(clientIp)), now)
  if (sameIp >= FAUCET_CLAIMS_PER_IP_PER_DAY) throw new ApiError('rate_limited', 'faucet_ip_limit', 'Too many faucet claims from this network address today.', { hint: `At most ${FAUCET_CLAIMS_PER_IP_PER_DAY} claims per source address per UTC day; try again after ${new Date(nextUtcMidnight(now)).toISOString()}.` })
  const total = await claimsToday(gte(faucetClaims.createdAt, 0), now)
  if (total >= c.FAUCET_DAILY_GLOBAL) throw new ApiError('state_error', 'faucet_busy', 'The faucet reached its daily total.', { status: 503, hint: `Try again after ${new Date(nextUtcMidnight(now)).toISOString()}, or get testnet USDC at ${chainFor('test').faucet}.` })

  const amount = c.FAUCET_AMOUNT_MINOR
  let res: Awaited<ReturnType<FaucetFetch>>
  try {
    res = await (testFetch ?? realFetch)(c.FAUCET_URL!, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'x-faucet-secret': c.FAUCET_SECRET! }, body: JSON.stringify({ to: address, amount }) })
  } catch {
    throw unavailable('The desk that sends faucet USDC did not answer; nothing was sent.')
  }
  const json = (await res.json().catch(() => undefined)) as { ok?: unknown; transaction?: unknown; explorer?: unknown; error?: unknown } | undefined
  if (res.status === 409) throw new ApiError('state_error', 'faucet_dry', 'The faucet cannot send right now (empty or at its cap).', { status: 503, hint: `Try again later, or get testnet USDC at ${chainFor('test').faucet}. Desk said: ${String(json?.error ?? '').slice(0, 200)}` })
  if (res.status >= 400 || !json || json.ok !== true || typeof json.transaction !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(json.transaction)) throw unavailable(`The desk answered HTTP ${res.status}${json?.error ? ` (${String(json.error).slice(0, 200)})` : ''}; nothing was recorded.`)
  const chain = chainFor('test')
  const transaction = json.transaction.toLowerCase()
  await db().insert(faucetClaims).values({ id: newId('faucetClaim'), agentId: agent.id, address, amount, transaction, day: dayOf(now), ipHash: ipHash(clientIp), createdAt: now })
  const next = new Date(nextUtcMidnight(now)).toISOString()
  await emit('test', agent.id, 'faucet.sent', { amount, address, transaction, explorer: chain.explorerTx + transaction, hint: 'Testnet USDC is on its way to your bound wallet; use it to pay a sandbox job (send to payment.pay_to, then POST /v1/jobs/{id}/pay with the hash).' })
  return {
    object: 'faucet_claim',
    amount,
    display: formatUsdc(amount),
    address,
    network: networkFor('test'),
    asset: chain.usdc,
    transaction,
    explorer: chain.explorerTx + transaction,
    next_claim_at: next,
    hint: `${formatUsdc(amount)} on Base Sepolia are being sent to ${address} (gas paid by the facilitator; a few seconds until mined). Practise the whole flow: hire a listing, then POST /v1/jobs/{id}/pay without a body and pay gas-free from this wallet (sign gasless.typed_data, POST it to the facilitator, submit the hash); no ETH needed. Next claim at ${next}.`,
  }
}
