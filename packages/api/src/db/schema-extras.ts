import { sqliteTable, text, integer, uniqueIndex, index } from 'drizzle-orm/sqlite-core'
import { agents, type Env } from './schema.js'

// ---------------------------------------------------------------------------------------------
// EXTRAS (ADR-14): persistent memory and wake-up schedules for agents.
// ---------------------------------------------------------------------------------------------

/** Key-value memory per agent identity (shared across live/test: it is about the agent, not money). */
export const agentMemory = sqliteTable(
  'agent_memory',
  {
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    key: text('key').notNull(),
    value: text('value', { mode: 'json' }).$type<unknown>().notNull(),
    size: integer('size').notNull(),
    expiresAt: integer('expires_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [uniqueIndex('agent_memory_pk').on(t.agentId, t.key), index('agent_memory_expires').on(t.expiresAt)],
)

export const SCHEDULE_STATUSES = ['active', 'paused', 'done'] as const
export type ScheduleStatus = (typeof SCHEDULE_STATUSES)[number]

export const schedules = sqliteTable(
  'schedules',
  {
    id: text('id').primaryKey(),
    env: text('env').$type<Env>().notNull(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    name: text('name'),
    runAt: integer('run_at').notNull(),
    intervalSeconds: integer('interval_seconds'),
    payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    status: text('status').$type<ScheduleStatus>().notNull().default('active'),
    runCount: integer('run_count').notNull().default(0),
    maxRuns: integer('max_runs'),
    lastRunAt: integer('last_run_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('schedules_due').on(t.status, t.runAt), index('schedules_agent').on(t.agentId)],
)

// ---------------------------------------------------------------------------------------------
// DOMAIN VERIFICATION (ADR-26): trust tier 2 = an agent that proved control of a DNS namespace.
// ---------------------------------------------------------------------------------------------

export const DOMAIN_STATUSES = ['pending', 'verified', 'revoked'] as const
export type DomainStatus = (typeof DOMAIN_STATUSES)[number]
export type DomainMethod = 'dns' | 'https'

export const agentDomains = sqliteTable(
  'agent_domains',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    /** lowercase, punycode (ASCII) host name without trailing dot */
    domain: text('domain').notNull(),
    status: text('status').$type<DomainStatus>().notNull().default('pending'),
    /** how it was last proven */
    method: text('method').$type<DomainMethod>(),
    lastCheckedAt: integer('last_checked_at'),
    verifiedAt: integer('verified_at'),
    revokedAt: integer('revoked_at'),
    revokedReason: text('revoked_reason'),
    /** consecutive failed re-checks of a verified domain */
    failures: integer('failures').notNull().default(0),
    lastError: text('last_error'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [uniqueIndex('agent_domains_pk').on(t.agentId, t.domain), index('agent_domains_domain').on(t.domain, t.status), index('agent_domains_recheck').on(t.status, t.lastCheckedAt)],
)

// ---------------------------------------------------------------------------------------------
// DISCOVERY INSTRUMENTATION (strategic brief §6 #20): who reads skill.md, llms.txt, the MCP
// endpoint and the well-knowns, per day and per user-agent class. Counts only, no addresses.
// ---------------------------------------------------------------------------------------------

export const discoveryHits = sqliteTable(
  'discovery_hits',
  {
    /** UTC day, YYYY-MM-DD */
    day: text('day').notNull(),
    /** which surface: skill.md, llms.txt, mcp, well-known, register, ... (see discovery/hits.ts) */
    surface: text('surface').notNull(),
    /** coarse user-agent class: claude, openai, perplexity, ..., curl, python, node, browser, other */
    uaClass: text('ua_class').notNull(),
    count: integer('count').notNull().default(0),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [uniqueIndex('discovery_hits_pk').on(t.day, t.surface, t.uaClass), index('discovery_hits_day').on(t.day)],
)

/**
 * ADR-30: sandbox faucet claims (testnet USDC the platform desk sent to a sandbox agent). The ledger behind the
 * per-agent, per-source-address and global daily limits; ip_hash is a peppered hash, never the address itself.
 */
export const faucetClaims = sqliteTable(
  'faucet_claims',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    /** the bound wallet the USDC went to (EIP-55) */
    address: text('address').notNull(),
    /** USDC minor units */
    amount: integer('amount').notNull(),
    /** transaction hash the facilitator reported */
    transaction: text('transaction').notNull(),
    /** UTC day, YYYY-MM-DD */
    day: text('day').notNull(),
    ipHash: text('ip_hash').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('faucet_claims_agent_day').on(t.agentId, t.day), index('faucet_claims_ip_day').on(t.ipHash, t.day), index('faucet_claims_day').on(t.day)],
)


// ---------------------------------------------------------------------------------------------
// DEMAND SIGNAL (ADR-35): what buyers searched for, per day and environment, and how often the
// search found nothing. Terms only (normalised query text), never who searched.
// ---------------------------------------------------------------------------------------------

export const searchDemand = sqliteTable(
  'search_demand',
  {
    /** UTC day, YYYY-MM-DD */
    day: text('day').notNull(),
    env: text('env').$type<Env>().notNull(),
    /** normalised query text (lowercased, whitespace collapsed, at most 80 characters) */
    term: text('term').notNull(),
    searches: integer('searches').notNull().default(0),
    /** searches for this term that returned no listing at all */
    zeroResults: integer('zero_results').notNull().default(0),
    /**
     * How many different clients searched this term on this day (ADR-36). Counted through a fingerprint that lives
     * in memory only and is never stored: one search repeated all day by one client is one searcher, and only a
     * term more than one client looked for reaches the public list. 0 = rows written before the column existed.
     */
    searchers: integer('searchers').notNull().default(0),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [uniqueIndex('search_demand_pk').on(t.day, t.env, t.term), index('search_demand_day').on(t.day)],
)


// ---------------------------------------------------------------------------------------------
// OPERATOR ALERTS (ADR-49): the one thing the operator cannot learn by reading a number later.
// One row per alert, deduplicated by `key`, delivered by the sweep with retries. Nothing here is
// public and nothing here is agent-scoped: it is the operator's own wire.
// ---------------------------------------------------------------------------------------------

export const ALERT_TIERS = ['urgent', 'notable', 'quiet'] as const
export type AlertTier = (typeof ALERT_TIERS)[number]

export const ALERT_STATUSES = ['pending', 'sent', 'failed', 'suppressed'] as const
export type AlertStatus = (typeof ALERT_STATUSES)[number]

export const operatorAlerts = sqliteTable(
  'operator_alerts',
  {
    id: text('id').primaryKey(),
    env: text('env').$type<Env>().notNull(),
    tier: text('tier').$type<AlertTier>().notNull(),
    /** What happened, in the shape `<kind>:<id>`. Unique: the same fact never wakes anyone twice. */
    key: text('key').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    /** Everything the alert was built from, so a later reader can check the judgement without the job table. */
    data: text('data', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
    status: text('status').$type<AlertStatus>().notNull().default('pending'),
    attempt: integer('attempt').notNull().default(0),
    nextAttemptAt: integer('next_attempt_at').notNull(),
    /** Per channel: what the send returned, so a silent failure is visible rather than assumed away. */
    results: text('results', { mode: 'json' }).$type<{ channel: string; ok: boolean; status?: number; error?: string }[]>(),
    lastError: text('last_error'),
    sentAt: integer('sent_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [uniqueIndex('operator_alerts_key').on(t.key), index('operator_alerts_due').on(t.status, t.nextAttemptAt), index('operator_alerts_created').on(t.createdAt)],
)
