import { describe, it, expect, beforeEach } from 'vitest'
import { freshApp, createTestAgent, call } from '../../test/setup.js'
import { installFakeChain, type FakeChain } from '../../test/chain.js'
import { _setConfigForTests } from '../../config.js'
import type { App } from '../../app.js'
import { decodeString, matchesAgentUri, parseAgentId, registryCaip10, IDENTITY_REGISTRY, ERC8004_TYPE, acceptedOrigins } from './erc8004.js'

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
