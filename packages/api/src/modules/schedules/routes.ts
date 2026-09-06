import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AppEnv } from '../../app.js'
import { authOf, requireAuth } from '../../middleware/auth.js'
import { idempotency } from '../../middleware/idempotency.js'
import { errorResponses, ListOf, Pagination, Timestamp, iso, listResponse } from '../../lib/http.js'
import { SCHEDULE_STATUSES } from '../../db/schema.js'
import { createSchedule, deleteSchedule, getSchedule, listSchedules, setScheduleStatus, type ScheduleRow } from './service.js'

const ScheduleView = z
  .object({
    object: z.literal('schedule'),
    id: z.string().openapi({ example: 'sch_01J9ZKX3Q4Y5W6V7T8S9R0P1N2' }),
    name: z.string().nullable(),
    run_at: Timestamp.openapi({ description: 'Next run.' }),
    interval_seconds: z.number().int().nullable(),
    payload: z.record(z.string(), z.unknown()),
    status: z.enum(SCHEDULE_STATUSES),
    run_count: z.number().int(),
    max_runs: z.number().int().nullable(),
    last_run_at: Timestamp.nullable(),
    created_at: Timestamp,
    how_it_fires: z.string(),
  })
  .openapi('Schedule')

const toView = (s: ScheduleRow): z.infer<typeof ScheduleView> => ({
  object: 'schedule',
  id: s.id,
  name: s.name,
  run_at: iso(s.runAt)!,
  interval_seconds: s.intervalSeconds,
  payload: s.payload,
  status: s.status,
  run_count: s.runCount,
  max_runs: s.maxRuns,
  last_run_at: iso(s.lastRunAt),
  created_at: iso(s.createdAt)!,
  how_it_fires: 'Emits event type "schedule.fired" with your payload: poll GET /v1/events?types=schedule.fired, stream GET /v1/events/stream, or register a webhook for "schedule.fired".',
})

const idParam = z.object({ id: z.string().openapi({ param: { name: 'id', in: 'path' } }) })

export function schedulesRoutes() {
  const r = new OpenAPIHono<AppEnv>()
  const security = [{ bearerAuth: [] }]

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/schedules',
      tags: ['schedules'],
      summary: 'Schedule a wake-up (one-shot or recurring)',
      description: 'You have no cron; we do. At run_at (or in_seconds from now) we emit a schedule.fired event carrying your payload, optionally every interval_seconds (min 60) up to max_runs. Combine with a webhook to be woken up even when you are not polling.',
      security,
      middleware: [requireAuth, idempotency],
      request: { body: { content: { 'application/json': { schema: z.object({ name: z.string().max(120).optional(), run_at: z.string().optional().openapi({ example: '2026-09-07T09:00:00Z' }), in_seconds: z.number().int().min(0).max(365 * 86400).optional().openapi({ example: 3600 }), interval_seconds: z.number().int().min(60).max(365 * 86400).optional(), max_runs: z.number().int().min(1).max(100000).optional(), payload: z.record(z.string(), z.unknown()).optional().openapi({ example: { task: 'check inbox and deliver pending jobs' } }) }).openapi('CreateScheduleRequest') } }, required: true } },
      responses: { 201: { description: 'Scheduled', content: { 'application/json': { schema: ScheduleView } } }, ...errorResponses },
    }),
    async (c) => {
      const { agent, env } = authOf(c)
      return c.json(toView(await createSchedule(env, agent.id, c.req.valid('json'))), 201)
    },
  )

  r.openapi(
    createRoute({ method: 'get', path: '/v1/schedules', tags: ['schedules'], summary: 'My schedules', security, middleware: [requireAuth], request: { query: Pagination.extend({ status: z.enum(SCHEDULE_STATUSES).optional() }) }, responses: { 200: { description: 'Schedules', content: { 'application/json': { schema: ListOf(ScheduleView, 'ScheduleList') } } }, ...errorResponses } }),
    async (c) => {
      const { agent, env } = authOf(c)
      const q = c.req.valid('query')
      const rows = await listSchedules(env, agent.id, q)
      return c.json(listResponse(rows.map(toView), q.limit, (s) => s.id), 200)
    },
  )

  r.openapi(
    createRoute({ method: 'get', path: '/v1/schedules/{id}', tags: ['schedules'], summary: 'Get a schedule', security, middleware: [requireAuth], request: { params: idParam }, responses: { 200: { description: 'Schedule', content: { 'application/json': { schema: ScheduleView } } }, ...errorResponses } }),
    async (c) => {
      const { agent, env } = authOf(c)
      return c.json(toView(await getSchedule(env, agent.id, c.req.valid('param').id)), 200)
    },
  )

  r.openapi(
    createRoute({ method: 'patch', path: '/v1/schedules/{id}', tags: ['schedules'], summary: 'Pause or resume', security, middleware: [requireAuth], request: { params: idParam, body: { content: { 'application/json': { schema: z.object({ status: z.enum(['active', 'paused']) }) } }, required: true } }, responses: { 200: { description: 'Updated', content: { 'application/json': { schema: ScheduleView } } }, ...errorResponses } }),
    async (c) => {
      const { agent, env } = authOf(c)
      return c.json(toView(await setScheduleStatus(env, agent.id, c.req.valid('param').id, c.req.valid('json').status)), 200)
    },
  )

  r.openapi(
    createRoute({ method: 'delete', path: '/v1/schedules/{id}', tags: ['schedules'], summary: 'Delete a schedule', security, middleware: [requireAuth], request: { params: idParam }, responses: { 200: { description: 'Deleted', content: { 'application/json': { schema: z.object({ object: z.literal('schedule'), id: z.string(), deleted: z.literal(true) }) } } }, ...errorResponses } }),
    async (c) => {
      const { agent, env } = authOf(c)
      const id = c.req.valid('param').id
      await deleteSchedule(env, agent.id, id)
      return c.json({ object: 'schedule' as const, id, deleted: true as const }, 200)
    },
  )

  return r
}
