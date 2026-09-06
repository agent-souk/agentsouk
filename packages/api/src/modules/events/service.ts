import { and, asc, desc, eq, gt, inArray, lte, sql, type SQL } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { events, feedItems, webhookDeliveries, webhooks, type Env } from '../../db/schema.js'
import { errors } from '../../lib/errors.js'
import { newId } from '../../lib/ids.js'
import { hmacSha256Hex, randomHex } from '../../lib/crypto.js'
import { log } from '../../lib/log.js'
import { registerSweep } from '../../lib/scheduler.js'
import { onEvent, emit, type EventRecord } from '../../events/bus.js'

/**
 * Events, SSE, webhooks and the public feed (SPEC §6).
 * - Poll: GET /v1/events?since=<evt_id>
 * - Stream: GET /v1/events/stream (SSE)
 * - Push: signed webhooks with retries
 */

export type WebhookRow = typeof webhooks.$inferSelect
export type DeliveryRow = typeof webhookDeliveries.$inferSelect
export const MAX_WEBHOOKS = 10
export const BACKOFF_MS = [10_000, 60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000]
export const MAX_ATTEMPTS = BACKOFF_MS.length
export const DISABLE_AFTER_FAILURES = 20
export const DELIVERY_TIMEOUT_MS = 10_000

// --- polling ----------------------------------------------------------------------------------

export async function listEvents(env: Env, agentId: string, opts: { since?: string; types?: string[]; limit: number }): Promise<EventRecord[]> {
  const conds: SQL[] = [eq(events.env, env), eq(events.agentId, agentId)]
  if (opts.since) conds.push(gt(events.id, opts.since))
  if (opts.types?.length) conds.push(inArray(events.type, opts.types))
  return db().query.events.findMany({ where: and(...conds), orderBy: [asc(events.id)], limit: opts.limit + 1 })
}

// --- SSE subscribers --------------------------------------------------------------------------

type Subscriber = (e: EventRecord) => void
const subscribers = new Map<string, Set<Subscriber>>()

export function subscribe(agentId: string, fn: Subscriber): () => void {
  let set = subscribers.get(agentId)
  if (!set) {
    set = new Set()
    subscribers.set(agentId, set)
  }
  set.add(fn)
  return () => {
    set!.delete(fn)
    if (!set!.size) subscribers.delete(agentId)
  }
}

export function subscriberCount(agentId: string): number {
  return subscribers.get(agentId)?.size ?? 0
}

// --- webhooks ---------------------------------------------------------------------------------

function validateUrl(env: Env, url: string) {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw errors.validation('url must be an absolute URL.', 'url')
  }
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname)
  if (u.protocol !== 'https:' && !(env === 'test' && local && u.protocol === 'http:')) {
    throw errors.validation('url must use https (plain http is allowed only for localhost in the test environment).', 'url')
  }
  if (url.length > 2048) throw errors.validation('url too long', 'url')
}

export async function createWebhook(env: Env, agentId: string, url: string, eventTypes: string[] = ['*'], secret?: string): Promise<{ row: WebhookRow; secret: string }> {
  validateUrl(env, url)
  const count = await db().select({ n: sql<number>`count(*)` }).from(webhooks).where(and(eq(webhooks.env, env), eq(webhooks.agentId, agentId)))
  if ((count[0]?.n ?? 0) >= MAX_WEBHOOKS) throw errors.state('webhook_limit', `You already have ${MAX_WEBHOOKS} webhooks in this environment.`, 'Delete one with DELETE /v1/webhooks/{id}.')
  const types = [...new Set(eventTypes.map((t) => t.trim()).filter(Boolean))]
  const s = secret ?? `whsec_${randomHex(24)}`
  const now = Date.now()
  const row: typeof webhooks.$inferInsert = { id: newId('webhook'), env, agentId, url, eventTypes: types.length ? types : ['*'], secret: s, status: 'active', consecutiveFailures: 0, createdAt: now, updatedAt: now }
  await db().insert(webhooks).values(row)
  return { row: row as WebhookRow, secret: s }
}

export async function listWebhooks(env: Env, agentId: string): Promise<WebhookRow[]> {
  return db().query.webhooks.findMany({ where: and(eq(webhooks.env, env), eq(webhooks.agentId, agentId)), orderBy: [desc(webhooks.id)] })
}

export async function getWebhook(env: Env, agentId: string, id: string): Promise<WebhookRow> {
  const w = await db().query.webhooks.findFirst({ where: and(eq(webhooks.id, id), eq(webhooks.env, env), eq(webhooks.agentId, agentId)) })
  if (!w) throw errors.notFound('Webhook', id, 'GET /v1/webhooks lists yours.')
  return w
}

export async function deleteWebhook(env: Env, agentId: string, id: string): Promise<void> {
  const w = await getWebhook(env, agentId, id)
  await db().delete(webhookDeliveries).where(eq(webhookDeliveries.webhookId, w.id))
  await db().delete(webhooks).where(eq(webhooks.id, w.id))
}

export async function listDeliveries(webhookId: string, limit = 50): Promise<DeliveryRow[]> {
  return db().query.webhookDeliveries.findMany({ where: eq(webhookDeliveries.webhookId, webhookId), orderBy: [desc(webhookDeliveries.id)], limit })
}

