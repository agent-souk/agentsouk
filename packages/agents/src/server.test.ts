import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { createServer, verifyWebhook } from './server.js'
import type { SellerRuntime } from './runner.js'

const secret = 'whsec_0123456789abcdef'
const sign = (ts: number, body: string) => `v1=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`

describe('verifyWebhook', () => {
  it('accepts a fresh, correctly signed body and rejects everything else', () => {
    const ts = Math.floor(Date.now() / 1000)
    const body = '{"type":"job.created"}'
    expect(verifyWebhook(secret, String(ts), sign(ts, body), body)).toBe(true)
    expect(verifyWebhook(secret, String(ts), sign(ts, body + ' '), body)).toBe(false)
    expect(verifyWebhook('other', String(ts), sign(ts, body), body)).toBe(false)
    expect(verifyWebhook(secret, String(ts - 1000), sign(ts - 1000, body), body)).toBe(false)
    expect(verifyWebhook(secret, 'abc', sign(ts, body), body)).toBe(false)
    expect(verifyWebhook(secret, String(ts), 'v0=zz', body)).toBe(false)
  })
})

describe('webhook endpoint', () => {
  it('routes signed job.created events to the runtime of that environment', async () => {
    const seen: unknown[] = []
    const rt = { handleEvent: async (ev: unknown) => (seen.push(ev), 'delivered' as const) } as unknown as SellerRuntime
    const app = createServer({ test: rt }, secret, () => undefined, { wait: true })
    const body = JSON.stringify({ id: 'evt_1', type: 'job.created', data: { job_id: 'job_1' } })
    const ts = Math.floor(Date.now() / 1000)
    const ok = await app.request('/webhooks/agentsouk/test', { method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-timestamp': String(ts), 'x-webhook-signature': sign(ts, body) }, body })
    expect(ok.status).toBe(200)
    expect(seen).toEqual([JSON.parse(body)])
    const bad = await app.request('/webhooks/agentsouk/test', { method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-timestamp': String(ts), 'x-webhook-signature': 'v1=00' }, body })
    expect(bad.status).toBe(401)
    const unknownEnv = await app.request('/webhooks/agentsouk/live', { method: 'POST', headers: { 'x-webhook-timestamp': String(ts), 'x-webhook-signature': sign(ts, body) }, body })
    expect(unknownEnv.status).toBe(404)
    expect((await (await app.request('/health')).json()).status).toBe('ok')
  })
})

describe('keep-alive while working (ADR-67)', () => {
  it('holds the process\'s own request open while jobs run, answers everyone else at once', async () => {
    let working = 2
    const app = createServer({}, secret, () => undefined, { working: () => working, keepaliveToken: 'tok-0123456789' })
    const own = { headers: { 'x-keepalive': 'tok-0123456789' } }
    const idle = Date.now()
    expect(await (await app.request('/keepalive?ms=3000', own)).json()).toEqual({ working: 2, held: true })
    expect(Date.now() - idle).toBeGreaterThanOrEqual(2_900) // held for the whole window while work is running
    // no token, or the wrong one: the instant answer, however busy the process is (a public hold would let anyone
    // fill the machine's request limit while it works)
    const stranger = Date.now()
    expect(await (await app.request('/keepalive?ms=30000')).json()).toEqual({ working: 2, held: false })
    expect(await (await app.request('/keepalive?ms=30000', { headers: { 'x-keepalive': 'tok-0123456780' } })).json()).toEqual({ working: 2, held: false })
    expect(Date.now() - stranger).toBeLessThan(500)
    const t0 = Date.now()
    const held = app.request('/keepalive?ms=30000', own)
    setTimeout(() => (working = 0), 400)
    expect(await (await held).json()).toEqual({ working: 0, held: true }) // released as soon as the work is done
    expect(Date.now() - t0).toBeLessThan(2_000)
    const quiet = Date.now()
    expect(await (await app.request('/keepalive', own)).json()).toEqual({ working: 0, held: true })
    expect(Date.now() - quiet).toBeLessThan(200)
    // without a token configured nothing is ever held
    const none = createServer({}, secret, () => undefined, { working: () => 1 })
    expect(await (await none.request('/keepalive?ms=30000', own)).json()).toEqual({ working: 1, held: false })
  }, 15_000)
})

describe('faucet endpoint', () => {
  it('needs the shared secret, validates the body, and reports refusals as 409', async () => {
    const sent: { to: string; amount: bigint }[] = []
    const faucet = { secret: 'faucet_secret_0123456789', send: async (to: string, amount: bigint) => (sent.push({ to, amount }), amount > 1_000_000n ? Promise.reject(new Error('amount exceeds the faucet cap')) : { hash: '0x' + '11'.repeat(32), explorer: 'https://sepolia.basescan.org/tx/0x' + '11'.repeat(32) }), status: () => ({ enabled: true }) }
    const app = createServer({}, secret, () => undefined, { faucet })
    const post = (body: unknown, key = faucet.secret) => app.request('/faucet', { method: 'POST', headers: { 'content-type': 'application/json', 'x-faucet-secret': key }, body: JSON.stringify(body) })
    expect((await post({ to: '0xA0a2494006B72109137630bC026434a809731c07', amount: 1000000 }, 'wrong')).status).toBe(401)
    expect((await post({ to: 'nope', amount: 1000000 })).status).toBe(400)
    expect((await post({ to: '0xA0a2494006B72109137630bC026434a809731c07', amount: 0 })).status).toBe(400)
    const ok = await post({ to: '0xA0a2494006B72109137630bC026434a809731c07', amount: 1000000 })
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as any).transaction).toBe('0x' + '11'.repeat(32))
    expect(sent).toEqual([{ to: '0xA0a2494006B72109137630bC026434a809731c07', amount: 1_000_000n }])
    const refused = await post({ to: '0xA0a2494006B72109137630bC026434a809731c07', amount: 5000000 })
    expect(refused.status).toBe(409)
    expect(((await (await app.request('/health')).json()) as any).faucet).toEqual({ enabled: true })
    const off = createServer({}, secret, () => undefined, {})
    expect((await off.request('/faucet', { method: 'POST', headers: { 'x-faucet-secret': 'x' }, body: '{}' })).status).toBe(404)
  })
})

