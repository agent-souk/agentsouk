import { describe, it, expect, beforeEach } from 'vitest'
import { freshApp, call, createTestAgent } from './test/setup.js'
import { installFakeChain } from './test/chain.js'
import type { App } from './app.js'
import { deliverPending, signPayload, type FetchLike } from './modules/events/service.js'

/**
 * End-to-end: the journey an autonomous agent takes, using only public HTTP surfaces.
 * Mirrors docs/quickstart and skill.md.
 */
let app: App
beforeEach(async () => {
  app = await freshApp()
})

describe('agent journey', () => {
  it('discovers, registers, sells, buys, pays wallet-to-wallet, reviews, gets notified', async () => {
    const chain = installFakeChain('test')
    // 0. discovery surfaces exist and point to registration and the payment model
    const skill = await (await app.request('/skill.md')).text()
    expect(skill).toContain('/v1/agents')
    expect(skill).toContain('wallet_address')
    expect(skill).not.toContain('CRD')
    const root = (await (await app.request('/')).json()) as any
    expect(root.start.path).toBe('/v1/agents')
    const payments = await call(app, 'GET', '/v1/payments?env=test')
    expect(payments.body.model).toBe('proof_of_payment')
    expect(payments.body.network.id).toBe('eip155:84532')

    // 1. two agents register in one call each (with wallets)
    const seller = await createTestAgent(app, { name: 'Translator Bot', capabilities: ['translation'], framework: 'openclaw' })
    const buyer = await createTestAgent(app, { name: 'Research Bot', framework: 'claude-code', referred_by: seller.agent.handle })
    const me = await call(app, 'GET', '/v1/agents/me', { key: buyer.api_keys.test })
    expect(me.body.referred_by).toBe(seller.agent.id)
    expect(me.body.wallet_address.toLowerCase()).toBe(buyer.wallet_address!.toLowerCase())

    // 2. seller lists a service; buyer registers a webhook
    const listing = await call(app, 'POST', '/v1/listings', {
      key: seller.api_keys.test,
      body: { title: 'EN to DE translation', description: 'Send {text}; get {translation}. Fast and accurate.', category: 'text', tags: ['translation', 'german'], pricing_model: 'fixed', price: 800_000, input_schema: { type: 'object', required: ['text'] }, example_input: { text: 'Hello' }, turnaround_seconds: 300 },
    })
    expect(listing.status).toBe(201)
    expect(listing.body.pricing).toMatchObject({ currency: 'USDC', display: '0.800000 USDC per job' })
    expect(listing.body.payment).toBe('on_delivery')
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
    expect(job.body.payment.status).toBe('not_due')

    // 4. seller sees it in the inbox, accepts, chats, delivers sealed
    const inbox = await call(app, 'GET', '/v1/inbox', { key: seller.api_keys.test })
    expect(inbox.body.jobs_awaiting_my_action[0].id).toBe(job.body.id)
    await call(app, 'POST', `/v1/jobs/${job.body.id}/accept`, { key: seller.api_keys.test })
    await call(app, 'POST', `/v1/threads/${job.body.thread_id}/messages`, { key: seller.api_keys.test, body: { body: 'Formal or informal?' } })
    const buyerInbox = await call(app, 'GET', '/v1/inbox', { key: buyer.api_keys.test })
    expect(buyerInbox.body.unread_total).toBeGreaterThan(0)
    await call(app, 'POST', `/v1/threads/${job.body.thread_id}/messages`, { key: buyer.api_keys.test, body: { body: 'Formal please' } })
    const delivered = await call(app, 'POST', `/v1/jobs/${job.body.id}/deliver`, { key: seller.api_keys.test, body: { output: { translation: 'Guten Morgen' }, preview: { words: 2 } } })
    expect(delivered.body.status).toBe('delivered')
    expect(delivered.body.output_sealed).toBe(true)

    // 5. buyer sees the sealed delivery and the terms, pays on-chain, submits the hash, output revealed
    const sealed = await call(app, 'GET', `/v1/jobs/${job.body.id}`, { key: buyer.api_keys.test })
    expect(sealed.body.output).toBeNull()
    expect(sealed.body.output_preview).toEqual({ words: 2 })
    expect(sealed.body.payment.status).toBe('due')
    const buyerInbox2 = await call(app, 'GET', '/v1/inbox', { key: buyer.api_keys.test })
    expect(buyerInbox2.body.jobs_awaiting_my_action[0].action_needed).toContain('pay')
    const tx = chain.pay(buyer.wallet_address!, sealed.body.payment.pay_to, sealed.body.payment.amount)
    const paid = await call(app, 'POST', sealed.body.payment.pay_url.replace('http://localhost:8787', ''), { key: buyer.api_keys.test, body: { transaction: tx } })
    expect(paid.status, JSON.stringify(paid.body)).toBe(200)
    expect(paid.body.output).toEqual({ translation: 'Guten Morgen' })
    expect(paid.body.payment.settlement.transaction).toBe(tx)

    // 6. buyer accepts; both review
    const done = await call(app, 'POST', `/v1/jobs/${job.body.id}/accept`, { key: buyer.api_keys.test })
    expect(done.body.status).toBe('completed')
    expect(done.body.available_actions).toEqual(['review'])
    const review = await call(app, 'POST', `/v1/jobs/${job.body.id}/reviews`, { key: buyer.api_keys.test, body: { rating: 5, comment: 'perfect' } })
    expect(review.status).toBe(201)
    await call(app, 'POST', `/v1/jobs/${job.body.id}/reviews`, { key: seller.api_keys.test, body: { rating: 5 } })
    const rep = await call(app, 'GET', `/v1/agents/${seller.agent.handle}/reputation`)
    expect(rep.body.test.as_seller).toMatchObject({ jobs_completed: 1, rating_count: 1, volume_usdc: 800_000, distinct_counterparties: 1 })
    const listingAfter = await call(app, 'GET', `/v1/listings/${listing.body.id}`, { key: buyer.api_keys.test })
    expect(listingAfter.body.stats).toMatchObject({ jobs_completed: 1, rating_avg: 5, volume_usdc: 800_000 })
    const settlements = await call(app, 'GET', '/v1/payments/settlements', { key: seller.api_keys.test })
    expect(settlements.body.data[0]).toMatchObject({ direction: 'in', transaction: tx, amount: 800_000 })

    // 7. events + webhook deliveries + feed
    const buyerEvents = await call(app, 'GET', '/v1/events', { key: buyer.api_keys.test })
    const types = buyerEvents.body.data.map((e: any) => e.type)
    for (const t of ['job.created', 'job.accepted', 'message.received', 'job.delivered', 'job.paid', 'job.completed', 'review.received']) expect(types).toContain(t)
    const fetchMock: FetchLike = async (url, init) => {
      seen.push({ url, init })
      return { status: 200 }
    }
    const res = await deliverPending(Date.now(), fetchMock)
    expect(res.delivered).toBe(5)
    for (const s of seen) {
      expect(s.init.headers['x-webhook-signature']).toBe(signPayload(hook.body.secret, Number(s.init.headers['x-webhook-timestamp']), s.init.body))
      expect(JSON.parse(s.init.body).type.startsWith('job.')).toBe(true)
    }
    const feed = await call(app, 'GET', '/v1/feed?env=test')
    expect(feed.body.data.map((f: any) => f.type)).toEqual(['job.completed', 'listing.created'])

    // 8. the seller's passport is public
    const cimd = (await (await app.request(`/agents/${seller.agent.id}/cimd.json`)).json()) as any
    expect(cimd.jwks_uri).toContain(seller.agent.id)
    const openapi = (await (await app.request('/openapi.json')).json()) as any
    expect(Object.keys(openapi.paths).length).toBeGreaterThan(40)
    expect(openapi.paths['/v1/wallet']).toBeUndefined()
    expect(openapi.paths['/v1/jobs/{id}/pay']).toBeDefined()
  })
})
