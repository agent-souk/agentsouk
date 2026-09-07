import { describe, it, expect, beforeEach } from 'vitest'
import { installFakeChain, FakeChain } from '../../test/chain.js'
import { _setRpcFetchForTests } from '../payments/chain.js'
import { freshApp, call, createTestAgent } from '../../test/setup.js'
import type { App } from '../../app.js'
import { bayesianRating, scoreOf, emptySide, reviewWeight, weightedRating } from './service.js'

let app: App
type Ag = Awaited<ReturnType<typeof createTestAgent>>
let seller: Ag
let buyer: Ag
let chain: FakeChain
let liveChain: FakeChain

beforeEach(async () => {
  app = await freshApp()
  chain = installFakeChain('test')
  liveChain = new FakeChain('live')
  seller = await createTestAgent(app, { name: 'Seller' })
  buyer = await createTestAgent(app, { name: 'Buyer' })
})

async function completedJob(env: 'test' | 'live', s: Ag, b: Ag, price: number) {
  const l = await call(app, 'POST', '/v1/listings', { key: s.api_keys[env], body: { title: 'Svc', description: 'Does a service for you reliably.', category: 'ops', pricing_model: 'fixed', price } })
  const j = await call(app, 'POST', '/v1/jobs', { key: b.api_keys[env], body: { listing_id: l.body.id, input: {} } })
  if (j.status !== 201) throw new Error(JSON.stringify(j.body))
  await call(app, 'POST', `/v1/jobs/${j.body.id}/accept`, { key: s.api_keys[env] })
  await call(app, 'POST', `/v1/jobs/${j.body.id}/deliver`, { key: s.api_keys[env], body: { output: 'ok' } })
  if (price > 0) {
    const c = env === 'live' ? liveChain : chain
    _setRpcFetchForTests(c.fetch)
    const paid = await call(app, 'POST', `/v1/jobs/${j.body.id}/pay`, { key: b.api_keys[env], body: { transaction: c.pay(b.wallet_address!, s.wallet_address!, price, { confirmations: env === 'live' ? 3 : 1 }) } })
    _setRpcFetchForTests(chain.fetch)
    if (paid.status !== 200) throw new Error('not paid: ' + JSON.stringify(paid.body))
  }
  const done = await call(app, 'POST', `/v1/jobs/${j.body.id}/accept`, { key: b.api_keys[env] })
  if (done.body.status !== 'completed') throw new Error('not completed: ' + JSON.stringify(done.body))
  return j.body as { id: string; listing_id: string }
}

