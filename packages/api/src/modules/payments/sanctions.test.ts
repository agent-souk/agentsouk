import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { freshApp, call, createTestAgent, randomWallet, setWallet } from '../../test/setup.js'
import { installFakeChain } from '../../test/chain.js'
import type { App } from '../../app.js'
import { _setConfigForTests } from '../../config.js'
import { _resetSanctionsForTests, _setSanctionsFetchForTests, _setSanctionsListForTests, assertNotSanctioned, isSanctioned, parseAddressList, refreshSanctions, sanctionsStatus } from './sanctions.js'

const LISTED = '0x8589427373D6D84E98730D7795D8f6f8731FDA16' // Tornado Cash router, on the SDN list since 2022
const OTHER = '0x000000000000000000000000000000000000dEaD'

afterEach(() => {
  _resetSanctionsForTests()
  _setSanctionsFetchForTests(null)
  _setConfigForTests({ SANCTIONS_LIST_URLS: 'https://example.invalid/list.txt' })
})

describe('sanctions list', () => {
  it('parses addresses out of any document shape', () => {
    const text = `# comment\n${LISTED}\n"SDN","Digital Currency Address - ETH ${OTHER};"\n<Feature>${LISTED.toLowerCase()}</Feature>\nnot-an-address 0x1234`
    expect(parseAddressList(text)).toEqual([LISTED.toLowerCase(), OTHER.toLowerCase()])
  })

  it('loads from all sources, keeps the last good list when a refresh fails, and reports status', async () => {
    _setConfigForTests({ SANCTIONS_LIST_URLS: 'https://a.invalid/x.txt, https://b.invalid/y.csv' })
    const docs: Record<string, string | null> = { 'https://a.invalid/x.txt': LISTED, 'https://b.invalid/y.csv': `x,y,${OTHER}` }
    _setSanctionsFetchForTests(async (url) => ({ ok: docs[url] != null, status: docs[url] != null ? 200 : 503, text: async () => docs[url] ?? '' }))
    const first = await refreshSanctions(1_000)
    expect(first).toMatchObject({ addresses: 2, sources_ok: 2, sources: 2, errors: [] })
    expect(isSanctioned(LISTED)).toBe(true)
    expect(isSanctioned(LISTED.toLowerCase())).toBe(true)
    expect(isSanctioned('0x1111111111111111111111111111111111111111')).toBe(false)
    expect(sanctionsStatus()).toMatchObject({ screening: true, addresses: 2, updated_at: new Date(1_000).toISOString(), last_error: null })
    docs['https://b.invalid/y.csv'] = null
    const second = await refreshSanctions(2_000)
    expect(second.sources_ok).toBe(1)
    expect(second.errors[0]).toContain('HTTP 503')
    expect(sanctionsStatus()).toMatchObject({ addresses: 2, updated_at: new Date(1_000).toISOString() })
    expect(sanctionsStatus().last_error).toContain('503')
    expect(isSanctioned(OTHER)).toBe(true)
  })

  it('uses a partial first load rather than nothing, and an empty document counts as a failure', async () => {
    _setConfigForTests({ SANCTIONS_LIST_URLS: 'https://a.invalid/x.txt,https://b.invalid/empty.txt' })
    _setSanctionsFetchForTests(async (url) => ({ ok: true, status: 200, text: async () => (url.includes('empty') ? 'nothing here' : LISTED) }))
    const r = await refreshSanctions()
    expect(r.sources_ok).toBe(1)
    expect(isSanctioned(LISTED)).toBe(true)
    expect(sanctionsStatus().last_error).toContain('no addresses')
  })

  it('assertNotSanctioned throws a 403 with the address and a support hint', () => {
    _setSanctionsListForTests([LISTED])
    expect(() => assertNotSanctioned(OTHER, 'x')).not.toThrow()
    try {
      assertNotSanctioned(LISTED.toLowerCase(), 'Your wallet address')
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toMatchObject({ status: 403, code: 'address_sanctioned' })
      expect((e as { opts: { hint: string } }).opts.hint).toContain('/v1/support/reports')
    }
  })
})

describe('sanctions screening in the API', () => {
  let app: App
  beforeEach(async () => {
    app = await freshApp()
    installFakeChain('test')
  })

  it('refuses to bind a listed wallet address, and reports screening in /health', async () => {
    _setSanctionsListForTests([LISTED])
    const a = await createTestAgent(app, { name: 'Binder', wallet_address: null })
    const w = randomWallet()
    const fine = await setWallet(app, a.api_keys.test, a.agent.id, w)
    expect(fine.status).toBe(200)
    const listedWallet = { ...w, address: LISTED }
    const res = await call(app, 'POST', '/v1/agents/me/wallet-address', { key: a.api_keys.test, body: { address: LISTED, signature: listedWallet.sign(`agentsouk:wallet:${a.agent.id}:${LISTED.toLowerCase()}`) } })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('address_sanctioned')
    expect(res.body.error.details.address).toBe(LISTED.toLowerCase())
    const health = await call(app, 'GET', '/health')
    expect(health.body.sanctions).toMatchObject({ screening: true, addresses: 1 })
  })

  it('refuses a payment when the payer or the seller wallet became listed after binding', async () => {
    const seller = await createTestAgent(app, { name: 'Seller' })
    const buyer = await createTestAgent(app, { name: 'Buyer' })
    const l = await call(app, 'POST', '/v1/listings', { key: seller.api_keys.test, body: { title: 'Svc', description: 'A paid service for the screening test.', category: 'ops', pricing_model: 'fixed', price: 10_000, input_schema: { type: 'object' } } })
    const j = await call(app, 'POST', '/v1/jobs', { key: buyer.api_keys.test, body: { listing_id: l.body.id, input: {} } })
    await call(app, 'POST', `/v1/jobs/${j.body.id}/accept`, { key: seller.api_keys.test, body: {} })
    await call(app, 'POST', `/v1/jobs/${j.body.id}/deliver`, { key: seller.api_keys.test, body: { output: { ok: true } } })
    _setSanctionsListForTests([buyer.wallet_address!])
    const asPayer = await call(app, 'POST', `/v1/jobs/${j.body.id}/pay`, { key: buyer.api_keys.test, body: { transaction: '0x' + 'ab'.repeat(32) } })
    expect(asPayer.status).toBe(403)
    expect(asPayer.body.error.code).toBe('address_sanctioned')
    _setSanctionsListForTests([seller.wallet_address!])
    const toSeller = await call(app, 'POST', `/v1/jobs/${j.body.id}/pay`, { key: buyer.api_keys.test, body: { transaction: '0x' + 'ab'.repeat(32) } })
    expect(toSeller.status).toBe(403)
    expect(toSeller.body.error.message).toContain('seller wallet address')
    _setSanctionsListForTests(null)
    const terms = await call(app, 'POST', `/v1/jobs/${j.body.id}/pay`, { key: buyer.api_keys.test })
    expect(terms.status).toBe(402)
  })
})
