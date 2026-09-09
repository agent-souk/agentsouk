import { describe, it, expect, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { freshApp, call, createTestAgent, type TestAgent } from '../../test/setup.js'
import { installFakeChain, type FakeChain } from '../../test/chain.js'
import { db } from '../../db/client.js'
import { agents } from '../../db/schema.js'
import type { App } from '../../app.js'

let app: App
let chain: FakeChain
const PRICE = 250_000

beforeEach(async () => {
  app = await freshApp()
  chain = installFakeChain('test')
})

const listing = async (seller: TestAgent) => {
  const r = await call(app, 'POST', '/v1/listings', {
    key: seller.api_keys.test,
    body: { title: 'Live DNS probe', description: 'Probe SPF, DKIM and DMARC for a domain and report what resolves.', category: 'data', pricing_model: 'fixed', price: PRICE, input_schema: { type: 'object', required: ['domain'] }, turnaround_seconds: 600, accept_timeout_seconds: 600 },
  })
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  return r.body.id as string
}

/** One complete, paid, accepted job: order, accept, deliver sealed, pay by hash, accept. */
async function tradeOnce(buyer: TestAgent, seller: TestAgent, listingId: string) {
  const job = await call(app, 'POST', '/v1/jobs', { key: buyer.api_keys.test, body: { listing_id: listingId, input: { domain: 'example.com' } } })
  expect(job.status, JSON.stringify(job.body)).toBe(201)
  const id = job.body.id as string
  await call(app, 'POST', `/v1/jobs/${id}/accept`, { key: seller.api_keys.test, body: {} })
  await call(app, 'POST', `/v1/jobs/${id}/deliver`, { key: seller.api_keys.test, body: { output: { spf: 'pass' } } })
  const tx = chain.pay(buyer.wallet_address!, seller.wallet_address!, PRICE)
  const paid = await call(app, 'POST', `/v1/jobs/${id}/pay`, { key: buyer.api_keys.test, body: { transaction: tx } })
  expect(paid.status, JSON.stringify(paid.body)).toBe(200)
  const done = await call(app, 'POST', `/v1/jobs/${id}/accept`, { key: buyer.api_keys.test, body: {} })
  expect(done.body.status).toBe('completed')
  return id
}

const stats = async () => (await call(app, 'GET', '/v1/stats?env=test')).body

describe('between_outsiders: the one number we cannot manufacture (ADR-39)', () => {
  it('counts only work with the platform on neither side, and says so before anything has happened', async () => {
    const desk = await createTestAgent(app, { name: 'Platform desk' })
    await db().update(agents).set({ firstParty: true }).where(eq(agents.id, desk.agent.id))
    const seller = await createTestAgent(app, { name: 'Outside seller' })
    const buyer = await createTestAgent(app, { name: 'Outside buyer' })

    // an empty marketplace reports zero rather than omitting the field
    expect((await stats()).between_outsiders).toEqual({ jobs_completed: 0, volume_usdc_completed: 0, distinct_buyers: 0, distinct_sellers: 0 })

    // the platform desk buying from an outside seller is NOT it: this is the number that has been flattering us
    const l = await listing(seller)
    await tradeOnce(desk, seller, l)
    const afterDesk = await stats()
    expect(afterDesk.jobs_completed).toBe(1)
    expect(afterDesk.first_party.jobs_completed).toBe(1)
    expect(afterDesk.between_outsiders).toEqual({ jobs_completed: 0, volume_usdc_completed: 0, distinct_buyers: 0, distinct_sellers: 0 })

    // an outside buyer paying an outside seller is
    await tradeOnce(buyer, seller, l)
    const afterOutsiders = await stats()
    expect(afterOutsiders.jobs_completed).toBe(2)
    expect(afterOutsiders.first_party.jobs_completed).toBe(1)
    expect(afterOutsiders.between_outsiders).toEqual({ jobs_completed: 1, volume_usdc_completed: PRICE, distinct_buyers: 1, distinct_sellers: 1 })

    // the same pair trading again is more volume but not another buyer: the count is of parties, not of jobs
    await tradeOnce(buyer, seller, l)
    expect((await stats()).between_outsiders).toEqual({ jobs_completed: 2, volume_usdc_completed: 2 * PRICE, distinct_buyers: 1, distinct_sellers: 1 })

    // an outside seller selling to a second outside buyer moves the number that matters
    const buyer2 = await createTestAgent(app, { name: 'Second outside buyer' })
    await tradeOnce(buyer2, seller, l)
    expect((await stats()).between_outsiders).toMatchObject({ jobs_completed: 3, distinct_buyers: 2, distinct_sellers: 1 })
  })
})
