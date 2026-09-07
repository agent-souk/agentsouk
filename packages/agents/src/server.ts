import { Hono } from 'hono'
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Env, Logger, SellerRuntime } from './runner.js'

/** Same scheme as the platform: x-webhook-signature = "v1=" + hex(HMAC-SHA256(secret, `${timestamp}.${body}`)). */
export function verifyWebhook(secret: string, timestamp: string, signature: string, body: string, now = Date.now(), toleranceSeconds = 300): boolean {
  if (!/^\d{1,12}$/.test(timestamp) || !signature.startsWith('v1=')) return false
  if (Math.abs(Math.floor(now / 1000) - Number(timestamp)) > toleranceSeconds) return false
  const expected = `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`
  const a = Buffer.from(expected)
  const b = Buffer.from(signature)
  return a.length === b.length && timingSafeEqual(a, b)
}

export type Runtimes = Partial<Record<Env, SellerRuntime>>

export function createServer(runtimes: Runtimes, secret: string, log: Logger, opts: { version?: string; wait?: boolean } = {}) {
  const app = new Hono()
  app.get('/', (c) => c.json({ service: 'agentsouk-agents', what: 'First-party seller agents of Agent Souk (ADR-23): reference services that run on the platform like any third party would.', platform: 'https://api.agentsouk.dev', envs: Object.keys(runtimes) }))
  app.get('/health', (c) => c.json({ status: 'ok', service: 'agentsouk-agents', version: opts.version ?? '0.1.0', envs: Object.keys(runtimes), time: new Date().toISOString() }))
  app.post('/webhooks/agentsouk/:env', async (c) => {
    const env = c.req.param('env') as Env
    const rt = runtimes[env]
    if (!rt) return c.json({ error: 'unknown environment' }, 404)
    const body = await c.req.text()
    if (!verifyWebhook(secret, c.req.header('x-webhook-timestamp') ?? '', c.req.header('x-webhook-signature') ?? '', body)) return c.json({ error: 'invalid signature' }, 401)
    let event: { type: string; data?: Record<string, unknown> }
    try {
      event = JSON.parse(body)
    } catch {
      return c.json({ error: 'invalid json' }, 400)
    }
    const work = rt.handleEvent(event).catch((e: unknown) => log('event handling failed', { env, type: event.type, error: String(e) }))
    if (opts.wait) await work
    return c.json({ ok: true }, 200)
  })
  return app
}
