import { and, eq, desc } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { accounts, ledgerEntries, transactions, type AccountKind, type Env, type TransactionType } from '../db/schema.js'
import { newId } from '../lib/ids.js'
import { ApiError, errors } from '../lib/errors.js'

/**
 * Double-entry ledger (ADR-6).
 *
 * Every money movement is a `transaction` with N `ledger_entries` whose deltas sum to zero.
 * Balances are materialised on `accounts` and updated inside the same DB transaction; entries store
 * balance_after so the full history is auditable and receipts can be signed.
 *
 * The ledger knows nothing about business rules (who may pay whom). Services above it do.
 */

export type AccountRef = {
  ownerType: 'agent' | 'platform' | 'escrow' | 'rail'
  ownerId: string
  currency: string
  kind: AccountKind
}

export type Leg = { account: AccountRef; delta: number }

export type PostInput = {
  env: Env
  type: TransactionType
  currency: string
  amount: number
  legs: Leg[]
  initiatorAgentId?: string | null
  idempotencyKey?: string | null
  referenceType?: string
  referenceId?: string
  memo?: string
  metadata?: Record<string, unknown>
  reversalOf?: string
}

export type PostedTransaction = typeof transactions.$inferSelect & { entries: (typeof ledgerEntries.$inferSelect)[] }

/** Accounts of these kinds/owners are funding or liability accounts and may go negative. */
function defaultAllowNegative(ref: AccountRef): boolean {
  if (ref.ownerType === 'platform' || ref.ownerType === 'rail') return true
  return false
}

export function formatAmount(minor: number, currency: string): string {
  const decimals = CURRENCY_DECIMALS[currency] ?? 0
  if (decimals === 0) return `${minor}`
  const neg = minor < 0
  const abs = Math.abs(minor)
  const whole = Math.floor(abs / 10 ** decimals)
  const frac = String(abs % 10 ** decimals).padStart(decimals, '0')
  return `${neg ? '-' : ''}${whole}.${frac}`
}

/**
 * Minor-unit decimals per currency. CRD (platform credits) is the internal unit of account:
 * 1000 CRD = 1 USD. Integer only; no decimals.
 */
export const CURRENCY_DECIMALS: Record<string, number> = {
  CRD: 0,
  USD: 2,
  EUR: 2,
  USDC: 6,
  SAT: 0,
}

/**
 * SQLite/libsql tolerates one writer at a time and interleaved statements inside overlapping
 * transactions wedge the connection (SQLITE_BUSY "SQL statements in progress"). All ledger writes
 * therefore run through a process-wide async mutex. Multi-instance deployments need Postgres (ADR-4).
 */
let writeChain: Promise<unknown> = Promise.resolve()
export function withLedgerLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn)
  writeChain = run.catch(() => undefined)
  return run
}

export class Ledger {
  constructor(private readonly db: Db) {}

  async getOrCreateAccount(env: Env, ref: AccountRef, allowNegative?: boolean): Promise<typeof accounts.$inferSelect> {
    const existing = await this.db.query.accounts.findFirst({
      where: and(
        eq(accounts.env, env),
        eq(accounts.ownerType, ref.ownerType),
        eq(accounts.ownerId, ref.ownerId),
        eq(accounts.currency, ref.currency),
        eq(accounts.kind, ref.kind),
      ),
    })
    if (existing) return existing
    const now = Date.now()
    const row: typeof accounts.$inferInsert = {
      id: newId('account'),
      env,
      ownerType: ref.ownerType,
      ownerId: ref.ownerId,
      currency: ref.currency,
      kind: ref.kind,
      balance: 0,
      allowNegative: allowNegative ?? defaultAllowNegative(ref),
      createdAt: now,
      updatedAt: now,
    }
    await this.db.insert(accounts).values(row).onConflictDoNothing()
    const created = await this.db.query.accounts.findFirst({ where: eq(accounts.id, row.id) })
    if (created) return created
    // lost a race: fetch the winner
    return (await this.getOrCreateAccount(env, ref, allowNegative))!
  }

  async balance(env: Env, ref: AccountRef): Promise<number> {
    const acc = await this.db.query.accounts.findFirst({
      where: and(
        eq(accounts.env, env),
        eq(accounts.ownerType, ref.ownerType),
        eq(accounts.ownerId, ref.ownerId),
        eq(accounts.currency, ref.currency),
        eq(accounts.kind, ref.kind),
      ),
    })
    return acc?.balance ?? 0
  }

  async findByIdempotency(env: Env, initiatorAgentId: string | null, key: string): Promise<PostedTransaction | undefined> {
    const txn = await this.db.query.transactions.findFirst({
      where: and(
        eq(transactions.env, env),
        initiatorAgentId === null ? eq(transactions.initiatorAgentId, '') : eq(transactions.initiatorAgentId, initiatorAgentId),
        eq(transactions.idempotencyKey, key),
      ),
    })
    if (!txn) return undefined
    return this.withEntries(txn)
  }

  async get(id: string): Promise<PostedTransaction | undefined> {
    const txn = await this.db.query.transactions.findFirst({ where: eq(transactions.id, id) })
    return txn ? this.withEntries(txn) : undefined
  }

  private async withEntries(txn: typeof transactions.$inferSelect): Promise<PostedTransaction> {
    const entries = await this.db.query.ledgerEntries.findMany({ where: eq(ledgerEntries.transactionId, txn.id) })
    return { ...txn, entries }
  }

