import { randomBytes } from 'node:crypto'
import { _resetDbForTests } from '../db/client.js'
import { runMigrations } from '../db/migrate.js'
import { _resetRateLimits } from '../middleware/ratelimit.js'
import { createApp, type App } from '../app.js'
import { _setRpcFetchForTests } from '../modules/payments/chain.js'
import { privateKeyToAddress, signMessage } from '../modules/payments/evm-signature.js'
import { walletMessage } from '../modules/agents/service.js'

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
  const res = await app.request(path, { method, headers, body: opts.body !== undefined ? JSON.stringify(body(opts.body)) : undefined })
  return { status: res.status, body: await json(res), headers: res.headers }
}
const body = (b: unknown) => b

/** A fresh lowercase EVM address nobody controls (for "wrong recipient/sender" cases). */
export function randomAddress(): string {
  return '0x' + randomBytes(20).toString('hex')
}

export type TestWallet = { address: string; privateKey: string; sign: (message: string) => string }

/** A throwaway secp256k1 wallet that can sign EIP-191 messages (never holds real funds). */
export function randomWallet(): TestWallet {
  const privateKey = '0x' + randomBytes(32).toString('hex')
  const address = privateKeyToAddress(privateKey)
  return { address, privateKey, sign: (message) => signMessage(message, privateKey) }
}

export type TestAgent = { agent: { id: string; handle: string }; api_keys: { live: string; test: string }; keypair?: { public_key: string; secret_key: string }; wallet_address: string | null; wallet: TestWallet | null }

/** Sets (or changes) an agent's wallet with a proper EIP-191 signature. */
export async function setWallet(app: App, key: string, agentId: string, wallet: TestWallet, proof?: string) {
  return call(app, 'POST', '/v1/agents/me/wallet-address', { key, body: { address: wallet.address, signature: wallet.sign(walletMessage(agentId, wallet.address)), proof } })
}

/**
 * Registers an agent and, by default, binds a fresh throwaway wallet with a valid signature.
 * Pass `wallet_address: null` to register without a wallet.
 */
export async function createTestAgent(app: App, overrides: Record<string, unknown> = {}): Promise<TestAgent> {
  const { wallet_address, ...rest } = overrides
  const r = await call(app, 'POST', '/v1/agents', { body: { name: 'Test Agent', ...rest } })
  if (r.status !== 201) throw new Error('createTestAgent failed: ' + JSON.stringify(r.body))
  const out = r.body as TestAgent
  out.wallet = null
  if (wallet_address !== null) {
    const wallet = randomWallet()
    const w = await setWallet(app, out.api_keys.test, out.agent.id, wallet)
    if (w.status !== 200) throw new Error('createTestAgent: wallet failed: ' + JSON.stringify(w.body))
    out.wallet_address = w.body.wallet_address
    out.wallet = wallet
  }
  return out
}
