import { and, desc, eq, inArray, lt, or } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { accounts, agents, deposits, ledgerEntries, transactions, withdrawals, type Env, type Rail } from '../../db/schema.js'
import { Ledger, CURRENCY_DECIMALS, formatAmount, type AccountRef } from '../../ledger/ledger.js'
import { errors } from '../../lib/errors.js'
import { newId } from '../../lib/ids.js'
import { config } from '../../config.js'

/**
 * Wallet = the agent-facing view over the ledger plus external rails (ADR-10).
 *
 * Money model:
 *  - CRD is the platform credit (1000 CRD = 1 USD). All prices, escrow and fees are in CRD.
 *  - `available` is spendable; `escrow` accounts belong to jobs, not agents.
 *  - test env: credits are free and worthless; deposits are instant "top-ups"; withdrawals are instant no-ops.
 *  - live env: deposits/withdrawals go through rails. Until the custody question (ADR-10) is settled,
 *    live rails other than `sandbox` return pending instructions and are settled by rail adapters.
 */

export const CREDIT_CURRENCY = 'CRD'
export const CRD_PER_USD = 1000

export type RailInfo = {
  rail: Rail
  name: string
  envs: Env[]
  status: 'available' | 'coming_soon'
  /** what agents pay with / receive in */
  assets: string[]
  deposit: boolean
  withdraw: boolean
  min_amount: number
  fee: string
  settlement: string
  how: string
}

export function railCatalog(): RailInfo[] {
  return [
    {
      rail: 'sandbox',
      name: 'Sandbox top-up',
      envs: ['test'],
      status: 'available',
      assets: ['CRD'],
      deposit: true,
      withdraw: true,
      min_amount: 1,
      fee: '0',
      settlement: 'instant',
      how: 'POST /v1/wallet/deposits {"rail":"sandbox","amount":<CRD>} with a test key. Free, capped per day. Worthless outside the sandbox.',
    },
    {
      rail: 'x402',
      name: 'x402 (USDC on Base)',
      envs: ['live'],
      status: 'coming_soon',
      assets: ['USDC'],
      deposit: true,
      withdraw: true,
      min_amount: 1000,
      fee: 'network gas only',
      settlement: '~seconds after on-chain confirmation',
      how: 'POST /v1/wallet/deposits {"rail":"x402","amount":<CRD>} returns x402 PaymentRequirements; pay them and we credit your wallet. 1000 CRD = 1 USDC.',
    },
    {
      rail: 'stripe',
      name: 'Card / bank (Stripe)',
      envs: ['live'],
      status: 'coming_soon',
      assets: ['USD', 'EUR'],
      deposit: true,
      withdraw: false,
      min_amount: 5000,
      fee: 'Stripe fees passed through',
      settlement: 'minutes',
      how: 'For agents whose operator has a card. Returns a hosted payment link.',
    },
    {
      rail: 'lightning',
      name: 'Bitcoin Lightning (L402)',
      envs: ['live'],
      status: 'coming_soon',
      assets: ['SAT'],
      deposit: true,
      withdraw: true,
      min_amount: 100,
      fee: 'routing fees',
      settlement: 'instant',
      how: 'Returns a BOLT11 invoice.',
    },
  ]
}

const SANDBOX_DAILY_CAP = 1_000_000 // CRD per agent per day in test env

const ledger = () => new Ledger(db())

export function agentAccount(agentId: string, kind: 'available' | 'promo' = 'available', currency = CREDIT_CURRENCY): AccountRef {
  return { ownerType: 'agent', ownerId: agentId, currency, kind }
}
export const platformAccount = (kind: 'fees' | 'faucet' | 'suspense', currency = CREDIT_CURRENCY): AccountRef => ({ ownerType: 'platform', ownerId: 'platform', currency, kind })
export const railAccount = (rail: Rail, currency = CREDIT_CURRENCY): AccountRef => ({ ownerType: 'rail', ownerId: rail, currency, kind: 'rail_reserve' })
export const escrowAccount = (jobId: string, currency = CREDIT_CURRENCY): AccountRef => ({ ownerType: 'escrow', ownerId: jobId, currency, kind: 'escrow' })

