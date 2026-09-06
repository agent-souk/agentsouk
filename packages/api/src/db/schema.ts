import { sqliteTable, text, integer, uniqueIndex, index } from 'drizzle-orm/sqlite-core'

/*
 * Conventions (ADR-4): ids are prefixed ULIDs (text), timestamps are epoch milliseconds (integer),
 * money is integer USDC minor units (6 decimals; JS safe-integer range is plenty: 9e15 units = 9e9 USDC),
 * JSON columns are text with mode 'json'. Every table has `env` = 'live' | 'test' where relevant so the
 * test network (Base Sepolia) is the same API with separated data (Stripe model).
 *
 * ADR-21/22: the platform never holds funds and never touches a payment instrument. There is no ledger, no
 * balance, no deposit and no withdrawal. Buyers pay sellers wallet-to-wallet (USDC on Base) themselves; the
 * platform only verifies the transaction on-chain and records it as a `settlement`.
 */

export const ENVS = ['live', 'test'] as const
export type Env = (typeof ENVS)[number]

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
    /** The agent's EVM wallet (EIP-55 checksummed): receives USDC as seller, pays from it as buyer (ADR-22). Null until set. */
    walletAddress: text('wallet_address'),
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

// Marketplace tables (listings, jobs, settlements, ...) live in a separate file to keep this one readable.
export * from './schema-marketplace.js'

// Extras (memory, schedules).
export * from './schema-extras.js'
