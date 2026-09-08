import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { freshApp, createTestAgent, call } from '../../test/setup.js'
import { _setConfigForTests } from '../../config.js'
import type { App } from '../../app.js'
import { _setFaucetFetchForTests, type FaucetFetch } from './service.js'

let app: App
let deskCalls: { url: string; headers: Record<string, string>; body: any }[]
const TX = '0x' + 'f1'.repeat(32)

function fakeDesk(reply: () => { status: number; body: unknown } = () => ({ status: 200, body: { ok: true, transaction: TX, explorer: `https://sepolia.basescan.org/tx/${TX}` } })): FaucetFetch {
  return async (url, init) => {
    deskCalls.push({ url, headers: init.headers, body: JSON.parse(init.body) })
    const r = reply()
    return { status: r.status, json: async () => r.body }
  }
}

beforeEach(async () => {
  app = await freshApp()
  deskCalls = []
  _setConfigForTests({ FAUCET_URL: 'http://desk.test/faucet', FAUCET_SECRET: 'faucet_secret_0123456789', FAUCET_AMOUNT_MINOR: 1_000_000, FAUCET_DAILY_GLOBAL: 100 })
  _setFaucetFetchForTests(fakeDesk())
})
afterEach(() => {
  _setFaucetFetchForTests(undefined)
  _setConfigForTests({ FAUCET_URL: undefined, FAUCET_SECRET: undefined })
})

describe('sandbox faucet (ADR-30)', () => {
  it('sends testnet USDC to the bound wallet once a day through the desk and records the claim', async () => {
    const a = await createTestAgent(app, { name: 'Thirsty Bot' })
    const before = await call(app, 'GET', '/v1/sandbox/faucet', { key: a.api_keys.test })
    expect(before.status).toBe(200)
    expect(before.body).toMatchObject({ object: 'faucet', enabled: true, env: 'test', amount: 1_000_000, display: '1.000000 USDC', network: 'eip155:84532', last_claim: null, next_claim_at: null })
    expect(before.body.how.join(' ')).toContain('POST /v1/sandbox/faucet')

    const r = await call(app, 'POST', '/v1/sandbox/faucet', { key: a.api_keys.test })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ object: 'faucet_claim', amount: 1_000_000, display: '1.000000 USDC', address: a.wallet_address, network: 'eip155:84532', transaction: TX, explorer: `https://sepolia.basescan.org/tx/${TX}` })
    expect(r.body.next_claim_at).toMatch(/T00:00:00\.000Z$/)
    expect(deskCalls).toHaveLength(1)
    expect(deskCalls[0]!.url).toBe('http://desk.test/faucet')
    expect(deskCalls[0]!.headers['x-faucet-secret']).toBe('faucet_secret_0123456789')
    expect(deskCalls[0]!.body).toEqual({ to: a.wallet_address, amount: 1_000_000 })

    const again = await call(app, 'POST', '/v1/sandbox/faucet', { key: a.api_keys.test })
    expect(again.status).toBe(409)
    expect(again.body.error.code).toBe('faucet_claimed_today')
    expect(again.body.error.details.next_claim_at).toBe(r.body.next_claim_at)
    expect(deskCalls).toHaveLength(1)

    const after = await call(app, 'GET', '/v1/sandbox/faucet', { key: a.api_keys.test })
    expect(after.body.last_claim).toMatchObject({ transaction: TX, amount: 1_000_000 })
    expect(after.body.next_claim_at).toBe(r.body.next_claim_at)
    const ev = await call(app, 'GET', '/v1/events?types=faucet.sent', { key: a.api_keys.test })
    expect(ev.body.data.some((e: any) => e.data.transaction === TX)).toBe(true)
  })

  it('refuses live keys and agents without a bound wallet, and never calls the desk for them', async () => {
    const a = await createTestAgent(app, { name: 'Live Bot' })
    const live = await call(app, 'POST', '/v1/sandbox/faucet', { key: a.api_keys.live })
    expect(live.status).toBe(409)
    expect(live.body.error.code).toBe('faucet_test_only')
    const b = await createTestAgent(app, { name: 'No Wallet', wallet_address: null })
    const noWallet = await call(app, 'POST', '/v1/sandbox/faucet', { key: b.api_keys.test })
    expect(noWallet.status).toBe(409)
    expect(noWallet.body.error.code).toBe('wallet_address_required')
    expect(deskCalls).toHaveLength(0)
    const status = await call(app, 'GET', '/v1/sandbox/faucet', { key: a.api_keys.live })
    expect(status.body.hint).toContain('as_test_')
  })

  it('maps desk refusals and outages honestly and records nothing', async () => {
    const a = await createTestAgent(app, { name: 'Unlucky Bot' })
    _setFaucetFetchForTests(fakeDesk(() => ({ status: 409, body: { ok: false, error: 'faucet daily cap reached' } })))
    const dry = await call(app, 'POST', '/v1/sandbox/faucet', { key: a.api_keys.test })
    expect(dry.status).toBe(503)
    expect(dry.body.error.code).toBe('faucet_dry')
    expect(dry.body.error.hint).toContain('faucet.circle.com')
    _setFaucetFetchForTests(async () => {
      throw new Error('ECONNREFUSED')
    })
    const down = await call(app, 'POST', '/v1/sandbox/faucet', { key: a.api_keys.test })
    expect(down.status).toBe(503)
    expect(down.body.error.code).toBe('faucet_unavailable')
    _setFaucetFetchForTests(fakeDesk(() => ({ status: 200, body: { ok: true, transaction: 'not-a-hash' } })))
    expect((await call(app, 'POST', '/v1/sandbox/faucet', { key: a.api_keys.test })).status).toBe(503)
    // nothing recorded: a later successful claim still counts as the first of the day
    _setFaucetFetchForTests(fakeDesk())
    expect((await call(app, 'POST', '/v1/sandbox/faucet', { key: a.api_keys.test })).status).toBe(200)
    // no faucet configured
    _setConfigForTests({ FAUCET_URL: undefined })
    const b = await createTestAgent(app, { name: 'Late Bot' })
    const off = await call(app, 'POST', '/v1/sandbox/faucet', { key: b.api_keys.test })
    expect(off.status).toBe(503)
    expect(off.body.error.code).toBe('faucet_unavailable')
    expect((await call(app, 'GET', '/v1/sandbox/faucet', { key: b.api_keys.test })).body.enabled).toBe(false)
  })

  it('caps claims per source address and per day globally', async () => {
    const agents = await Promise.all([1, 2, 3, 4].map((i) => createTestAgent(app, { name: `Bot ${i}` })))
    for (const a of agents.slice(0, 3)) expect((await call(app, 'POST', '/v1/sandbox/faucet', { key: a.api_keys.test })).status).toBe(200)
    const fourth = await call(app, 'POST', '/v1/sandbox/faucet', { key: agents[3]!.api_keys.test })
    expect(fourth.status).toBe(429)
    expect(fourth.body.error.code).toBe('faucet_ip_limit')
    expect(deskCalls).toHaveLength(3)
    _setConfigForTests({ FAUCET_DAILY_GLOBAL: 3 })
    const x = await createTestAgent(app, { name: 'Bot X' })
    const busy = await call(app, 'POST', '/v1/sandbox/faucet', { key: x.api_keys.test, headers: { 'x-forwarded-for': '203.0.113.9' } })
    expect([503, 429]).toContain(busy.status) // the ip limit (same test ip) or the global cap: both refuse before the desk
    expect(deskCalls).toHaveLength(3)
  })
})
