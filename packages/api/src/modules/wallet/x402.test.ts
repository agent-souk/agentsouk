import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { freshApp, call, createTestAgent } from '../../test/setup.js'
import type { App } from '../../app.js'
import { _setConfigForTests } from '../../config.js'
import { payDepositX402, expireDeposits } from './service.js'
import { atomicUsdcForCrd, type FacilitatorFetch } from './rails/x402.js'

let app: App
type Ag = Awaited<ReturnType<typeof createTestAgent>>
let a: Ag

beforeEach(async () => {
  _setConfigForTests({ X402_PAY_TO: '0x1111111111111111111111111111111111111111', X402_NETWORK: 'base' })
  app = await freshApp()
  a = await createTestAgent(app, { name: 'Payer' })
})
afterEach(() => _setConfigForTests({ X402_PAY_TO: undefined }))

const facilitator = (verify: Record<string, unknown>, settle: Record<string, unknown>, seen: any[] = []): FacilitatorFetch => async (url, init) => {
  seen.push({ url, body: JSON.parse(init.body) })
  const json = url.endsWith('/verify') ? verify : settle
  return { status: 200, json: async () => json }
}

describe('x402 deposits', () => {
  it('creates a pending deposit with standard PaymentRequirements; 402 without X-PAYMENT', async () => {
    const rails = await call(app, 'GET', '/v1/wallet/rails')
    expect(rails.body.data.find((r: any) => r.rail === 'x402').status).toBe('available')
    const dep = await call(app, 'POST', '/v1/wallet/deposits', { key: a.api_keys.live, body: { rail: 'x402', amount: 2500 } })
    expect(dep.status, JSON.stringify(dep.body)).toBe(201)
    expect(dep.body.status).toBe('pending')
    const req = dep.body.external_request
    expect(req.x402Version).toBe(1)
    expect(req.accepts[0]).toMatchObject({ scheme: 'exact', network: 'base', maxAmountRequired: '2500000', payTo: '0x1111111111111111111111111111111111111111', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' })
    expect(req.accepts[0].resource).toContain(`/v1/wallet/deposits/${dep.body.id}/pay`)
    expect(atomicUsdcForCrd(1000)).toBe('1000000')
    const need = await call(app, 'POST', `/v1/wallet/deposits/${dep.body.id}/pay`, { key: a.api_keys.live })
    expect(need.status).toBe(402)
    expect(need.body.accepts[0].maxAmountRequired).toBe('2500000')
    const testDep = await call(app, 'POST', '/v1/wallet/deposits', { key: a.api_keys.test, body: { rail: 'x402', amount: 1000 } })
    expect(testDep.body.external_request.accepts[0].network).toBe('base-sepolia')
    expect((await call(app, 'GET', '/v1/wallet', { key: a.api_keys.live })).body.balances[0].available).toBe(0)
  })

  it('verifies + settles via the facilitator, credits once (idempotent), emits deposit.confirmed', async () => {
    const dep = await call(app, 'POST', '/v1/wallet/deposits', { key: a.api_keys.live, body: { rail: 'x402', amount: 2500 } })
    const seen: any[] = []
    const ok = facilitator({ isValid: true }, { success: true, transaction: '0xabc', network: 'base', payer: '0x2222222222222222222222222222222222222222' }, seen)
    const r1 = await payDepositX402('live', a.agent.id, dep.body.id, 'base64payload', ok)
    expect(r1.deposit.status).toBe('confirmed')
    expect(r1.deposit.externalRef).toBe('0xabc')
    expect(seen.map((s) => s.url.split('/').pop())).toEqual(['verify', 'settle'])
    expect(seen[0].body.paymentHeader).toBe('base64payload')
    expect(seen[0].body.paymentRequirements.maxAmountRequired).toBe('2500000')
    expect((await call(app, 'GET', '/v1/wallet', { key: a.api_keys.live })).body.balances[0].available).toBe(2500)
    const r2 = await payDepositX402('live', a.agent.id, dep.body.id, 'base64payload', ok)
    expect(r2.deposit.status).toBe('confirmed')
    expect((await call(app, 'GET', '/v1/wallet', { key: a.api_keys.live })).body.balances[0].available).toBe(2500)
    const ev = await call(app, 'GET', '/v1/events?types=deposit.confirmed', { key: a.api_keys.live })
    expect(ev.body.data[0].data.transaction).toBe('0xabc')
    const other = await createTestAgent(app, { name: 'Other' })
    await expect(payDepositX402('live', other.agent.id, dep.body.id, 'x', ok)).rejects.toMatchObject({ status: 404 })
  })

  it('rejects invalid payments and failed settlements without crediting; expires old deposits', async () => {
    const dep = await call(app, 'POST', '/v1/wallet/deposits', { key: a.api_keys.live, body: { rail: 'x402', amount: 1000 } })
    await expect(payDepositX402('live', a.agent.id, dep.body.id, 'bad', facilitator({ isValid: false, invalidReason: 'insufficient_funds' }, {}))).rejects.toMatchObject({ code: 'payment_invalid', status: 402 })
    await expect(payDepositX402('live', a.agent.id, dep.body.id, 'bad', facilitator({ isValid: true }, { success: false, errorReason: 'nonce_used' }))).rejects.toMatchObject({ code: 'settlement_failed' })
    expect((await call(app, 'GET', '/v1/wallet', { key: a.api_keys.live })).body.balances[0].available).toBe(0)
    expect(await expireDeposits(Date.now() + 25 * 3600_000)).toBe(1)
    const after = await call(app, 'GET', `/v1/wallet/deposits/${dep.body.id}`, { key: a.api_keys.live })
    expect(after.body.status).toBe('expired')
    const late = await call(app, 'POST', `/v1/wallet/deposits/${dep.body.id}/pay`, { key: a.api_keys.live })
    expect(late.status).toBe(409)
  })

  it('is coming_soon when unconfigured', async () => {
    _setConfigForTests({ X402_PAY_TO: undefined })
    const rails = await call(app, 'GET', '/v1/wallet/rails')
    expect(rails.body.data.find((r: any) => r.rail === 'x402').status).toBe('coming_soon')
    const dep = await call(app, 'POST', '/v1/wallet/deposits', { key: a.api_keys.live, body: { rail: 'x402', amount: 1000 } })
    expect(dep.status).toBe(501)
  })
})
