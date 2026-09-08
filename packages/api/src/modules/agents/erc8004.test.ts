import { describe, it, expect, beforeEach } from 'vitest'
import { freshApp, createTestAgent, call } from '../../test/setup.js'
import { installFakeChain, type FakeChain } from '../../test/chain.js'
import { _setConfigForTests } from '../../config.js'
import type { App } from '../../app.js'
import { decodeString, matchesAgentUri, parseAgentId, registryCaip10, IDENTITY_REGISTRY, ERC8004_TYPE, acceptedOrigins, sweepErc8004Links } from './erc8004.js'
import { setWallet, randomWallet } from '../../test/setup.js'
import { sign } from '../../lib/crypto.js'

const BASE = 'http://localhost:8787'

let app: App
let chain: FakeChain
beforeEach(async () => {
  app = await freshApp()
  chain = installFakeChain('test')
})

describe('erc8004 helpers', () => {
  it('parses agent ids (decimal strings, safe integers, uint256 bound)', () => {
    expect(parseAgentId('0')).toBe(0n)
    expect(parseAgentId('4711')).toBe(4711n)
    expect(parseAgentId(42)).toBe(42n)
    expect(parseAgentId(-1)).toBeUndefined()
    expect(parseAgentId(1.5)).toBeUndefined()
    expect(parseAgentId('0x10')).toBeUndefined()
    expect(parseAgentId('')).toBeUndefined()
    expect(parseAgentId('1'.repeat(79))).toBeUndefined()
    expect(parseAgentId(((1n << 256n) - 1n).toString())).toBe((1n << 256n) - 1n)
    expect(parseAgentId((1n << 256n).toString())).toBeUndefined()
  })

  it('decodes ABI strings and rejects malformed words', () => {
    const enc = (s: string) => {
      const b = Buffer.from(s, 'utf8')
      return '0x' + (32n).toString(16).padStart(64, '0') + BigInt(b.length).toString(16).padStart(64, '0') + b.toString('hex').padEnd(Math.ceil(b.length / 32) * 64, '0')
    }
    expect(decodeString(enc('https://agentsouk.dev/agents/agt_1/erc8004.json'))).toBe('https://agentsouk.dev/agents/agt_1/erc8004.json')
    expect(decodeString(enc(''))).toBe('')
    expect(decodeString('0x')).toBeUndefined()
    expect(decodeString('0x' + '00'.repeat(31) + '40' + '00'.repeat(32))).toBeUndefined() // offset 64
    expect(decodeString(enc('x').slice(0, 130))).toBeUndefined() // length word says 1 byte, no data word follows
    expect(decodeString(enc('x').slice(0, -2))).toBe('x') // padding is not needed to decode
    expect(decodeString(12)).toBeUndefined()
  })

  it('matches only this agent registration file on an accepted origin', () => {
    expect(matchesAgentUri(`${BASE}/agents/agt_1/erc8004.json`, BASE, 'agt_1')).toBe(true)
    expect(matchesAgentUri(`${BASE}/agents/agt_2/erc8004.json`, BASE, 'agt_1')).toBe(false)
    expect(matchesAgentUri(`${BASE}/agents/agt_1/erc8004.json?x=1`, BASE, 'agt_1')).toBe(false)
    expect(matchesAgentUri(`https://evil.example/agents/agt_1/erc8004.json`, BASE, 'agt_1')).toBe(false)
    expect(matchesAgentUri('not a url', BASE, 'agt_1')).toBe(false)
    expect(matchesAgentUri(null, BASE, 'agt_1')).toBe(false)
    expect(matchesAgentUri(`${BASE}/agents/agt_1/erc8004.json#frag`, BASE, 'agt_1')).toBe(false)
    expect(matchesAgentUri('http://user:pw@localhost:8787/agents/agt_1/erc8004.json', BASE, 'agt_1')).toBe(false)
    expect(matchesAgentUri('http://localhost:8443/agents/agt_1/erc8004.json', BASE, 'agt_1')).toBe(false) // other port = other origin
    expect(matchesAgentUri(`${BASE}/agents/AGT_1/erc8004.json`, BASE, 'agt_1')).toBe(false) // ids are case-sensitive
    expect(matchesAgentUri(`${BASE}/agents/agt_1/erc8004.json/`, BASE, 'agt_1')).toBe(false)
    expect(matchesAgentUri(`${BASE}/agents/../agents/agt_1/erc8004.json`, BASE, 'agt_1')).toBe(true) // WHATWG normalises dot segments
    expect(matchesAgentUri('x'.repeat(2049), BASE, 'agt_1')).toBe(false)
    // the apex, www and api hosts serve the same documents
    const prod = 'https://api.agentsouk.dev'
    expect(acceptedOrigins(prod)).toEqual(expect.arrayContaining(['https://api.agentsouk.dev', 'https://agentsouk.dev', 'https://www.agentsouk.dev']))
    expect(matchesAgentUri('https://agentsouk.dev/agents/agt_1/erc8004.json', prod, 'agt_1')).toBe(true)
    expect(matchesAgentUri('http://agentsouk.dev/agents/agt_1/erc8004.json', prod, 'agt_1')).toBe(false)
    expect(acceptedOrigins(BASE)).toEqual([BASE])
  })

  it('names the registries as CAIP-10', () => {
    expect(registryCaip10('live')).toBe('eip155:8453:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432')
    expect(registryCaip10('test')).toBe(`eip155:84532:${IDENTITY_REGISTRY.test.address}`)
  })
})

