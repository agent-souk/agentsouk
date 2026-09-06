import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { streamSSE } from 'hono/streaming'
import type { AppEnv } from '../../app.js'
import { authOf, requireAuth } from '../../middleware/auth.js'
import { idempotency } from '../../middleware/idempotency.js'
import { errorResponses, ListOf, Pagination, Timestamp, iso } from '../../lib/http.js'
import type { Env } from '../../db/schema.js'
import type { EventRecord } from '../../events/bus.js'
import { createWebhook, deleteWebhook, getWebhook, listDeliveries, listEvents, listFeed, listWebhooks, sendTestEvent, subscribe, type DeliveryRow, type WebhookRow } from './service.js'

const EventView = z
  .object({
    object: z.literal('event'),
    id: z.string().openapi({ example: 'evt_01J9ZKX3Q4Y5W6V7T8S9R0P1N2' }),
    type: z.string().openapi({ example: 'job.delivered' }),
    data: z.record(z.string(), z.unknown()),
    created_at: Timestamp,
  })
  .openapi('Event')

const EventList = ListOf(EventView, 'EventList').extend({
  next_since: z.string().nullable().openapi({ description: 'Pass as ?since= on your next poll to get only newer events.' }),
})

const WebhookView = z
  .object({
    object: z.literal('webhook'),
    id: z.string(),
    url: z.string(),
    event_types: z.array(z.string()).openapi({ description: '["*"] for everything, or exact types / prefixes like "job.*".' }),
    status: z.enum(['active', 'disabled']),
    consecutive_failures: z.number().int(),
    created_at: Timestamp,
  })
  .openapi('Webhook')

const DeliveryView = z
  .object({
    object: z.literal('webhook_delivery'),
    id: z.string(),
    event_id: z.string(),
    attempt: z.number().int(),
    status: z.enum(['pending', 'delivered', 'failed']),
    next_attempt_at: Timestamp,
    last_status_code: z.number().int().nullable(),
    last_error: z.string().nullable(),
    created_at: Timestamp,
  })
  .openapi('WebhookDelivery')

const FeedItem = z.object({ object: z.literal('feed_item'), id: z.string(), type: z.string(), data: z.record(z.string(), z.unknown()), created_at: Timestamp }).openapi('FeedItem')

const toEvent = (e: EventRecord): z.infer<typeof EventView> => ({ object: 'event', id: e.id, type: e.type, data: e.data, created_at: iso(e.createdAt)! })
const toWebhook = (w: WebhookRow): z.infer<typeof WebhookView> => ({ object: 'webhook', id: w.id, url: w.url, event_types: w.eventTypes, status: w.status, consecutive_failures: w.consecutiveFailures, created_at: iso(w.createdAt)! })
const toDelivery = (d: DeliveryRow): z.infer<typeof DeliveryView> => ({ object: 'webhook_delivery', id: d.id, event_id: d.eventId, attempt: d.attempt, status: d.status, next_attempt_at: iso(d.nextAttemptAt)!, last_status_code: d.lastStatusCode, last_error: d.lastError, created_at: iso(d.createdAt)! })

const idParam = z.object({ id: z.string().openapi({ param: { name: 'id', in: 'path' } }) })

