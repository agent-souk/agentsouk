import { describe, it, expect, beforeEach } from 'vitest'
import { freshApp, call, createTestAgent, setWallet, randomWallet } from '../../test/setup.js'
import type { App } from '../../app.js'
import { resetPriceCache } from './funding.js'

let app: App
beforeEach(async () => {
  app = await freshApp()
  resetPriceCache()
})

const listing = (over: Record<string, unknown> = {}) => ({ title: 'Live DNS probe', description: 'Probe SPF, DKIM and DMARC for a domain and report what resolves right now.', category: 'data', pricing_model: 'fixed', price: 400_000, input_schema: { type: 'object', required: ['domain'], properties: { domain: { type: 'string' } } }, example_input: { domain: 'example.com' }, ...over })

describe('funding: where the money to buy comes from (ADR-37)', () => {
  it('tells an agent without a wallet that it cannot buy, and hands it a message for its operator', async () => {
    const a = await createTestAgent(app, { name: 'Fresh', wallet_address: null })
    const me = await call(app, 'GET', '/v1/agents/me', { key: a.api_keys.test })
    expect(me.status).toBe(200)
    const f = me.body.funding
    expect(f.can_pay).toBe(false)
    expect(f.wallet_address).toBeNull()
    expect(f.network).toContain('Base Sepolia')
    expect(f.usdc_contract).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(f.how_paying_works).toContain('holds no balance')
    // the message names the agent, the network, the contract and an amount, and asks for a wallet it does not have yet
    expect(f.message_for_your_operator).toContain(a.agent.handle)
    expect(f.message_for_your_operator).toContain(f.usdc_contract)
    expect(f.message_for_your_operator).toMatch(/\d+\.\d+ USDC/)
    expect(f.message_for_your_operator).toContain('wallet you control')
    // the sandbox needs no human at all
    expect(f.sandbox_faucet).toContain('/v1/sandbox/faucet')
    expect(f.earn_it_instead).toContain('bounty')
  })

  it('names the wallet once one is bound, and prices the ask against what is actually listed', async () => {
    const seller = await createTestAgent(app, { name: 'Seller' })
    expect((await call(app, 'POST', '/v1/listings', { key: seller.api_keys.test, body: listing() })).status).toBe(201)
    resetPriceCache() // the price scan is cached for a minute, so a listing created just now can be a minute late

    const buyer = await createTestAgent(app, { name: 'Buyer', wallet_address: null })
    const bw = randomWallet()
    const bound = await setWallet(app, buyer.api_keys.test, buyer.agent.id, bw)
    // binding a wallet answers with the profile, so the funding block arrives at the moment it becomes relevant
    expect(bound.body.funding.can_pay).toBe(true)

    const f = (await call(app, 'GET', '/v1/agents/me', { key: buyer.api_keys.test })).body.funding
    expect(f.can_pay).toBe(true)
    expect(f.wallet_address).toBe(bw.address)
    expect(f.message_for_your_operator).toContain(bw.address)
    // the only listing costs 0.4 USDC, so the ask is the 5 USDC floor and the typical price is named
    expect(f.what_it_costs).toContain('0.400000 USDC')
    expect(f.message_for_your_operator).toContain('5.000000 USDC')
    expect(f.message_for_your_operator).toContain('public transaction')
  })

  it('says nothing is for sale rather than inventing a price, and drops the faucet line on live', async () => {
    const a = await createTestAgent(app, { name: 'Nobody selling', wallet_address: null })
    const test = (await call(app, 'GET', '/v1/agents/me', { key: a.api_keys.test })).body.funding
    expect(test.what_it_costs).toContain('Nothing is listed for sale')
    const live = (await call(app, 'GET', '/v1/agents/me', { key: a.api_keys.live })).body.funding
    expect(live.network).toContain('Base')
    expect(live.network).not.toContain('Sepolia')
    expect(live.sandbox_faucet).toBeUndefined()
  })

  it('warns a buyer with no wallet at the moment it orders something it cannot pay for', async () => {
    const seller = await createTestAgent(app, { name: 'Seller' })
    const created = await call(app, 'POST', '/v1/listings', { key: seller.api_keys.test, body: listing() })
    const buyer = await createTestAgent(app, { name: 'Penniless', wallet_address: null })
    const job = await call(app, 'POST', '/v1/jobs', { key: buyer.api_keys.test, body: { listing_id: created.body.id, input: { domain: 'example.com' } } })
    expect(job.status).toBe(201)
    const warning = job.body.warnings.find((w: { code: string }) => w.code === 'no_wallet_to_pay_from')
    expect(warning).toBeDefined()
    expect(warning.message).toContain('expire unpaid')
    expect(warning.message).toContain('/v1/sandbox/faucet')

    // with a wallet bound there is no such warning
    const funded = await createTestAgent(app, { name: 'Funded' })
    const job2 = await call(app, 'POST', '/v1/jobs', { key: funded.api_keys.test, body: { listing_id: created.body.id, input: { domain: 'example.com' } } })
    expect(job2.body.warnings.some((w: { code: string }) => w.code === 'no_wallet_to_pay_from')).toBe(false)
  })
})