export type Balances = { currency: string; available: number; promo: number; in_escrow: number; total: number; formatted: { available: string; in_escrow: string } }[]

export async function getBalances(env: Env, agentId: string): Promise<Balances> {
  const rows = await db().query.accounts.findMany({ where: and(eq(accounts.env, env), eq(accounts.ownerType, 'agent'), eq(accounts.ownerId, agentId)) })
  const byCurrency = new Map<string, { available: number; promo: number }>()
  for (const r of rows) {
    const cur = byCurrency.get(r.currency) ?? { available: 0, promo: 0 }
    if (r.kind === 'available') cur.available += r.balance
    if (r.kind === 'promo') cur.promo += r.balance
    byCurrency.set(r.currency, cur)
  }
  if (!byCurrency.has(CREDIT_CURRENCY)) byCurrency.set(CREDIT_CURRENCY, { available: 0, promo: 0 })
  const inEscrow = await escrowLockedByAgent(env, agentId)
  return [...byCurrency.entries()].map(([currency, b]) => ({
    currency,
    available: b.available,
    promo: b.promo,
    in_escrow: inEscrow.get(currency) ?? 0,
    total: b.available + b.promo + (inEscrow.get(currency) ?? 0),
    formatted: { available: formatAmount(b.available, currency), in_escrow: formatAmount(inEscrow.get(currency) ?? 0, currency) },
  }))
}

/** Sum of escrow locks this agent funded that are still held (lock minus release/refund per job). Computed from ledger. */
async function escrowLockedByAgent(env: Env, agentId: string): Promise<Map<string, number>> {
  const locks = await db().query.transactions.findMany({
    where: and(eq(transactions.env, env), eq(transactions.initiatorAgentId, agentId), eq(transactions.type, 'escrow_lock'), eq(transactions.status, 'posted')),
  })
  const out = new Map<string, number>()
  if (!locks.length) return out
  const jobIds = [...new Set(locks.map((l) => l.referenceId).filter((x): x is string => !!x))]
  if (!jobIds.length) return out
  const escrowAccounts = await db().query.accounts.findMany({ where: and(eq(accounts.env, env), eq(accounts.ownerType, 'escrow'), inArray(accounts.ownerId, jobIds)) })
  for (const a of escrowAccounts) out.set(a.currency, (out.get(a.currency) ?? 0) + a.balance)
  return out
}

export type TransferInput = { env: Env; from: string; to: string; amount: number; currency?: string; memo?: string; idempotencyKey?: string }

export async function transfer(input: TransferInput) {
  const currency = input.currency ?? CREDIT_CURRENCY
  if (!(currency in CURRENCY_DECIMALS)) throw errors.validation(`Unknown currency '${currency}'.`, 'currency', `Use one of: ${Object.keys(CURRENCY_DECIMALS).join(', ')}.`)
  const to = await db().query.agents.findFirst({ where: or(eq(agents.id, input.to), eq(agents.handle, input.to.toLowerCase())) })
  if (!to || to.status !== 'active') throw errors.notFound('Recipient agent', input.to, 'Pass the recipient agent id (agt_...) or handle. Search with GET /v1/agents?q=.')
  if (to.id === input.from) throw errors.validation('You cannot transfer to yourself.', 'to')
  return ledger().post({
    env: input.env,
    type: 'transfer',
    currency,
    amount: input.amount,
    legs: [
      { account: agentAccount(input.from, 'available', currency), delta: -input.amount },
      { account: agentAccount(to.id, 'available', currency), delta: +input.amount },
    ],
    initiatorAgentId: input.from,
    idempotencyKey: input.idempotencyKey ?? null,
    referenceType: 'agent',
    referenceId: to.id,
    memo: input.memo,
  })
}

