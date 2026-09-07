import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { freshApp, call, createTestAgent, type TestAgent } from '../../test/setup.js'
import type { App } from '../../app.js'
import { _setConfigForTests } from '../../config.js'

/** ADR-23: platform-run agents are labelled, counted separately and never trade with each other on live. */

const ADMIN = 'test-admin-token-1234567890'
type EnvName = 'live' | 'test'

let app: App
let ours: TestAgent
let ours2: TestAgent
let third: TestAgent

beforeEach(async () => {
  app = await freshApp()
  _setConfigForTests({ ADMIN_TOKEN: ADMIN })
  ours = await createTestAgent(app, { name: 'Souk Translator' })
  ours2 = await createTestAgent(app, { name: 'Souk Summarizer' })
  third = await createTestAgent(app, { name: 'Third Party' })
  for (const a of [ours, ours2]) expect((await flag(a.agent.id, true)).status).toBe(200)
})
afterEach(() => _setConfigForTests({ ADMIN_TOKEN: undefined }))

/** token null = send no X-Admin-Token header at all */
const flag = (id: string, first_party: boolean, token: string | null = ADMIN) =>
  call(app, 'POST', `/v1/admin/agents/${id}/first-party`, { headers: token ? { 'x-admin-token': token } : {}, body: { first_party } })
const listing = async (a: TestAgent, env: EnvName) => {
  const r = await call(app, 'POST', '/v1/listings', {
    key: a.api_keys[env],
    body: { title: 'Translate', description: 'Translate EN to DE. Send {text}, receive {translation}.', category: 'text', pricing_model: 'fixed', price: 10_000, input_schema: { type: 'object', required: ['text'] } },
  })
  if (r.status !== 201) throw new Error(JSON.stringify(r.body))
  return r.body as { id: string; first_party: boolean; seller: { first_party: boolean } }
}
const order = (a: TestAgent, env: EnvName, listingId: string) => call(app, 'POST', '/v1/jobs', { key: a.api_keys[env], body: { listing_id: listingId, input: { text: 'hi' } } })
const bountyBody = { title: 'Translate the docs', description: 'Translate our documentation to German, plain text delivery.', budget_max: 50_000, category: 'text' }

describe('first_party (ADR-23)', () => {
  it('admin flags an agent; the flag is public on the profile and on listings', async () => {
    expect((await call(app, 'GET', '/v1/agents/me', { key: ours.api_keys.test })).body.first_party).toBe(true)
    expect((await call(app, 'GET', `/v1/agents/${ours.agent.handle}`)).body.first_party).toBe(true)
    expect((await call(app, 'GET', `/v1/agents/${third.agent.id}`)).body.first_party).toBe(false)
    const l = await listing(ours, 'test')
    expect(l.first_party).toBe(true)
    expect(l.seller.first_party).toBe(true)
    const search = await call(app, 'GET', '/v1/listings?q=translate', { key: third.api_keys.test })
    expect(search.body.data[0].first_party).toBe(true)
    const off = await flag(ours.agent.handle, false)
    expect(off.status).toBe(200)
    expect(off.body.first_party).toBe(false)
    expect((await call(app, 'GET', `/v1/listings/${l.id}`, { key: third.api_keys.test })).body.first_party).toBe(false)
  })

  it('rejects wrong or missing admin tokens and unknown agents; without ADMIN_TOKEN the route does not exist', async () => {
    expect((await flag(third.agent.id, true, 'nope')).status).toBe(401)
    expect((await flag(third.agent.id, true, null)).status).toBe(401)
    expect((await flag('agt_missing', true)).status).toBe(404)
    expect((await call(app, 'GET', `/v1/agents/${third.agent.id}`)).body.first_party).toBe(false)
    _setConfigForTests({ ADMIN_TOKEN: undefined })
    expect((await flag(third.agent.id, true)).status).toBe(404)
  })

  it('two first-party agents cannot trade on live, but can in the sandbox and with third parties', async () => {
    const live = await listing(ours, 'live')
    const blocked = await order(ours2, 'live', live.id)
    expect(blocked.status).toBe(409)
    expect(blocked.body.error.code).toBe('first_party_self_dealing')
    expect(blocked.body.error.hint).toContain('third')
    expect((await order(third, 'live', live.id)).status).toBe(201)
    const sandbox = await listing(ours, 'test')
    expect((await order(ours2, 'test', sandbox.id)).status).toBe(201)
    const thirdListing = await listing(third, 'live')
    expect((await order(ours, 'live', thirdListing.id)).status).toBe(201)
  })

  it('bounties: first-party sellers cannot propose on first-party bounties on live; awarding is guarded too', async () => {
    const b = await call(app, 'POST', '/v1/bounties', { key: ours.api_keys.live, body: bountyBody })
    expect(b.status).toBe(201)
    const p = await call(app, 'POST', `/v1/bounties/${b.body.id}/proposals`, { key: ours2.api_keys.live, body: { price: 10_000 } })
    expect(p.status).toBe(409)
    expect(p.body.error.code).toBe('first_party_self_dealing')
    const p3 = await call(app, 'POST', `/v1/bounties/${b.body.id}/proposals`, { key: third.api_keys.live, body: { price: 10_000 } })
    expect([200, 201]).toContain(p3.status)
    // flagged after proposing: the award must still refuse
    await flag(third.agent.id, true)
    const award = await call(app, 'POST', `/v1/bounties/${b.body.id}/award`, { key: ours.api_keys.live, body: { proposal_id: p3.body.id } })
    expect(award.status).toBe(409)
    expect(award.body.error.code).toBe('first_party_self_dealing')
    await flag(third.agent.id, false)
    const awarded = await call(app, 'POST', `/v1/bounties/${b.body.id}/award`, { key: ours.api_keys.live, body: { proposal_id: p3.body.id } })
    expect([200, 201]).toContain(awarded.status)
    // the sandbox is free for demos
    const bt = await call(app, 'POST', '/v1/bounties', { key: ours.api_keys.test, body: bountyBody })
    const pt = await call(app, 'POST', `/v1/bounties/${bt.body.id}/proposals`, { key: ours2.api_keys.test, body: { price: 10_000 } })
    expect([200, 201]).toContain(pt.status)
  })

  it('stats report the first-party share separately', async () => {
    await listing(ours, 'test')
    await listing(third, 'test')
    const s = await call(app, 'GET', '/v1/stats?env=test')
    expect(s.body.listings_active).toBe(2)
    expect(s.body.first_party).toEqual({ agents: 2, listings_active: 1, jobs_completed: 0, volume_usdc_completed: 0 })
  })
})
