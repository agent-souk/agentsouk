import { describe, it, expect, beforeEach } from 'vitest'
import { freshApp, createTestAgent } from '../test/setup.js'
import type { App } from '../app.js'
import { verify, canonicalJson } from '../lib/crypto.js'
import { signReceipt, serverKey } from '../lib/server-keys.js'

let app: App
beforeEach(async () => {
  app = await freshApp()
})

describe('discovery surfaces', () => {
  it('serves skill.md in Agent Skills format with the registration call', async () => {
    const res = await app.request('/skill.md')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body.startsWith('---\nname: agentsouk\ndescription: ')).toBe(true)
    expect(body).toContain('POST http://localhost:8787/v1/agents')
    expect(res.headers.get('content-type')).toContain('text/markdown')
  })

  it('serves llms.txt, llms-full.txt (with generated reference), quickstart, errors and root', async () => {
    const llms = await (await app.request('/llms.txt')).text()
    expect(llms.startsWith('# Agent Souk\n\n> ')).toBe(true)
    const full = await (await app.request('/llms-full.txt')).text()
    expect(full).toContain('## POST /v1/agents')
    expect(full).toContain('## GET /v1/payments')
    expect(full).toContain('Body (JSON):')
    expect((await app.request('/docs/quickstart')).status).toBe(200)
    expect((await app.request('/docs/errors')).status).toBe(200)
    const root = (await (await app.request('/')).json()) as any
    expect(root.start.path).toBe('/v1/agents')
    expect(root.did).toMatch(/^did:key:z6Mk/)
  })

  it('serves the A2A agent card and platform JWKS', async () => {
    const card = (await (await app.request('/.well-known/agent-card.json')).json()) as any
    expect(card.protocolVersion).toBe('1.0')
    expect(card.skills.length).toBeGreaterThan(3)
    expect(card.additionalInterfaces.some((i: any) => i.transport === 'MCP')).toBe(true)
    const jwks = (await (await app.request('/.well-known/jwks.json')).json()) as any
    expect(jwks.keys[0]).toMatchObject({ kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA' })
    expect(jwks.keys[0].kid).toHaveLength(43)
    const alias = await app.request('/.well-known/agent.json')
    expect(alias.status).toBe(301)
  })

  it('serves per-agent jwks, cimd and did documents', async () => {
    const a = await createTestAgent(app, { name: 'Passport Bot' })
    const jwks = (await (await app.request(`/agents/${a.agent.id}/jwks.json`)).json()) as any
    expect(jwks.keys[0].kty).toBe('OKP')
    const cimd = (await (await app.request(`/agents/passport-bot/cimd.json`)).json()) as any
    expect(cimd.client_id).toBe(`http://localhost:8787/agents/${a.agent.id}/cimd.json`)
    expect(cimd.token_endpoint_auth_method).toBe('private_key_jwt')
    const did = (await (await app.request(`/agents/${a.agent.id}/did.json`)).json()) as any
    expect(did.id).toMatch(/^did:key:/)
    expect(did.verificationMethod[0].publicKeyJwk.x).toBe(jwks.keys[0].x)
    expect((await app.request('/agents/nobody/jwks.json')).status).toBe(404)
  })

  it('signs receipts verifiable with the platform public key', () => {
    const r = signReceipt({ b: 2, a: 1 })
    expect(verify(r.signature.sig, canonicalJson(r.payload), serverKey().publicKey)).toBe(true)
    expect(r.signature.kid).toBe(serverKey().kid)
  })

  it('serves oauth well-knowns', async () => {
    const pr = (await (await app.request('/.well-known/oauth-protected-resource')).json()) as any
    expect(pr.resource).toBe('http://localhost:8787')
    const as = (await (await app.request('/.well-known/oauth-authorization-server')).json()) as any
    expect(as.client_id_metadata_document_supported).toBe(true)
  })
})

describe('crawler access', () => {
  it('serves robots.txt (allow-all, agent crawlers named, sitemap link) and sitemap.xml', async () => {
    const robots = await app.request('/robots.txt')
    expect(robots.status).toBe(200)
    const body = await robots.text()
    expect(body).toContain('User-agent: *\nAllow: /')
    expect(body).toContain('User-agent: ClaudeBot\nAllow: /')
    expect(body).toContain('User-agent: OAI-SearchBot\nAllow: /')
    expect(body).toContain('Sitemap: http://localhost:8787/sitemap.xml')
    expect(body).not.toContain('Disallow')
    const sitemap = await app.request('/sitemap.xml')
    expect(sitemap.status).toBe(200)
    expect(sitemap.headers.get('content-type')).toContain('application/xml')
    const xml = await sitemap.text()
    expect(xml).toContain('<loc>http://localhost:8787/skill.md</loc>')
    expect(xml).toContain('<loc>http://localhost:8787/v1/listings</loc>')
    // every listed page really answers 200 without auth
    for (const loc of [...xml.matchAll(/<loc>http:\/\/localhost:8787([^<]*)<\/loc>/g)].map((m) => m[1]!)) {
      const res = await app.request(loc)
      expect(res.status, loc).toBe(200)
    }
  })

  it('points every documentation response at llms.txt and skill.md, and answers Accept: text/markdown on the root', async () => {
    for (const path of ['/', '/skill.md', '/llms.txt', '/docs', '/docs/quickstart']) {
      const res = await app.request(path)
      expect(res.headers.get('x-llms-txt'), path).toBe('http://localhost:8787/llms.txt')
      expect(res.headers.get('link'), path).toContain('rel="llms-txt"')
      expect(res.headers.get('link'), path).toContain('rel="agent-skill"')
    }
    const md = await app.request('/', { headers: { accept: 'text/markdown' } })
    expect(md.headers.get('content-type')).toContain('text/markdown')
    expect(await md.text()).toContain('/skill.md')
    const json = await app.request('/', { headers: { accept: 'application/json' } })
    expect(json.headers.get('content-type')).toContain('application/json')
  })
})

describe('machine-readable catalogues (well-known suite)', () => {
  it('serves the MCP server card (SEP-2127) with CORS, and the aliases redirect to it', async () => {
    const res = await app.request('/.well-known/mcp-server-card')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    // the route's public max-age survives the global no-store default
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600')
    expect((await app.request('/skill.md')).headers.get('cache-control')).toBe('public, max-age=300')
    expect((await app.request('/v1/listings')).headers.get('cache-control')).toBe('no-store')
    const card = (await res.json()) as any
    expect(card.$schema).toContain('server-card.schema.json')
    expect(card.name).toBe('dev.agentsouk/agentsouk')
    expect(card.name.split('/')).toHaveLength(2)
    expect(card.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(card.remotes[0]).toMatchObject({ type: 'streamable-http', url: 'http://localhost:8787/mcp' })
    expect(card.remotes[0].headers[0].name).toBe('Authorization')
    for (const alias of ['/.well-known/mcp/server-card.json', '/mcp/server-card']) {
      const r = await app.request(alias)
      expect(r.status, alias).toBe(301)
      expect(r.headers.get('location')).toBe('/.well-known/mcp-server-card')
    }
    const list = (await (await app.request('/.well-known/mcp.json')).json()) as any
    expect(list.servers[0].url).toBe('http://localhost:8787/mcp')
    expect(list.servers[0].server_card).toBe('http://localhost:8787/.well-known/mcp-server-card')
  })

  it('serves the ARD manifest and the AI catalog with the same artifacts, each fetchable and with representative queries', async () => {
    const ard = await app.request('/.well-known/ard.json')
    expect(ard.status).toBe(200)
    const manifest = (await ard.json()) as any
    expect(manifest.entries.length).toBeGreaterThanOrEqual(5)
    const types = manifest.entries.map((e: any) => e.type)
    expect(types).toContain('application/mcp-server-card+json')
    expect(types).toContain('application/a2a-agent-card+json')
    expect(types).toContain('application/agent-skills+md')
    for (const e of manifest.entries) {
      expect(e.identifier, e.displayName).toMatch(/^urn:air:agentsouk\.dev:[a-z0-9-]+:[a-z0-9-]+$/)
      expect(typeof e.displayName).toBe('string')
      expect(e.url.startsWith('http://localhost:8787/')).toBe(true)
      expect(e.representativeQueries.length).toBeGreaterThanOrEqual(2)
      expect(e.representativeQueries.length).toBeLessThanOrEqual(5)
      const target = await app.request(e.url.slice('http://localhost:8787'.length))
      expect(target.status, e.url).toBe(200)
    }
    const cat = await app.request('/.well-known/ai-catalog.json')
    expect(cat.status).toBe(200)
    expect(cat.headers.get('content-type')).toContain('application/ai-catalog+json')
    const catalog = (await cat.json()) as any
    expect(catalog.specVersion).toBe('1.0')
    expect(catalog.host.identifier).toMatch(/^did:key:z6Mk/)
    expect(catalog.entries.map((e: any) => e.identifier)).toEqual(manifest.entries.map((e: any) => e.identifier))
    for (const e of catalog.entries) {
      expect(e.publisher.identifier).toBe(catalog.host.identifier)
      expect(e.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    }
    // the ANP collection and the OpenAPI alias
    // Glama's HTTP ownership challenge: exact JSON, public, valid claim token, on the connector's own origin
    const glama = await app.request('/.well-known/glama.json')
    expect(glama.status).toBe(200)
    expect(glama.headers.get('content-type')).toContain('application/json')
    const claim = (await glama.json()) as any
    expect(claim.$schema).toBe('https://glama.ai/mcp/schemas/connector.json')
    expect(claim.claim).toMatch(/^glama_claim_[A-Za-z0-9_-]{32}$/)
    expect(claim.maintainers).toBeUndefined() // never publish an email as ownership proof
    const anp = (await (await app.request('/.well-known/agent-descriptions')).json()) as any
    expect(anp.items[0].url).toBe('http://localhost:8787/.well-known/agent-card.json')
    expect(catalog.host.documentationUrl).toBe('http://localhost:8787/llms.txt')
    for (const e of catalog.entries) expect(e.representativeQueries.length, e.identifier).toBeGreaterThanOrEqual(2)
    const oa = await app.request('/.well-known/openapi.json')
    expect(oa.status).toBe(301)
    expect(oa.headers.get('location')).toBe('/openapi.json')
    // the root advertises them, llms.txt links them
    const root = (await (await app.request('/')).json()) as any
    expect(root.interfaces.mcp_server_card).toBe('http://localhost:8787/.well-known/mcp-server-card')
    expect(root.interfaces.ard).toBe('http://localhost:8787/.well-known/ard.json')
    expect(root.install.claude_code).toContain('agent-souk/agentsouk')
    const llms = await (await app.request('/llms.txt')).text()
    expect(llms).toContain('/.well-known/ard.json')
    expect(llms).toContain('/plugin marketplace add agent-souk/agentsouk')
  })
})
