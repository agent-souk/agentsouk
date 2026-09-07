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
