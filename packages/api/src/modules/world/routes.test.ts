import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { freshApp, call, createTestAgent, type TestAgent } from '../../test/setup.js'
import { installFakeChain, type FakeChain } from '../../test/chain.js'
import type { App } from '../../app.js'
import { _setConfigForTests } from '../../config.js'
import { matchTermsFor } from './service.js'

let app: App
let chain: FakeChain
let seller: TestAgent
let buyer: TestAgent
const PRICE = 500_000

beforeEach(async () => {
  app = await freshApp()
  chain = installFakeChain('test')
  seller = await createTestAgent(app, { name: 'Translator Bot', capabilities: ['translation:de-en', 'summarization'], tags: ['german'] })
  buyer = await createTestAgent(app, { name: 'Buyer' })
})
afterEach(() => _setConfigForTests({ ADMIN_TOKEN: undefined }))

const bounty = (a: TestAgent, over: Record<string, unknown> = {}) => call(app, 'POST', '/v1/bounties', { key: a.api_keys.test, body: { title: 'Translate our docs to German', description: 'Fifteen markdown pages, keep the formatting, deliver as markdown.', budget_max: 2_000_000, category: 'text', tags: ['docs'], ...over } })

describe('matchTermsFor', () => {
  it('derives lowercase terms from capabilities and tags, including the part before a colon', () => {
    expect(matchTermsFor({ capabilities: ['Translation:de-en', 'ab'], tags: ['German', 'translation:de-en'] })).toEqual(['translation:de-en', 'translation', 'german'])
  })
})

describe('GET /v1/opportunities', () => {
  it('matches bounties to capabilities, lists unanswered ones and new listings, excludes my own, and explains the next step', async () => {
    const mine = await bounty(seller, { title: 'My own bounty about translation' })
    expect(mine.status).toBe(201)
    const b1 = await bounty(buyer)
    const b2 = await bounty(buyer, { title: 'Scrape competitor prices', description: 'Fetch ten shop pages daily and return a CSV of prices.', category: 'web', tags: ['scraping'], budget_max: 800_000 })
    const other = await createTestAgent(app, { name: 'Other Seller' })
    const l = await call(app, 'POST', '/v1/listings', { key: other.api_keys.test, body: { title: 'Summaries', description: 'Send a document, get a summary in your language.', category: 'text', pricing_model: 'fixed', price: 10_000 } })
    expect(l.status).toBe(201)
    await call(app, 'POST', '/v1/listings', { key: seller.api_keys.test, body: { title: 'My own listing', description: 'Should not show up in my opportunities.', category: 'text', pricing_model: 'fixed', price: 10_000 } })

    const o = await call(app, 'GET', '/v1/opportunities', { key: seller.api_keys.test })
    expect(o.status).toBe(200)
    expect(o.body.terms).toEqual(['translation:de-en', 'translation', 'summarization', 'german'])
    expect(o.body.bounties_for_you.map((b: any) => b.id)).toEqual([b1.body.id])
    expect(o.body.bounties_for_you[0].matched_terms).toEqual(['translation:de-en', 'translation', 'german'])
    expect(o.body.bounties_for_you[0].how_to_propose.path).toBe(`/v1/bounties/${b1.body.id}/proposals`)
    expect(o.body.bounties_for_you[0].buyer).toMatchObject({ id: buyer.agent.id, first_party: false })
    expect(o.body.unanswered_bounties.map((b: any) => b.id).sort()).toEqual([b1.body.id, b2.body.id].sort())
    expect(o.body.newest_listings.map((x: any) => x.id)).toEqual([l.body.id])
    expect(o.body.demand).toEqual(expect.arrayContaining([{ category: 'text', open_bounties: 2, budget_total: 4_000_000, budget_display: '4.000000 USDC' }, { category: 'web', open_bounties: 1, budget_total: 800_000, budget_display: '0.800000 USDC' }]))
    expect(o.body.hint).toContain('POST /v1/bounties/{id}/proposals')

    await call(app, 'POST', `/v1/bounties/${b1.body.id}/proposals`, { key: seller.api_keys.test, body: { price: 1_500_000 } })
    const after = await call(app, 'GET', '/v1/opportunities', { key: seller.api_keys.test })
    expect(after.body.unanswered_bounties.map((b: any) => b.id)).toEqual([b2.body.id])

    const blank = await createTestAgent(app, { name: 'No Terms' })
    const nb = await call(app, 'GET', '/v1/opportunities', { key: blank.api_keys.test })
    expect(nb.body.terms).toEqual([])
    expect(nb.body.bounties_for_you).toEqual([])
    expect(nb.body.hint).toContain('PATCH /v1/agents/me')
    expect((await call(app, 'GET', '/v1/opportunities')).status).toBe(401)
  })
})

