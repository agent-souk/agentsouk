import { describe, it, expect, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { freshApp, call, createTestAgent, setWallet, type TestAgent } from '../../test/setup.js'
import { installFakeChain, type FakeChain } from '../../test/chain.js'
import { db } from '../../db/client.js'
import { agents, faucetClaims } from '../../db/schema.js'
import { newId } from '../../lib/ids.js'
import { _setConfigForTests } from '../../config.js'
import type { App } from '../../app.js'

let app: App
let chain: FakeChain
const PRICE = 250_000

beforeEach(async () => {
  app = await freshApp()
  chain = installFakeChain('test')
})

const listing = async (seller: TestAgent, price: number = PRICE) => {
  const r = await call(app, 'POST', '/v1/listings', {
    key: seller.api_keys.test,
    body: { title: 'Live DNS probe', description: 'Probe SPF, DKIM and DMARC for a domain and report what resolves.', category: 'data', pricing_model: 'fixed', price, input_schema: { type: 'object', required: ['domain'] }, turnaround_seconds: 600, accept_timeout_seconds: 600 },
  })
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  return r.body.id as string
}

/** What our own sandbox faucet does: 1 test USDC to a bound wallet. Recorded against the wallet, which is what matters. */
const faucetWent = async (agent: TestAgent) =>
  db()
    .insert(faucetClaims)
    .values({ id: newId('faucetClaim'), agentId: agent.agent.id, address: agent.wallet_address!, amount: 1_000_000, transaction: '0x' + 'f'.repeat(64), day: '2026-09-09', ipHash: 'test', createdAt: Date.now() })

/** One complete, paid, accepted job: order, accept, deliver sealed, pay by hash, accept. */
async function tradeOnce(buyer: TestAgent, seller: TestAgent, listingId: string, price: number = PRICE) {
  const job = await call(app, 'POST', '/v1/jobs', { key: buyer.api_keys.test, body: { listing_id: listingId, input: { domain: 'example.com' } } })
  expect(job.status, JSON.stringify(job.body)).toBe(201)
  const id = job.body.id as string
  await call(app, 'POST', `/v1/jobs/${id}/accept`, { key: seller.api_keys.test, body: {} })
  await call(app, 'POST', `/v1/jobs/${id}/deliver`, { key: seller.api_keys.test, body: { output: { spf: 'pass' } } })
  if (price > 0) {
    const tx = chain.pay(buyer.wallet_address!, seller.wallet_address!, price)
    const paid = await call(app, 'POST', `/v1/jobs/${id}/pay`, { key: buyer.api_keys.test, body: { transaction: tx } })
    expect(paid.status, JSON.stringify(paid.body)).toBe(200)
  }
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
    expect((await stats()).between_outsiders).toEqual({ orders: 0, orders_from_distinct_wallets: 0, jobs_completed: 0, volume_usdc_completed: 0, gross_volume_usdc: 0, distinct_buyers: 0, distinct_sellers: 0, excluded: { no_money_moved: 0, below_price_floor: 0, funded_by_us: 0, refunded: 0 } })

    // the platform desk buying from an outside seller is NOT it: this is the number that has been flattering us
    const l = await listing(seller)
    await tradeOnce(desk, seller, l)
    const afterDesk = await stats()
    expect(afterDesk.jobs_completed).toBe(1)
    expect(afterDesk.first_party.jobs_completed).toBe(1)
    expect(afterDesk.between_outsiders).toMatchObject({ jobs_completed: 0, volume_usdc_completed: 0, distinct_buyers: 0, distinct_sellers: 0 })

    // an outside buyer paying an outside seller is
    await tradeOnce(buyer, seller, l)
    const afterOutsiders = await stats()
    expect(afterOutsiders.jobs_completed).toBe(2)
    expect(afterOutsiders.first_party.jobs_completed).toBe(1)
    expect(afterOutsiders.between_outsiders).toMatchObject({ jobs_completed: 1, volume_usdc_completed: PRICE, distinct_buyers: 1, distinct_sellers: 1 })

    // the same pair trading again is more volume but not another buyer: the count is of parties, not of jobs
    await tradeOnce(buyer, seller, l)
    expect((await stats()).between_outsiders).toMatchObject({ jobs_completed: 2, volume_usdc_completed: 2 * PRICE, distinct_buyers: 1, distinct_sellers: 1 })

    // an outside seller selling to a second outside buyer moves the number that matters
    const buyer2 = await createTestAgent(app, { name: 'Second outside buyer' })
    await tradeOnce(buyer2, seller, l)
    expect((await stats()).between_outsiders).toMatchObject({ jobs_completed: 3, distinct_buyers: 2, distinct_sellers: 1 })
  })
})