describe('reviews & reputation', () => {
  it('math helpers', () => {
    expect(bayesianRating(0, 0)).toBeNull()
    expect(bayesianRating(5, 1)).toBe(3.75)
    expect(bayesianRating(25, 5)).toBe(4.25)
    expect(scoreOf(emptySide(), emptySide())).toBe(20)
  })

  it('reviews only settled jobs, once per party, updates reputation and listing stats', async () => {
    const l = await call(app, 'POST', '/v1/listings', { key: seller.api_keys.test, body: { title: 'Svc', description: 'Does a service for you reliably.', category: 'ops', pricing_model: 'fixed', price: 1000 } })
    const j = await call(app, 'POST', '/v1/jobs', { key: buyer.api_keys.test, body: { listing_id: l.body.id, input: {} } })
    const early = await call(app, 'POST', `/v1/jobs/${j.body.id}/reviews`, { key: buyer.api_keys.test, body: { rating: 5 } })
    expect(early.status).toBe(409)
    expect(early.body.error.code).toBe('job_not_settled')
    await call(app, 'POST', `/v1/jobs/${j.body.id}/accept`, { key: seller.api_keys.test })
    await call(app, 'POST', `/v1/jobs/${j.body.id}/deliver`, { key: seller.api_keys.test, body: { output: 'ok' } })
    await call(app, 'POST', `/v1/jobs/${j.body.id}/pay`, { key: buyer.api_keys.test, body: { transaction: chain.pay(buyer.wallet_address!, seller.wallet_address!, 1000) } })
    await call(app, 'POST', `/v1/jobs/${j.body.id}/accept`, { key: buyer.api_keys.test })

    const rev = await call(app, 'POST', `/v1/jobs/${j.body.id}/reviews`, { key: buyer.api_keys.test, body: { rating: 5, comment: 'great' } })
    expect(rev.status).toBe(201)
    expect(rev.body.role).toBe('buyer')
    expect(rev.body.subject_id).toBe(seller.agent.id)
    expect(rev.body.job_value).toBe(1000)
    const again = await call(app, 'POST', `/v1/jobs/${j.body.id}/reviews`, { key: buyer.api_keys.test, body: { rating: 1 } })
    expect(again.status).toBe(409)
    const bySeller = await call(app, 'POST', `/v1/jobs/${j.body.id}/reviews`, { key: seller.api_keys.test, body: { rating: 4, comment: 'paid promptly' } })
    expect(bySeller.status).toBe(201)
    expect(bySeller.body.role).toBe('seller')
    const stranger = await createTestAgent(app, { name: 'Stranger' })
    expect((await call(app, 'POST', `/v1/jobs/${j.body.id}/reviews`, { key: stranger.api_keys.test, body: { rating: 5 } })).status).toBe(404)

    const rep = await call(app, 'GET', `/v1/agents/${seller.agent.handle}/reputation`)
    expect(rep.status).toBe(200)
    expect(rep.body.test.as_seller).toMatchObject({ jobs_completed: 1, distinct_counterparties: 1, volume_usdc: 1000, rating_count: 1, rating_avg: 3.75, on_time_rate: 1 })
    expect(rep.body.test.score).toBeGreaterThan(20)
    expect(rep.body.live.as_seller.jobs_completed).toBe(0)
    expect(rep.body.trust_tier).toBe(0)
    const buyerRep = await call(app, 'GET', `/v1/agents/${buyer.agent.id}/reputation`)
    expect(buyerRep.body.test.as_buyer).toMatchObject({ jobs_completed: 1, rating_count: 1 })

    const list = await call(app, 'GET', `/v1/agents/${seller.agent.id}/reviews?env=test`)
    expect(list.body.data).toHaveLength(1)
    expect(list.body.data[0].reviewer.handle).toBe('buyer')
    const listing = await call(app, 'GET', `/v1/listings/${l.body.id}`, { key: buyer.api_keys.test })
    expect(listing.body.stats.rating_avg).toBe(5)
    expect(listing.body.stats.rating_count).toBe(1)
    const ev = await call(app, 'GET', '/v1/events', { key: seller.api_keys.test })
    expect([200, 404]).toContain(ev.status)
  })

  it('promotes trust tier after 5 completed PAID live jobs from 3 distinct paying wallets; free jobs do not count', async () => {
    const buyers = [buyer, await createTestAgent(app, { name: 'B2' }), await createTestAgent(app, { name: 'B3' })]
    for (let i = 0; i < 5; i++) await completedJob('live', seller, buyers[i % 3]!, 0)
    expect((await call(app, 'GET', `/v1/agents/${seller.agent.id}/reputation`)).body.trust_tier).toBe(0)
    for (let i = 0; i < 5; i++) await completedJob('live', seller, buyers[i % 3]!, 2_000_000) // 10 USDC total: the T1 volume floor
    const rep = await call(app, 'GET', `/v1/agents/${seller.agent.id}/reputation`)
    expect(rep.body.live.as_seller.jobs_completed).toBe(10)
    expect(rep.body.live.as_seller.distinct_counterparties).toBe(3)
    expect(rep.body.trust_tier).toBe(1)
    const me = await call(app, 'GET', '/v1/agents/me', { key: seller.api_keys.live })
    expect(me.body.trust_tier).toBe(1)
    const sandboxOnly = await createTestAgent(app, { name: 'Sandboxer' })
    for (let i = 0; i < 5; i++) await completedJob('test', sandboxOnly, buyers[i % 3]!, 10)
    expect((await call(app, 'GET', `/v1/agents/${sandboxOnly.agent.id}/reputation`)).body.trust_tier).toBe(0)
  })

  it('ADR-27 math: one counterparty is one vote, weighted by what it paid', () => {
    expect(reviewWeight(0)).toBe(1)
    expect(reviewWeight(1_000_000)).toBe(3)
    expect(reviewWeight(100_000_000)).toBe(5)
    expect(weightedRating([])).toBeNull()
    // one reviewer, two reviews: averaged to one vote of weight 1 -> (3 + 17.5) / 6
    expect(weightedRating([{ reviewerAgentId: 'a', rating: 5, jobPrice: 0 }, { reviewerAgentId: 'a', rating: 1, jobPrice: 0 }])).toBe(3.42)
    // a free 1-star vote (weight 1) against a 1-USDC 5-star vote (weight 3)
    expect(weightedRating([{ reviewerAgentId: 'a', rating: 1, jobPrice: 0 }, { reviewerAgentId: 'b', rating: 5, jobPrice: 1_000_000 }])).toBe(3.72)
  })

  it('ADR-27: weighted rating, per-category cards and the seller summary on listings', async () => {
    const paying = buyer
    const freeloader = await createTestAgent(app, { name: 'Freeloader' })
    const paidJob = await completedJob('test', seller, paying, 5_000_000)
    expect((await call(app, 'POST', `/v1/jobs/${paidJob.id}/reviews`, { key: paying.api_keys.test, body: { rating: 5 } })).status).toBe(201)
    const freeJob = await completedJob('test', seller, freeloader, 0)
    expect((await call(app, 'POST', `/v1/jobs/${freeJob.id}/reviews`, { key: freeloader.api_keys.test, body: { rating: 1 } })).status).toBe(201)

    const rep = (await call(app, 'GET', `/v1/agents/${seller.agent.id}/reputation`)).body
    expect(rep.test.as_seller).toMatchObject({ jobs_completed: 2, rating_count: 2, rating_avg: 3.36, rating_weighted: 3.81, volume_usdc: 5_000_000 })
    expect(rep.test.as_seller.categories).toEqual([{ category: 'ops', jobs_completed: 2, jobs_failed: 0, volume_usdc: 5_000_000, rating_avg: 3.81, rating_count: 2, on_time_rate: 1 }])
    expect(rep.test.as_buyer.categories).toEqual([])
    expect(rep.live.as_seller).toMatchObject({ rating_weighted: null, categories: [] })
    expect(rep.explain).toContain('rating_weighted')

    // the listing carries the seller summary, with the card for its own category
    const listing = (await call(app, 'GET', `/v1/listings/${paidJob.listing_id}`, { key: paying.api_keys.test })).body
    expect(listing.seller).toMatchObject({ id: seller.agent.id, verified_domain: null, reputation: { jobs_completed: 2, rating: 3.81, distinct_counterparties: 2, in_category: { jobs_completed: 2, jobs_failed: 0, rating: 3.81, on_time_rate: 1 } } })
    expect(listing.seller.reputation.score).toBeGreaterThan(20)
    const other = await call(app, 'POST', '/v1/listings', { key: seller.api_keys.test, body: { title: 'Translate', description: 'A text service with no history yet in this category.', category: 'text', pricing_model: 'fixed', price: 1000 } })
    const search = (await call(app, 'GET', '/v1/listings?q=translate&env=test')).body
    expect(search.data[0].id).toBe(other.body.id)
    expect(search.data[0].seller.reputation).toMatchObject({ jobs_completed: 2, in_category: null })
    const newcomer = await createTestAgent(app, { name: 'Newcomer' })
    const fresh = await call(app, 'POST', '/v1/listings', { key: newcomer.api_keys.test, body: { title: 'Brand new', description: 'No finished jobs anywhere yet, so no reputation.', category: 'ops', pricing_model: 'fixed', price: 1000 } })
    expect((await call(app, 'GET', `/v1/listings/${fresh.body.id}?env=test`)).body.seller.reputation).toBeNull()
  })
})
