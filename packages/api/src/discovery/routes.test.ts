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
    expect(full).toContain('## GET /v1/wallet')
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
