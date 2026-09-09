import { describe, it, expect, beforeEach } from 'vitest'
import { installFakeChain, FakeChain } from '../../test/chain.js'
import { _setRpcFetchForTests } from '../payments/chain.js'
import { freshApp, call, createTestAgent } from '../../test/setup.js'
import { _setConfigForTests } from '../../config.js'
import type { App } from '../../app.js'
import { backfillReputation, bayesianRating, scoreOf, emptySide, reviewWeight, weightedRating } from './service.js'
import { db } from '../../db/client.js'
import { agentReputation } from '../../db/schema.js'
import { sql } from 'drizzle-orm'

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
  it('splits counterparties and volume into first-party and third-party (ADR-32) and labels machine-generated reviews', async () => {
    _setConfigForTests({ ADMIN_TOKEN: 'adm-token-1234567890' })
    try {
      const desk = await createTestAgent(app, { name: 'Souk Desk' })
      expect((await call(app, 'POST', `/v1/admin/agents/${desk.agent.id}/first-party`, { headers: { 'x-admin-token': 'adm-token-1234567890' }, body: { first_party: true } })).status).toBe(200)

      // 1. the platform desk is the only buyer: everything counts as first party
      const j1 = await completedJob('test', seller, desk, 20_000)
      const machine = await call(app, 'POST', `/v1/jobs/${j1.id}/reviews`, { key: desk.api_keys.test, body: { rating: 3, comment: 'Graded by an automated judge against the listing text.', machine_generated: true } })
      expect(machine.status).toBe(201)
      expect(machine.body.machine_generated).toBe(true)
      let rep = (await call(app, 'GET', `/v1/agents/${seller.agent.id}/reputation`)).body
      expect(rep.test.as_seller).toMatchObject({ jobs_completed: 1, distinct_counterparties: 1, first_party_counterparties: 1, third_party_counterparties: 0, volume_usdc: 20_000, third_party_volume_usdc: 0 })
      let listing = (await call(app, 'GET', `/v1/listings/${j1.listing_id}`, { key: buyer.api_keys.test })).body
      expect(listing.seller.reputation).toMatchObject({ jobs_completed: 1, distinct_counterparties: 1, third_party_counterparties: 0 })
      let lb = (await call(app, 'GET', '/v1/leaderboard?env=test')).body
      expect(lb.data[0]).toMatchObject({ agent: { id: seller.agent.id }, distinct_counterparties: 1, third_party_counterparties: 0, rank_value: 0 })

      // 2. a real buyer pays: the third-party numbers move, the first-party ones do not
      const j2 = await completedJob('test', seller, buyer, 30_000)
      const human = await call(app, 'POST', `/v1/jobs/${j2.id}/reviews`, { key: buyer.api_keys.test, body: { rating: 5, comment: 'chosen by me' } })
      expect(human.status).toBe(201)
      expect(human.body.machine_generated).toBe(false)
      rep = (await call(app, 'GET', `/v1/agents/${seller.agent.id}/reputation`)).body
      expect(rep.test.as_seller).toMatchObject({ jobs_completed: 2, distinct_counterparties: 2, first_party_counterparties: 1, third_party_counterparties: 1, volume_usdc: 50_000, third_party_volume_usdc: 30_000 })
      listing = (await call(app, 'GET', `/v1/listings/${j2.listing_id}`, { key: buyer.api_keys.test })).body
      expect(listing.seller.reputation).toMatchObject({ jobs_completed: 2, distinct_counterparties: 2, third_party_counterparties: 1 })
      lb = (await call(app, 'GET', '/v1/leaderboard?env=test')).body
      // ADR-45: rank_value is THIRD-PARTY volume x third-party counterparties. It used to be total volume, so this
      // seller ranked at 50_000 - the 20_000 our own desk paid it counted as demand, which the method text denied.
      expect(lb.data[0]).toMatchObject({ agent: { id: seller.agent.id }, third_party_counterparties: 1, rank_value: 30_000 })
      expect(lb.method).toContain('third_party_counterparties')

      // 3. the desk's own buyer side: the seller is a third party to it
      const deskRep = (await call(app, 'GET', `/v1/agents/${desk.agent.id}/reputation`)).body
      expect(deskRep.test.as_buyer).toMatchObject({ jobs_completed: 1, distinct_counterparties: 1, first_party_counterparties: 0, third_party_counterparties: 1, third_party_volume_usdc: 20_000 })

      // 4. the label is public on the list and in the event the subject received
      const list = (await call(app, 'GET', `/v1/agents/${seller.agent.id}/reviews`)).body
      expect(list.data.map((r: any) => r.machine_generated).sort()).toEqual([false, true])
      const events = (await call(app, 'GET', '/v1/events?types=review.received', { key: seller.api_keys.test })).body
      expect(events.data.map((e: any) => e.data.machine_generated).sort()).toEqual([false, true])

      // 5. the attestation carries the split too
      const att = (await call(app, 'GET', `/v1/agents/${seller.agent.id}/reputation/attestation?env=test`)).body
      expect(att.attestation.reputation.as_seller).toMatchObject({ third_party_counterparties: 1, first_party_counterparties: 1 })
    } finally {
      _setConfigForTests({ ADMIN_TOKEN: undefined })
    }
  })
  it('labels every first_party review machine_generated server-side, classifies free jobs, recomputes on flag changes and backfills old rows (ADR-32 review)', async () => {
    _setConfigForTests({ ADMIN_TOKEN: 'adm-token-1234567890' })
    try {
      const desk = await createTestAgent(app, { name: 'Souk Desk' })
      const flag = (id: string, first_party: boolean) => call(app, 'POST', `/v1/admin/agents/${id}/first-party`, { headers: { 'x-admin-token': 'adm-token-1234567890' }, body: { first_party } })
      expect((await flag(desk.agent.id, true)).status).toBe(200)

      // 1. a first_party reviewer that sends nothing (or false) is still labelled: the API enforces the public rule
      const j1 = await completedJob('test', seller, desk, 20_000)
      const silent = await call(app, 'POST', `/v1/jobs/${j1.id}/reviews`, { key: desk.api_keys.test, body: { rating: 4, comment: 'no flag sent', machine_generated: false } })
      expect(silent.status).toBe(201)
      expect(silent.body.machine_generated).toBe(true)
      const ev = (await call(app, 'GET', '/v1/events?types=review.received', { key: seller.api_keys.test })).body
      expect(ev.data[0].data.machine_generated).toBe(true)

      // 2. free jobs count, but on their own (ADR-45): a counterparty that never paid is not a paying third party.
      // Until then N throwaway registrations doing N jobs at price 0 produced N "third_party_counterparties" - the
      // very field GET /v1/commitments points buyers at as the honest demand signal.
      const other = await createTestAgent(app, { name: 'Free Rider' })
      await completedJob('test', seller, desk, 0)
      await completedJob('test', seller, other, 0)
      let rep = (await call(app, 'GET', `/v1/agents/${seller.agent.id}/reputation`)).body
      expect(rep.test.as_seller).toMatchObject({ jobs_completed: 3, distinct_counterparties: 2, first_party_counterparties: 1, third_party_counterparties: 0, counterparties_without_payment: 1, third_party_volume_usdc: 0 })

      // 3. the buyer-role leaderboard lists the desk, labelled, with the seller as its third party
      const buyers = (await call(app, 'GET', '/v1/leaderboard?env=test&role=buyer')).body
      expect(buyers.data.find((x: any) => x.agent.id === desk.agent.id)).toMatchObject({ agent: { first_party: true }, third_party_counterparties: 1, rank_value: 20_000 })

      // 4. un-flagging the desk recomputes the seller: everything becomes third party
      expect((await flag(desk.agent.id, false)).status).toBe(200)
      rep = (await call(app, 'GET', `/v1/agents/${seller.agent.id}/reputation`)).body
      expect(rep.test.as_seller).toMatchObject({ first_party_counterparties: 0, third_party_counterparties: 1, counterparties_without_payment: 1, third_party_volume_usdc: 20_000 })
      expect((await flag(desk.agent.id, true)).status).toBe(200)
      rep = (await call(app, 'GET', `/v1/agents/${seller.agent.id}/reputation`)).body
      expect(rep.test.as_seller).toMatchObject({ first_party_counterparties: 1, third_party_counterparties: 0, counterparties_without_payment: 1 })

      // 5. a row written before the split reports null (never a made-up 0) until the startup backfill recomputes it
      await db().run(sql`update agent_reputation set as_seller = json_remove(as_seller, '$.third_party_counterparties', '$.first_party_counterparties', '$.third_party_volume_usdc') where agent_id = ${seller.agent.id} and env = 'test'`)
      rep = (await call(app, 'GET', `/v1/agents/${seller.agent.id}/reputation`)).body
      expect(rep.test.as_seller).toMatchObject({ distinct_counterparties: 2, first_party_counterparties: null, third_party_counterparties: null, third_party_volume_usdc: null })
      const listing = (await call(app, 'GET', `/v1/listings/${j1.listing_id}`, { key: buyer.api_keys.test })).body
      expect(listing.seller.reputation.third_party_counterparties).toBeNull()
      const lb = (await call(app, 'GET', '/v1/leaderboard?env=test')).body
      expect(lb.data.find((x: any) => x.agent.id === seller.agent.id)).toMatchObject({ third_party_counterparties: null, rank_value: 20_000 * 2 })
      expect(await backfillReputation()).toEqual({ recomputed: 1, errors: 0 })
      rep = (await call(app, 'GET', `/v1/agents/${seller.agent.id}/reputation`)).body
      expect(rep.test.as_seller).toMatchObject({ first_party_counterparties: 1, third_party_counterparties: 0, counterparties_without_payment: 1, third_party_volume_usdc: 0 })
      expect(await backfillReputation()).toEqual({ recomputed: 0, errors: 0 })
      const rows = await db().select().from(agentReputation)
      expect(rows.every((r) => r.asSeller.third_party_counterparties != null)).toBe(true)
    } finally {
      _setConfigForTests({ ADMIN_TOKEN: undefined })
    }
  })

  it('trust tier 1 needs third-party wallets and volume: the platform desk buying does not count (ADR-32)', async () => {
    _setConfigForTests({ ADMIN_TOKEN: 'adm-token-1234567890' })
    try {
      const desk = await createTestAgent(app, { name: 'Souk Desk' })
      expect((await call(app, 'POST', `/v1/admin/agents/${desk.agent.id}/first-party`, { headers: { 'x-admin-token': 'adm-token-1234567890' }, body: { first_party: true } })).status).toBe(200)
      const outsiders = [buyer, await createTestAgent(app, { name: 'B2' })]
      // 5 completed live jobs, 3 paying wallets and 10 USDC, but one wallet and 6 USDC of it are the desk's
      await completedJob('live', seller, desk, 3_000_000)
      await completedJob('live', seller, desk, 3_000_000)
      await completedJob('live', seller, outsiders[0]!, 2_000_000)
      await completedJob('live', seller, outsiders[1]!, 2_000_000)
      await completedJob('live', seller, outsiders[0]!, 1_000_000)
      let rep = (await call(app, 'GET', `/v1/agents/${seller.agent.id}/reputation`)).body
      expect(rep.live.as_seller).toMatchObject({ jobs_completed: 5, distinct_counterparties: 3, third_party_counterparties: 2, volume_usdc: 11_000_000, third_party_volume_usdc: 5_000_000 })
      expect(rep.trust_tier).toBe(0)
      // a third outside wallet and enough third-party volume: tier 1
      const b3 = await createTestAgent(app, { name: 'B3' })
      await completedJob('live', seller, b3, 5_000_000)
      rep = (await call(app, 'GET', `/v1/agents/${seller.agent.id}/reputation`)).body
      expect(rep.live.as_seller).toMatchObject({ third_party_counterparties: 3, third_party_volume_usdc: 10_000_000 })
      expect(rep.trust_tier).toBe(1)
    } finally {
      _setConfigForTests({ ADMIN_TOKEN: undefined })
    }
  })
  it('suggested exposure (ADR-34): floor without third-party history, grows with third-party volume, shrinks with failures, pinned while a refund is open', async () => {
    _setConfigForTests({ ADMIN_TOKEN: 'adm-token-1234567890' })
    try {
      const desk = await createTestAgent(app, { name: 'Souk Desk' })
      expect((await call(app, 'POST', `/v1/admin/agents/${desk.agent.id}/first-party`, { headers: { 'x-admin-token': 'adm-token-1234567890' }, body: { first_party: true } })).status).toBe(200)
      // no history: the floor
      let rep = (await call(app, 'GET', `/v1/agents/${seller.agent.id}/reputation`)).body
      expect(rep.test.exposure).toMatchObject({ suggested_max_usdc: 100_000, display: '0.100000 USDC', basis: { third_party_volume_usdc: 0, third_party_counterparties: 0 } })
      expect(rep.test.exposure.method).toContain('clamp')
      expect(rep.test.exposure.note).toContain('not a limit')
      // the desk pays 5 USDC: still the floor (first-party volume adds nothing)
      await completedJob('test', seller, desk, 5_000_000)
      rep = (await call(app, 'GET', `/v1/agents/${seller.agent.id}/reputation`)).body
      expect(rep.test.exposure.suggested_max_usdc).toBe(100_000)
      expect(rep.test.exposure.reason).toContain('platform desk do not count')
      // a third party pays 2 USDC: 0.10 + 0.5 × 2 = 1.10 USDC
      const paid = await completedJob('test', seller, buyer, 2_000_000)
      rep = (await call(app, 'GET', `/v1/agents/${seller.agent.id}/reputation`)).body
      expect(rep.test.exposure).toMatchObject({ suggested_max_usdc: 1_100_000, basis: { third_party_volume_usdc: 2_000_000, third_party_counterparties: 1, jobs_completed: 2 } })
      const listing = (await call(app, 'GET', `/v1/listings/${paid.listing_id}`, { key: buyer.api_keys.test })).body
      expect(listing.seller.reputation.suggested_max_exposure_usdc).toBe(1_100_000)
      // the attestation carries it
      const att = (await call(app, 'GET', `/v1/agents/${seller.agent.id}/reputation/attestation?env=test`)).body
      expect(att.attestation.reputation.exposure.suggested_max_usdc).toBe(1_100_000)
      // a failed job halves the earned part: 2 completed + 1 failed -> rate 1/3 -> 0.10 + 1.0 × 2/3 = 0.7667
      const l = await call(app, 'POST', '/v1/listings', { key: seller.api_keys.test, body: { title: 'Svc', description: 'Does a service for you reliably.', category: 'ops', pricing_model: 'fixed', price: 1000 } })
      const j = await call(app, 'POST', '/v1/jobs', { key: buyer.api_keys.test, body: { listing_id: l.body.id, input: {} } })
      await call(app, 'POST', `/v1/jobs/${j.body.id}/accept`, { key: seller.api_keys.test })
      expect((await call(app, 'POST', `/v1/jobs/${j.body.id}/cancel`, { key: seller.api_keys.test, body: { reason: 'cannot' } })).body.status).toBe('cancelled')
      rep = (await call(app, 'GET', `/v1/agents/${seller.agent.id}/reputation`)).body
      expect(rep.test.exposure.suggested_max_usdc).toBe(766_667)
      expect(rep.test.exposure.basis.jobs_cancelled).toBe(1)
    } finally {
      _setConfigForTests({ ADMIN_TOKEN: undefined })
    }
  })
})
