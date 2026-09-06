import { describe, it, expect, beforeEach } from 'vitest'
import { freshApp, call, createTestAgent } from '../test/setup.js'
import { signRequest } from '../test/sign.js'
import type { App } from '../app.js'
import { generateKeyPair, sign, didKeyFromPublicKey } from '../lib/crypto.js'
import { jwkThumbprint } from '../lib/server-keys.js'
import { _resetNonces } from './signatures.js'
import { rotationMessage } from '../modules/agents/service.js'

let app: App
const BASE = 'http://localhost:8787'
type Ag = Awaited<ReturnType<typeof createTestAgent>>
let a: Ag

beforeEach(async () => {
  app = await freshApp()
  _resetNonces()
  a = await createTestAgent(app, { name: 'Signer' })
})

async function signed(method: string, path: string, opts: { body?: unknown; secretKey?: string; keyid?: string; env?: string; created?: number; nonce?: string; tamper?: (h: Record<string, string>) => void; components?: string[] } = {}) {
  const bodyText = opts.body !== undefined ? JSON.stringify(opts.body) : undefined
  const headers = signRequest({ method, url: `${BASE}${path}`, body: bodyText, secretKey: opts.secretKey ?? a.keypair!.secret_key, keyid: opts.keyid ?? a.agent.id, created: opts.created, nonce: opts.nonce, components: opts.components, extraHeaders: opts.env ? { 'x-env': opts.env } : undefined })
  if (bodyText) headers['content-type'] = 'application/json'
  opts.tamper?.(headers)
  const res = await app.request(path, { method, headers, body: bodyText })
  return { status: res.status, body: (await res.json()) as any }
}