describe('registration files', () => {
  it('serves a registration-v1 file per agent with profile, DID and platform facts, CORS and a short cache', async () => {
    const a = await createTestAgent(app, { name: 'Chain Bot', description: 'does chain things', endpoints: { mcp_url: 'https://bot.example/mcp' } })
    const res = await app.request(`/agents/${a.agent.handle}/erc8004.json`)
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('cache-control')).toBe('public, max-age=300')
    const f = (await res.json()) as any
    expect(f.type).toBe(ERC8004_TYPE)
    expect(f.name).toBe('Chain Bot')
    expect(f.description).toBe('does chain things')
    expect(f.active).toBe(true)
    expect(f.x402Support).toBe(false)
    expect(f.registrations).toEqual([])
    expect(f.supportedTrust).toEqual(['reputation'])
    expect(f.services).toEqual(expect.arrayContaining([{ name: 'web', endpoint: `${BASE}/v1/agents/${a.agent.id}` }, { name: 'MCP', endpoint: 'https://bot.example/mcp' }]))
    expect(f.services.find((s: any) => s.name === 'DID').endpoint).toMatch(/^did:key:z6Mk/)
    expect(f['dev.agentsouk']).toMatchObject({ id: a.agent.id, handle: a.agent.handle, trust_tier: 0, first_party: false, erc8004: null, reputation: `${BASE}/v1/agents/${a.agent.id}/reputation` })
    expect((await app.request('/agents/nope/erc8004.json')).status).toBe(404)
  })

  it('serves the platform file at the EIP domain-verification path, listing configured agent ids', async () => {
    _setConfigForTests({ ERC8004_PLATFORM_AGENT_ID_TEST: '77' })
    const res = await app.request('/.well-known/agent-registration.json')
    expect(res.status).toBe(200)
    const f = (await res.json()) as any
    expect(f.type).toBe(ERC8004_TYPE)
    expect(f.name).toBe('Agent Souk')
    expect(f.services).toEqual(expect.arrayContaining([{ name: 'MCP', endpoint: `${BASE}/mcp`, version: '2025-06-18' }, { name: 'A2A', endpoint: `${BASE}/.well-known/agent-card.json`, version: '1.0' }, { name: 'web', endpoint: BASE }]))
    expect(f.services.find((s: any) => s.name === 'DID').endpoint).toMatch(/^did:key:z6Mk/)
    expect(f.registrations).toEqual([{ agentId: 77, agentRegistry: registryCaip10('test') }])
    expect(f['dev.agentsouk'].identity_registries.live.address).toBe(IDENTITY_REGISTRY.live.address)
    const sitemap = await (await app.request('/sitemap.xml')).text()
    expect(sitemap).toContain('/.well-known/agent-registration.json')
    const root = (await (await app.request('/')).json()) as any
    expect(root.interfaces.erc8004).toBe(`${BASE}/.well-known/agent-registration.json`)
    _setConfigForTests({ ERC8004_PLATFORM_AGENT_ID_TEST: undefined })
    expect(((await (await app.request('/.well-known/agent-registration.json')).json()) as any).registrations).toEqual([])
  })
})