export type TxView = {
  object: 'transaction'
  id: string
  type: string
  currency: string
  amount: number
  /** signed effect on the calling agent's available balance */
  delta: number
  balance_after: number | null
  status: string
  reference_type: string | null
  reference_id: string | null
  memo: string | null
  created_at: string
}

export async function listTransactions(env: Env, agentId: string, limit: number, cursor?: string): Promise<TxView[]> {
  const myAccounts = await db().query.accounts.findMany({ where: and(eq(accounts.env, env), eq(accounts.ownerType, 'agent'), eq(accounts.ownerId, agentId)) })
  const ids = myAccounts.map((a) => a.id)
  if (!ids.length) return []
  const conds = [inArray(ledgerEntries.accountId, ids)]
  if (cursor) conds.push(lt(ledgerEntries.id, cursor))
  const entries = await db().query.ledgerEntries.findMany({ where: and(...conds), orderBy: [desc(ledgerEntries.id)], limit: limit + 1 })
  if (!entries.length) return []
  const txns = await db().query.transactions.findMany({ where: inArray(transactions.id, [...new Set(entries.map((e) => e.transactionId))]) })
  const byId = new Map(txns.map((t) => [t.id, t]))
  return entries.map((e) => {
    const t = byId.get(e.transactionId)!
    return {
      object: 'transaction' as const,
      id: e.id,
      type: t.type,
      currency: t.currency,
      amount: t.amount,
      delta: e.delta,
      balance_after: e.balanceAfter,
      status: t.status,
      reference_type: t.referenceType,
      reference_id: t.referenceId,
      memo: t.memo,
      created_at: new Date(e.createdAt).toISOString(),
    }
  })
}

// --- deposits ---------------------------------------------------------------------------------

export type Deposit = typeof deposits.$inferSelect

export async function createDeposit(env: Env, agentId: string, rail: Rail, amount: number, idempotencyKey?: string): Promise<Deposit> {
  const info = railCatalog().find((r) => r.rail === rail)
  if (!info || !info.deposit) throw errors.validation(`Rail '${rail}' does not support deposits.`, 'rail', 'GET /v1/wallet/rails lists rails and what they support.')
  if (!info.envs.includes(env)) {
    throw errors.validation(`Rail '${rail}' is not available in the ${env} environment.`, 'rail', env === 'live' ? 'Use rail "x402" or "stripe" with a live key.' : 'Use rail "sandbox" with a test key.')
  }
  if (amount < info.min_amount) throw errors.validation(`Minimum deposit on '${rail}' is ${info.min_amount} CRD.`, 'amount')
  const now = Date.now()

  if (rail === 'sandbox') {
    const since = now - 86_400_000
    const recent = await db().query.deposits.findMany({ where: and(eq(deposits.env, 'test'), eq(deposits.agentId, agentId), eq(deposits.rail, 'sandbox'), eq(deposits.status, 'confirmed')) })
    const today = recent.filter((d) => d.createdAt >= since).reduce((s, d) => s + d.amount, 0)
    if (today + amount > SANDBOX_DAILY_CAP) {
      throw errors.state('sandbox_cap_reached', `Sandbox top-ups are capped at ${SANDBOX_DAILY_CAP} CRD per 24h; you have used ${today}.`, 'Earn test credits by completing sandbox jobs, or wait.')
    }
    const id = newId('deposit')
    const txn = await ledger().post({
      env: 'test',
      type: 'deposit',
      currency: CREDIT_CURRENCY,
      amount,
      legs: [
        { account: railAccount('sandbox'), delta: -amount },
        { account: agentAccount(agentId), delta: +amount },
      ],
      initiatorAgentId: agentId,
      idempotencyKey: idempotencyKey ? `deposit:${idempotencyKey}` : null,
      referenceType: 'deposit',
      referenceId: id,
      memo: 'sandbox top-up',
    })
    const row: typeof deposits.$inferInsert = {
      id,
      env: 'test',
      agentId,
      rail: 'sandbox',
      currency: CREDIT_CURRENCY,
      amount,
      externalRequest: null,
      externalRef: null,
      status: 'confirmed',
      transactionId: txn.id,
      expiresAt: null,
      createdAt: now,
      updatedAt: now,
    }
    await db().insert(deposits).values(row)
    return row as Deposit
  }

  if (info.status === 'coming_soon') {
    throw errors.notImplemented(`Deposits via '${rail}'`)
  }
  throw errors.notImplemented(`Deposits via '${rail}'`)
}

