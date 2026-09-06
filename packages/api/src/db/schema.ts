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

// ---------------------------------------------------------------------------------------------
// IDENTITY
// ---------------------------------------------------------------------------------------------

export type AgentEndpoints = {
  /** A2A Agent Card URL (https://.../.well-known/agent-card.json) */
  a2a_card_url?: string
  /** MCP server URL (streamable HTTP) */
  mcp_url?: string
  /** Generic HTTPS endpoint the agent can be called at */
  api_url?: string
  /** Where we deliver webhooks (jobs, messages, payments) */
  webhook_url?: string
  homepage?: string
}

export const agents = sqliteTable(
  'agents',
  {
    id: text('id').primaryKey(),
    handle: text('handle').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    capabilities: text('capabilities', { mode: 'json' }).$type<string[]>().notNull().default([]),
    tags: text('tags', { mode: 'json' }).$type<string[]>().notNull().default([]),
    /** hex Ed25519 public key (32 bytes) */
    publicKey: text('public_key').notNull(),
    did: text('did').notNull(),
    endpoints: text('endpoints', { mode: 'json' }).$type<AgentEndpoints>().notNull().default({}),
    framework: text('framework'),
    trustTier: integer('trust_tier').notNull().default(0),
    status: text('status').$type<'active' | 'suspended' | 'deleted'>().notNull().default('active'),
    referredBy: text('referred_by'),
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    lastSeenAt: integer('last_seen_at'),
  },
  (t) => [uniqueIndex('agents_handle').on(t.handle), uniqueIndex('agents_public_key').on(t.publicKey), index('agents_created').on(t.createdAt)],
)

export const apiKeys = sqliteTable(
  'api_keys',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    env: text('env').$type<Env>().notNull(),
    keyHash: text('key_hash').notNull(),
    prefix: text('prefix').notNull(),
    name: text('name'),
    scopes: text('scopes', { mode: 'json' }).$type<string[]>().notNull().default(['*']),
    status: text('status').$type<'active' | 'revoked'>().notNull().default('active'),
    lastUsedAt: integer('last_used_at'),
    expiresAt: integer('expires_at'),
    createdAt: integer('created_at').notNull(),
    revokedAt: integer('revoked_at'),
  },
  (t) => [uniqueIndex('api_keys_hash').on(t.keyHash), index('api_keys_agent').on(t.agentId)],
)

/** Idempotent request replay cache (24h). */
export const idempotencyKeys = sqliteTable(
  'idempotency_keys',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id').notNull(),
    key: text('key').notNull(),
    method: text('method').notNull(),
    path: text('path').notNull(),
    requestHash: text('request_hash').notNull(),
    status: integer('status'),
    responseBody: text('response_body'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('idempotency_agent_key').on(t.agentId, t.key), index('idempotency_created').on(t.createdAt)],
)

// ---------------------------------------------------------------------------------------------
// WALLET: deposits / withdrawals via external rails. The ledger stays the source of truth for
// balances; these tables track the external side (rail, reference, status).
// ---------------------------------------------------------------------------------------------

export const RAILS = ['sandbox', 'x402', 'stripe', 'lightning', 'manual'] as const
export type Rail = (typeof RAILS)[number]

export const deposits = sqliteTable(
  'deposits',
  {
    id: text('id').primaryKey(),
    env: text('env').$type<Env>().notNull(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    rail: text('rail').$type<Rail>().notNull(),
    /** currency credited on the ledger (CRD) */
    currency: text('currency').notNull(),
    amount: integer('amount').notNull(),
    /** what the agent pays externally, e.g. { asset: 'USDC', network: 'base', amount: '1.000000', pay_to: '0x...' } */
    externalRequest: text('external_request', { mode: 'json' }).$type<Record<string, unknown>>(),
    /** proof / reference on the external rail (tx hash, payment intent id, ...) */
    externalRef: text('external_ref'),
    status: text('status').$type<'pending' | 'confirmed' | 'failed' | 'expired'>().notNull().default('pending'),
    transactionId: text('transaction_id'),
    expiresAt: integer('expires_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('deposits_agent').on(t.agentId, t.createdAt), index('deposits_external').on(t.rail, t.externalRef)],
)

export const withdrawals = sqliteTable(
  'withdrawals',
  {
    id: text('id').primaryKey(),
    env: text('env').$type<Env>().notNull(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    rail: text('rail').$type<Rail>().notNull(),
    currency: text('currency').notNull(),
    amount: integer('amount').notNull(),
    /** where to send, e.g. { asset: 'USDC', network: 'base', address: '0x...' } */
    destination: text('destination', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    externalRef: text('external_ref'),
    status: text('status').$type<'pending' | 'processing' | 'completed' | 'failed' | 'cancelled'>().notNull().default('pending'),
    /** ledger txn that moved funds out of `available` into the rail reserve */
    transactionId: text('transaction_id'),
    failureReason: text('failure_reason'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('withdrawals_agent').on(t.agentId, t.createdAt)],
)

// Marketplace tables live in a separate file to keep this one readable.
export * from './schema-marketplace.js'

// Extras (memory, schedules).
export * from './schema-extras.js'
