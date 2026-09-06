import { describe, it, expect, beforeEach } from 'vitest'
import { freshApp, call, createTestAgent, randomWallet, setWallet } from '../../test/setup.js'
import type { App } from '../../app.js'

/** Listings under the non-custodial model (ADR-22): wallet requirement, payment timing, upfront trust gate. */
let app: App
beforeEach(async () => {
  app = await freshApp()
})

const body = (over: Record<string, unknown> = {}) => ({ title: 'Paid thing', description: 'A paid service for the payments listing tests.', category: 'ops', pricing_model: 'fixed', price: 10_000, ...over })

describe('listings & payments', () => {
  it('paid listings need a wallet address; free ones do not; setting the wallet unlocks selling', async () => {
    const s = await createTestAgent(app, { name: 'NoWallet', wallet_address: null })
    const paid = await call(app, 'POST', '/v1/listings', { key: s.api_keys.test, body: body() })
    expect(paid.status).toBe(409)
    expect(paid.body.error.code).toBe('wallet_address_required')
    expect(paid.body.error.hint).toContain('/v1/agents/me/wallet-address')
    const quote = await call(app, 'POST', '/v1/listings', { key: s.api_keys.test, body: body({ pricing_model: 'quote', price: null }) })
    expect(quote.status).toBe(409)
    const free = await call(app, 'POST', '/v1/listings', { key: s.api_keys.test, body: body({ price: 0 }) })
    expect(free.status).toBe(201)
    expect(free.body.pricing.display).toBe('free')
    const raise = await call(app, 'PATCH', `/v1/listings/${free.body.id}`, { key: s.api_keys.test, body: { price: 5 } })
    expect(raise.status).toBe(409)
    expect(raise.body.error.code).toBe('wallet_address_required')
    const set = await setWallet(app, s.api_keys.test, s.agent.id, randomWallet())
    expect(set.status).toBe(200)
    expect(set.body.wallet_address).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect((await call(app, 'POST', '/v1/listings', { key: s.api_keys.test, body: body() })).status).toBe(201)
  })

  it('upfront is a sandbox-only option for untrusted sellers; on live it needs trust tier 1', async () => {
    const s = await createTestAgent(app, { name: 'Newbie' })
    const test = await call(app, 'POST', '/v1/listings', { key: s.api_keys.test, body: body({ payment: 'upfront' }) })
    expect(test.status).toBe(201)
    expect(test.body.payment).toBe('upfront')
    const live = await call(app, 'POST', '/v1/listings', { key: s.api_keys.live, body: body({ payment: 'upfront' }) })
    expect(live.status).toBe(409)
    expect(live.body.error.code).toBe('upfront_requires_trust')
    const liveDefault = await call(app, 'POST', '/v1/listings', { key: s.api_keys.live, body: body() })
    expect(liveDefault.status).toBe(201)
    const flip = await call(app, 'PATCH', `/v1/listings/${liveDefault.body.id}`, { key: s.api_keys.live, body: { payment: 'upfront' } })
    expect(flip.status).toBe(409)
    const found = await call(app, 'GET', '/v1/listings?env=test&payment=upfront')
    expect(found.body.data.map((l: any) => l.id)).toEqual([test.body.id])
  })

  it('prices are USDC minor units everywhere', async () => {
    const s = await createTestAgent(app, { name: 'Pricer' })
    const r = await call(app, 'POST', '/v1/listings', { key: s.api_keys.test, body: body({ price: 1_250_000 }) })
    expect(r.body.pricing).toMatchObject({ price: 1_250_000, currency: 'USDC', display: '1.250000 USDC per job' })
    const bad = await call(app, 'POST', '/v1/listings', { key: s.api_keys.test, body: body({ price: 1.5 }) })
    expect(bad.status).toBe(400)
    const search = await call(app, 'GET', '/v1/listings?env=test&max_price=1000000')
    expect(search.body.data).toHaveLength(0)
  })
})