/**
 * ADR-43. Every case here is something the live figure was actually counting on 2026-09-09: seven of the ten
 * sandbox jobs it reported were our own deploy smoke test paying itself with our own faucet USDC, two were two
 * registrations of one operator, and two were free jobs nobody ever paid for.
 */
describe('between_outsiders: it must not count what we produced ourselves (ADR-43)', () => {
  it('does not count a completed job nobody ever paid for, and says how many it left out', async () => {
    const seller = await createTestAgent(app, { name: 'Outside seller' })
    const buyer = await createTestAgent(app, { name: 'Outside buyer' })
    const free = await listing(seller, 0)

    await tradeOnce(buyer, seller, free, 0)

    const s = await stats()
    expect(s.jobs_completed).toBe(1) // it happened, and the headline number still says so
    expect(s.between_outsiders).toMatchObject({ jobs_completed: 0, volume_usdc_completed: 0, distinct_buyers: 0, distinct_sellers: 0 })
    expect(s.between_outsiders.excluded).toEqual({ no_money_moved: 1, below_price_floor: 0, funded_by_us: 0, refunded: 0 })
  })

  it('does not count a buyer that is spending USDC our own faucet handed it', async () => {
    const seller = await createTestAgent(app, { name: 'Smoke seller' })
    const buyer = await createTestAgent(app, { name: 'Smoke buyer' })
    const l = await listing(seller)

    await faucetWent(buyer) // exactly what scripts/smoke-gasless.ts does, once per deploy
    await tradeOnce(buyer, seller, l)

    const s = await stats()
    expect(s.jobs_completed).toBe(1)
    expect(s.volume_usdc_completed).toBe(PRICE) // the payment was real and stays in the headline volume
    expect(s.between_outsiders).toMatchObject({ jobs_completed: 0, volume_usdc_completed: 0, distinct_buyers: 0, distinct_sellers: 0 })
    expect(s.between_outsiders.excluded).toEqual({ no_money_moved: 0, below_price_floor: 0, funded_by_us: 1, refunded: 0 })

    // and a buyer that never took our money, on the same seller, still counts
    const real = await createTestAgent(app, { name: 'Buyer with its own money' })
    await tradeOnce(real, seller, l)
    expect((await stats()).between_outsiders).toMatchObject({ jobs_completed: 1, distinct_buyers: 1, distinct_sellers: 1, excluded: { funded_by_us: 1 } })
  })

  it('counts parties by wallet, so one operator with two registrations is one buyer', async () => {
    const seller = await createTestAgent(app, { name: 'Outside seller' })
    const first = await createTestAgent(app, { name: 'Buyer identity one' })
    const second = await createTestAgent(app, { name: 'Buyer identity two', wallet_address: null })
    // the same operator, two agents, one wallet
    const w = await setWallet(app, second.api_keys.test, second.agent.id, first.wallet!)
    expect(w.status, JSON.stringify(w.body)).toBe(200)
    second.wallet_address = w.body.wallet_address
    second.wallet = first.wallet

    const l = await listing(seller)
    await tradeOnce(first, seller, l)
    await tradeOnce(second, seller, l)

    const s = await stats()
    expect(s.between_outsiders).toMatchObject({ jobs_completed: 2, volume_usdc_completed: 2 * PRICE, distinct_buyers: 1, distinct_sellers: 1 })
  })

  it('the faucet is matched on the wallet, not the agent, so a second registration on the same wallet is caught too', async () => {
    const seller = await createTestAgent(app, { name: 'Outside seller' })
    const claimer = await createTestAgent(app, { name: 'Took the faucet' })
    await faucetWent(claimer)

    // a fresh registration, never at the faucet itself, paying from the wallet that was funded
    const spender = await createTestAgent(app, { name: 'Spends it', wallet_address: null })
    const w = await setWallet(app, spender.api_keys.test, spender.agent.id, claimer.wallet!)
    expect(w.status, JSON.stringify(w.body)).toBe(200)
    spender.wallet_address = w.body.wallet_address
    spender.wallet = claimer.wallet

    await tradeOnce(spender, seller, await listing(seller))

    expect((await stats()).between_outsiders).toMatchObject({ jobs_completed: 0, distinct_buyers: 0, excluded: { funded_by_us: 1 } })
  })

  it('publishes the counting rule with the number, so the subtraction can be checked from outside', async () => {
    const seller = await createTestAgent(app, { name: 'Outside seller' })
    const buyer = await createTestAgent(app, { name: 'Smoke buyer' })
    await faucetWent(buyer)
    await tradeOnce(buyer, seller, await listing(seller))

    const c = await call(app, 'GET', '/v1/commitments?env=test')
    expect(c.status).toBe(200)
    const said = c.body.the_operator_is_a_participant.without_us_is_counted_like_this as string
    expect(said).toContain('1 bought with money that came from us')
    expect(said).toContain('net position, not gross transfers')
  })
})

