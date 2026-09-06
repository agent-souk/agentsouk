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
