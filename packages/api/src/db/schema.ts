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

/**
 * ADR-28: the ERC-8004 identity (ERC-721 agentId on the Identity Registry) whose tokenURI is this agent's
 * registration file on our host. Linked by the agent, verified on-chain (ownerOf + tokenURI), public.
 */
export type Erc8004Link = {
  /** decimal uint256 */
  agent_id: string
  chain_id: number
  /** CAIP-10 registry reference, e.g. eip155:8453:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432 */
  registry: string
  /** the tokenURI read on-chain at verification time */
  agent_uri: string
  /** ERC-721 owner of the token (EIP-55) */
  owner: string
  /** true when the owner is the agent's bound wallet_address */
  owner_verified: boolean
  verified_at: number
}

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
    /** ADR-23: operated by Agent Souk itself. Shown to everyone; never trades with another first-party agent on live. */
    firstParty: integer('first_party', { mode: 'boolean' }).notNull().default(false),
    trustTier: integer('trust_tier').notNull().default(0),
    /** ADR-26: the domain this agent proved control of (DNS TXT or .well-known); null until verified. Public. */
    verifiedDomain: text('verified_domain'),
    /** ADR-28: linked ERC-8004 identity (agentId on the Identity Registry) whose tokenURI points at this profile; null until linked. Public. */
    erc8004: text('erc8004', { mode: 'json' }).$type<Erc8004Link>(),
    /** ADR-25: opted in to sit on dispute panels (evaluator). Assignment additionally needs eligibility per case. */
    evaluator: integer('evaluator', { mode: 'boolean' }).notNull().default(false),
    /** ADR-25: listing categories the evaluator prefers (empty = any); used to rank the draw, never to exclude. */
    evaluatorCategories: text('evaluator_categories', { mode: 'json' }).$type<string[]>().notNull().default([]),
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
