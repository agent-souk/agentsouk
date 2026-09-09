import { describe, it, expect, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { freshApp, call, createTestAgent, type TestAgent } from '../../test/setup.js'
import { installFakeChain, type FakeChain } from '../../test/chain.js'
import { db } from '../../db/client.js'
import { agents, faucetClaims } from '../../db/schema.js'
import { newId } from '../../lib/ids.js'
import type { App } from '../../app.js'

let app: App
let chain: FakeChain
const PRICE = 250_000

beforeEach(async () => {
  app = await freshApp()
  chain = installFakeChain('test')
})

const body = (price: number) => ({
  title: 'Live DNS probe',
  description: 'Probe SPF, DKIM and DMARC for a domain and report what resolves.',
  category: 'data',
  pricing_model: 'fixed',
  price,
  input_schema: { type: 'object', required: ['domain'] },
  turnaround_seconds: 600,
  accept_timeout_seconds: 600,
})

const listing = async (seller: TestAgent, price: number = PRICE, env: 'test' | 'live' = 'test') => {
  const r = await call(app, 'POST', '/v1/listings', { key: env === 'test' ? seller.api_keys.test : seller.api_keys.live, body: body(price) })
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  return r.body.id as string
}

async function tradeOnce(buyer: TestAgent, seller: TestAgent, listingId: string, price: number = PRICE, env: 'test' | 'live' = 'test', c: FakeChain = chain) {
  const bk = env === 'test' ? buyer.api_keys.test : buyer.api_keys.live
  const sk = env === 'test' ? seller.api_keys.test : seller.api_keys.live
  const job = await call(app, 'POST', '/v1/jobs', { key: bk, body: { listing_id: listingId, input: { domain: 'example.com' } } })
  expect(job.status, JSON.stringify(job.body)).toBe(201)
  const id = job.body.id as string
  await call(app, 'POST', `/v1/jobs/${id}/accept`, { key: sk, body: {} })
  await call(app, 'POST', `/v1/jobs/${id}/deliver`, { key: sk, body: { output: { spf: 'pass' } } })
  if (price > 0) {
    const tx = c.pay(buyer.wallet_address!, seller.wallet_address!, price, { confirmations: 3 }) // live needs 3
    const paid = await call(app, 'POST', `/v1/jobs/${id}/pay`, { key: bk, body: { transaction: tx } })
    expect(paid.status, JSON.stringify(paid.body)).toBe(200)
  }
  const done = await call(app, 'POST', `/v1/jobs/${id}/accept`, { key: bk, body: {} })
  expect(done.body.status).toBe('completed')
  return id
}

const record = async (a: TestAgent, env: 'test' | 'live' = 'test') => (await call(app, 'GET', `/v1/agents/${a.agent.id}/reputation`)).body[env].as_seller

/**
 * ADR-45: third_party_counterparties is the field GET /v1/commitments points buyers at as the honest per-agent
 * demand signal, and it is printed on the seller summary of every listing. It has to follow the same rule as the
 * headline figure (ADR-43/44): money above the floor, that was not ours, counted by wallet.
 */
describe('who counts as a paying third party (ADR-45)', () => {
  it('a counterparty that never paid is counted, and named, on its own', async () => {
    const seller = await createTestAgent(app, { name: 'Seller' })
    const free = await createTestAgent(app, { name: 'Free rider' })
    await tradeOnce(free, seller, await listing(seller, 0), 0)

    const r = await record(seller)
    expect(r.jobs_completed).toBe(1)
    expect(r.distinct_counterparties).toBe(1)
    expect(r.third_party_counterparties).toBe(0)
    expect(r.counterparties_without_payment).toBe(1)
    expect(r.first_party_counterparties + r.third_party_counterparties + r.counterparties_without_payment).toBe(r.distinct_counterparties)
  })

  it('dust does not buy a place in the demand signal, but the volume stays a plain fact', async () => {
    const seller = await createTestAgent(app, { name: 'Seller' })
    const duster = await createTestAgent(app, { name: 'Duster' })
    await tradeOnce(duster, seller, await listing(seller, 1), 1) // 0.000001 USDC

    const r = await record(seller)
    expect(r.third_party_counterparties).toBe(0)
    expect(r.counterparties_without_payment).toBe(1)
    expect(r.volume_usdc).toBe(1) // it really did settle on chain, so we do not hide it
  })

  it('a buyer spending money our own desk paid it is not an independent third party', async () => {
    const desk = await createTestAgent(app, { name: 'Platform desk' })
    await db().update(agents).set({ firstParty: true }).where(eq(agents.id, desk.agent.id))
    const middle = await createTestAgent(app, { name: 'Seller we paid' })
    const seller = await createTestAgent(app, { name: 'Seller it then bought from' })

    await tradeOnce(desk, middle, await listing(middle)) // our money reaches middle
    await tradeOnce(middle, seller, await listing(seller)) // middle spends it

    const r = await record(seller)
    expect(r.jobs_completed).toBe(1)
    expect(r.third_party_counterparties).toBe(0)
    expect(r.first_party_counterparties).toBe(1) // our money, however many hands it passed through
    expect(r.third_party_volume_usdc).toBe(0)
  })

  it('a buyer with its own money still counts, at full volume', async () => {
    const seller = await createTestAgent(app, { name: 'Seller' })
    const buyer = await createTestAgent(app, { name: 'Real buyer' })
    await tradeOnce(buyer, seller, await listing(seller))

    const r = await record(seller)
    expect(r.third_party_counterparties).toBe(1)
    expect(r.third_party_volume_usdc).toBe(PRICE)
    expect(r.counterparties_without_payment).toBe(0)
  })

  it('the sandbox faucet does not follow a wallet onto live, where testnet USDC is worth nothing', async () => {
    const seller = await createTestAgent(app, { name: 'Seller' })
    const buyer = await createTestAgent(app, { name: 'Tried the sandbox first' })
    await db()
      .insert(faucetClaims)
      .values({ id: newId('faucetClaim'), agentId: buyer.agent.id, address: buyer.wallet_address!, amount: 1_000_000, transaction: '0x' + 'f'.repeat(64), day: '2026-09-09', ipHash: 'test', createdAt: Date.now() })

    await tradeOnce(buyer, seller, await listing(seller))
    expect((await record(seller)).third_party_counterparties).toBe(0) // in the sandbox that is our money

    // the same wallet on live is spending real USDC on another chain: excluding it for ever would suppress exactly
    // the signal we are waiting for, since every serious agent is told to try the sandbox first
    const liveChain = installFakeChain('live')
    await tradeOnce(buyer, seller, await listing(seller, PRICE, 'live'), PRICE, 'live', liveChain)

    const live = await record(seller, 'live')
    expect(live.third_party_counterparties).toBe(1)
    expect(live.third_party_volume_usdc).toBe(PRICE)
  })
})
