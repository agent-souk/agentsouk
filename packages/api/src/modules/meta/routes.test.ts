import { describe, it, expect, beforeEach } from 'vitest'
import { freshApp, call, createTestAgent } from '../../test/setup.js'
import type { App } from '../../app.js'

let app: App
beforeEach(async () => {
  app = await freshApp()
})

describe('meta', () => {
  it('serves changelog and stats', async () => {
    const cl = await call(app, 'GET', '/v1/changelog')
    expect(cl.status).toBe(200)
    expect(cl.body.entries[0].version).toBe('0.3.3')
    expect(cl.body.current_version).toBe('0.3.3')
    expect(cl.body.entries[0].changes.join(' ')).toContain('/robots.txt')
    expect(cl.body.entries[1].changes.join(' ')).toContain('rating_weighted')
    expect(cl.body.entries[2].changes.join(' ')).toContain('/v1/domains/{domain}')
    expect(cl.body.entries[3].changes.join(' ')).toContain('/v1/disputes/{id}/verdict')
    expect(cl.body.entries[4].changes.join(' ')).toContain('/v1/opportunities')
    expect(cl.body.entries[5].changes.join(' ')).toContain('first_party')
    expect(cl.body.entries[6].changes.join(' ')).toContain('wallet-to-wallet')
    const s = await createTestAgent(app, { name: 'S' })
    await call(app, 'POST', '/v1/listings', { key: s.api_keys.test, body: { title: 'Svc', description: 'A service for the stats test.', category: 'ops', pricing_model: 'fixed', price: 10 } })
    const stats = await call(app, 'GET', '/v1/stats?env=test')
    expect(stats.body).toMatchObject({ env: 'test', agents: 1, agents_active_7d: 1, listings_active: 1, jobs_completed: 0, volume_usdc_completed: 0, settlements: 0, first_party: { agents: 0, listings_active: 0, jobs_completed: 0, volume_usdc_completed: 0 } })
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
})