describe('RFC 9421 signed requests', () => {
  it('authenticates GET and POST with content-digest; env from X-Env', async () => {
    const me = await signed('GET', '/v1/agents/me', { env: 'test' })
    expect(me.status, JSON.stringify(me.body)).toBe(200)
    expect(me.body.id).toBe(a.agent.id)
    expect(me.body.env).toBe('test')
    const live = await signed('GET', '/v1/agents/me')
    expect(live.body.env).toBe('live')
    const l = await signed('POST', '/v1/listings', { env: 'test', body: { title: 'Signed listing', description: 'Created with a signed request, no API key.', category: 'ops', pricing_model: 'fixed', price: 10 } })
    expect(l.status, JSON.stringify(l.body)).toBe(201)
    expect(l.body.seller.id).toBe(a.agent.id)
  })

  it('accepts keyid as handle, did:key and JWK thumbprint', async () => {
    expect((await signed('GET', '/v1/agents/me', { keyid: a.agent.handle })).status).toBe(200)
    expect((await signed('GET', '/v1/agents/me', { keyid: didKeyFromPublicKey(a.keypair!.public_key) })).status).toBe(200)
    expect((await signed('GET', '/v1/agents/me', { keyid: jwkThumbprint(a.keypair!.public_key) })).status).toBe(200)
  })

  it('rejects tampering, wrong keys, stale timestamps, replayed nonces and missing digests', async () => {
    const tampered = await signed('POST', '/v1/listings', { env: 'test', body: { title: 'x' }, tamper: (h) => (h['content-digest'] = 'sha-256=:AAAA:') })
    expect(tampered.status).toBe(401)
    expect(tampered.body.error.code).toBe('invalid_signature')
    const other = generateKeyPair()
    expect((await signed('GET', '/v1/agents/me', { secretKey: other.secretKey })).status).toBe(401)
    const stale = await signed('GET', '/v1/agents/me', { created: Math.floor(Date.now() / 1000) - 1000 })
    expect(stale.status).toBe(401)
    expect(stale.body.error.hint).toContain('clock')
    expect((await signed('GET', '/v1/agents/me', { nonce: 'n1' })).status).toBe(200)
    const replay = await signed('GET', '/v1/agents/me', { nonce: 'n1' })
    expect(replay.status).toBe(401)
    expect(replay.body.error.message).toContain('Nonce')
    const noDigest = await signed('POST', '/v1/listings', { env: 'test', body: { title: 'x' }, components: ['@method', '@target-uri', 'x-env'] })
    expect(noDigest.status).toBe(401)
    expect(noDigest.body.error.message).toContain('content-digest')
    const noNonce = await signed('POST', '/v1/listings', { env: 'test', body: { title: 'x' }, nonce: '', tamper: (h) => (h['signature-input'] = h['signature-input']!.replace(/;nonce="[^"]*"/, '')) })
    expect(noNonce.status).toBe(401)
    const envUncovered = await signed('GET', '/v1/agents/me', { tamper: (h) => (h['x-env'] = 'test') })
    expect(envUncovered.status).toBe(401)
    expect(envUncovered.body.error.message).toContain('X-Env')
    const envSwap = await signed('GET', '/v1/agents/me', { env: 'test', tamper: (h) => (h['x-env'] = 'live') })
    expect(envSwap.status).toBe(401)
    const unknown = await signed('GET', '/v1/agents/me', { keyid: 'agt_nope' })
    expect(unknown.status).toBe(401)
    const wrongMethod = await signed('GET', '/v1/agents/me', { tamper: (h) => (h['signature-input'] = h['signature-input']!.replace('"@method"', '"@path"')) })
    expect(wrongMethod.status).toBe(401)
  })

  it('optionalAuth treats an invalid signature as anonymous', async () => {
    const r = await signed('GET', '/v1/listings', { secretKey: generateKeyPair().secretKey })
    expect(r.status).toBe(200)
  })
})

describe('recovery and rotation', () => {
  it('recovers keys with a signed request and can revoke the old ones', async () => {
    const viaKey = await call(app, 'POST', '/v1/agents/recover', { key: a.api_keys.test, body: {} })
    expect(viaKey.status).toBe(401)
    expect(viaKey.body.error.hint).toContain('Signature-Input')
    const rec = await signed('POST', '/v1/agents/recover', { body: { revoke_existing: true } })
    expect(rec.status, JSON.stringify(rec.body)).toBe(200)
    expect(rec.body.api_keys.test).toMatch(/^as_test_/)
    expect(rec.body.revoked_previous).toBe(true)
    expect((await call(app, 'GET', '/v1/agents/me', { key: a.api_keys.test })).status).toBe(401)
    expect((await call(app, 'GET', '/v1/agents/me', { key: rec.body.api_keys.test })).status).toBe(200)
    const events = await call(app, 'GET', '/v1/events?types=agent.keys_recovered', { key: rec.body.api_keys.live })
    expect(events.body.data).toHaveLength(1)
  })

  it('rotates the key only via a signed request with a proof from the new key; old key stops working', async () => {
    const next = generateKeyPair()
    const viaApiKey = await call(app, 'POST', '/v1/agents/me/rotate-key', { key: a.api_keys.test, body: { new_public_key: next.publicKey, proof: 'ab'.repeat(64) } })
    expect(viaApiKey.status).toBe(401)
    const bad = await signed('POST', '/v1/agents/me/rotate-key', { body: { new_public_key: next.publicKey, proof: 'ab'.repeat(64) } })
    expect(bad.status).toBe(400)
    expect(bad.body.error.hint).toContain('agentsouk:rotate:')
    const proof = sign(rotationMessage(a.agent.id, a.keypair!.public_key, next.publicKey), next.secretKey)
    const ok = await signed('POST', '/v1/agents/me/rotate-key', { body: { new_public_key: didKeyFromPublicKey(next.publicKey), proof } })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(ok.body.public_key).toBe(next.publicKey)
    expect(ok.body.did).toBe(didKeyFromPublicKey(next.publicKey))
    expect((await signed('GET', '/v1/agents/me', { secretKey: next.secretKey })).status).toBe(200)
    expect((await signed('GET', '/v1/agents/me')).status).toBe(401)
    const jwks = (await (await app.request(`/agents/${a.agent.id}/jwks.json`)).json()) as any
    expect(jwks.keys[0].kid).toBe(jwkThumbprint(next.publicKey))
  })
})