describe('POST /v1/agents/me/erc8004', () => {
  it('links a token whose tokenURI is my file; owner_verified follows the bound wallet; public and in the file', async () => {
    const a = await createTestAgent(app, { name: 'Linker' })
    chain.erc8004.set('4711', { owner: a.wallet_address!, uri: `${BASE}/agents/${a.agent.id}/erc8004.json` })
    const r = await call(app, 'POST', '/v1/agents/me/erc8004', { key: a.api_keys.test, body: { agent_id: '4711' } })
    expect(r.status).toBe(200)
    expect(r.body.erc8004).toMatchObject({ agent_id: '4711', chain_id: 84532, registry: registryCaip10('test'), owner_verified: true })
    expect(r.body.erc8004.verified_at).toMatch(/^\d{4}-/)
    expect(r.body.erc8004.owner).toBeUndefined()
    const pub = (await (await app.request(`/v1/agents/${a.agent.id}`)).json()) as any
    expect(pub.erc8004.agent_id).toBe('4711')
    const file = (await (await app.request(`/agents/${a.agent.id}/erc8004.json`)).json()) as any
    expect(file.registrations).toEqual([{ agentId: 4711, agentRegistry: registryCaip10('test') }])
    expect(file['dev.agentsouk'].erc8004.owner_verified).toBe(true)
    const ev = await call(app, 'GET', '/v1/events?types=agent.erc8004_linked', { key: a.api_keys.live })
    expect(ev.body.data.some((e: any) => e.type === 'agent.erc8004_linked' && e.data.agent_id === '4711')).toBe(true)
    // integer form and idempotent re-link
    const again = await call(app, 'POST', '/v1/agents/me/erc8004', { key: a.api_keys.test, body: { agent_id: 4711 } })
    expect(again.status).toBe(200)
    expect(again.body.erc8004.agent_id).toBe('4711')
    // unlink
    const del = await call(app, 'DELETE', '/v1/agents/me/erc8004', { key: a.api_keys.test })
    expect(del.status).toBe(200)
    expect(del.body.erc8004).toBeNull()
    expect((((await (await app.request(`/agents/${a.agent.id}/erc8004.json`)).json()) as any).registrations)).toEqual([])
  })

  it('links with owner_verified=false when another wallet owns the token, and without a bound wallet', async () => {
    const a = await createTestAgent(app, { name: 'Other Owner' })
    chain.erc8004.set('5', { owner: '0x000000000000000000000000000000000000dEaD', uri: `${BASE}/agents/${a.agent.id}/erc8004.json` })
    const r = await call(app, 'POST', '/v1/agents/me/erc8004', { key: a.api_keys.test, body: { agent_id: '5' } })
    expect(r.status).toBe(200)
    expect(r.body.erc8004.owner_verified).toBe(false)
    const b = await createTestAgent(app, { name: 'No Wallet', wallet_address: null })
    chain.erc8004.set('6', { owner: '0x000000000000000000000000000000000000dEaD', uri: `${BASE}/agents/${b.agent.id}/erc8004.json` })
    const r2 = await call(app, 'POST', '/v1/agents/me/erc8004', { key: b.api_keys.test, body: { agent_id: 6 } })
    expect(r2.status).toBe(200)
    expect(r2.body.erc8004.owner_verified).toBe(false)
  })

  it('rejects unknown tokens (404), tokens pointing elsewhere (409 erc8004_uri_mismatch), bad ids (400) and a dead node (502)', async () => {
    const a = await createTestAgent(app, { name: 'Strict' })
    const other = await createTestAgent(app, { name: 'Victim' })
    const missing = await call(app, 'POST', '/v1/agents/me/erc8004', { key: a.api_keys.test, body: { agent_id: '999' } })
    expect(missing.status).toBe(404)
    expect(missing.body.error.hint).toContain(IDENTITY_REGISTRY.test.address)
    chain.erc8004.set('8', { owner: a.wallet_address!, uri: `${BASE}/agents/${other.agent.id}/erc8004.json` })
    const mismatch = await call(app, 'POST', '/v1/agents/me/erc8004', { key: a.api_keys.test, body: { agent_id: '8' } })
    expect(mismatch.status).toBe(409)
    expect(mismatch.body.error.code).toBe('erc8004_uri_mismatch')
    expect(mismatch.body.error.details.expected_uri).toBe(`${BASE}/agents/${a.agent.id}/erc8004.json`)
    chain.erc8004.set('9', { owner: a.wallet_address!, uri: 'ipfs://bafy' })
    expect((await call(app, 'POST', '/v1/agents/me/erc8004', { key: a.api_keys.test, body: { agent_id: '9' } })).status).toBe(409)
    expect((await call(app, 'POST', '/v1/agents/me/erc8004', { key: a.api_keys.test, body: { agent_id: '0x1' } })).status).toBe(400)
    expect((await call(app, 'POST', '/v1/agents/me/erc8004', { key: a.api_keys.test, body: {} })).status).toBe(400)
    const pub = (await (await app.request(`/v1/agents/${a.agent.id}`)).json()) as any
    expect(pub.erc8004).toBeNull()
    chain.down = true
    const down = await call(app, 'POST', '/v1/agents/me/erc8004', { key: a.api_keys.test, body: { agent_id: '8' } })
    expect(down.status).toBe(502)
    expect(down.body.error.code).toBe('chain_unavailable')
  })

  it('uses the live registry for live keys', async () => {
    const live = installFakeChain('live')
    const a = await createTestAgent(app, { name: 'Live Linker' })
    live.erc8004.set('12', { owner: a.wallet_address!, uri: `${BASE}/agents/${a.agent.id}/erc8004.json` })
    const r = await call(app, 'POST', '/v1/agents/me/erc8004', { key: a.api_keys.live, body: { agent_id: '12' } })
    expect(r.status).toBe(200)
    expect(r.body.erc8004).toMatchObject({ chain_id: 8453, registry: registryCaip10('live') })
    expect(live.calls.filter((c) => c.method === 'eth_call').every((c) => String((c.params[0] as any).to).toLowerCase() === IDENTITY_REGISTRY.live.address.toLowerCase())).toBe(true)
  })
})

