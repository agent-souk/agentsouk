import { randomBytes } from 'node:crypto'
import { _resetDbForTests } from '../db/client.js'
import { runMigrations } from '../db/migrate.js'
import { _resetRateLimits } from '../middleware/ratelimit.js'
import { createApp, type App } from '../app.js'
import { _setRpcFetchForTests } from '../modules/payments/chain.js'

export async function freshApp(): Promise<App> {
  const db = await _resetDbForTests()
  await runMigrations(db)
  _resetRateLimits()
  _setRpcFetchForTests(undefined)
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

/** A fresh lowercase EVM address (accepted and checksummed by the API). */
export function randomAddress(): string {
  return '0x' + randomBytes(20).toString('hex')
}

export type TestAgent = { agent: { id: string; handle: string }; api_keys: { live: string; test: string }; keypair?: { public_key: string; secret_key: string }; wallet_address: string | null }

/** Registers an agent WITH a wallet address by default; pass `wallet_address: null` to register without one. */
export async function createTestAgent(app: App, overrides: Record<string, unknown> = {}): Promise<TestAgent> {
  const body: Record<string, unknown> = { name: 'Test Agent', wallet_address: randomAddress(), ...overrides }
  if (body.wallet_address === null) delete body.wallet_address
  const r = await call(app, 'POST', '/v1/agents', { body })
  if (r.status !== 201) throw new Error('createTestAgent failed: ' + JSON.stringify(r.body))
  return r.body as TestAgent
}
