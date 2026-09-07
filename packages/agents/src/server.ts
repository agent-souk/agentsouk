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
export type Operators = Partial<Record<Env, { handleEvent(event: { type: string; data?: Record<string, unknown> }): Promise<boolean>; status(): unknown }>>
export type ServerOptions = { version?: string; wait?: boolean; llm?: () => Record<string, unknown>; operators?: Operators }

type WebhookEvent = { type: string; data?: Record<string, unknown> }

export function createServer(runtimes: Runtimes, secret: string, log: Logger, opts: ServerOptions = {}) {
  const app = new Hono()
  const operators = opts.operators ?? {}
  app.get('/', (c) => c.json({ service: 'agentsouk-agents', what: 'First-party agents of Agent Souk (ADR-23): reference seller services and the bounty desk, running on the platform like any third party would.', platform: 'https://api.agentsouk.dev', envs: Object.keys(runtimes), operator_envs: Object.keys(operators) }))
  app.get('/health', (c) =>
    c.json({
      status: 'ok',
      service: 'agentsouk-agents',
      version: opts.version ?? '0.1.0',
      envs: Object.keys(runtimes),
      llm: opts.llm?.() ?? null,
      operators: Object.fromEntries(Object.entries(operators).map(([env, o]) => [env, o.status()])),
      time: new Date().toISOString(),
    }),
  )

  const parse = async (c: { req: { text(): Promise<string>; header(n: string): string | undefined } }): Promise<{ event: WebhookEvent } | { error: string; status: 400 | 401 }> => {
    const body = await c.req.text()
    if (!verifyWebhook(secret, c.req.header('x-webhook-timestamp') ?? '', c.req.header('x-webhook-signature') ?? '', body)) return { error: 'invalid signature', status: 401 }
    try {
      return { event: JSON.parse(body) as WebhookEvent }
    } catch {
      return { error: 'invalid json', status: 400 }
    }
  }

  app.post('/webhooks/agentsouk/:env', async (c) => {
    const env = c.req.param('env') as Env
    const rt = runtimes[env]
    if (!rt) return c.json({ error: 'unknown environment' }, 404)
    const p = await parse(c)
    if ('error' in p) return c.json({ error: p.error }, p.status)
    const work = rt.handleEvent(p.event).catch((e: unknown) => log('event handling failed', { env, type: p.event.type, error: String(e) }))
    if (opts.wait) await work
    return c.json({ ok: true }, 200)
  })

  app.post('/webhooks/agentsouk/:env/operator', async (c) => {
    const env = c.req.param('env') as Env
    const op = operators[env]
    if (!op) return c.json({ error: 'unknown environment' }, 404)
    const p = await parse(c)
    if ('error' in p) return c.json({ error: p.error }, p.status)
    const work = op.handleEvent(p.event).catch((e: unknown) => log('operator event handling failed', { env, type: p.event.type, error: String(e) }))
    if (opts.wait) await work
    return c.json({ ok: true }, 200)
  })
  return app
}
