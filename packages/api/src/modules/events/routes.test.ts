import { describe, it, expect, beforeEach } from 'vitest'
import { installFakeChain } from '../../test/chain.js'
import { freshApp, call, createTestAgent } from '../../test/setup.js'
import type { App } from '../../app.js'
import { emit } from '../../events/bus.js'
import { deliverPending, signPayload, BACKOFF_MS, type FetchLike } from './service.js'
import { db } from '../../db/client.js'
import { webhooks } from '../../db/schema.js'
import { eq } from 'drizzle-orm'

let app: App
type Ag = Awaited<ReturnType<typeof createTestAgent>>
let a: Ag
let b: Ag

beforeEach(async () => {
  app = await freshApp()
  a = await createTestAgent(app, { name: 'Alice' })
  b = await createTestAgent(app, { name: 'Bob' })
})

describe('events', () => {
  it('lists my events with since cursor and type filter; env isolation', async () => {
    await emit('test', a.agent.id, 'job.created', { job_id: 'job_1' })
    await emit('test', a.agent.id, 'message.received', { thread_id: 'thr_1' })
    await emit('live', a.agent.id, 'job.created', { job_id: 'job_live' })
    await emit('test', b.agent.id, 'job.created', { job_id: 'job_b' })
    const all = await call(app, 'GET', '/v1/events', { key: a.api_keys.test })
    expect(all.body.data.map((e: any) => e.type)).toEqual(['job.created', 'message.received'])
    expect(all.body.next_since).toBe(all.body.data[1].id)
    const since = await call(app, 'GET', `/v1/events?since=${all.body.data[0].id}`, { key: a.api_keys.test })
    expect(since.body.data).toHaveLength(1)
    const typed = await call(app, 'GET', '/v1/events?types=job.created', { key: a.api_keys.test })
    expect(typed.body.data).toHaveLength(1)
    const live = await call(app, 'GET', '/v1/events', { key: a.api_keys.live })
    expect(live.body.data.some((e: any) => e.data.job_id === 'job_live')).toBe(true)
  })

  it('job actions produce events for the other party', async () => {
    const l = await call(app, 'POST', '/v1/listings', { key: b.api_keys.test, body: { title: 'Svc', description: 'Does the service you need quickly.', category: 'ops', pricing_model: 'fixed', price: 10 } })
    await call(app, 'POST', '/v1/jobs', { key: a.api_keys.test, body: { listing_id: l.body.id, input: {} } })
    const ev = await call(app, 'GET', '/v1/events', { key: b.api_keys.test })
    const types = ev.body.data.map((e: any) => e.type)
    expect(types).toContain('job.created')
    expect(types).toContain('message.received')
  })

  it('SSE stream sends ready then backlog', async () => {
    await emit('test', a.agent.id, 'job.created', { job_id: 'job_1' })
    const res = await app.request('/v1/events/stream', { headers: { authorization: `Bearer ${a.api_keys.test}` } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const reader = res.body!.getReader()
    let text = ''
    const decoder = new TextDecoder()
    for (let i = 0; i < 5 && !text.includes('job.created'); i++) {
      const { value, done } = await reader.read()
      if (done) break
      text += decoder.decode(value)
    }
    await reader.cancel()
    expect(text).toContain('event: ready')
    expect(text).toContain('event: job.created')
  })
})

describe('webhooks', () => {
  const mockFetch = (status: number, seen: any[] = []): FetchLike => async (url, init) => {
    seen.push({ url, init })
    return { status }
  }

  it('creates, lists, deletes; secret shown once; ownership 404; url validation', async () => {
    const bad = await call(app, 'POST', '/v1/webhooks', { key: a.api_keys.test, body: { url: 'http://example.com/hook' } })
    expect(bad.status).toBe(400)
    const w = await call(app, 'POST', '/v1/webhooks', { key: a.api_keys.test, body: { url: 'http://localhost:9999/hook', event_types: ['job.*', 'message.received'] } })
    expect(w.status).toBe(201)
    expect(w.body.secret).toMatch(/^whsec_/)
    const list = await call(app, 'GET', '/v1/webhooks', { key: a.api_keys.test })
    expect(list.body.data).toHaveLength(1)
    expect(JSON.stringify(list.body)).not.toContain(w.body.secret)
    expect((await call(app, 'GET', `/v1/webhooks/${w.body.id}/deliveries`, { key: b.api_keys.test })).status).toBe(404)
    expect((await call(app, 'DELETE', `/v1/webhooks/${w.body.id}`, { key: b.api_keys.test })).status).toBe(404)
    expect((await call(app, 'GET', '/v1/webhooks', { key: a.api_keys.live })).body.data).toHaveLength(0)
    const del = await call(app, 'DELETE', `/v1/webhooks/${w.body.id}`, { key: a.api_keys.test })
    expect(del.body.deleted).toBe(true)
  })

  it('delivers matching events with a valid signature; filters non-matching types', async () => {
    const seen: any[] = []
    const w = await call(app, 'POST', '/v1/webhooks', { key: a.api_keys.test, body: { url: 'http://localhost:9999/hook', event_types: ['job.*'], secret: 'my-shared-secret-1234' } })
    await emit('test', a.agent.id, 'job.created', { job_id: 'job_1' })
    await emit('test', a.agent.id, 'message.received', { thread_id: 'thr_1' })
    const now = Date.now()
    const r = await deliverPending(now, mockFetch(200, seen))
    expect(r.delivered).toBe(1)
    expect(seen).toHaveLength(1)
    const { init } = seen[0]
    expect(init.headers['x-webhook-id']).toBe(w.body.id)
    expect(init.headers['x-event-type']).toBe('job.created')
    const ts = Number(init.headers['x-webhook-timestamp'])
    expect(init.headers['x-webhook-signature']).toBe(signPayload('my-shared-secret-1234', ts, init.body))
    expect(JSON.parse(init.body).data.job_id).toBe('job_1')
    const deliveries = await call(app, 'GET', `/v1/webhooks/${w.body.id}/deliveries`, { key: a.api_keys.test })
    expect(deliveries.body.data[0].status).toBe('delivered')
  })

  it('retries with backoff, fails after 5 attempts, disables after 20 failed deliveries', async () => {
    const w = await call(app, 'POST', '/v1/webhooks', { key: a.api_keys.test, body: { url: 'http://localhost:9999/hook' } })
    await emit('test', a.agent.id, 'job.created', { job_id: 'job_1' })
    let now = Date.now()
    let r = await deliverPending(now, mockFetch(500))
    expect(r.retried).toBe(1)
    let d = (await call(app, 'GET', `/v1/webhooks/${w.body.id}/deliveries`, { key: a.api_keys.test })).body.data[0]
    expect(d.attempt).toBe(1)
    expect(new Date(d.next_attempt_at).getTime()).toBe(now + BACKOFF_MS[0]!)
    r = await deliverPending(now + 1000, mockFetch(500))
    expect(r.retried + r.delivered + r.failed).toBe(0)
    for (let i = 1; i < 5; i++) {
      now += BACKOFF_MS[i - 1]! + 1
      r = await deliverPending(now, mockFetch(503))
    }
    d = (await call(app, 'GET', `/v1/webhooks/${w.body.id}/deliveries`, { key: a.api_keys.test })).body.data[0]
    expect(d.status).toBe('failed')
    expect(d.attempt).toBe(5)
    const hook = (await call(app, 'GET', '/v1/webhooks', { key: a.api_keys.test })).body.data[0]
    expect(hook.consecutive_failures).toBe(1)
    expect(hook.status).toBe('active')
    await db().update(webhooks).set({ consecutiveFailures: 19 }).where(eq(webhooks.id, w.body.id))
    await emit('test', a.agent.id, 'job.created', { job_id: 'job_2' })
    for (let i = 0; i < 5; i++) {
      now += (BACKOFF_MS[i - 1] ?? 0) + 1
      await deliverPending(now, mockFetch(500))
    }
    const disabled = (await call(app, 'GET', '/v1/webhooks', { key: a.api_keys.test })).body.data[0]
    expect(disabled.status).toBe('disabled')
    // recovery resets failures
    const w2 = await call(app, 'POST', '/v1/webhooks', { key: a.api_keys.test, body: { url: 'http://localhost:9999/hook2' } })
    await db().update(webhooks).set({ consecutiveFailures: 3 }).where(eq(webhooks.id, w2.body.id))
    await emit('test', a.agent.id, 'job.created', { job_id: 'job_3' })
    await deliverPending(now + 1, mockFetch(204))
    const recovered = (await call(app, 'GET', '/v1/webhooks', { key: a.api_keys.test })).body.data.find((x: any) => x.id === w2.body.id)
    expect(recovered.consecutive_failures).toBe(0)
  })

  it('test endpoint emits and attempts delivery', async () => {
    const w = await call(app, 'POST', '/v1/webhooks', { key: a.api_keys.test, body: { url: 'http://localhost:1/unreachable' } })
    const t = await call(app, 'POST', `/v1/webhooks/${w.body.id}/test`, { key: a.api_keys.test })
    expect(t.status).toBe(200)
    expect(t.body.event_id).toMatch(/^evt_/)
    expect(t.body.retried).toBe(1)
  })

  it('public feed shows listings and completed jobs', async () => {
    const l = await call(app, 'POST', '/v1/listings', { key: b.api_keys.test, body: { title: 'Feed me', description: 'A service that appears in the feed.', category: 'ops', pricing_model: 'fixed', price: 10 } })
    const j = await call(app, 'POST', '/v1/jobs', { key: a.api_keys.test, body: { listing_id: l.body.id, input: {} } })
    await call(app, 'POST', `/v1/jobs/${j.body.id}/accept`, { key: b.api_keys.test })
    await call(app, 'POST', `/v1/jobs/${j.body.id}/deliver`, { key: b.api_keys.test, body: { output: 1 } })
    const chain = installFakeChain('test')
    await call(app, 'POST', `/v1/jobs/${j.body.id}/pay`, { key: a.api_keys.test, body: { transaction: chain.pay(a.wallet_address!, b.wallet_address!, 10) } })
    await call(app, 'POST', `/v1/jobs/${j.body.id}/accept`, { key: a.api_keys.test })
    const feed = await call(app, 'GET', '/v1/feed?env=test')
    expect(feed.body.data.map((f: any) => f.type)).toEqual(['job.completed', 'listing.created'])
    expect((await call(app, 'GET', '/v1/feed')).body.data).toHaveLength(0)
  })
})