/**
 * ADR-44. Every case here is an attack an adversarial audit of ADR-43 actually confirmed against the running
 * code on 2026-09-09 - four of them by executing it. Two were ours (the flag we could flip, the money we had
 * already handed out); the rest cost an outsider nearly nothing.
 */
describe('between_outsiders: it must not be ours to move, and it must cost an outsider real money (ADR-44)', () => {
  it('a job keeps the classification it had when it was created, so un-flagging the desk afterwards changes nothing', async () => {
    _setConfigForTests({ ADMIN_TOKEN: 'test-admin-token' })
    try {
    const desk = await createTestAgent(app, { name: 'Platform desk' })
    await db().update(agents).set({ firstParty: true }).where(eq(agents.id, desk.agent.id))
    const seller = await createTestAgent(app, { name: 'Outside seller' })
    await tradeOnce(desk, seller, await listing(seller))
    expect((await stats()).between_outsiders).toMatchObject({ jobs_completed: 0, distinct_buyers: 0 })

    // one admin call used to reclassify the platform's entire purchase history as work between outsiders
    const r = await call(app, 'POST', `/v1/admin/agents/${desk.agent.id}/first-party`, { headers: { 'x-admin-token': 'test-admin-token' }, body: { first_party: false } })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.first_party).toBe(false)
    expect((await stats()).between_outsiders).toMatchObject({ jobs_completed: 0, volume_usdc_completed: 0, distinct_buyers: 0, distinct_sellers: 0 })
    } finally {
      _setConfigForTests({ ADMIN_TOKEN: undefined })
    }
  })

  it('does not count a buyer spending USDC our own desk paid it, however many hops it takes inside the marketplace', async () => {
    const desk = await createTestAgent(app, { name: 'Platform desk' })
    await db().update(agents).set({ firstParty: true }).where(eq(agents.id, desk.agent.id))
    const a = await createTestAgent(app, { name: 'Seller we paid' })
    const bb = await createTestAgent(app, { name: 'Second hand' })
    const c = await createTestAgent(app, { name: 'Third hand' })

    await tradeOnce(desk, a, await listing(a)) // our money leaves us and lands on A's wallet
    expect((await stats()).between_outsiders).toMatchObject({ jobs_completed: 0 })

    await tradeOnce(a, bb, await listing(bb)) // A spends it on B - our money, one hop out
    expect((await stats()).between_outsiders).toMatchObject({ jobs_completed: 0, distinct_buyers: 0, excluded: { funded_by_us: 1 } })

    await tradeOnce(bb, c, await listing(c)) // B spends the same money on C - two hops out
    expect((await stats()).between_outsiders).toMatchObject({ jobs_completed: 0, distinct_buyers: 0, excluded: { funded_by_us: 2 } })
  })

  it('does not treat one millionth of a dollar as a purchase', async () => {
    const seller = await createTestAgent(app, { name: 'Outside seller' })
    const buyer = await createTestAgent(app, { name: 'Outside buyer' })
    await tradeOnce(buyer, seller, await listing(seller, 1), 1) // 0.000001 USDC, two free registrations

    const s = await stats()
    expect(s.between_outsiders).toMatchObject({ jobs_completed: 0, volume_usdc_completed: 0, distinct_buyers: 0, distinct_sellers: 0 })
    expect(s.between_outsiders.excluded.below_price_floor).toBe(1)
  })

  it('reports nothing for a ring of wallets passing the same coin around, and shows the gross next to it', async () => {
    const a = await createTestAgent(app, { name: 'Ring A' })
    const bb = await createTestAgent(app, { name: 'Ring B' })
    const c = await createTestAgent(app, { name: 'Ring C' })
    const [la, lb, lc] = [await listing(a), await listing(bb), await listing(c)]
    await tradeOnce(a, bb, lb)
    await tradeOnce(bb, c, lc)
    await tradeOnce(c, a, la)

    const s = await stats()
    // every wallet ends where it started, so nobody bought anything and nobody earned anything
    expect(s.between_outsiders).toMatchObject({ volume_usdc_completed: 0, distinct_buyers: 0, distinct_sellers: 0 })
    // the jobs and the gross are still published, so the shape of it is visible rather than hidden
    expect(s.between_outsiders.jobs_completed).toBe(3)
    expect(s.between_outsiders.gross_volume_usdc).toBe(3 * PRICE)
  })

  it('reports nothing for two wallets trading the same coin back and forth', async () => {
    const a = await createTestAgent(app, { name: 'Wash A' })
    const bb = await createTestAgent(app, { name: 'Wash B' })
    const [la, lb] = [await listing(a), await listing(bb)]
    await tradeOnce(a, bb, lb)
    await tradeOnce(bb, a, la)

    expect((await stats()).between_outsiders).toMatchObject({ volume_usdc_completed: 0, distinct_buyers: 0, distinct_sellers: 0, gross_volume_usdc: 2 * PRICE })
  })

  it('a real purchase still counts, and the net figure equals what actually changed hands', async () => {
    const seller = await createTestAgent(app, { name: 'Outside seller' })
    const buyer = await createTestAgent(app, { name: 'Outside buyer' })
    await tradeOnce(buyer, seller, await listing(seller))

    expect((await stats()).between_outsiders).toMatchObject({
      jobs_completed: 1,
      volume_usdc_completed: PRICE,
      gross_volume_usdc: PRICE,
      distinct_buyers: 1,
      distinct_sellers: 1,
      excluded: { no_money_moved: 0, below_price_floor: 0, funded_by_us: 0, refunded: 0 },
    })
  })

  it('a purchase refunded in full does not stand', async () => {
    const seller = await createTestAgent(app, { name: 'Outside seller' })
    const buyer = await createTestAgent(app, { name: 'Outside buyer' })
    const id = await tradeOnce(buyer, seller, await listing(seller))
    expect((await stats()).between_outsiders).toMatchObject({ jobs_completed: 1, distinct_buyers: 1 })

    const back = chain.pay(seller.wallet_address!, buyer.wallet_address!, PRICE)
    const r = await call(app, 'POST', `/v1/jobs/${id}/refund`, { key: seller.api_keys.test, body: { transaction: back } })
    expect(r.status, JSON.stringify(r.body)).toBe(200)

    const s = await stats()
    expect(s.between_outsiders).toMatchObject({ jobs_completed: 0, volume_usdc_completed: 0, distinct_buyers: 0, distinct_sellers: 0 })
    expect(s.between_outsiders.excluded.refunded).toBe(1)
  })
})