  /**
   * Post a balanced transaction atomically. Throws `insufficient_funds` if any non-negative-allowed
   * account would go below zero. Idempotent on (env, initiator, idempotencyKey).
   */
  async post(input: PostInput): Promise<PostedTransaction> {
    if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
      throw errors.validation('amount must be a positive integer in minor units', 'amount')
    }
    const sum = input.legs.reduce((s, l) => s + l.delta, 0)
    if (sum !== 0) throw new ApiError('internal_error', 'unbalanced_transaction', `ledger legs sum to ${sum}, expected 0`)
    for (const l of input.legs) {
      if (!Number.isSafeInteger(l.delta) || l.delta === 0) throw new ApiError('internal_error', 'invalid_leg', 'each leg delta must be a non-zero safe integer')
      if (l.account.currency !== input.currency) throw new ApiError('internal_error', 'currency_mismatch', 'all legs must use the transaction currency')
    }

    const initiator = input.initiatorAgentId ?? ''
    return withLedgerLock(async () => {
      if (input.idempotencyKey) {
        const prior = await this.findByIdempotency(input.env, input.initiatorAgentId ?? null, input.idempotencyKey)
        if (prior) return prior
      }

      // Ensure accounts exist before entering the write transaction.
      const accountRows: (typeof accounts.$inferSelect)[] = []
      for (const leg of input.legs) accountRows.push(await this.getOrCreateAccount(input.env, leg.account))

      const now = Date.now()
      const txnId = newId('transaction')

      return await this.db.transaction(async (tx) => {
      const entries: (typeof ledgerEntries.$inferSelect)[] = []
      // Aggregate deltas per account (a transaction may touch the same account twice).
      const perAccount = new Map<string, { row: typeof accounts.$inferSelect; delta: number }>()
      input.legs.forEach((leg, i) => {
        const row = accountRows[i]!
        const cur = perAccount.get(row.id)
        if (cur) cur.delta += leg.delta
        else perAccount.set(row.id, { row, delta: leg.delta })
      })

      for (const { row, delta } of perAccount.values()) {
        const fresh = (await tx.select().from(accounts).where(eq(accounts.id, row.id)))[0]!
        const after = fresh.balance + delta
        if (after < 0 && !fresh.allowNegative) {
          throw errors.insufficientFunds(formatAmount(-delta, input.currency), formatAmount(fresh.balance, input.currency), input.currency)
        }
        await tx.update(accounts).set({ balance: after, updatedAt: now }).where(eq(accounts.id, row.id))
        entries.push({
          id: newId('ledgerEntry'),
          transactionId: txnId,
          accountId: row.id,
          delta,
          balanceAfter: after,
          createdAt: now,
        })
      }

      const txnRow: typeof transactions.$inferInsert = {
        id: txnId,
        env: input.env,
        type: input.type,
        currency: input.currency,
        amount: input.amount,
        status: 'posted',
        initiatorAgentId: initiator,
        idempotencyKey: input.idempotencyKey ?? null,
        referenceType: input.referenceType ?? null,
        referenceId: input.referenceId ?? null,
        memo: input.memo ?? null,
        metadata: input.metadata ?? null,
        reversalOf: input.reversalOf ?? null,
        createdAt: now,
      }
      await tx.insert(transactions).values(txnRow)
      await tx.insert(ledgerEntries).values(entries)
      return { ...(txnRow as typeof transactions.$inferSelect), entries }
      })
    })
  }

  /** Reverse a posted transaction by posting the mirror-image legs. */
  async reverse(id: string, opts: { initiatorAgentId?: string | null; idempotencyKey?: string | null; memo?: string } = {}): Promise<PostedTransaction> {
    const original = await this.get(id)
    if (!original) throw errors.notFound('Transaction', id)
    if (original.status === 'reversed') throw errors.state('already_reversed', `Transaction ${id} was already reversed.`)
    const accountsById = new Map<string, typeof accounts.$inferSelect>()
    for (const e of original.entries) {
      const acc = await this.db.query.accounts.findFirst({ where: eq(accounts.id, e.accountId) })
      if (acc) accountsById.set(acc.id, acc)
    }
    const legs: Leg[] = original.entries.map((e) => {
      const a = accountsById.get(e.accountId)!
      return { account: { ownerType: a.ownerType, ownerId: a.ownerId, currency: a.currency, kind: a.kind }, delta: -e.delta }
    })
    const reversal = await this.post({
      env: original.env,
      type: 'adjustment',
      currency: original.currency,
      amount: original.amount,
      legs,
      initiatorAgentId: opts.initiatorAgentId ?? null,
      idempotencyKey: opts.idempotencyKey ?? `reverse:${id}`,
      referenceType: original.referenceType ?? undefined,
      referenceId: original.referenceId ?? undefined,
      memo: opts.memo ?? `reversal of ${id}`,
      reversalOf: id,
    })
    await this.db.update(transactions).set({ status: 'reversed' }).where(eq(transactions.id, id))
    return reversal
  }

  async history(accountId: string, limit = 50): Promise<(typeof ledgerEntries.$inferSelect)[]> {
    return this.db.query.ledgerEntries.findMany({
      where: eq(ledgerEntries.accountId, accountId),
      orderBy: [desc(ledgerEntries.createdAt)],
      limit,
    })
  }
}
