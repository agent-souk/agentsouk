import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { freshApp, call, createTestAgent, type TestAgent } from '../../test/setup.js'
import { installFakeChain, type FakeChain } from '../../test/chain.js'
import type { App } from '../../app.js'
import { _setConfigForTests, config } from '../../config.js'
import { sweepJobs } from '../jobs/service.js'

/**
 * Milestone series (ADR-33): one contract as N ordinary jobs. The platform creates milestone k+1 when k completes,
 * stops the series when a milestone fails, the next one cannot be created, or a party asks. No money mechanism.
 */

let app: App
let chain: FakeChain
let seller: TestAgent
let buyer: TestAgent
const PRICE = 250_000
const ADMIN = 'test-admin-token-1234567890'

beforeEach(async () => {
  app = await freshApp()
  chain = installFakeChain('test')
  seller = await createTestAgent(app, { name: 'Seller' })
  buyer = await createTestAgent(app, { name: 'Buyer' })
})
afterEach(() => _setConfigForTests({ ADMIN_TOKEN: undefined }))

async function makeListing(over: Record<string, unknown> = {}) {
  const r = await call(app, 'POST', '/v1/listings', {
    key: seller.api_keys.test,
    body: { title: 'Translate', description: 'Translate EN to DE. Send {text}, receive {translation}.', category: 'text', pricing_model: 'fixed', price: PRICE, input_schema: { type: 'object', required: ['text'] }, turnaround_seconds: 600, accept_timeout_seconds: 600, ...over },
  })
  if (r.status !== 201) throw new Error(JSON.stringify(r.body))
  return r.body as { id: string }
}
const act = (a: TestAgent, id: string, action: string, body: Record<string, unknown> = {}) => call(app, 'POST', `/v1/jobs/${id}/${action}`, { key: a.api_keys.test, body })
const series = (a: TestAgent, id: string) => call(app, 'GET', `/v1/series/${id}`, { key: a.api_keys.test })
const order = async (listingId: string, body: Record<string, unknown>) => call(app, 'POST', '/v1/jobs', { key: buyer.api_keys.test, body: { listing_id: listingId, ...body } })
const steps = (...texts: string[]) => texts.map((text) => ({ input: { text } }))

/** seller accepts + delivers sealed, buyer pays and accepts: the milestone completes */
async function completeMilestone(jobId: string, price = PRICE) {
  expect((await act(seller, jobId, 'accept')).status).toBe(200)
  expect((await act(seller, jobId, 'deliver', { output: { translation: 'ok' } })).status).toBe(200)
  if (price > 0) expect((await act(buyer, jobId, 'pay', { transaction: chain.pay(buyer.wallet_address!, seller.wallet_address!, price) })).status).toBe(200)
  const done = await act(buyer, jobId, 'accept')
  expect(done.body.status).toBe('completed')
  return done.body
}

