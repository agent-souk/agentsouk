import { describe, it, expect, beforeEach } from 'vitest'
import { freshApp, call, createTestAgent } from '../../test/setup.js'
import { _setConfigForTests } from '../../config.js'
import { generateKeyPair, canonicalJson, sign } from '../../lib/crypto.js'
import { jwkThumbprint } from '../../lib/server-keys.js'
import type { App } from '../../app.js'

let app: App
beforeEach(async () => {
  app = await freshApp()
})

describe('meta', () => {
  it('serves changelog and stats', async () => {
    const cl = await call(app, 'GET', '/v1/changelog')
    expect(cl.status).toBe(200)
    expect(cl.body.entries[0].version).toBe('0.4.7')
    expect(cl.body.current_version).toBe('0.4.7')
    expect(cl.body.entries[0].changes.join(' ')).toContain('orders_ignored')
    expect(cl.body.entries[1].changes.join(' ')).toContain('between_outsiders')
    expect(cl.body.entries[2].changes.join(' ')).toContain('raise this marketplace')
    expect(cl.body.entries[3].changes.join(' ')).toContain('message_for_your_operator')
    expect(cl.body.entries[4].changes.join(' ')).toContain('what_the_searching_produced')
    expect(cl.body.entries[5].changes.join(' ')).toContain('listing_limit')
    expect(cl.body.entries[6].changes.join(' ')).toContain('suggested_max_usdc')
    expect(cl.body.entries[7].changes.join(' ')).toContain('/v1/series/{id}')
    expect(cl.body.entries[8].changes.join(' ')).toContain('/v1/commitments')
    expect(cl.body.entries[9].changes.join(' ')).toContain('First-buy programme')
    expect(cl.body.entries[10].changes.join(' ')).toContain('gasless')
    expect(cl.body.entries[11].changes.join(' ')).toContain('/.well-known/agent-registration.json')
    expect(cl.body.entries[12].changes.join(' ')).toContain('/.well-known/ard.json')
    expect(cl.body.entries[13].changes.join(' ')).toContain('bounty desk')
    expect(cl.body.entries[14].changes.join(' ')).toContain('/robots.txt')
    expect(cl.body.entries[15].changes.join(' ')).toContain('rating_weighted')
    expect(cl.body.entries[16].changes.join(' ')).toContain('/v1/domains/{domain}')
    expect(cl.body.entries[17].changes.join(' ')).toContain('/v1/disputes/{id}/verdict')
    expect(cl.body.entries[18].changes.join(' ')).toContain('/v1/opportunities')
    expect(cl.body.entries[19].changes.join(' ')).toContain('first_party')
    expect(cl.body.entries[20].changes.join(' ')).toContain('wallet-to-wallet')
    // the word a supervisor would quote back never appears in a money sense on any public surface (ADR-32)
    expect(JSON.stringify(cl.body)).not.toMatch(/is escrowed/)
    const s = await createTestAgent(app, { name: 'S' })
    await call(app, 'POST', '/v1/listings', { key: s.api_keys.test, body: { title: 'Svc', description: 'A service for the stats test.', category: 'ops', pricing_model: 'fixed', price: 10 } })
    const stats = await call(app, 'GET', '/v1/stats?env=test')
    expect(stats.body).toMatchObject({ env: 'test', agents: 1, agents_active_7d: 1, listings_active: 1, jobs_completed: 0, volume_usdc_completed: 0, settlements: 0, series: { active: 0, completed: 0, stopped: 0 }, first_party: { agents: 0, listings_active: 0, jobs_completed: 0, volume_usdc_completed: 0 } })
    const live = await call(app, 'GET', '/v1/stats')
    expect(live.body.listings_active).toBe(0)
  })

  it('accepts support reports with and without auth', async () => {
    const anon = await call(app, 'POST', '/v1/support/reports', { body: { message: 'Job job_x is stuck', request_id: 'req_1' } })
    expect(anon.status).toBe(201)
    expect(anon.body.id).toMatch(/^rpt_/)
    const short = await call(app, 'POST', '/v1/support/reports', { body: { message: 'hi' } })
    expect(short.status).toBe(400)
  })

  it('records referrals and emits an event (no credits: the platform holds no money)', async () => {
    const ref = await createTestAgent(app, { name: 'Referrer' })
    const newbie = await createTestAgent(app, { name: 'Newbie', referred_by: ref.agent.handle })
    expect((await call(app, 'GET', '/v1/agents/me', { key: newbie.api_keys.test })).body.referred_by).toBe(ref.agent.id)
    const ev = await call(app, 'GET', '/v1/events?types=agent.referred', { key: ref.api_keys.live })
    expect(ev.body.data[0].data.new_agent_id).toBe(newbie.agent.id)
    const unknownRef = await createTestAgent(app, { name: 'Lost', referred_by: 'nobody-here' })
    expect((await call(app, 'GET', '/v1/agents/me', { key: unknownRef.api_keys.test })).body.referred_by).toBeNull()
  })
  it('publishes the commitments document: verifiable claims, the operator agents with wallets, the stats, no licence (ADR-32)', async () => {
    _setConfigForTests({ ADMIN_TOKEN: 'adm-token-1234567890' })
    try {
      const desk = await createTestAgent(app, { name: 'Souk Desk', description: 'Pays bounties and first buys.' })
      expect((await call(app, 'POST', `/v1/admin/agents/${desk.agent.id}/first-party`, { headers: { 'x-admin-token': 'adm-token-1234567890' }, body: { first_party: true } })).status).toBe(200)
      const outsider = await createTestAgent(app, { name: 'Outsider' })

      const res = await call(app, 'GET', '/v1/commitments?env=test')
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toContain('max-age=300')
      const d = res.body
      expect(d.object).toBe('commitments')
      expect(d.env).toBe('test')
      expect(d.api_version).toBe('0.4.7')
      expect(d.platform_did).toMatch(/^did:key:z/)
      // the licence section is a factual negative with machine-readable fields
      expect(d.licences).toMatchObject({ held: [], applied_for: [], planned: null, supervised_by: null })
      expect(d.licences.statement).toContain('no application pending')
      // every positive claim names its check
      for (const section of [d.what_we_cannot_do_to_you, d.what_we_promise, d.your_record_outlives_us.claims]) {
        expect(section.length).toBeGreaterThan(0)
        for (const c of section) {
          expect(typeof c.claim).toBe('string')
          expect(c.verify.length).toBeGreaterThan(20)
        }
      }
      for (const p of d.what_we_promise) expect(typeof p.enforcement).toBe('string')
      expect(d.what_we_do_not_offer.map((x: any) => x.not_offered).join(' ')).toMatch(/escrow.*refund enforcement.*insurance.*licence/s)
      // the operator's own agents are listed with their wallets; outsiders are not
      expect(d.the_operator_is_a_participant.agents).toEqual([expect.objectContaining({ id: desk.agent.id, handle: desk.agent.handle, wallet_address: desk.wallet_address, explorer: expect.stringContaining(desk.wallet_address!) })])
      expect(JSON.stringify(d)).not.toContain(outsider.agent.id)
      expect(d.the_operator_is_a_participant.first_buy_programme.default_caps_live).toMatchObject({ max_price_usdc: 1, programme_per_day_usdc: 5, per_seller: 2, desk_lifetime_usdc: 50 })
      expect(d.the_operator_is_a_participant.first_buy_programme.default_caps_test).toMatchObject({ max_price_usdc: 0.1, desk_lifetime_usdc: 50 })
      expect(d.the_operator_is_a_participant.agents[0]).toMatchObject({ active_listings: 0, open_bounties: 0 })
      expect(d.the_operator_is_a_participant.agents[0].role).toContain('pays')
      expect(d.working_on.some((w: any) => /bond|escrow/i.test(w.item))).toBe(false)
      expect(d.what_we_do_not_offer.some((x: any) => /seller bond/.test(x.not_offered))).toBe(true)
      // bounties label their buyer first_party (finding A1)
      const bty = await call(app, 'POST', '/v1/bounties', { key: desk.api_keys.test, body: { title: 'Walk the sandbox', description: 'Register, list, buy, pay and report what broke; at least ten steps.', budget_max: 3_000_000, category: 'ops' } })
      expect(bty.status).toBe(201)
      expect(bty.body.buyer).toMatchObject({ id: desk.agent.id, first_party: true })
      const listed = await call(app, 'GET', '/v1/bounties?env=test')
      expect(listed.body.data.find((b: any) => b.id === bty.body.id).buyer.first_party).toBe(true)
      const after = await call(app, 'GET', '/v1/commitments?env=test')
      expect(after.body.the_operator_is_a_participant.agents[0]).toMatchObject({ open_bounties: 1 })
      expect(d.the_operator_is_a_participant.first_buy_programme.running_configuration).toBe('https://agentsouk-agents.fly.dev/health')
      // the stats it quotes are the public ones
      const stats = (await call(app, 'GET', '/v1/stats?env=test')).body
      expect(d.what_we_are_building.where_we_are).toMatchObject({ env: 'test', agents: stats.agents, first_party: { agents: 1 } })
      expect(d.what_we_are_building.marked_as).toContain('intention')
      expect(d.what_we_are_building.honest_reading.operator_share_of_completed_jobs_percent).toBeNull()
      // vocabulary discipline: the words a supervisor would quote back never appear as a self-description
      expect(JSON.stringify(d)).not.toMatch(/escrowed|risk-free|trustless|BaFin-registered|MiCA-compliant|fully insured|guaranteed refund|we guarantee/i)
      expect(d.working_on.every((w: any) => w.promise.startsWith('none') || w.promise.startsWith('we do not'))).toBe(true)
      expect(d.links.desk_health).toBe('https://agentsouk-agents.fly.dev/health')
      // live is the default and is linked from the front door and the docs index
      expect((await call(app, 'GET', '/v1/commitments')).body.env).toBe('live')
      expect((await call(app, 'GET', '/')).body.docs.commitments).toMatch(/\/v1\/commitments$/)
      const docs = await app.request('/docs')
      expect(await docs.text()).toContain('/v1/commitments')
      const sitemap = await app.request('/sitemap.xml')
      expect(await sitemap.text()).toContain('/v1/commitments')
      const llms = await app.request('/llms.txt')
      const llmsText = await llms.text()
      expect(llmsText).toContain('/v1/commitments')
      expect(llmsText).not.toMatch(/within the hour|obliges the seller|verified operator, later|hires every new/)
      const skill = await (await app.request('/skill.md')).text()
      expect(skill).not.toMatch(/within the hour|obliges the seller|hires every new/)
      expect(skill).toContain('/v1/commitments')
    } finally {
      _setConfigForTests({ ADMIN_TOKEN: undefined })
    }
  })
  it('key history (ADR-34): retired keys stay in the JWKS and /v1/receipts/verify accepts their signatures', async () => {
    const old = generateKeyPair()
    const oldKid = jwkThumbprint(old.publicKey)
    const payload = { object: 'receipt', job: 'job_x', price: 1 }
    const sig = sign(canonicalJson(payload), old.secretKey)
    // without the history: unknown key id
    let res = await call(app, 'POST', '/v1/receipts/verify', { body: { receipt: payload, signature: { kid: oldKid, sig } } })
    expect(res.body).toMatchObject({ valid: false, retired: false })
    expect(res.body.reason).toContain('unknown key id')
    _setConfigForTests({ SERVER_PREVIOUS_PUBLIC_KEYS: ` ${old.publicKey.toUpperCase()},not-a-key` })
    try {
      const jwks = (await call(app, 'GET', '/.well-known/jwks.json')).body
      expect(jwks.keys).toHaveLength(2)
      expect(jwks.keys[1]).toMatchObject({ kid: oldKid, 'dev.agentsouk/retired': true })
      expect(jwks.keys[0]['dev.agentsouk/retired']).toBeUndefined()
      res = await call(app, 'POST', '/v1/receipts/verify', { body: { receipt: payload, signature: { kid: oldKid, sig } } })
      expect(res.body).toMatchObject({ valid: true, retired: true, kid: oldKid })
      // a tampered payload still fails
      res = await call(app, 'POST', '/v1/receipts/verify', { body: { receipt: { ...payload, price: 2 }, signature: { kid: oldKid, sig } } })
      expect(res.body.valid).toBe(false)
      // the current key still works and is not retired
      const att = (await call(app, 'GET', `/v1/agents/${(await createTestAgent(app, { name: 'K' })).agent.id}/reputation/attestation`)).body
      res = await call(app, 'POST', '/v1/receipts/verify', { body: { attestation: att.attestation, signature: att.signature } })
      expect(res.body).toMatchObject({ valid: true, retired: false })
    } finally {
      _setConfigForTests({ SERVER_PREVIOUS_PUBLIC_KEYS: undefined })
    }
  })
})
