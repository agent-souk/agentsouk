import { describe, it, expect, beforeEach } from 'vitest'
import { freshApp, call, createTestAgent } from '../../test/setup.js'
import type { App } from '../../app.js'
import { generateKeyPair, didKeyFromPublicKey } from '../../lib/crypto.js'

let app: App
beforeEach(async () => {
  app = await freshApp()
})

describe('POST /v1/agents', () => {
  it('creates an identity in one call with keys, keypair, sandbox credits and next steps', async () => {
    const r = await call(app, 'POST', '/v1/agents', { body: { name: 'Summarizer Bot', capabilities: ['Summarization', 'summarization'], tags: ['NLP'] } })
    expect(r.status).toBe(201)
    expect(r.body.object).toBe('agent.created')
    expect(r.body.agent.handle).toBe('summarizer-bot')
    expect(r.body.agent.capabilities).toEqual(['summarization'])
    expect(r.body.agent.tags).toEqual(['nlp'])
    expect(r.body.agent.did).toMatch(/^did:key:z6Mk/)
    expect(r.body.api_keys.live).toMatch(/^as_live_/)
    expect(r.body.api_keys.test).toMatch(/^as_test_/)
    expect(r.body.keypair.secret_key).toHaveLength(64)
    expect(r.body.wallet.test.CRD).toBeGreaterThan(0)
    expect(r.body.wallet.live.CRD).toBe(0)
    expect(r.body.next_steps.length).toBeGreaterThan(2)
    expect(r.body.docs.openapi).toContain('/openapi.json')
  })

  it('accepts a bring-your-own key (hex and did:key) and rejects duplicates', async () => {
    const kp = generateKeyPair()
    const a = await call(app, 'POST', '/v1/agents', { body: { name: 'A', public_key: kp.publicKey } })
    expect(a.status).toBe(201)
    expect(a.body.keypair).toBeUndefined()
    expect(a.body.agent.public_key).toBe(kp.publicKey)
    const dup = await call(app, 'POST', '/v1/agents', { body: { name: 'B', public_key: didKeyFromPublicKey(kp.publicKey) } })
    expect(dup.status).toBe(409)
    expect(dup.body.error.code).toBe('public_key_in_use')
    expect(dup.body.error.hint).toBeTruthy()
  })

  it('derives unique handles and rejects taken/reserved ones', async () => {
    const a = await createTestAgent(app, { name: 'Dup Name' })
    const b = await createTestAgent(app, { name: 'Dup Name' })
    expect(a.agent.handle).toBe('dup-name')
    expect(b.agent.handle).toMatch(/^dup-name-[a-z0-9]{4}$/)
    const taken = await call(app, 'POST', '/v1/agents', { body: { name: 'x', handle: 'dup-name' } })
    expect(taken.status).toBe(409)
    const reserved = await call(app, 'POST', '/v1/agents', { body: { name: 'x', handle: 'admin' } })
    expect(reserved.status).toBe(409)
  })

  it('returns uniform validation errors with param and hint', async () => {
    const r = await call(app, 'POST', '/v1/agents', { body: { handle: 'ok-handle' } })
    expect(r.status).toBe(400)
    expect(r.body.error.type).toBe('validation_error')
    expect(r.body.error.param).toBe('name')
    expect(r.body.error.hint).toContain('/openapi.json')
    expect(r.body.error.details.issues[0].path).toBe('name')
  })
})

describe('auth', () => {
  it('GET /v1/agents/me works with live and test keys and reports env', async () => {
    const a = await createTestAgent(app)
    const live = await call(app, 'GET', '/v1/agents/me', { key: a.api_keys.live })
    expect(live.status).toBe(200)
    expect(live.body.env).toBe('live')
    expect(live.body.id).toBe(a.agent.id)
    const test = await call(app, 'GET', '/v1/agents/me', { key: a.api_keys.test })
    expect(test.body.env).toBe('test')
  })

  it('accepts X-API-Key and raw key without Bearer', async () => {
    const a = await createTestAgent(app)
    const r1 = await call(app, 'GET', '/v1/agents/me', { headers: { 'x-api-key': a.api_keys.test } })
    expect(r1.status).toBe(200)
    const r2 = await call(app, 'GET', '/v1/agents/me', { headers: { authorization: a.api_keys.test } })
    expect(r2.status).toBe(200)
  })

  it('rejects missing and bogus keys with a helpful hint', async () => {
    const none = await call(app, 'GET', '/v1/agents/me')
    expect(none.status).toBe(401)
    expect(none.body.error.hint).toContain('POST /v1/agents')
    const bogus = await call(app, 'GET', '/v1/agents/me', { key: 'as_test_' + 'x'.repeat(40) })
    expect(bogus.status).toBe(401)
  })

  it('manages keys: create, list, revoke; cannot revoke last key in use', async () => {
    const a = await createTestAgent(app)
    const created = await call(app, 'POST', '/v1/agents/me/keys', { key: a.api_keys.live, body: { env: 'test', name: 'ci', expires_in_days: 30 } })
    expect(created.status).toBe(201)
    expect(created.body.key).toMatch(/^as_test_/)
    expect(created.body.expires_at).toBeTruthy()
    const list = await call(app, 'GET', '/v1/agents/me/keys', { key: a.api_keys.live })
    expect(list.body.data).toHaveLength(3)
    expect(JSON.stringify(list.body)).not.toContain(a.api_keys.live)
    const revoked = await call(app, 'DELETE', `/v1/agents/me/keys/${created.body.id}`, { key: a.api_keys.live })
    expect(revoked.body.status).toBe('revoked')
    const useRevoked = await call(app, 'GET', '/v1/agents/me', { key: created.body.key })
    expect(useRevoked.status).toBe(401)
    // revoke test key, then live key becomes the last one
    const testKeyId = list.body.data.find((k: any) => k.env === 'test' && k.id !== created.body.id).id
    await call(app, 'DELETE', `/v1/agents/me/keys/${testKeyId}`, { key: a.api_keys.live })
    const liveId = list.body.data.find((k: any) => k.env === 'live').id
    const last = await call(app, 'DELETE', `/v1/agents/me/keys/${liveId}`, { key: a.api_keys.live })
    expect(last.status).toBe(409)
    expect(last.body.error.code).toBe('last_key')
  })
})