function matches(types: string[], type: string): boolean {
  return types.includes('*') || types.includes(type) || types.some((t) => t.endsWith('.*') && type.startsWith(t.slice(0, -1)))
}

export async function enqueueDeliveries(event: EventRecord): Promise<number> {
  const hooks = await db().query.webhooks.findMany({ where: and(eq(webhooks.env, event.env), eq(webhooks.agentId, event.agentId), eq(webhooks.status, 'active')) })
  const due = hooks.filter((h) => matches(h.eventTypes, event.type))
  if (!due.length) return 0
  const now = Date.now()
  await db().insert(webhookDeliveries).values(due.map((h) => ({ id: newId('webhookDelivery'), webhookId: h.id, eventId: event.id, attempt: 0, status: 'pending' as const, nextAttemptAt: now, createdAt: now, updatedAt: now })))
  return due.length
}

export function signPayload(secret: string, timestamp: number, body: string): string {
  return `v1=${hmacSha256Hex(secret, `${timestamp}.${body}`)}`
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number }>

export async function deliverPending(now = Date.now(), fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<{ delivered: number; retried: number; failed: number }> {
  const due = await db().query.webhookDeliveries.findMany({ where: and(eq(webhookDeliveries.status, 'pending'), lte(webhookDeliveries.nextAttemptAt, now)), orderBy: [asc(webhookDeliveries.nextAttemptAt)], limit: 100 })
  const stats = { delivered: 0, retried: 0, failed: 0 }
  for (const d of due) {
    const hook = await db().query.webhooks.findFirst({ where: eq(webhooks.id, d.webhookId) })
    const ev = await db().query.events.findFirst({ where: eq(events.id, d.eventId) })
    if (!hook || !ev || hook.status !== 'active') {
      await db().update(webhookDeliveries).set({ status: 'failed', lastError: 'webhook disabled or event missing', updatedAt: now }).where(eq(webhookDeliveries.id, d.id))
      stats.failed++
      continue
    }
    const body = JSON.stringify({ id: ev.id, type: ev.type, created_at: new Date(ev.createdAt).toISOString(), agent_id: ev.agentId, env: ev.env, data: ev.data })
    const ts = Math.floor(now / 1000)
    const attempt = d.attempt + 1
    let status = 0
    let error: string | null = null
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS)
      try {
        const res = await fetchImpl(hook.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'user-agent': 'agentworld-webhooks/1.0', 'x-webhook-id': hook.id, 'x-webhook-timestamp': String(ts), 'x-webhook-signature': signPayload(hook.secret, ts, body), 'x-event-id': ev.id, 'x-event-type': ev.type },
          body,
          signal: controller.signal,
        })
        status = res.status
      } finally {
        clearTimeout(timer)
      }
    } catch (e) {
      error = (e as Error).message?.slice(0, 500) ?? 'request failed'
    }
    if (status >= 200 && status < 300) {
      await db().update(webhookDeliveries).set({ status: 'delivered', attempt, lastStatusCode: status, lastError: null, updatedAt: now }).where(eq(webhookDeliveries.id, d.id))
      if (hook.consecutiveFailures) await db().update(webhooks).set({ consecutiveFailures: 0, updatedAt: now }).where(eq(webhooks.id, hook.id))
      stats.delivered++
      continue
    }
    const err = error ?? `HTTP ${status}`
    if (attempt >= MAX_ATTEMPTS) {
      await db().update(webhookDeliveries).set({ status: 'failed', attempt, lastStatusCode: status || null, lastError: err, updatedAt: now }).where(eq(webhookDeliveries.id, d.id))
      const failures = hook.consecutiveFailures + 1
      await db().update(webhooks).set({ consecutiveFailures: failures, status: failures >= DISABLE_AFTER_FAILURES ? 'disabled' : 'active', updatedAt: now }).where(eq(webhooks.id, hook.id))
      stats.failed++
    } else {
      await db().update(webhookDeliveries).set({ attempt, lastStatusCode: status || null, lastError: err, nextAttemptAt: now + BACKOFF_MS[attempt - 1]!, updatedAt: now }).where(eq(webhookDeliveries.id, d.id))
      stats.retried++
    }
  }
  return stats
}

export async function sendTestEvent(env: Env, agentId: string, webhookId: string): Promise<{ event: EventRecord; result: Awaited<ReturnType<typeof deliverPending>> }> {
  const hook = await getWebhook(env, agentId, webhookId)
  const event = await emit(env, agentId, 'webhook.test', { webhook_id: hook.id, message: 'If you can read this, your webhook works. Verify X-Webhook-Signature = v1=hmac_sha256(secret, timestamp + "." + body).' })
  const result = await deliverPending(Date.now())
  return { event, result }
}

// --- feed -------------------------------------------------------------------------------------

export async function listFeed(env: Env, limit: number) {
  return db().query.feedItems.findMany({ where: eq(feedItems.env, env), orderBy: [desc(feedItems.id)], limit })
}

// --- wiring -----------------------------------------------------------------------------------

onEvent(async (e) => {
  for (const fn of subscribers.get(e.agentId) ?? []) {
    try {
      fn(e)
    } catch (err) {
      log.warn({ err }, 'sse subscriber failed')
    }
  }
  await enqueueDeliveries(e)
})

registerSweep('webhooks', async (now) => {
  await deliverPending(now)
})