describe('milestone series (ADR-33)', () => {
  it('creates milestone 1 as an ordinary job, validates the whole plan, creates the next step on completion and completes the series after the last', async () => {
    const l = await makeListing()
    const r = await order(l.id, { title: 'Big translation', milestones: [{ input: { text: 'a' } }, { input: { text: 'b' }, title: 'Step B' }, { input: { text: 'c' } }] })
    expect(r.status).toBe(201)
    expect(r.body.series).toEqual({ id: expect.stringMatching(/^ser_/), index: 1, count: 3 })
    expect(r.body.title).toBe('Big translation (1/3)')
    expect(r.body.status).toBe('open')
    expect(r.body.price).toBe(PRICE)
    expect(r.body.next_steps.some((s: any) => s.path === `/v1/series/${r.body.series.id}`)).toBe(true)
    const sid = r.body.series.id as string

    // both parties see the plan; a stranger does not
    const asBuyer = await series(buyer, sid)
    expect(asBuyer.status).toBe(200)
    expect(asBuyer.body).toMatchObject({ object: 'series', role: 'buyer', status: 'active', count: 3, current_index: 1, listing_id: l.id, buyer: { id: buyer.agent.id }, seller: { id: seller.agent.id }, totals: { price_total: 3 * PRICE, paid_total: 0, completed: 0 }, stopped_by: null })
    expect(asBuyer.body.milestones.map((m: any) => [m.index, m.status, m.job_id != null, m.price])).toEqual([[1, 'open', true, PRICE], [2, 'pending', false, PRICE], [3, 'pending', false, PRICE]])
    expect(asBuyer.body.milestones[1].title).toBe('Step B')
    expect(asBuyer.body.milestones[0].job_id).toBe(r.body.id)
    expect((await series(seller, sid)).body.role).toBe('seller')
    const stranger = await createTestAgent(app, { name: 'Stranger' })
    expect((await series(stranger, sid)).status).toBe(404)
    const created = (await call(app, 'GET', '/v1/events?types=series.created', { key: seller.api_keys.test })).body
    expect(created.data[0].data).toMatchObject({ series_id: sid, count: 3, job_id: r.body.id, price_total: 3 * PRICE })
    // the seller's thread note says which milestone this is
    const thread = (await call(app, 'GET', `/v1/threads/${r.body.thread_id}/messages`, { key: seller.api_keys.test })).body
    expect(thread.data.some((m: any) => String(m.body).includes('milestone 1 of 3'))).toBe(true)

    // milestone 1 completes: milestone 2 exists, with the planned input and title
    await completeMilestone(r.body.id)
    let s = (await series(buyer, sid)).body
    expect(s).toMatchObject({ status: 'active', current_index: 2, totals: { paid_total: PRICE, completed: 1 } })
    expect(s.milestones[1]).toMatchObject({ index: 2, status: 'open', title: 'Step B' })
    const job2 = (await call(app, 'GET', `/v1/jobs/${s.milestones[1].job_id}`, { key: seller.api_keys.test })).body
    expect(job2).toMatchObject({ status: 'open', title: 'Step B', input: { text: 'b' }, series: { id: sid, index: 2, count: 3 }, price: PRICE })
    const advanced = (await call(app, 'GET', '/v1/events?types=series.advanced', { key: buyer.api_keys.test })).body
    expect(advanced.data[0].data).toMatchObject({ series_id: sid, index: 2, job_id: job2.id, previous_job_id: r.body.id })
    // the seller was told about the new job like any other
    const sellerJobs = (await call(app, 'GET', '/v1/events?types=job.created', { key: seller.api_keys.test })).body
    expect(sellerJobs.data.map((e: any) => e.data.milestone_index).sort()).toEqual([1, 2])

    // milestones 2 and 3 complete: the series completes, nothing more is created
    await completeMilestone(job2.id)
    s = (await series(buyer, sid)).body
    expect(s.current_index).toBe(3)
    await completeMilestone(s.milestones[2].job_id)
    s = (await series(buyer, sid)).body
    expect(s).toMatchObject({ status: 'completed', totals: { paid_total: 3 * PRICE, completed: 3 } })
    expect(s.completed_at).not.toBeNull()
    expect((await call(app, 'GET', '/v1/events?types=series.completed', { key: seller.api_keys.test })).body.data).toHaveLength(1)
    const mine = (await call(app, 'GET', '/v1/series?status=completed', { key: buyer.api_keys.test })).body
    expect(mine.data.map((x: any) => x.id)).toEqual([sid])
    expect((await call(app, 'GET', '/v1/series?status=active', { key: buyer.api_keys.test })).body.data).toEqual([])
    // three completed jobs, one counterparty: reputation counts every milestone
    const rep = (await call(app, 'GET', `/v1/agents/${seller.agent.id}/reputation`)).body
    expect(rep.test.as_seller).toMatchObject({ jobs_completed: 3, volume_usdc: 3 * PRICE, distinct_counterparties: 1 })
  })

  it('validates the plan up front: step count, input xor milestones, a step missing a required field is named', async () => {
    const l = await makeListing()
    expect((await order(l.id, { milestones: steps('a') })).status).toBe(400)
    expect((await order(l.id, { milestones: steps(...Array.from({ length: 21 }, (_, i) => `s${i}`)) })).status).toBe(400)
    const both = await order(l.id, { input: { text: 'x' }, milestones: steps('a', 'b') })
    expect(both.status).toBe(400)
    expect((await order(l.id, {})).status).toBe(400)
    const bad = await order(l.id, { milestones: [{ input: { text: 'a' } }, { input: { nope: 1 } }] })
    expect(bad.status).toBe(400)
    expect(bad.body.error.message).toContain('milestone 2')
    expect(bad.body.error.param).toBe('milestones[1].input')
    // nothing was created by the rejected plans
    expect((await call(app, 'GET', '/v1/series', { key: buyer.api_keys.test })).body.data).toEqual([])
    expect((await call(app, 'GET', '/v1/jobs', { key: buyer.api_keys.test })).body.data).toEqual([])
    // an ordinary job still works exactly as before
    const one = await order(l.id, { input: { text: 'solo' } })
    expect(one.status).toBe(201)
    expect(one.body.series).toBeNull()
  })

  it('a declined milestone stops the series; either party can stop after a step; the job in flight is untouched; stop is idempotent', async () => {
    const l = await makeListing()
    const a = (await order(l.id, { milestones: steps('a', 'b', 'c') })).body
    expect((await act(seller, a.id, 'decline', { reason: 'busy' })).status).toBe(200)
    let s = (await series(buyer, a.series.id)).body
    expect(s).toMatchObject({ status: 'stopped', stopped_by: 'platform', current_index: 1 })
    expect(s.stopped_reason).toContain('milestone 1 of 3 ended as declined')
    expect(s.milestones[1].job_id).toBeNull()
    expect((await call(app, 'GET', '/v1/events?types=series.stopped', { key: buyer.api_keys.test })).body.data[0].data).toMatchObject({ series_id: a.series.id, stopped_by: 'platform' })

    const b = (await order(l.id, { milestones: steps('a', 'b', 'c') })).body
    await completeMilestone(b.id)
    s = (await series(seller, b.series.id)).body
    expect(s.current_index).toBe(2)
    const job2 = s.milestones[1].job_id as string
    const stopped = await call(app, 'POST', `/v1/series/${b.series.id}/stop`, { key: buyer.api_keys.test, body: { reason: 'enough for now' } })
    expect(stopped.status).toBe(200)
    expect(stopped.body).toMatchObject({ status: 'stopped', stopped_by: 'buyer', stopped_reason: 'buyer: enough for now' })
    // the job in flight is still a normal job and completing it creates nothing further
    expect((await call(app, 'GET', `/v1/jobs/${job2}`, { key: seller.api_keys.test })).body.status).toBe('open')
    await completeMilestone(job2)
    s = (await series(buyer, b.series.id)).body
    expect(s).toMatchObject({ status: 'stopped', current_index: 2, totals: { completed: 2 } })
    expect(s.milestones[2].job_id).toBeNull()
    // idempotent, and the seller may stop too
    expect((await call(app, 'POST', `/v1/series/${b.series.id}/stop`, { key: buyer.api_keys.test })).body.stopped_reason).toBe('buyer: enough for now')
    const c = (await order(l.id, { milestones: steps('a', 'b') })).body
    const sellerStop = await call(app, 'POST', `/v1/series/${c.series.id}/stop`, { key: seller.api_keys.test, body: {} })
    expect(sellerStop.body).toMatchObject({ status: 'stopped', stopped_by: 'seller', stopped_reason: 'seller: stopped' })
    const stranger = await createTestAgent(app, { name: 'Stranger' })
    expect((await call(app, 'POST', `/v1/series/${c.series.id}/stop`, { key: stranger.api_keys.test, body: {} })).status).toBe(404)
  })

  it('per-unit steps carry their own units and prices; quote listings quote every step; free listings need no payment and auto-complete by sweep', async () => {
    const perUnit = await makeListing({ pricing_model: 'per_unit', price: 1000, unit_name: 'word' })
    const p = (await order(perUnit.id, { milestones: [{ input: { text: 'a' }, units: 10 }, { input: { text: 'b' }, units: 25 }] })).body
    expect(p.status).toBe('open')
    expect(p.units).toBe(10)
    expect(p.price).toBe(10_000)
    let s = (await series(buyer, p.series.id)).body
    expect(s.milestones.map((m: any) => [m.units, m.price])).toEqual([[10, 10_000], [25, 25_000]])
    expect(s.totals.price_total).toBe(35_000)

    const quote = await makeListing({ pricing_model: 'quote', price: null })
    const q = (await order(quote.id, { milestones: steps('a', 'b') })).body
    expect(q.status).toBe('quote_requested')
    expect(q.price).toBeNull()
    s = (await series(buyer, q.series.id)).body
    expect(s.totals.price_total).toBeNull()
    expect(s.milestones[0].price).toBeNull()

    const free = await makeListing({ price: 0 })
    const f = (await order(free.id, { milestones: steps('a', 'b') })).body
    expect(f.price).toBe(0)
    expect((await act(seller, f.id, 'accept')).status).toBe(200)
    expect((await act(seller, f.id, 'deliver', { output: { translation: 'frei' } })).status).toBe(200)
    const swept = await sweepJobs(Date.now() + config().REVIEW_WINDOW_SECONDS_TEST * 1000 + 1000)
    expect(swept.auto_completed).toBe(1)
    s = (await series(buyer, f.series.id)).body
    expect(s).toMatchObject({ status: 'active', current_index: 2, totals: { price_total: 0, paid_total: 0, completed: 1 } })
    expect(s.milestones[1].status).toBe('open')
  })

  it('when the next milestone cannot be created (listing paused) the series stops and says why; an expired milestone stops it too', async () => {
    const l = await makeListing()
    const a = (await order(l.id, { milestones: steps('a', 'b') })).body
    expect((await act(seller, a.id, 'accept')).status).toBe(200)
    expect((await act(seller, a.id, 'deliver', { output: { translation: 'ok' } })).status).toBe(200)
    expect((await act(buyer, a.id, 'pay', { transaction: chain.pay(buyer.wallet_address!, seller.wallet_address!, PRICE) })).status).toBe(200)
    expect((await call(app, 'PATCH', `/v1/listings/${l.id}`, { key: seller.api_keys.test, body: { status: 'paused' } })).status).toBe(200)
    expect((await act(buyer, a.id, 'accept')).body.status).toBe('completed') // the job itself completes regardless
    const s = (await series(buyer, a.series.id)).body
    expect(s).toMatchObject({ status: 'stopped', stopped_by: 'platform', current_index: 1, totals: { completed: 1, paid_total: PRICE } })
    expect(s.stopped_reason).toContain('listing_unavailable')
    expect(s.milestones[1].job_id).toBeNull()

    expect((await call(app, 'PATCH', `/v1/listings/${l.id}`, { key: seller.api_keys.test, body: { status: 'active' } })).status).toBe(200)
    // a price change between milestones is a new deal: the series stops instead of silently charging the new price
    const c = (await order(l.id, { milestones: steps('a', 'b') })).body
    await completeMilestone(c.id)
    expect((await series(buyer, c.series.id)).body.current_index).toBe(2)
    const d = (await order(l.id, { milestones: steps('a', 'b') })).body
    expect((await act(seller, d.id, 'accept')).status).toBe(200)
    expect((await act(seller, d.id, 'deliver', { output: { translation: 'ok' } })).status).toBe(200)
    expect((await act(buyer, d.id, 'pay', { transaction: chain.pay(buyer.wallet_address!, seller.wallet_address!, PRICE) })).status).toBe(200)
    expect((await call(app, 'PATCH', `/v1/listings/${l.id}`, { key: seller.api_keys.test, body: { price: PRICE * 2 } })).status).toBe(200)
    expect((await act(buyer, d.id, 'accept')).body.status).toBe('completed')
    const sd = (await series(buyer, d.series.id)).body
    expect(sd.status).toBe('stopped')
    expect(sd.stopped_reason).toContain('listing_price_changed')
    expect(sd.milestones[1].job_id).toBeNull()
    expect((await call(app, 'PATCH', `/v1/listings/${l.id}`, { key: seller.api_keys.test, body: { price: PRICE } })).status).toBe(200)
    const b = (await order(l.id, { milestones: steps('a', 'b') })).body
    const swept = await sweepJobs(Date.now() + 601_000)
    expect(swept.expired).toBeGreaterThanOrEqual(1)
    const sb = (await series(seller, b.series.id)).body
    expect(sb.status).toBe('stopped')
    expect(sb.stopped_reason).toContain('ended as expired')
  })

  it('a dispute resolved for the buyer stops the series; resolved split advances it', async () => {
    _setConfigForTests({ ADMIN_TOKEN: ADMIN })
    const l = await makeListing()
    const a = (await order(l.id, { milestones: steps('a', 'b', 'c') })).body
    expect((await act(seller, a.id, 'accept')).status).toBe(200)
    expect((await act(seller, a.id, 'deliver', { output: { translation: 'meh' } })).status).toBe(200)
    expect((await act(buyer, a.id, 'pay', { transaction: chain.pay(buyer.wallet_address!, seller.wallet_address!, PRICE) })).status).toBe(200)
    expect((await act(buyer, a.id, 'dispute', { reason: 'wrong language' })).status).toBe(200)
    // no evaluators in a fresh sandbox: escalated, the operator decides
    const split = await call(app, 'POST', `/v1/admin/jobs/${a.id}/resolve`, { headers: { 'x-admin-token': ADMIN }, body: { outcome: 'split', note: 'half right' } })
    expect(split.status).toBe(200)
    let s = (await series(buyer, a.series.id)).body
    expect(s).toMatchObject({ status: 'active', current_index: 2, totals: { completed: 1 } })
    const job2 = s.milestones[1].job_id as string
    expect((await act(seller, job2, 'accept')).status).toBe(200)
    expect((await act(seller, job2, 'deliver', { output: { translation: 'bad' } })).status).toBe(200)
    expect((await act(buyer, job2, 'pay', { transaction: chain.pay(buyer.wallet_address!, seller.wallet_address!, PRICE) })).status).toBe(200)
    expect((await act(buyer, job2, 'dispute', { reason: 'empty' })).status).toBe(200)
    expect((await call(app, 'POST', `/v1/admin/jobs/${job2}/resolve`, { headers: { 'x-admin-token': ADMIN }, body: { outcome: 'buyer', note: 'nothing delivered' } })).status).toBe(200)
    s = (await series(buyer, a.series.id)).body
    expect(s).toMatchObject({ status: 'stopped', stopped_by: 'platform', current_index: 2 })
    expect(s.stopped_reason).toContain('milestone 2 of 3 ended as resolved')
    expect(s.milestones[2].job_id).toBeNull()
  })
})
