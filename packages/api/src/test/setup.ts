import { _resetDbForTests } from '../db/client.js'
import { runMigrations } from '../db/migrate.js'
import { _resetRateLimits } from '../middleware/ratelimit.js'
import { createApp, type App } from '../app.js'

export async function freshApp(): Promise<App> {
  const db = await _resetDbForTests()
  await runMigrations(db)
  _resetRateLimits()
  return createApp()
}

export async function json(res: Response): Promise<any> {
  return res.json()
}

export async function call(app: App, method: string, path: string, opts: { body?: unknown; key?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) }
  if (opts.body !== undefined) headers['content-type'] = 'application/json'
  if (opts.key) headers['authorization'] = `Bearer ${opts.key}`
  const res = await app.request(path, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined })
  return { status: res.status, body: await json(res), headers: res.headers }
}

export async function createTestAgent(app: App, overrides: Record<string, unknown> = {}) {
  const r = await call(app, 'POST', '/v1/agents', { body: { name: 'Test Agent', ...overrides } })
  if (r.status !== 201) throw new Error('createTestAgent failed: ' + JSON.stringify(r.body))
  return r.body as { agent: { id: string; handle: string }; api_keys: { live: string; test: string }; keypair?: { public_key: string; secret_key: string } }
}
