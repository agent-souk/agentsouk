import { and, asc, desc, eq, lt, lte, sql, type SQL } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { schedules, type Env } from '../../db/schema.js'
import { errors } from '../../lib/errors.js'
import { newId } from '../../lib/ids.js'
import { emit } from '../../events/bus.js'
import { registerSweep } from '../../lib/scheduler.js'
import { scanJson } from '../../lib/content-safety.js'

/**
 * Wake-ups (ADR-14 extra #8). Agents have no cron: "fire an event with this payload at T (every N
 * seconds)". Fired events are `schedule.fired` and reach the agent via polling, SSE or webhooks.
 */
export type ScheduleRow = typeof schedules.$inferSelect
export const MAX_ACTIVE = 100
export const MIN_INTERVAL_SECONDS = 60
export const MAX_PAYLOAD_BYTES = 16 * 1024

export type CreateScheduleInput = { name?: string; run_at?: string; in_seconds?: number; interval_seconds?: number; max_runs?: number; payload?: Record<string, unknown> }

export async function createSchedule(env: Env, agentId: string, input: CreateScheduleInput, now = Date.now()): Promise<ScheduleRow> {
  let runAt: number
  if (input.run_at) {
    runAt = Date.parse(input.run_at)
    if (Number.isNaN(runAt)) throw errors.validation('run_at must be an ISO-8601 timestamp.', 'run_at', 'Example: "2026-09-07T09:00:00Z". Or use in_seconds.')
  } else if (input.in_seconds !== undefined) {
    runAt = now + input.in_seconds * 1000
  } else throw errors.validation('Provide run_at (ISO timestamp) or in_seconds.', 'run_at')
  if (runAt < now - 60_000) throw errors.validation('run_at is in the past.', 'run_at')
  if (input.interval_seconds !== undefined && input.interval_seconds < MIN_INTERVAL_SECONDS) throw errors.validation(`interval_seconds must be at least ${MIN_INTERVAL_SECONDS}.`, 'interval_seconds')
  const payload = input.payload ?? {}
  if (JSON.stringify(payload).length > MAX_PAYLOAD_BYTES) throw errors.validation(`payload must be at most ${MAX_PAYLOAD_BYTES} bytes.`, 'payload')
  const scan = scanJson(payload)
  const active = await db().select({ n: sql<number>`count(*)` }).from(schedules).where(and(eq(schedules.agentId, agentId), eq(schedules.status, 'active')))
  if ((active[0]?.n ?? 0) >= MAX_ACTIVE) throw errors.state('schedule_limit', `You already have ${MAX_ACTIVE} active schedules.`, 'Delete or pause some: DELETE /v1/schedules/{id}.')
  const row: typeof schedules.$inferInsert = {
    id: newId('schedule'),
    env,
    agentId,
    name: input.name?.slice(0, 120) ?? null,
    runAt,
    intervalSeconds: input.interval_seconds ?? null,
    payload: { ...payload, ...(scan.warnings.length ? { content_warnings: scan.warnings } : {}) },
    status: 'active',
    runCount: 0,
    maxRuns: input.max_runs ?? null,
    lastRunAt: null,
    createdAt: now,
    updatedAt: now,
  }
  await db().insert(schedules).values(row)
  return row as ScheduleRow
}

export async function getSchedule(env: Env, agentId: string, id: string): Promise<ScheduleRow> {
  const s = await db().query.schedules.findFirst({ where: and(eq(schedules.id, id), eq(schedules.env, env), eq(schedules.agentId, agentId)) })
  if (!s) throw errors.notFound('Schedule', id, 'GET /v1/schedules lists yours.')
  return s
}

export async function listSchedules(env: Env, agentId: string, opts: { status?: string; limit: number; cursor?: string }): Promise<ScheduleRow[]> {
  const conds: SQL[] = [eq(schedules.env, env), eq(schedules.agentId, agentId)]
  if (opts.status) conds.push(eq(schedules.status, opts.status as ScheduleRow['status']))
  if (opts.cursor) conds.push(lt(schedules.id, opts.cursor))
  return db().query.schedules.findMany({ where: and(...conds), orderBy: [desc(schedules.id)], limit: opts.limit + 1 })
}

export async function setScheduleStatus(env: Env, agentId: string, id: string, status: 'active' | 'paused'): Promise<ScheduleRow> {
  const s = await getSchedule(env, agentId, id)
  if (s.status === 'done') throw errors.state('schedule_done', 'This schedule has finished.', 'Create a new one with POST /v1/schedules.')
  await db().update(schedules).set({ status, updatedAt: Date.now() }).where(eq(schedules.id, id))
  return getSchedule(env, agentId, id)
}

export async function deleteSchedule(env: Env, agentId: string, id: string): Promise<void> {
  await getSchedule(env, agentId, id)
  await db().delete(schedules).where(eq(schedules.id, id))
}

export async function fireSchedules(now = Date.now()): Promise<number> {
  const due = await db().query.schedules.findMany({ where: and(eq(schedules.status, 'active'), lte(schedules.runAt, now)), orderBy: [asc(schedules.runAt)], limit: 500 })
  for (const s of due) {
    const runCount = s.runCount + 1
    await emit(s.env, s.agentId, 'schedule.fired', { schedule_id: s.id, name: s.name, run_count: runCount, scheduled_for: new Date(s.runAt).toISOString(), payload: s.payload })
    const finished = !s.intervalSeconds || (s.maxRuns != null && runCount >= s.maxRuns)
    let nextRun = s.runAt
    if (!finished) {
      const step = s.intervalSeconds! * 1000
      nextRun = s.runAt + step * Math.max(1, Math.ceil((now - s.runAt + 1) / step))
    }
    await db().update(schedules).set({ runCount, lastRunAt: now, runAt: nextRun, status: finished ? 'done' : 'active', updatedAt: now }).where(eq(schedules.id, s.id))
  }
  return due.length
}

registerSweep('schedules', async (now) => {
  await fireSchedules(now)
})
