import { describe, it, expect, beforeEach } from 'vitest'
import { freshApp, call, createTestAgent, randomAddress, randomWallet, setWallet } from '../../test/setup.js'
import type { App } from '../../app.js'
import { generateKeyPair, didKeyFromPublicKey, sign } from '../../lib/crypto.js'
import { walletMessage } from './service.js'
import { toChecksumAddress } from '../payments/address.js'

let app: App
beforeEach(async () => {
  app = await freshApp()
})

describe('POST /v1/agents', () => {
  it('creates an identity in one call with keys, keypair and next steps', async () => {
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
    expect(r.body.wallet).toBeUndefined()
    expect(r.body.wallet_address).toBeNull()
    expect(r.body.next_steps.some((s: any) => s.path === '/v1/agents/me/wallet-address')).toBe(true)
    expect(r.body.docs.openapi).toContain('/openapi.json')
    expect(r.body.docs.payments).toContain('/v1/payments')
  })

  it('ignores wallet_address at registration: wallets are bound afterwards with a signature', async () => {
    const r = await call(app, 'POST', '/v1/agents', { body: { name: 'Walleted', wallet_address: randomAddress() } })
    expect(r.status).toBe(201)
    expect(r.body.wallet_address).toBeNull()
    const pub = await call(app, 'GET', `/v1/agents/${r.body.agent.id}`)
    expect(pub.body.wallet_address).toBeUndefined()
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

describe('wallet address', () => {
  it('binding needs a personal_sign signature by the wallet; a stranger cannot claim an address it does not control', async () => {
    const a = await createTestAgent(app, { name: 'Wallet', wallet_address: null })
    const w = randomWallet()
    const other = randomWallet()
    const noSig = await call(app, 'POST', '/v1/agents/me/wallet-address', { key: a.api_keys.test, body: { address: w.address } })
    expect(noSig.status).toBe(400)
    const wrongSigner = await call(app, 'POST', '/v1/agents/me/wallet-address', { key: a.api_keys.test, body: { address: w.address, signature: other.sign(walletMessage(a.agent.id, w.address)) } })
    expect(wrongSigner.status).toBe(400)
    expect(wrongSigner.body.error.code).toBe('wallet_signature_invalid')
    expect(wrongSigner.body.error.hint).toContain(`agentsouk:wallet:${a.agent.id}:${w.address.toLowerCase()}`)
    const wrongAgent = await call(app, 'POST', '/v1/agents/me/wallet-address', { key: a.api_keys.test, body: { address: w.address, signature: w.sign(walletMessage('agt_someone_else', w.address)) } })
    expect(wrongAgent.status).toBe(400)
    const bad = await call(app, 'POST', '/v1/agents/me/wallet-address', { key: a.api_keys.test, body: { address: '0x123', signature: '0x00' } })
    expect(bad.status).toBe(400)
    expect(bad.body.error.param).toBe('address')
    const ok = await setWallet(app, a.api_keys.test, a.agent.id, w)
    expect(ok.status).toBe(200)
    expect(ok.body.wallet_address).toBe(toChecksumAddress(w.address))
    // lowercase / uppercase spellings of the same address are the same wallet
    const same = await call(app, 'POST', '/v1/agents/me/wallet-address', { key: a.api_keys.test, body: { address: w.address.toLowerCase(), signature: w.sign(walletMessage(a.agent.id, w.address)) } })
    expect(same.status).toBe(200)
    const me = await call(app, 'GET', '/v1/agents/me', { key: a.api_keys.test })
    expect(me.body.wallet_address).toBe(toChecksumAddress(w.address))
    // re-binding the SAME address still verifies the signature: a 200 here always means "this wallet signed" (security bounty, veriton, 2026-09-08)
    const sameBadSig = await call(app, 'POST', '/v1/agents/me/wallet-address', { key: a.api_keys.test, body: { address: w.address, signature: '0x' + 'ab'.repeat(65) } })
    expect(sameBadSig.status).toBe(400)
    expect(sameBadSig.body.error.code).toBe('wallet_signature_invalid')
    const sameStranger = await call(app, 'POST', '/v1/agents/me/wallet-address', { key: a.api_keys.test, body: { address: w.address, signature: other.sign(walletMessage(a.agent.id, w.address)) } })
    expect(sameStranger.status).toBe(400)
    const sameGood = await call(app, 'POST', '/v1/agents/me/wallet-address', { key: a.api_keys.test, body: { address: w.address, signature: w.sign(walletMessage(a.agent.id, w.address)) } })
    expect(sameGood.status).toBe(200) // no proof needed: nothing changes
  })

  it('changing a bound wallet needs the new wallet signature AND an Ed25519 proof by the agent key', async () => {
    const a = await createTestAgent(app, { name: 'Changer' })
    const first = a.wallet!
    const second = randomWallet()
    const noProof = await call(app, 'POST', '/v1/agents/me/wallet-address', { key: a.api_keys.test, body: { address: second.address, signature: second.sign(walletMessage(a.agent.id, second.address)) } })
    expect(noProof.status).toBe(400)
    expect(noProof.body.error.param).toBe('proof')
    const attacker = generateKeyPair()
    const forged = await setWallet(app, a.api_keys.test, a.agent.id, second, sign(walletMessage(a.agent.id, second.address), attacker.secretKey))
    expect(forged.status).toBe(400)
    const ok = await setWallet(app, a.api_keys.test, a.agent.id, second, sign(walletMessage(a.agent.id, second.address), a.keypair!.secret_key))
    expect(ok.status).toBe(200)
    expect(ok.body.wallet_address).toBe(toChecksumAddress(second.address))
    const ev = await call(app, 'GET', '/v1/events?types=agent.wallet_address_changed', { key: a.api_keys.live })
    expect(ev.body.data).toHaveLength(2)
    expect(ev.body.data.map((e: any) => e.data.previous)).toContain(toChecksumAddress(first.address))
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

describe('DELETE /v1/agents/me', () => {
  it('needs the handle as confirmation, then hides the profile, revokes both keys and archives listings', async () => {
    const a = await createTestAgent(app, { name: 'Leaver' })
    const l = await call(app, 'POST', '/v1/listings', { key: a.api_keys.test, body: { title: 'Svc', description: 'A service that is archived when the seller leaves.', category: 'ops', pricing_model: 'fixed', price: 10 } })
    expect(l.status).toBe(201)
    const wrong = await call(app, 'DELETE', '/v1/agents/me', { key: a.api_keys.test, body: { confirm: 'nope' } })
    expect(wrong.status).toBe(400)
    expect(wrong.body.error.hint).toContain('irreversible')
    const del = await call(app, 'DELETE', '/v1/agents/me', { key: a.api_keys.test, body: { confirm: a.agent.handle } })
    expect(del.status).toBe(200)
    expect(del.body).toEqual({ object: 'agent.deleted', id: a.agent.id, handle: a.agent.handle })
    expect((await call(app, 'GET', '/v1/agents/me', { key: a.api_keys.test })).status).toBe(401)
    expect((await call(app, 'GET', '/v1/agents/me', { key: a.api_keys.live })).status).toBe(401)
    expect((await call(app, 'GET', `/v1/agents/${a.agent.id}`)).status).toBe(404)
    expect((await call(app, 'GET', `/v1/listings/${l.body.id}`)).status).toBe(404)
    expect((await call(app, 'GET', '/v1/stats?env=test')).body.agents).toBe(0)
  })
})

describe('registration names', () => {
  it('rejects blank names and gives non-Latin or symbol names a unique handle instead of a shared "agent-"', async () => {
    const blank = await call(app, 'POST', '/v1/agents', { body: { name: '   ' } })
    expect(blank.status).toBe(400)
    const emoji = await call(app, 'POST', '/v1/agents', { body: { name: '🤖' } })
    expect(emoji.status).toBe(201)
    expect(emoji.body.agent.handle).toMatch(/^agent-[a-z0-9]{4}$/)
    const cjk = await call(app, 'POST', '/v1/agents', { body: { name: '翻訳ボット' } })
    expect(cjk.status).toBe(201)
    expect(cjk.body.agent.handle).toMatch(/^agent-[a-z0-9]{4}$/)
    expect(cjk.body.agent.handle).not.toBe(emoji.body.agent.handle)
    const padded = await call(app, 'POST', '/v1/agents', { body: { name: '  Padded Bot  ' } })
    expect(padded.body.agent.name).toBe('Padded Bot')
    expect(padded.body.agent.handle).toBe('padded-bot')
  })
})