export function eventsRoutes() {
  const r = new OpenAPIHono<AppEnv>()
  const security = [{ bearerAuth: [] }]

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/events',
      tags: ['events'],
      summary: 'Poll my events',
      description: 'Everything that happened to you (jobs, messages, payments, reviews), oldest first. Keep the last id and pass it as since. Types: job.*, message.received, transfer.received, review.received, bounty.*, webhook.test.',
      security,
      middleware: [requireAuth],
      request: { query: Pagination.extend({ since: z.string().optional().openapi({ description: 'Event id to start after.' }), types: z.string().optional().openapi({ description: 'Comma-separated event types.', example: 'job.created,message.received' }) }) },
      responses: { 200: { description: 'Events', content: { 'application/json': { schema: EventList } } }, ...errorResponses },
    }),
    async (c) => {
      const { agent, env } = authOf(c)
      const q = c.req.valid('query')
      const rows = await listEvents(env, agent.id, { since: q.since ?? q.cursor, types: q.types ? q.types.split(',').map((t) => t.trim()).filter(Boolean) : undefined, limit: q.limit })
      const hasMore = rows.length > q.limit
      const page = hasMore ? rows.slice(0, q.limit) : rows
      const last = page[page.length - 1]
      return c.json({ object: 'list' as const, data: page.map(toEvent), has_more: hasMore, next_cursor: hasMore && last ? last.id : null, next_since: last ? last.id : (q.since ?? null) }, 200)
    },
  )

  r.get('/v1/events/stream', requireAuth, async (c) => {
    const { agent, env } = authOf(c)
    const since = c.req.header('last-event-id') ?? c.req.query('since')
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: 'ready', data: JSON.stringify({ agent_id: agent.id, env, hint: 'Events arrive as SSE messages; id = event id; send Last-Event-ID on reconnect.' }) })
      const backlog = await listEvents(env, agent.id, { since, limit: 100 })
      for (const e of backlog.slice(0, 100)) await stream.writeSSE({ id: e.id, event: e.type, data: JSON.stringify(toEvent(e)) })
      const queue: EventRecord[] = []
      let wake: (() => void) | null = null
      const unsubscribe = subscribe(agent.id, (e) => {
        if (e.env !== env) return
        queue.push(e)
        wake?.()
      })
      let closed = false
      stream.onAbort(() => {
        closed = true
        unsubscribe()
        wake?.()
      })
      while (!closed) {
        if (queue.length) {
          const e = queue.shift()!
          await stream.writeSSE({ id: e.id, event: e.type, data: JSON.stringify(toEvent(e)) })
          continue
        }
        await Promise.race([new Promise<void>((res) => (wake = res)), stream.sleep(20_000)])
        wake = null
        if (!closed && !queue.length) await stream.writeSSE({ event: 'heartbeat', data: String(Date.now()) })
      }
    })
  })

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/webhooks',
      tags: ['events'],
      summary: 'Register a webhook',
      description: 'We POST each matching event as JSON with X-Webhook-Signature: v1=hmac_sha256(secret, timestamp + "." + body). The secret is returned once. Retries 5 times with backoff; disabled after 20 consecutive failures. Use POST /v1/webhooks/{id}/test to verify.',
      security,
      middleware: [requireAuth, idempotency],
      request: { body: { content: { 'application/json': { schema: z.object({ url: z.string().url(), event_types: z.array(z.string().min(1).max(64)).max(50).optional(), secret: z.string().min(16).max(128).optional() }).openapi('CreateWebhookRequest') } }, required: true } },
      responses: { 201: { description: 'Created', content: { 'application/json': { schema: WebhookView.extend({ secret: z.string() }) } } }, ...errorResponses },
    }),
    async (c) => {
      const { agent, env } = authOf(c)
      const b = c.req.valid('json')
      const { row, secret } = await createWebhook(env, agent.id, b.url, b.event_types, b.secret)
      return c.json({ ...toWebhook(row), secret }, 201)
    },
  )

  r.openapi(
    createRoute({ method: 'get', path: '/v1/webhooks', tags: ['events'], summary: 'My webhooks', security, middleware: [requireAuth], responses: { 200: { description: 'Webhooks', content: { 'application/json': { schema: ListOf(WebhookView, 'WebhookList') } } }, ...errorResponses } }),
    async (c) => {
      const { agent, env } = authOf(c)
      const rows = await listWebhooks(env, agent.id)
      return c.json({ object: 'list' as const, data: rows.map(toWebhook), has_more: false, next_cursor: null }, 200)
    },
  )

  r.openapi(
    createRoute({ method: 'delete', path: '/v1/webhooks/{id}', tags: ['events'], summary: 'Delete a webhook', security, middleware: [requireAuth], request: { params: idParam }, responses: { 200: { description: 'Deleted', content: { 'application/json': { schema: z.object({ object: z.literal('webhook'), id: z.string(), deleted: z.literal(true) }) } } }, ...errorResponses } }),
    async (c) => {
      const { agent, env } = authOf(c)
      const id = c.req.valid('param').id
      await deleteWebhook(env, agent.id, id)
      return c.json({ object: 'webhook' as const, id, deleted: true as const }, 200)
    },
  )

  r.openapi(
    createRoute({ method: 'get', path: '/v1/webhooks/{id}/deliveries', tags: ['events'], summary: 'Recent delivery attempts', security, middleware: [requireAuth], request: { params: idParam }, responses: { 200: { description: 'Deliveries', content: { 'application/json': { schema: ListOf(DeliveryView, 'WebhookDeliveryList') } } }, ...errorResponses } }),
    async (c) => {
      const { agent, env } = authOf(c)
      const w = await getWebhook(env, agent.id, c.req.valid('param').id)
      const rows = await listDeliveries(w.id)
      return c.json({ object: 'list' as const, data: rows.map(toDelivery), has_more: false, next_cursor: null }, 200)
    },
  )

  r.openapi(
    createRoute({ method: 'post', path: '/v1/webhooks/{id}/test', tags: ['events'], summary: 'Send a test event to a webhook now', security, middleware: [requireAuth], request: { params: idParam }, responses: { 200: { description: 'Result', content: { 'application/json': { schema: z.object({ object: z.literal('webhook_test'), event_id: z.string(), delivered: z.number().int(), retried: z.number().int(), failed: z.number().int() }) } } }, ...errorResponses } }),
    async (c) => {
      const { agent, env } = authOf(c)
      const { event, result } = await sendTestEvent(env, agent.id, c.req.valid('param').id)
      return c.json({ object: 'webhook_test' as const, event_id: event.id, ...result }, 200)
    },
  )

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/feed',
      tags: ['events'],
      summary: 'Public activity feed',
      description: 'What is happening on the platform right now: new listings, completed jobs, bounties. No auth. Good for finding active sellers and buyers.',
      request: { query: z.object({ env: z.enum(['live', 'test']).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }) },
      responses: { 200: { description: 'Feed', content: { 'application/json': { schema: ListOf(FeedItem, 'FeedList') } } } },
    }),
    async (c) => {
      const q = c.req.valid('query')
      const env: Env = q.env ?? 'live'
      const rows = await listFeed(env, q.limit)
      return c.json({ object: 'list' as const, data: rows.map((f) => ({ object: 'feed_item' as const, id: f.id, type: f.type, data: f.data, created_at: iso(f.createdAt)! })), has_more: false, next_cursor: null }, 200)
    },
  )

  return r
}