describe('profile + search', () => {
  it('updates profile and merges endpoints', async () => {
    const a = await createTestAgent(app, { endpoints: { homepage: 'https://example.com' } })
    const r = await call(app, 'PATCH', '/v1/agents/me', { key: a.api_keys.live, body: { description: 'I summarize', endpoints: { mcp_url: 'https://example.com/mcp' }, tags: ['nlp'] } })
    expect(r.status).toBe(200)
    expect(r.body.description).toBe('I summarize')
    expect(r.body.endpoints).toEqual({ homepage: 'https://example.com', mcp_url: 'https://example.com/mcp' })
  })

  it('replays idempotent PATCH and rejects key reuse with different body', async () => {
    const a = await createTestAgent(app)
    const h = { 'idempotency-key': 'k-1' }
    const r1 = await call(app, 'PATCH', '/v1/agents/me', { key: a.api_keys.live, body: { name: 'N1' }, headers: h })
    const r2 = await call(app, 'PATCH', '/v1/agents/me', { key: a.api_keys.live, body: { name: 'N1' }, headers: h })
    expect(r2.headers.get('idempotent-replayed')).toBe('true')
    expect(r2.body).toEqual(r1.body)
    const r3 = await call(app, 'PATCH', '/v1/agents/me', { key: a.api_keys.live, body: { name: 'N2' }, headers: h })
    expect(r3.status).toBe(409)
    expect(r3.body.error.code).toBe('idempotency_key_reused')
  })

  it('searches by q, tag, capability with pagination', async () => {
    await createTestAgent(app, { name: 'Alpha Translator', capabilities: ['translation'], tags: ['lang'] })
    await createTestAgent(app, { name: 'Beta Summarizer', capabilities: ['summarization'], tags: ['nlp'] })
    await createTestAgent(app, { name: 'Gamma Translator', capabilities: ['translation'], tags: ['lang', 'fast'] })
    const q = await call(app, 'GET', '/v1/agents?q=translator')
    expect(q.body.data.map((a: any) => a.name).sort()).toEqual(['Alpha Translator', 'Gamma Translator'])
    const cap = await call(app, 'GET', '/v1/agents?capability=summarization')
    expect(cap.body.data).toHaveLength(1)
    const tag = await call(app, 'GET', '/v1/agents?tag=fast')
    expect(tag.body.data[0].name).toBe('Gamma Translator')
    const page1 = await call(app, 'GET', '/v1/agents?limit=2')
    expect(page1.body.data).toHaveLength(2)
    expect(page1.body.has_more).toBe(true)
    const page2 = await call(app, 'GET', `/v1/agents?limit=2&cursor=${page1.body.next_cursor}`)
    expect(page2.body.data).toHaveLength(1)
    expect(page2.body.has_more).toBe(false)
  })

  it('gets by id or handle', async () => {
    const a = await createTestAgent(app, { name: 'Lookup Me' })
    const byHandle = await call(app, 'GET', '/v1/agents/lookup-me')
    expect(byHandle.body.id).toBe(a.agent.id)
    const byId = await call(app, 'GET', `/v1/agents/${a.agent.id}`)
    expect(byId.body.handle).toBe('lookup-me')
    const missing = await call(app, 'GET', '/v1/agents/nobody-here')
    expect(missing.status).toBe(404)
  })

  it('rate limits agent creation per ip', async () => {
    for (let i = 0; i < 20; i++) await createTestAgent(app, { name: `A${i}` })
    const r = await call(app, 'POST', '/v1/agents', { body: { name: 'one too many' } })
    expect(r.status).toBe(429)
    expect(r.headers.get('retry-after')).toBeTruthy()
    expect(r.headers.get('ratelimit-remaining')).toBe('0')
  })
})
