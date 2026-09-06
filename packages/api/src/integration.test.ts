import { describe, it, expect, beforeEach } from 'vitest'
import { freshApp, call, createTestAgent } from './test/setup.js'
import type { App } from './app.js'
import { deliverPending, signPayload, type FetchLike } from './modules/events/service.js'
import { Ledger } from './ledger/ledger.js'
import { db } from './db/client.js'
import { platformAccount } from './modules/wallet/service.js'
import { REFERRAL_TEST_BONUS } from './modules/agents/service.js'

/**
 * End-to-end: the journey an autonomous agent takes, using only public HTTP surfaces.
 * Mirrors docs/quickstart and skill.md.
 */
let app: App
beforeEach(async () => {
  app = await freshApp()
})

describe('agent journey', () => {
  it('discovers, registers, sells, buys, pays, reviews, gets notified', async () => {
    // 0. discovery surfaces exist and point to registration
    const skill = await (await app.request('/skill.md')).text()
    expect(skill).toContain('/v1/agents')
    const root = (await (await app.request('/')).json()) as any
    expect(root.start.path).toBe('/v1/agents')

    // 1. two agents register in one call each
    const seller = await createTestAgent(app, { name: 'Translator Bot', capabilities: ['translation'], framework: 'openclaw' })
    const buyer = await createTestAgent(app, { name: 'Research Bot', framework: 'claude-code', referred_by: seller.agent.handle })
    const me = await call(app, 'GET', '/v1/agents/me', { key: buyer.api_keys.test })
    expect(me.body.referred_by).toBe(seller.agent.id)

    // 2. seller lists a service; buyer registers a webhook
    const listing = await call(app, 'POST', '/v1/listings', {
      key: seller.api_keys.test,
      body: { title: 'EN to DE translation', description: 'Send {text}; get {translation}. Fast and accurate.', category: 'text', tags: ['translation', 'german'], pricing_model: 'fixed', price: 800, input_schema: { type: 'object', required: ['text'] }, example_input: { text: 'Hello' }, turnaround_seconds: 300 },
    })
    expect(listing.status).toBe(201)
    const seen: any[] = []
    const hook = await call(app, 'POST', '/v1/webhooks', { key: buyer.api_keys.test, body: { url: 'http://localhost:9999/hook', event_types: ['job.*'] } })
    expect(hook.status).toBe(201)

    // 3. buyer finds the listing and orders exactly what how_to_order says
    const search = await call(app, 'GET', '/v1/listings?q=german+translation', { key: buyer.api_keys.test })
    expect(search.body.data[0].id).toBe(listing.body.id)
    const order = search.body.data[0].how_to_order
    const job = await call(app, 'POST', order.path, { key: buyer.api_keys.test, body: { ...order.body_example, input: { text: 'Good morning' } } })
    expect(job.status).toBe(201)
    expect(job.body.status).toBe('open')
    const buyerWallet = await call(app, 'GET', '/v1/wallet', { key: buyer.api_keys.test })
    expect(buyerWallet.body.balances[0]).toMatchObject({ available: 100_000 - 800, in_escrow: 800 })

    // 4. seller sees it in the inbox, accepts, chats, delivers
    const inbox = await call(app, 'GET', '/v1/inbox', { key: seller.api_keys.test })
    expect(inbox.body.jobs_awaiting_my_action[0].id).toBe(job.body.id)
    await call(app, 'POST', `/v1/jobs/${job.body.id}/accept`, { key: seller.api_keys.test })
    await call(app, 'POST', `/v1/threads/${job.body.thread_id}/messages`, { key: seller.api_keys.test, body: { body: 'Formal or informal?' } })
    const buyerInbox = await call(app, 'GET', '/v1/inbox', { key: buyer.api_keys.test })
    expect(buyerInbox.body.unread_total).toBeGreaterThan(0)
    await call(app, 'POST', `/v1/threads/${job.body.thread_id}/messages`, { key: buyer.api_keys.test, body: { body: 'Formal please' } })
    const delivered = await call(app, 'POST', `/v1/jobs/${job.body.id}/deliver`, { key: seller.api_keys.test, body: { output: { translation: 'Guten Morgen' } } })
    expect(delivered.body.status).toBe('delivered')

    // 5. buyer accepts; money moves; both review
    const done = await call(app, 'POST', `/v1/jobs/${job.body.id}/accept`, { key: buyer.api_keys.test })
    expect(done.body.status).toBe('completed')
    expect(done.body.available_actions).toEqual(['review'])
    const sellerWallet = await call(app, 'GET', '/v1/wallet', { key: seller.api_keys.test })
    expect(sellerWallet.body.balances[0].available).toBe(100_000 + REFERRAL_TEST_BONUS + 800 - 24)
    expect(await new Ledger(db()).balance('test', platformAccount('fees'))).toBe(24)
    const review = await call(app, 'POST', `/v1/jobs/${job.body.id}/reviews`, { key: buyer.api_keys.test, body: { rating: 5, comment: 'perfect' } })
    expect(review.status).toBe(201)
    await call(app, 'POST', `/v1/jobs/${job.body.id}/reviews`, { key: seller.api_keys.test, body: { rating: 5 } })
    const rep = await call(app, 'GET', `/v1/agents/${seller.agent.handle}/reputation`)
    expect(rep.body.test.as_seller).toMatchObject({ jobs_completed: 1, rating_count: 1, volume_crd: 800 })
    const listingAfter = await call(app, 'GET', `/v1/listings/${listing.body.id}`, { key: buyer.api_keys.test })
    expect(listingAfter.body.stats).toMatchObject({ jobs_completed: 1, rating_avg: 5 })

    // 6. events + webhook deliveries + feed
    const buyerEvents = await call(app, 'GET', '/v1/events', { key: buyer.api_keys.test })
    const types = buyerEvents.body.data.map((e: any) => e.type)
    for (const t of ['job.created', 'job.accepted', 'message.received', 'job.delivered', 'job.completed', 'review.received']) expect(types).toContain(t)
    const fetchMock: FetchLike = async (url, init) => {
      seen.push({ url, init })
      return { status: 200 }
    }
    const res = await deliverPending(Date.now(), fetchMock)
    expect(res.delivered).toBe(4)
    for (const s of seen) {
      expect(s.init.headers['x-webhook-signature']).toBe(signPayload(hook.body.secret, Number(s.init.headers['x-webhook-timestamp']), s.init.body))
      expect(JSON.parse(s.init.body).type.startsWith('job.')).toBe(true)
    }
    const feed = await call(app, 'GET', '/v1/feed?env=test')
    expect(feed.body.data.map((f: any) => f.type)).toEqual(['job.completed', 'listing.created'])

    // 7. the seller's passport is public
    const cimd = (await (await app.request(`/agents/${seller.agent.id}/cimd.json`)).json()) as any
    expect(cimd.jwks_uri).toContain(seller.agent.id)
    const openapi = (await (await app.request('/openapi.json')).json()) as any
    expect(Object.keys(openapi.paths).length).toBeGreaterThan(40)
  })
})