describe('GET /v1/leaderboard', () => {
  it('ranks by verified volume × counterparties after a paid job, per role and environment', async () => {
    expect((await call(app, 'GET', '/v1/leaderboard?env=test')).body.data).toEqual([])
    const l = await call(app, 'POST', '/v1/listings', { key: seller.api_keys.test, body: { title: 'Translate', description: 'Translate EN to DE. Send {text}, receive {translation}.', category: 'text', pricing_model: 'fixed', price: PRICE, input_schema: { type: 'object', required: ['text'] } } })
    const j = await call(app, 'POST', '/v1/jobs', { key: buyer.api_keys.test, body: { listing_id: l.body.id, input: { text: 'hi' } } })
    await call(app, 'POST', `/v1/jobs/${j.body.id}/accept`, { key: seller.api_keys.test, body: {} })
    await call(app, 'POST', `/v1/jobs/${j.body.id}/deliver`, { key: seller.api_keys.test, body: { output: { translation: 'hallo' } } })
    const tx = chain.pay(buyer.wallet_address!, seller.wallet_address!, PRICE)
    expect((await call(app, 'POST', `/v1/jobs/${j.body.id}/pay`, { key: buyer.api_keys.test, body: { transaction: tx } })).status).toBe(200)
    expect((await call(app, 'POST', `/v1/jobs/${j.body.id}/accept`, { key: buyer.api_keys.test, body: {} })).body.status).toBe('completed')

    const sellers = await call(app, 'GET', '/v1/leaderboard?env=test')
    expect(sellers.status).toBe(200)
    expect(sellers.body.role).toBe('seller')
    expect(sellers.body.data).toHaveLength(1)
    expect(sellers.body.data[0]).toMatchObject({ rank: 1, agent: { id: seller.agent.id, handle: seller.agent.handle, first_party: false }, jobs_completed: 1, distinct_counterparties: 1, third_party_counterparties: 1, volume_usdc: PRICE, volume_display: '0.500000 USDC', rank_value: PRICE })
    expect(sellers.body.method).toContain('third_party_counterparties')
    const buyers = await call(app, 'GET', '/v1/leaderboard?env=test&role=buyer')
    expect(buyers.body.data[0].agent.id).toBe(buyer.agent.id)
    expect((await call(app, 'GET', '/v1/leaderboard')).body).toMatchObject({ env: 'live', data: [] })
    expect((await call(app, 'GET', '/v1/leaderboard?limit=0')).status).toBe(400)
  })
})

describe('GET /v1/admin/overview', () => {
  it('needs the admin token and lists disputes and refunds due', async () => {
    _setConfigForTests({ ADMIN_TOKEN: 'test-admin-token-1234567890' })
    expect((await call(app, 'GET', '/v1/admin/overview')).status).toBe(401)
    const l = await call(app, 'POST', '/v1/listings', { key: seller.api_keys.test, body: { title: 'Translate', description: 'Translate EN to DE. Send {text}, receive {translation}.', category: 'text', pricing_model: 'fixed', price: PRICE, input_schema: { type: 'object', required: ['text'] } } })
    const j = await call(app, 'POST', '/v1/jobs', { key: buyer.api_keys.test, body: { listing_id: l.body.id, input: { text: 'hi' } } })
    await call(app, 'POST', `/v1/jobs/${j.body.id}/accept`, { key: seller.api_keys.test, body: {} })
    await call(app, 'POST', `/v1/jobs/${j.body.id}/deliver`, { key: seller.api_keys.test, body: { output: { translation: 'hallo' } } })
    const tx = chain.pay(buyer.wallet_address!, seller.wallet_address!, PRICE)
    await call(app, 'POST', `/v1/jobs/${j.body.id}/pay`, { key: buyer.api_keys.test, body: { transaction: tx } })
    expect((await call(app, 'POST', `/v1/jobs/${j.body.id}/dispute`, { key: buyer.api_keys.test, body: { reason: 'wrong language' } })).body.status).toBe('disputed')
    const o = await call(app, 'GET', '/v1/admin/overview', { headers: { 'x-admin-token': 'test-admin-token-1234567890' } })
    expect(o.status).toBe(200)
    expect(o.body.disputes).toHaveLength(1)
    expect(o.body.disputes[0]).toMatchObject({ job_id: j.body.id, env: 'test', paid: true, reason: 'wrong language', buyer_id: buyer.agent.id })
    expect(o.body.refunds_due).toEqual([])
    expect(o.body.agents.active).toBe(2)
    expect(o.body.jobs).toEqual(expect.arrayContaining([{ env: 'test', status: 'disputed', count: 1 }]))
    expect(o.body.sanctions).toHaveProperty('screening')
    const verdict = await call(app, 'POST', `/v1/admin/jobs/${j.body.id}/resolve`, { headers: { 'x-admin-token': 'test-admin-token-1234567890' }, body: { outcome: 'buyer', note: 'seller delivered the wrong language' } })
    expect(verdict.status).toBe(200)
    const after = await call(app, 'GET', '/v1/admin/overview', { headers: { 'x-admin-token': 'test-admin-token-1234567890' } })
    expect(after.body.disputes).toEqual([])
    expect(after.body.refunds_due).toHaveLength(1)
    expect(after.body.refunds_due[0]).toMatchObject({ job_id: j.body.id, seller_id: seller.agent.id, refund_expected: PRICE })
  })
})
