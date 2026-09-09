import { describe, it, expect, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { freshApp, call, createTestAgent } from '../../test/setup.js'
import type { App } from '../../app.js'
import { db } from '../../db/client.js'
import { agents } from '../../db/schema.js'
import { normaliseTerm, recordSearch, flushSearches, setDemandUpsert, resetSearchers } from './service.js'

let app: App
beforeEach(async () => {
  app = await freshApp()
  setDemandUpsert(null)
  resetSearchers()
})

const listing = (over: Record<string, unknown> = {}) => ({ title: 'German translation', description: 'Translate English to German. Send {text}, get {translation}.', category: 'text', pricing_model: 'fixed', price: 500, input_schema: { type: 'object', required: ['text'] }, example_input: { text: 'Hi' }, ...over })

describe('demand signal (ADR-35, narrowed by ADR-36)', () => {
  it('normalises terms: lowercase, wildcards and whitespace collapsed, bounded, empty when nothing is left', () => {
    expect(normaliseTerm('  Quantum   Forecast ')).toBe('quantum forecast')
    expect(normaliseTerm('a%b_c')).toBe('a b c')
    expect(normaliseTerm('x')).toBeNull()
    expect(normaliseTerm('')).toBeNull()
    expect(normaliseTerm(undefined)).toBeNull()
    expect(normaliseTerm('w'.repeat(200))).toBeNull() // one over-long token is a pasted blob, not a word
    expect(normaliseTerm(Array(30).fill('word').join(' '))!.length).toBeLessThanOrEqual(80)
    // identifying tokens never reach the public page
    expect(normaliseTerm('jobs by @alice for 0x9f3c2a7b6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a')).toBe('jobs by for')
    expect(normaliseTerm('contact me bob@example.com about OCR')).toBe('contact me about ocr')
    expect(normaliseTerm('as_live_abcdef123456 ocr receipts')).toBe('ocr receipts')
    expect(normaliseTerm('agt_01M21GVRS5M5K7CHFCCBXNDPT5 did:key:z6Mk translation')).toBe('translation')
    expect(normaliseTerm('0xdeadbeefdeadbeefdeadbeef')).toBeNull()
    expect(normaliseTerm('a'.repeat(41) + ' summary')).toBe('summary')
  })

  it('counts the first page of a query by outsiders, tells an empty search how to post a bounty, and serves the aggregate on GET /v1/demand and in opportunities', async () => {
    const seller = await createTestAgent(app, { name: 'Seller' })
    const buyer = await createTestAgent(app, { name: 'Buyer' })
    const buyer2 = await createTestAgent(app, { name: 'Second buyer' })
    const desk = await createTestAgent(app, { name: 'Desk' })
    await db().update(agents).set({ firstParty: true }).where(eq(agents.id, desk.agent.id))
    expect((await call(app, 'POST', '/v1/listings', { key: seller.api_keys.test, body: listing() })).status).toBe(201)

    // an empty search answers with a ready-to-send bounty body
    const empty = await call(app, 'GET', '/v1/listings?q=Quantum%20forecast%20for%20tuesday', { key: buyer.api_keys.test })
    expect(empty.status).toBe(200)
    expect(empty.body.data).toEqual([])
    expect(empty.body.hint).toContain('Post it as a bounty')
    expect(empty.body.hint).toContain('a search moves nobody')
    expect(empty.body.post_a_bounty).toMatchObject({ method: 'POST', path: '/v1/bounties', body_example: { title: 'Quantum forecast for tuesday', budget_max: 1_000_000, category: 'other' } })
    // the bounty body is accepted as is
    const posted = await call(app, 'POST', '/v1/bounties', { key: buyer.api_keys.test, body: empty.body.post_a_bounty.body_example })
    expect(posted.status).toBe(201)
    // a second, different client searches the same term: only now is it more than one voice (ADR-36)
    await call(app, 'GET', '/v1/listings?q=Quantum%20forecast%20for%20tuesday', { key: buyer2.api_keys.test })

    // a search with results carries no hint and is counted without zero_results
    const hit = await call(app, 'GET', '/v1/listings?q=german%20translation', { key: buyer.api_keys.test })
    expect(hit.body.data).toHaveLength(1)
    expect(hit.body.hint).toBeUndefined()
    expect(hit.body.post_a_bounty).toBeUndefined()
    await call(app, 'GET', '/v1/listings?q=german%20translation', { key: buyer2.api_keys.test }) // a second client
    // an anonymous call we cannot place (no address at all, as in the in-process call behind an MCP tool) counts
    // as a search but as nobody: it must not be able to lift a term over the threshold on its own
    await call(app, 'GET', '/v1/listings?q=german%20translation&env=test')
    // not counted: a cursor page, a seller catalogue, a first_party searcher, an empty q
    await call(app, 'GET', '/v1/listings?q=german%20translation&cursor=o:1', { key: buyer.api_keys.test })
    await call(app, 'GET', `/v1/listings?q=german%20translation&seller=${seller.agent.handle}`, { key: buyer.api_keys.test })
    await call(app, 'GET', '/v1/listings?q=quantum%20forecast%20for%20tuesday', { key: desk.api_keys.test })
    await call(app, 'GET', '/v1/listings', { key: buyer.api_keys.test })
    // a filtered empty page is counted as a search, not as unmet (the listing exists; the price cap hid it)
    const narrowed = await call(app, 'GET', '/v1/listings?q=german%20translation&max_price=1', { key: buyer.api_keys.test })
    expect(narrowed.body.data).toEqual([])
    expect(narrowed.body.post_a_bounty).toBeDefined()
    // a one-character category never produces a bounty body the API rejects
    const oneChar = await call(app, 'GET', '/v1/listings?q=quantum%20forecast%20for%20tuesday&category=x', { key: buyer.api_keys.test })
    expect(oneChar.body.post_a_bounty.body_example.category).toBe('other')
    expect((await call(app, 'POST', '/v1/bounties', { key: buyer.api_keys.test, body: oneChar.body.post_a_bounty.body_example })).status).toBe(201)
    // one client alone, however often: never published (ADR-36)
    for (let i = 0; i < 5; i++) await call(app, 'GET', '/v1/listings?q=solo%20probe%20term', { key: buyer.api_keys.test })

    // nothing is visible until the scheduler flushed: a term cannot be paired with the second it was typed
    expect((await call(app, 'GET', '/v1/demand?env=test')).body.searched).toEqual([])
    await flushSearches()
    const d = await call(app, 'GET', '/v1/demand?env=test')
    expect(d.status).toBe(200)
    expect(d.headers.get('cache-control')).toContain('max-age=60')
    expect(d.headers.get('vary')).toContain('Authorization')
    expect(d.body.object).toBe('demand')
    expect(d.body.env).toBe('test')
    expect(d.body.window_days).toBe(7)
    expect(d.body.read_me_first).toContain('cannot do themselves in a minute')
    expect(d.body.read_me_first).toContain('traffic and nothing more')
    expect(d.body.unmet_searches[0].last_day).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(d.body.searched).toEqual([
      { term: 'german translation', searches: 4, zero_results: 0, searchers: 2, last_day: expect.any(String) },
      { term: 'quantum forecast for tuesday', searches: 3, zero_results: 2, searchers: 2, last_day: expect.any(String) }, // the category-filtered empty page is a search, not a gap
    ])
    expect(d.body.unmet_searches).toEqual([{ term: 'quantum forecast for tuesday', searches: 3, zero_results: 2, searchers: 2, last_day: expect.any(String) }])
    // the term only one client searched is withheld entirely, and counted
    expect(d.body.searched.map((t: { term: string }) => t.term)).not.toContain('solo probe term')
    expect(d.body.what_the_searching_produced).toMatchObject({ searches: 12, terms: 3, terms_published: 2, terms_withheld: 1, most_clients_on_one_term: 2, bounties_posted: 2, jobs_started: 0 })
    expect(d.body.what_the_searching_produced.note).toContain('12 searches')
    expect(d.body.limits).toContain('1 of 3')
    expect(d.body.open_bounties).toHaveLength(2)
    expect(d.body.open_bounties[1]).toMatchObject({ id: posted.body.id, title: 'Quantum forecast for tuesday', budget_max: 1_000_000, budget_display: 'up to 1.000000 USDC', proposal_count: 0, buyer: { handle: buyer.agent.handle, first_party: false }, how_to_propose: { method: 'POST', path: `/v1/bounties/${posted.body.id}/proposals` } })
    expect(d.body.by_category).toEqual([{ category: 'other', open_bounties: 2, budget_total: 2_000_000, budget_display: '2.000000 USDC' }])
    expect(d.body.how_this_is_made).toContain('Nothing here identifies a searcher')
    expect(d.body.how_this_is_made).toContain('never leaves the server')
    // the bounties come first in the body: an agent reading top to bottom meets the demand that names a budget
    expect(Object.keys(d.body).indexOf('open_bounties')).toBeLessThan(Object.keys(d.body).indexOf('unmet_searches'))

    // an environment where nothing happened says so plainly instead of showing an empty list
    const live = await call(app, 'GET', '/v1/demand')
    expect(live.body.searched).toEqual([])
    expect(live.body.what_the_searching_produced).toMatchObject({ searches: 0, bounties_posted: 0, jobs_started: 0, most_clients_on_one_term: 0 })
    expect(live.body.what_the_searching_produced.note).toContain('not one of them turned into a bounty or a job')

    // the key decides the env, the query overrides it
    expect((await call(app, 'GET', '/v1/demand', { key: buyer.api_keys.test })).body.searched).toHaveLength(2)

    // opportunities show the unmet searches to sellers
    const o = await call(app, 'GET', '/v1/opportunities', { key: seller.api_keys.test })
    expect(o.body.unmet_searches).toEqual([{ term: 'quantum forecast for tuesday', searches: 3, zero_results: 2, searchers: 2, last_day: expect.any(String) }])

    // days add up per term; the window drops old days; searchers is the busiest day, never the sum
    const day = 86_400_000
    const t0 = Date.now()
    recordSearch('test', 'quantum forecast for tuesday', true, 'agent:one', t0 - 20 * day)
    recordSearch('test', 'quantum forecast for tuesday', false, 'agent:one', t0 - 2 * day)
    await flushSearches(t0)
    const find = (body: { searched: { term: string }[] }) => body.searched.find((t) => t.term === 'quantum forecast for tuesday')
    expect(find((await call(app, 'GET', '/v1/demand?env=test&days=30')).body)).toMatchObject({ searches: 5, zero_results: 3, searchers: 2 })
    expect(find((await call(app, 'GET', '/v1/demand?env=test')).body)).toMatchObject({ searches: 4, zero_results: 2, searchers: 2 })
  })

  it('counts clients, not searches: one client repeating a term stays one, and a term without a known client is never published', async () => {
    const rows: { term: string; searches: number; searchers: number }[] = []
    setDemandUpsert(async (row) => {
      rows.push({ term: row.term, searches: row.searches, searchers: row.searchers })
    })
    for (let i = 0; i < 9; i++) recordSearch('test', 'one client many searches', true, 'agent:a')
    recordSearch('test', 'two clients', true, 'agent:a')
    recordSearch('test', 'two clients', true, 'agent:b')
    recordSearch('test', 'nobody named', true, null)
    await flushSearches()
    expect(rows).toEqual([
      { term: 'one client many searches', searches: 9, searchers: 1 },
      { term: 'two clients', searches: 2, searchers: 2 },
      { term: 'nobody named', searches: 1, searchers: 0 },
    ])
  })

  it('does not count the same client twice because a flush happened in between', async () => {
    const rows: { term: string; searchers: number }[] = []
    setDemandUpsert(async (row) => {
      rows.push({ term: row.term, searchers: row.searchers })
    })
    recordSearch('test', 'across a flush', true, 'agent:a')
    await flushSearches()
    recordSearch('test', 'across a flush', true, 'agent:a')
    await flushSearches()
    recordSearch('test', 'across a flush', true, 'agent:b')
    await flushSearches()
    expect(rows).toEqual([
      { term: 'across a flush', searchers: 1 },
      { term: 'across a flush', searchers: 1 },
      { term: 'across a flush', searchers: 2 },
    ])
  })

  it('keeps unflushed counts when the database write fails and flushes them later', async () => {
    let fail = true
    setDemandUpsert(async () => {
      if (fail) throw new Error('db down')
    })
    recordSearch('test', 'ocr for receipts', true, 'agent:a')
    recordSearch('test', 'ocr for receipts', false, 'agent:b')
    await flushSearches()
    fail = false
    const rows: unknown[] = []
    setDemandUpsert(async (row) => {
      rows.push(row)
    })
    await flushSearches()
    expect(rows).toEqual([expect.objectContaining({ env: 'test', term: 'ocr for receipts', searches: 2, zeroResults: 1, searchers: 2 })])
  })
})