export async function getDeposit(agentId: string, id: string): Promise<Deposit> {
  const d = await db().query.deposits.findFirst({ where: and(eq(deposits.id, id), eq(deposits.agentId, agentId)) })
  if (!d) throw errors.notFound('Deposit', id)
  return d
}

export async function listDeposits(env: Env, agentId: string, limit: number, cursor?: string): Promise<Deposit[]> {
  const conds = [eq(deposits.env, env), eq(deposits.agentId, agentId)]
  if (cursor) conds.push(lt(deposits.id, cursor))
  return db().query.deposits.findMany({ where: and(...conds), orderBy: [desc(deposits.id)], limit: limit + 1 })
}

// --- withdrawals ------------------------------------------------------------------------------

export type Withdrawal = typeof withdrawals.$inferSelect

export async function createWithdrawal(env: Env, agentId: string, rail: Rail, amount: number, destination: Record<string, unknown>, idempotencyKey?: string): Promise<Withdrawal> {
  const info = railCatalog().find((r) => r.rail === rail)
  if (!info || !info.withdraw) throw errors.validation(`Rail '${rail}' does not support withdrawals.`, 'rail', 'GET /v1/wallet/rails lists rails and what they support.')
  if (!info.envs.includes(env)) throw errors.validation(`Rail '${rail}' is not available in the ${env} environment.`, 'rail')
  if (amount < info.min_amount) throw errors.validation(`Minimum withdrawal on '${rail}' is ${info.min_amount} CRD.`, 'amount')
  if (info.status === 'coming_soon') throw errors.notImplemented(`Withdrawals via '${rail}'`)

  const now = Date.now()
  const id = newId('withdrawal')
  const txn = await ledger().post({
    env,
    type: 'withdrawal',
    currency: CREDIT_CURRENCY,
    amount,
    legs: [
      { account: agentAccount(agentId), delta: -amount },
      { account: railAccount(rail), delta: +amount },
    ],
    initiatorAgentId: agentId,
    idempotencyKey: idempotencyKey ? `withdrawal:${idempotencyKey}` : null,
    referenceType: 'withdrawal',
    referenceId: id,
    memo: `withdrawal via ${rail}`,
  })
  const row: typeof withdrawals.$inferInsert = {
    id,
    env,
    agentId,
    rail,
    currency: CREDIT_CURRENCY,
    amount,
    destination,
    externalRef: null,
    status: rail === 'sandbox' ? 'completed' : 'pending',
    transactionId: txn.id,
    failureReason: null,
    createdAt: now,
    updatedAt: now,
  }
  await db().insert(withdrawals).values(row)
  return row as Withdrawal
}

export async function listWithdrawals(env: Env, agentId: string, limit: number, cursor?: string): Promise<Withdrawal[]> {
  const conds = [eq(withdrawals.env, env), eq(withdrawals.agentId, agentId)]
  if (cursor) conds.push(lt(withdrawals.id, cursor))
  return db().query.withdrawals.findMany({ where: and(...conds), orderBy: [desc(withdrawals.id)], limit: limit + 1 })
}

export function faucetGrantForNewAgent(): number {
  return config().FAUCET_CREDITS * 100
}
