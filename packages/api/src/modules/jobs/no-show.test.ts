import { describe, it, expect, beforeEach } from 'vitest'
import { freshApp, call, createTestAgent, type TestAgent } from '../../test/setup.js'
import { installFakeChain } from '../../test/chain.js'
import { sweepJobs } from './service.js'
import type { App } from '../../app.js'

let app: App

beforeEach(async () => {
  app = await freshApp()
  installFakeChain('test')
})

const listing = async (seller: TestAgent, acceptSeconds = 60) => {
  const r = await call(app, 'POST', '/v1/listings', {
    key: seller.api_keys.test,
    body: { title: 'Live DNS probe', description: 'Probe SPF, DKIM and DMARC for a domain and report what resolves.', category: 'data', pricing_model: 'fixed', price: 400_000, input_schema: { type: 'object', required: ['domain'] }, accept_timeout_seconds: acceptSeconds },
  })
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  return r.body.id as string
}

const order = async (buyer: TestAgent, listingId: string) => {
  const r = await call(app, 'POST', '/v1/jobs', { key: buyer.api_keys.test, body: { listing_id: listingId, input: { domain: 'example.com' } } })
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  return r.body as { id: string; thread_id: string }
}

const sellerRecord = async (seller: TestAgent) => (await call(app, 'GET', `/v1/agents/${seller.agent.id}/reputation`)).body.test.as_seller

/**
 * The one order on this marketplace that ever looked like real demand between two outside agents - moneymaker to
 * veriton, 0.02 USDC, 2026-09-08 - expired because the seller never answered, and the seller's record stayed
 * spotless (ADR-41). A seller that can ignore orders for free is a marketplace that cannot work.
 */
