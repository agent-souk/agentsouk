import { describe, it, expect, beforeEach } from 'vitest'
import { freshApp, call, createTestAgent, type TestAgent } from '../../test/setup.js'
import { installFakeChain, type FakeChain } from '../../test/chain.js'
import type { App } from '../../app.js'

let app: App
let chain: FakeChain
const PRICE = 400_000

beforeEach(async () => {
  app = await freshApp()
  chain = installFakeChain('test')
})

/** Order, accept, deliver sealed. Returns the thread's system message that the buyer reads next. */
async function sealedDelivery(buyer: TestAgent, seller: TestAgent) {
  const l = await call(app, 'POST', '/v1/listings', {
    key: seller.api_keys.test,
    body: { title: 'Live DNS probe', description: 'Probe SPF, DKIM and DMARC for a domain and report what resolves.', category: 'data', pricing_model: 'fixed', price: PRICE, input_schema: { type: 'object', required: ['domain'] } },
  })
  expect(l.status, JSON.stringify(l.body)).toBe(201)
  const job = await call(app, 'POST', '/v1/jobs', { key: buyer.api_keys.test, body: { listing_id: l.body.id, input: { domain: 'example.com' } } })
  expect(job.status, JSON.stringify(job.body)).toBe(201)
  const id = job.body.id as string
  await call(app, 'POST', `/v1/jobs/${id}/accept`, { key: seller.api_keys.test, body: {} })
  await call(app, 'POST', `/v1/jobs/${id}/deliver`, { key: seller.api_keys.test, body: { output: { spf: 'pass' } } })
  const msgs = await call(app, 'GET', `/v1/threads/${job.body.thread_id}/messages?order=desc&limit=1`, { key: buyer.api_keys.test })
  return { id, text: String(msgs.body.data[0].body ?? '') }
}

/**
 * The sealed delivery is where this marketplace loses its buyers: on 2026-09-09 about thirty of them had reached
 * exactly this point and never paid, most in the sandbox where money is free for the asking (ADR-40).
 */
describe('sealed delivery: the buyer is told whether it can pay at all', () => {
  it('points an empty wallet at the free sandbox faucet instead of repeating the call it cannot complete', async () => {
    chain.usdcBalanceOf = () => 0n
    const seller = await createTestAgent(app, { name: 'Seller' })
    const buyer = await createTestAgent(app, { name: 'Broke buyer' })
    const { text } = await sealedDelivery(buyer, seller)
    expect(text).toContain('Delivered (sealed')
    expect(text).toContain('holds 0.000000 USDC')
    expect(text).toContain('0.400000 USDC') // and what it costs
    expect(text).toContain('/v1/sandbox/faucet')
    expect(text).toContain('payGasless')
    expect(text).toContain('neither of you gets anything')
  })

  it('tells a funded buyer that it is covered, and how to pay in one call without ETH', async () => {
    chain.usdcBalanceOf = () => 5_000_000n
    const seller = await createTestAgent(app, { name: 'Seller' })
    const buyer = await createTestAgent(app, { name: 'Funded buyer' })
    const { text } = await sealedDelivery(buyer, seller)
    expect(text).toContain('holds 5.000000 USDC, which covers this')
    expect(text).toContain('no ETH needed')
    expect(text).not.toContain('faucet')
  })

  it('says the wallet is missing when it is, because then no amount of money helps', async () => {
    const seller = await createTestAgent(app, { name: 'Seller' })
    const buyer = await createTestAgent(app, { name: 'No wallet', wallet_address: null })
    const { text } = await sealedDelivery(buyer, seller)
    expect(text).toContain('no wallet bound')
    expect(text).toContain('/v1/agents/me/wallet-address')
  })

  it('still delivers when the chain cannot be reached: the help simply drops the balance sentence', async () => {
    chain.down = true
    const seller = await createTestAgent(app, { name: 'Seller' })
    const buyer = await createTestAgent(app, { name: 'Unknown balance' })
    const { text } = await sealedDelivery(buyer, seller)
    expect(text).toContain('Delivered (sealed')
    expect(text).toContain('payGasless')
    expect(text).not.toContain('holds')
  })
})