describe('link maintenance (review findings)', () => {
  it('owner_verified follows a wallet change and a token that moves to another profile releases the stale claim', async () => {
    const a = await createTestAgent(app, { name: 'First Claimant' })
    const b = await createTestAgent(app, { name: 'Second Claimant' })
    chain.erc8004.set('21', { owner: a.wallet_address!, uri: `${BASE}/agents/${a.agent.id}/erc8004.json` })
    expect((await call(app, 'POST', '/v1/agents/me/erc8004', { key: a.api_keys.test, body: { agent_id: '21' } })).body.erc8004.owner_verified).toBe(true)
    // a changes its wallet (needs the Ed25519 proof): the token still belongs to the old one
    const w2 = randomWallet()
    const changed = await setWallet(app, a.api_keys.test, a.agent.id, w2, sign(`agentsouk:wallet:${a.agent.id}:${w2.address.toLowerCase()}`, a.keypair!.secret_key))
    expect(changed.status).toBe(200)
    expect(changed.body.erc8004.owner_verified).toBe(false)
    const ev = await call(app, 'GET', '/v1/events?types=agent.erc8004_owner_changed', { key: a.api_keys.live })
    expect(ev.body.data.some((e: any) => e.data.owner_verified === false)).toBe(true)
    // the token owner points the tokenURI at b's file and b links it: a's stale claim is released
    chain.erc8004.set('21', { owner: b.wallet_address!, uri: `${BASE}/agents/${b.agent.id}/erc8004.json` })
    const rb = await call(app, 'POST', '/v1/agents/me/erc8004', { key: b.api_keys.test, body: { agent_id: 21 } })
    expect(rb.status).toBe(200)
    expect(rb.body.erc8004.owner_verified).toBe(true)
    expect(((await (await app.request(`/v1/agents/${a.agent.id}`)).json()) as any).erc8004).toBeNull()
    const gone = await call(app, 'GET', '/v1/events?types=agent.erc8004_unlinked', { key: a.api_keys.live })
    expect(gone.body.data.some((e: any) => e.data.reason === 'moved' && e.data.agent_id === '21')).toBe(true)
  })

  it('a test-key link does not replace a live link', async () => {
    const live = installFakeChain('live')
    const a = await createTestAgent(app, { name: 'Two Envs' })
    live.erc8004.set('32', { owner: a.wallet_address!, uri: `${BASE}/agents/${a.agent.id}/erc8004.json` })
    expect((await call(app, 'POST', '/v1/agents/me/erc8004', { key: a.api_keys.live, body: { agent_id: '32' } })).body.erc8004.chain_id).toBe(8453)
    const test = installFakeChain('test')
    test.erc8004.set('31', { owner: a.wallet_address!, uri: `${BASE}/agents/${a.agent.id}/erc8004.json` })
    const blocked = await call(app, 'POST', '/v1/agents/me/erc8004', { key: a.api_keys.test, body: { agent_id: '31' } })
    expect(blocked.status).toBe(409)
    expect(blocked.body.error.code).toBe('erc8004_live_link_exists')
    expect(((await (await app.request(`/v1/agents/${a.agent.id}`)).json()) as any).erc8004.chain_id).toBe(8453)
  })

  it('maps node trouble to 502 (empty result, rate limit) and a reverting tokenURI to 409', async () => {
    const a = await createTestAgent(app, { name: 'Node Trouble' })
    chain.erc8004Raw = '0x'
    const empty = await call(app, 'POST', '/v1/agents/me/erc8004', { key: a.api_keys.test, body: { agent_id: '1' } })
    expect(empty.status).toBe(502)
    expect(empty.body.error.details.reason).toContain('malformed ownerOf')
    chain.erc8004Raw = null
    chain.erc8004Error = { code: -32005, message: 'rate limit exceeded' }
    const limited = await call(app, 'POST', '/v1/agents/me/erc8004', { key: a.api_keys.test, body: { agent_id: '1' } })
    expect(limited.status).toBe(502)
    expect(limited.body.error.details.rpc_code).toBe(-32005)
    chain.erc8004Error = null
    chain.erc8004.set('41', { owner: a.wallet_address!, uri: null }) // tokenURI reverts with a 0x payload (VM execution error wording)
    const noUri = await call(app, 'POST', '/v1/agents/me/erc8004', { key: a.api_keys.test, body: { agent_id: '41' } })
    expect(noUri.status).toBe(409)
    expect(noUri.body.error.code).toBe('erc8004_uri_mismatch')
    expect(noUri.body.error.details.token_uri).toBe('')
  })

  it('the daily sweep drops moved links, updates owner_verified, and leaves fresh links alone', async () => {
    const a = await createTestAgent(app, { name: 'Sweep A' })
    const b = await createTestAgent(app, { name: 'Sweep B' })
    const c = await createTestAgent(app, { name: 'Sweep C' })
    const trio = [['51', a], ['52', b], ['53', c]] as const
    for (const [id, x] of trio) chain.erc8004.set(id, { owner: x.wallet_address!, uri: `${BASE}/agents/${x.agent.id}/erc8004.json` })
    for (const [id, x] of trio) expect((await call(app, 'POST', '/v1/agents/me/erc8004', { key: x.api_keys.test, body: { agent_id: id } })).status).toBe(200)
    // nothing is due yet
    expect(await sweepErc8004Links(Date.now())).toMatchObject({ checked: 0, dropped: 0, changed: 0, errors: 0 })
    // a: tokenURI moved elsewhere; b: token changed hands; c: unchanged
    chain.erc8004.set('51', { owner: a.wallet_address!, uri: 'https://elsewhere.example/x.json' })
    chain.erc8004.set('52', { owner: '0x000000000000000000000000000000000000dEaD', uri: `${BASE}/agents/${b.agent.id}/erc8004.json` })
    const later = Date.now() + 25 * 3600_000
    expect(await sweepErc8004Links(later)).toMatchObject({ checked: 3, dropped: 1, changed: 1, errors: 0 })
    expect(((await (await app.request(`/v1/agents/${a.agent.id}`)).json()) as any).erc8004).toBeNull()
    const pb = ((await (await app.request(`/v1/agents/${b.agent.id}`)).json()) as any).erc8004
    expect(pb.owner_verified).toBe(false)
    expect(new Date(pb.verified_at).getTime()).toBe(later)
    expect(((await (await app.request(`/v1/agents/${c.agent.id}`)).json()) as any).erc8004.owner_verified).toBe(true)
    const evA = await call(app, 'GET', '/v1/events?types=agent.erc8004_unlinked', { key: a.api_keys.live })
    expect(evA.body.data.some((e: any) => e.data.reason === 'uri_changed')).toBe(true)
    // node trouble keeps the links and counts errors
    chain.erc8004Error = { code: -32005, message: 'rate limit exceeded' }
    expect(await sweepErc8004Links(later + 25 * 3600_000)).toMatchObject({ checked: 0, errors: 2 })
    chain.erc8004Error = null
    expect(((await (await app.request(`/v1/agents/${c.agent.id}`)).json()) as any).erc8004).not.toBeNull()
  })
})
