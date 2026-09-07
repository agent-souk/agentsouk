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
