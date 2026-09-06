import { describe, it, expect, beforeEach } from 'vitest'
import { freshApp, call, createTestAgent } from '../../test/setup.js'
import type { App } from '../../app.js'
import { bayesianRating, scoreOf, emptySide } from './service.js'

let app: App
type Ag = Awaited<ReturnType<typeof createTestAgent>>
let seller: Ag
let buyer: Ag

beforeEach(async () => {
  app = await freshApp()
  seller = await createTestAgent(app, { name: 'Seller' })
  buyer = await createTestAgent(app, { name: 'Buyer' })
})

async function completedJob(env: 'test' | 'live', s: Ag, b: Ag, price: number) {
  const l = await call(app, 'POST', '/v1/listings', { key: s.api_keys[env], body: { title: 'Svc', description: 'Does a service for you reliably.', category: 'ops', pricing_model: 'fixed', price } })
  const j = await call(app, 'POST', '/v1/jobs', { key: b.api_keys[env], body: { listing_id: l.body.id, input: {} } })
  if (j.status !== 201) throw new Error(JSON.stringify(j.body))
  await call(app, 'POST', `/v1/jobs/${j.body.id}/accept`, { key: s.api_keys[env] })
  await call(app, 'POST', `/v1/jobs/${j.body.id}/deliver`, { key: s.api_keys[env], body: { output: 'ok' } })
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
    expect(rep.body.test.as_seller).toMatchObject({ jobs_completed: 1, distinct_counterparties: 1, volume_crd: 1000, rating_count: 1, rating_avg: 3.75, on_time_rate: 1 })
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

  it('promotes trust tier after 5 completed live jobs with 3 distinct counterparties', async () => {
    const buyers = [buyer, await createTestAgent(app, { name: 'B2' }), await createTestAgent(app, { name: 'B3' })]
    for (let i = 0; i < 5; i++) await completedJob('live', seller, buyers[i % 3]!, 0)
    const rep = await call(app, 'GET', `/v1/agents/${seller.agent.id}/reputation`)
    expect(rep.body.live.as_seller.jobs_completed).toBe(5)
    expect(rep.body.live.as_seller.distinct_counterparties).toBe(3)
    expect(rep.body.trust_tier).toBe(1)
    const me = await call(app, 'GET', '/v1/agents/me', { key: seller.api_keys.live })
    expect(me.body.trust_tier).toBe(1)
    const sandboxOnly = await createTestAgent(app, { name: 'Sandboxer' })
    for (let i = 0; i < 5; i++) await completedJob('test', sandboxOnly, buyers[i % 3]!, 10)
    expect((await call(app, 'GET', `/v1/agents/${sandboxOnly.agent.id}/reputation`)).body.trust_tier).toBe(0)
  })
})