/**
 * ADR-46: every other figure on the stats page counts finished work, so a marketplace nobody ever orders from and
 * one whose orders all fail look identical. Reading our own history by hand on 2026-09-09 showed which one we were:
 * of 90 jobs ever recorded, 76 had one of our own identities on a side, and of the 14 that did not, almost all were
 * operators ordering from themselves. That fact was invisible in every published number.
 */
describe('between_outsiders.orders: how many ever tried (ADR-46)', () => {
  it('counts orders whatever became of them, and leaves ours out', async () => {
    const desk = await createTestAgent(app, { name: 'Platform desk' })
    await db().update(agents).set({ firstParty: true }).where(eq(agents.id, desk.agent.id))
    const seller = await createTestAgent(app, { name: 'Outside seller' })
    const buyer = await createTestAgent(app, { name: 'Outside buyer' })
    const l = await listing(seller)

    // our own desk ordering is not somebody trying this marketplace
    await tradeOnce(desk, seller, l)
    expect((await stats()).between_outsiders).toMatchObject({ orders: 0, orders_from_distinct_wallets: 0 })

    // an order that never becomes anything still counts here, and nowhere else
    const abandoned = await call(app, 'POST', '/v1/jobs', { key: buyer.api_keys.test, body: { listing_id: l, input: { domain: 'example.com' } } })
    expect(abandoned.status, JSON.stringify(abandoned.body)).toBe(201)
    const s1 = await stats()
    expect(s1.between_outsiders).toMatchObject({ orders: 1, orders_from_distinct_wallets: 1, jobs_completed: 0 })

    // a second order from the same buyer is another order, but not another wallet
    await tradeOnce(buyer, seller, l)
    const s2 = await stats()
    expect(s2.between_outsiders).toMatchObject({ orders: 2, orders_from_distinct_wallets: 1, jobs_completed: 1 })

    // a second buyer widens the mouth of the funnel
    const buyer2 = await createTestAgent(app, { name: 'Second outside buyer' })
    await call(app, 'POST', '/v1/jobs', { key: buyer2.api_keys.test, body: { listing_id: l, input: { domain: 'example.com' } } })
    expect((await stats()).between_outsiders).toMatchObject({ orders: 3, orders_from_distinct_wallets: 2 })
  })

  it('publishes how many ever tried, with the limit of the figure attached', async () => {
    const seller = await createTestAgent(app, { name: 'Outside seller' })
    const buyer = await createTestAgent(app, { name: 'Outside buyer' })
    await call(app, 'POST', '/v1/jobs', { key: buyer.api_keys.test, body: { listing_id: await listing(seller), input: { domain: 'example.com' } } })

    const c = await call(app, 'GET', '/v1/commitments?env=test')
    const said = c.body.the_operator_is_a_participant.without_us_how_many_ever_tried as string
    expect(said).toContain('1 orders have ever been placed here with us on neither side')
    expect(said).toContain('cannot tell two identities of one operator apart')
  })
})
