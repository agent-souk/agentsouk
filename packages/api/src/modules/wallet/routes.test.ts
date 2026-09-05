import { describe, it, expect, beforeEach } from 'vitest'
import { freshApp, call, createTestAgent } from '../../test/setup.js'
import type { App } from '../../app.js'

let app: App
beforeEach(async () => {
  app = await freshApp()
})

describe('wallet', () => {
  it('shows sandbox credits on the test key and zero on live', async () => {
    const a = await createTestAgent(app)
    const t = await call(app, 'GET', '/v1/wallet', { key: a.api_keys.test })
    expect(t.status).toBe(200)
    expect(t.body.env).toBe('test')
    expect(t.body.balances[0].currency).toBe('CRD')
    expect(t.body.balances[0].available).toBeGreaterThan(0)
    const l = await call(app, 'GET', '/v1/wallet', { key: a.api_keys.live })
    expect(l.body.env).toBe('live')
    expect(l.body.balances[0].available).toBe(0)
  })

  it('transfers between agents, is idempotent, and rejects overdraft with 402', async () => {
    const a = await createTestAgent(app, { name: 'Payer' })
    const b = await createTestAgent(app, { name: 'Payee' })
    const before = (await call(app, 'GET', '/v1/wallet', { key: a.api_keys.test })).body.balances[0].available
    const h = { 'idempotency-key': 'tr-1' }
    const r1 = await call(app, 'POST', '/v1/wallet/transfers', { key: a.api_keys.test, body: { to: b.agent.handle, amount: 250, memo: 'thanks' }, headers: h })
    expect(r1.status).toBe(201)
    expect(r1.body.to).toBe(b.agent.id)
    expect(r1.body.balance.available).toBe(before - 250)
    const r2 = await call(app, 'POST', '/v1/wallet/transfers', { key: a.api_keys.test, body: { to: b.agent.handle, amount: 250, memo: 'thanks' }, headers: h })
    expect(r2.headers.get('idempotent-replayed')).toBe('true')
    const payee = await call(app, 'GET', '/v1/wallet', { key: b.api_keys.test })
    expect(payee.body.balances[0].available).toBe(before + 250)
    const over = await call(app, 'POST', '/v1/wallet/transfers', { key: a.api_keys.live, body: { to: b.agent.id, amount: 1 } })
    expect(over.status).toBe(402)
    expect(over.body.error.code).toBe('insufficient_funds')
    expect(over.body.error.hint).toContain('/v1/wallet/deposits')
    const self = await call(app, 'POST', '/v1/wallet/transfers', { key: a.api_keys.test, body: { to: a.agent.id, amount: 1 } })
    expect(self.status).toBe(400)
  })

  it('lists transaction history with deltas and pagination', async () => {
    const a = await createTestAgent(app)
    const b = await createTestAgent(app, { name: 'B' })
    await call(app, 'POST', '/v1/wallet/transfers', { key: a.api_keys.test, body: { to: b.agent.id, amount: 10 } })
    await call(app, 'POST', '/v1/wallet/transfers', { key: a.api_keys.test, body: { to: b.agent.id, amount: 20 } })
    const p1 = await call(app, 'GET', '/v1/wallet/transactions?limit=2', { key: a.api_keys.test })
    expect(p1.body.data).toHaveLength(2)
    expect(p1.body.data[0].delta).toBe(-20)
    expect(p1.body.data[1].delta).toBe(-10)
    expect(p1.body.has_more).toBe(true)
    const p2 = await call(app, 'GET', `/v1/wallet/transactions?limit=2&cursor=${p1.body.next_cursor}`, { key: a.api_keys.test })
    expect(p2.body.data[0].type).toBe('faucet')
    expect(p2.body.has_more).toBe(false)
  })

  it('sandbox deposits are instant and capped; live rails are documented but not yet live', async () => {
    const a = await createTestAgent(app)
    const rails = await call(app, 'GET', '/v1/wallet/rails')
    expect(rails.body.data.map((r: any) => r.rail)).toContain('x402')
    const dep = await call(app, 'POST', '/v1/wallet/deposits', { key: a.api_keys.test, body: { rail: 'sandbox', amount: 5000 } })
    expect(dep.status).toBe(201)
    expect(dep.body.status).toBe('confirmed')
    const w = await call(app, 'GET', '/v1/wallet', { key: a.api_keys.test })
    expect(w.body.balances[0].available).toBe(100000 + 5000)
    const wrongEnv = await call(app, 'POST', '/v1/wallet/deposits', { key: a.api_keys.live, body: { rail: 'sandbox', amount: 5000 } })
    expect(wrongEnv.status).toBe(400)
    const live = await call(app, 'POST', '/v1/wallet/deposits', { key: a.api_keys.live, body: { rail: 'x402', amount: 5000 } })
    expect(live.status).toBe(501)
    const cap = await call(app, 'POST', '/v1/wallet/deposits', { key: a.api_keys.test, body: { rail: 'sandbox', amount: 1_000_000 } })
    expect(cap.status).toBe(409)
    expect(cap.body.error.code).toBe('sandbox_cap_reached')
    const list = await call(app, 'GET', '/v1/wallet/deposits', { key: a.api_keys.test })
    expect(list.body.data).toHaveLength(1)
    const one = await call(app, 'GET', `/v1/wallet/deposits/${dep.body.id}`, { key: a.api_keys.test })
    expect(one.body.id).toBe(dep.body.id)
    const other = await call(app, 'GET', `/v1/wallet/deposits/${dep.body.id}`, { key: (await createTestAgent(app, { name: 'O' })).api_keys.test })
    expect(other.status).toBe(404)
  })

  it('sandbox withdrawals debit immediately', async () => {
    const a = await createTestAgent(app)
    const w = await call(app, 'POST', '/v1/wallet/withdrawals', { key: a.api_keys.test, body: { rail: 'sandbox', amount: 1000, destination: { note: 'void' } } })
    expect(w.status).toBe(201)
    expect(w.body.status).toBe('completed')
    const bal = await call(app, 'GET', '/v1/wallet', { key: a.api_keys.test })
    expect(bal.body.balances[0].available).toBe(99000)
    const list = await call(app, 'GET', '/v1/wallet/withdrawals', { key: a.api_keys.test })
    expect(list.body.data).toHaveLength(1)
  })
})
