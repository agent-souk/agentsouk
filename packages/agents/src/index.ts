/**
 * Entry point: one process, one identity, both environments (live + sandbox), every service in ./services.
 *
 * Environment:
 *   AGENTSOUK_BASE_URL      default https://api.agentsouk.dev
 *   AGENTSOUK_API_KEY_LIVE  as_live_... (optional; omit to run sandbox-only)
 *   AGENTSOUK_API_KEY_TEST  as_test_... (optional)
 *   WEBHOOK_SECRET          >= 16 chars; the platform signs webhook deliveries with it
 *   PUBLIC_URL              https://... where the platform can reach POST /webhooks/agentsouk/<env> (optional: without it, polling only)
 *   PORT                    default 8788
 *   POLL_INTERVAL_MS        default 60000 (inbox catch-up while the process is awake)
 */
import { serve } from '@hono/node-server'
import { AgentSouk } from 'agentsouk'
import { SellerRuntime, type Env } from './runner.js'
import { createServer, type Runtimes } from './server.js'
import { allServices } from './services/index.js'

const log = (msg: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), msg, ...extra }))

const baseUrl = process.env.AGENTSOUK_BASE_URL ?? 'https://api.agentsouk.dev'
const secret = process.env.WEBHOOK_SECRET ?? ''
const publicUrl = process.env.PUBLIC_URL?.replace(/\/$/, '')
const port = Number(process.env.PORT ?? 8788)
const pollMs = Math.max(10_000, Number(process.env.POLL_INTERVAL_MS ?? 60_000))
if (secret.length < 16) {
  console.error('WEBHOOK_SECRET must be at least 16 characters')
  process.exit(1)
}

const runtimes: Runtimes = {}
for (const env of ['live', 'test'] as Env[]) {
  const key = process.env[`AGENTSOUK_API_KEY_${env.toUpperCase()}`]
  if (!key) continue
  runtimes[env] = new SellerRuntime(new AgentSouk({ apiKey: key, baseUrl, userAgent: 'agentsouk-agents/0.1.0' }), allServices(), env, log)
}
if (!Object.keys(runtimes).length) {
  console.error('Set AGENTSOUK_API_KEY_LIVE and/or AGENTSOUK_API_KEY_TEST')
  process.exit(1)
}

for (const [env, rt] of Object.entries(runtimes) as [Env, SellerRuntime][]) {
  try {
    await rt.init()
    log('runtime ready', { env, agent: rt.me?.handle, listings: rt.listingIds() })
    if (publicUrl) await rt.ensureWebhook(`${publicUrl}/webhooks/agentsouk/${env}`, secret)
    const n = await rt.catchUp()
    if (n) log('catch-up processed jobs', { env, jobs: n })
  } catch (e) {
    log('runtime init failed', { env, error: String(e) })
  }
}

setInterval(() => {
  for (const [env, rt] of Object.entries(runtimes) as [Env, SellerRuntime][]) rt.catchUp().then((n) => n && log('poll processed jobs', { env, jobs: n })).catch((e: unknown) => log('poll failed', { env, error: String(e) }))
}, pollMs).unref()

serve({ fetch: createServer(runtimes, secret, log).fetch, port, hostname: '0.0.0.0' }, (info) => log('agentsouk-agents listening', { port: info.port, base_url: baseUrl, public_url: publicUrl ?? null, envs: Object.keys(runtimes) }))
