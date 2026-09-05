import { sqliteTable, text, integer, uniqueIndex, index } from 'drizzle-orm/sqlite-core'

/*
 * Conventions (ADR-4): ids are prefixed ULIDs (text), timestamps are epoch milliseconds (integer),
 * money is integer minor units (JS safe-integer range is plenty: 9e15 minor units),
 * JSON columns are text with mode 'json'. Every table has `env` = 'live' | 'test' where relevant so a
 * sandbox is the same API with separated data (Stripe model).
 */

export const ENVS = ['live', 'test'] as const
export type Env = (typeof ENVS)[number]

// ---------------------------------------------------------------------------------------------
// LEDGER (double-entry). Owner types: agent | platform | escrow | rail.
// ---------------------------------------------------------------------------------------------

export const ACCOUNT_KINDS = ['available', 'promo', 'escrow', 'fees', 'faucet', 'rail_reserve', 'suspense'] as const
export type AccountKind = (typeof ACCOUNT_KINDS)[number]

export const accounts = sqliteTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    env: text('env').$type<Env>().notNull(),
    ownerType: text('owner_type').$type<'agent' | 'platform' | 'escrow' | 'rail'>().notNull(),
    ownerId: text('owner_id').notNull(),
    currency: text('currency').notNull(),
    kind: text('kind').$type<AccountKind>().notNull(),
    balance: integer('balance').notNull().default(0),
    /** Liability/funding accounts (faucet, rail_reserve, platform fees) may go negative. Agent accounts never. */
    allowNegative: integer('allow_negative', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('accounts_owner_currency_kind').on(t.env, t.ownerType, t.ownerId, t.currency, t.kind),
    index('accounts_owner').on(t.ownerType, t.ownerId),
  ],
)

export const TRANSACTION_TYPES = [
  'faucet',
  'transfer',
  'escrow_lock',
  'escrow_release',
  'escrow_refund',
  'deposit',
  'withdrawal',
  'fee',
  'referral_bonus',
  'adjustment',
] as const
export type TransactionType = (typeof TRANSACTION_TYPES)[number]

export const transactions = sqliteTable(
  'transactions',
  {
    id: text('id').primaryKey(),
    env: text('env').$type<Env>().notNull(),
    type: text('type').$type<TransactionType>().notNull(),
    currency: text('currency').notNull(),
    /** Gross amount moved (positive). */
    amount: integer('amount').notNull(),
    status: text('status').$type<'posted' | 'reversed'>().notNull().default('posted'),
    initiatorAgentId: text('initiator_agent_id'),
    /** Idempotency: unique per (initiator, key). Null initiator = platform. */
    idempotencyKey: text('idempotency_key'),
    referenceType: text('reference_type'),
    referenceId: text('reference_id'),
    memo: text('memo'),
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>(),
    reversalOf: text('reversal_of'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('transactions_idempotency').on(t.env, t.initiatorAgentId, t.idempotencyKey),
    index('transactions_reference').on(t.referenceType, t.referenceId),
    index('transactions_created').on(t.createdAt),
  ],
)

export const ledgerEntries = sqliteTable(
  'ledger_entries',
  {
    id: text('id').primaryKey(),
    transactionId: text('transaction_id')
      .notNull()
      .references(() => transactions.id),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id),
    /** Signed delta applied to the account (+ credit, - debit). Sum per transaction is always 0. */
    delta: integer('delta').notNull(),
    balanceAfter: integer('balance_after').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('ledger_entries_account').on(t.accountId, t.createdAt), index('ledger_entries_txn').on(t.transactionId)],
)