describe('a seller that never answers (ADR-41)', () => {
  it('records an unanswered order, shows it on the listing, and says so in the thread', async () => {
    const seller = await createTestAgent(app, { name: 'Silent seller' })
    const buyer = await createTestAgent(app, { name: 'Buyer' })
    const l = await listing(seller)
    const job = await order(buyer, l)

    expect((await sellerRecord(seller)).orders_ignored).toBe(0)
    expect((await sellerRecord(seller)).response_rate).toBeNull()

    // the seller's own window passes without a word
    await sweepJobs(Date.now() + 61_000)
    expect((await call(app, 'GET', `/v1/jobs/${job.id}`, { key: buyer.api_keys.test })).body.status).toBe('expired')

    const rec = await sellerRecord(seller)
    expect(rec.orders_ignored).toBe(1)
    expect(rec.response_rate).toBe(0)
    expect(rec.jobs_failed).toBe(0) // nothing was ever started: not a failed delivery

    // a buyer reading the listing sees it before ordering
    const view = (await call(app, 'GET', `/v1/listings/${l}`, { key: buyer.api_keys.test })).body
    expect(view.seller.reputation.orders_ignored).toBe(1)
    expect(view.seller.reputation.response_rate).toBe(0)

    // and both sides are told what happened, in the seller's own terms
    const msgs = await call(app, 'GET', `/v1/threads/${job.thread_id}/messages?order=desc&limit=1`, { key: seller.api_keys.test })
    const text = String(msgs.body.data[0].body ?? '')
    expect(text).toContain('did not answer within its own accept window')
    expect(text).toContain('orders_ignored')
    expect(text).toContain('accept_timeout_seconds')
    expect(text).toContain('Nothing was charged')
  })

  it('counts declining as an answer: saying no is not ignoring', async () => {
    const seller = await createTestAgent(app, { name: 'Honest no' })
    const buyer = await createTestAgent(app, { name: 'Buyer' })
    const l = await listing(seller)
    const job = await order(buyer, l)
    expect((await call(app, 'POST', `/v1/jobs/${job.id}/decline`, { key: seller.api_keys.test, body: { reason: 'out of scope' } })).status).toBe(200)
    await sweepJobs(Date.now() + 61_000)

    const rec = await sellerRecord(seller)
    expect(rec.orders_ignored).toBe(0)
    expect(rec.response_rate).toBe(1)
  })

  it('does not blame the seller when the buyer is the one who went silent', async () => {
    const seller = await createTestAgent(app, { name: 'Answered' })
    const buyer = await createTestAgent(app, { name: 'Silent buyer' })
    const l = await listing(seller)
    const job = await order(buyer, l)
    await call(app, 'POST', `/v1/jobs/${job.id}/accept`, { key: seller.api_keys.test, body: {} })
    await call(app, 'POST', `/v1/jobs/${job.id}/deliver`, { key: seller.api_keys.test, body: { output: { spf: 'pass' } } })
    // the buyer never pays for the sealed delivery
    await sweepJobs(Date.now() + 40 * 86_400_000)

    const rec = await sellerRecord(seller)
    expect(rec.orders_ignored).toBe(0)
    expect(rec.response_rate).toBe(1)
    expect(rec.deliveries_unpaid).toBe(1) // the existing rule still owns this case
    const buyerRec = (await call(app, 'GET', `/v1/agents/${buyer.agent.id}/reputation`)).body.test.as_buyer
    expect(buyerRec.jobs_unpaid).toBe(1)
  })

  it('mixes answered and unanswered buyers into a rate a buyer can read', async () => {
    const seller = await createTestAgent(app, { name: 'Half there' })
    const answeredBuyer = await createTestAgent(app, { name: 'Buyer it answered' })
    const ignoredBuyer = await createTestAgent(app, { name: 'Buyer it ignored' })
    const l = await listing(seller)
    const answered = await order(answeredBuyer, l)
    await call(app, `POST`, `/v1/jobs/${answered.id}/accept`, { key: seller.api_keys.test, body: {} })
    await order(ignoredBuyer, l)
    await sweepJobs(Date.now() + 61_000)

    const rec = await sellerRecord(seller)
    expect(rec.orders_ignored).toBe(1)
    expect(rec.response_rate).toBe(0.5)
  })

  /*
   * ADR-45. Ordering costs nothing, so counting raw orders made this a weapon: an adversarial audit showed that any
   * agent could order from a competitor N times, let each expire, and drive the response_rate printed on all of its
   * listings to zero at no cost. Counted by distinct buyer wallet, one buyer can move a seller's record by one.
   */
  it('one buyer cannot damage a seller more than once, however many orders it lets expire', async () => {
    const seller = await createTestAgent(app, { name: 'Target' })
    const attacker = await createTestAgent(app, { name: 'Attacker' })
    const l = await listing(seller)
    for (let i = 0; i < 5; i++) await order(attacker, l)
    await sweepJobs(Date.now() + 61_000)

    const rec = await sellerRecord(seller)
    expect(rec.orders_ignored).toBe(1)
    expect(rec.response_rate).toBe(0)
  })

  it('a buyer that never bound a wallet, and so could never have paid, does not count against a seller', async () => {
    const seller = await createTestAgent(app, { name: 'Target' })
    const walletless = await createTestAgent(app, { name: 'Cannot pay', wallet_address: null })
    const l = await listing(seller)
    await order(walletless, l)
    await sweepJobs(Date.now() + 61_000)

    const rec = await sellerRecord(seller)
    expect(rec.orders_ignored).toBe(0)
    expect(rec.response_rate).toBe(null)
  })

  it('answering a buyer once means its later unanswered orders do not also count against the seller', async () => {
    const seller = await createTestAgent(app, { name: 'Answers sometimes' })
    const buyer = await createTestAgent(app, { name: 'Repeat buyer' })
    const l = await listing(seller)
    const first = await order(buyer, l)
    await call(app, `POST`, `/v1/jobs/${first.id}/accept`, { key: seller.api_keys.test, body: {} })
    await order(buyer, l)
    await order(buyer, l)
    await sweepJobs(Date.now() + 61_000)

    const rec = await sellerRecord(seller)
    expect(rec.orders_ignored).toBe(0)
    expect(rec.response_rate).toBe(1)
  })
})
