import { describe, it, expect, beforeEach } from 'vitest'
import { base64urlnopad } from '@scure/base'
import { hexToBytes } from '@noble/hashes/utils.js'
import { freshApp, call, createTestAgent } from '../../test/setup.js'
import type { App } from '../../app.js'
import { sign, generateKeyPair } from '../../lib/crypto.js'
import { _resetJti } from './routes.js'

let app: App
type Ag = Awaited<ReturnType<typeof createTestAgent>>
let a: Ag
const TOKEN_URL = 'http://localhost:8787/v1/oauth/token'

beforeEach(async () => {
  app = await freshApp()
  _resetJti()
  a = await createTestAgent(app, { name: 'OAuth Bot' })
})

function jwt(claims: Record<string, unknown>, secretKey: string, header: Record<string, unknown> = { alg: 'EdDSA', typ: 'JWT' }) {
  const enc = (o: unknown) => base64urlnopad.encode(new TextEncoder().encode(JSON.stringify(o)))
  const signingInput = `${enc(header)}.${enc(claims)}`
  const sig = sign(signingInput, secretKey)
  return `${signingInput}.${base64urlnopad.encode(hexToBytes(sig))}`
}

async function token(assertion: string, extra: Record<string, string> = {}) {
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: assertion, ...extra })
  const res = await app.request('/v1/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() })
  return { status: res.status, body: (await res.json()) as any }
}

describe('OAuth token endpoint (private_key_jwt)', () => {
  it('issues a short-lived API key for a valid EdDSA assertion (CIMD client_id, env scope)', async () => {
    const now = Math.floor(Date.now() / 1000)
    const clientId = `http://localhost:8787/agents/${a.agent.id}/cimd.json`
    const t = await token(jwt({ iss: clientId, sub: clientId, aud: TOKEN_URL, iat: now, exp: now + 120, jti: 'j1' }, a.keypair!.secret_key), { scope: 'env:test' })
    expect(t.status, JSON.stringify(t.body)).toBe(200)
    expect(t.body.token_type).toBe('Bearer')
    expect(t.body.access_token).toMatch(/^as_test_/)
    expect(t.body.expires_in).toBe(3600)
    const me = await call(app, 'GET', '/v1/agents/me', { key: t.body.access_token })
    expect(me.body.id).toBe(a.agent.id)
    expect(me.body.env).toBe('test')
    const live = await token(jwt({ iss: a.agent.handle, sub: a.agent.handle, aud: TOKEN_URL, iat: now, exp: now + 120, jti: 'j2' }, a.keypair!.secret_key), { scope: 'env:live' })
    expect(live.body.access_token).toMatch(/^as_live_/)
    const keys = await call(app, 'GET', '/v1/agents/me/keys', { key: a.api_keys.live })
    expect(keys.body.data.filter((k: any) => k.name === 'oauth-session')).toHaveLength(2)
  })

  it('rejects wrong keys, replayed jti, bad aud, expired, wrong grant and unknown clients', async () => {
    const now = Math.floor(Date.now() / 1000)
    const good = { iss: a.agent.id, sub: a.agent.id, aud: TOKEN_URL, iat: now, exp: now + 60, jti: 'x1' }
    const other = generateKeyPair()
    expect((await token(jwt(good, other.secretKey))).status).toBe(401)
    expect((await token(jwt(good, a.keypair!.secret_key))).status).toBe(200)
    const replay = await token(jwt(good, a.keypair!.secret_key))
    expect(replay.status).toBe(401)
    expect(replay.body.error_description).toContain('jti')
    expect((await token(jwt({ ...good, jti: 'x2', aud: 'https://evil.example' }, a.keypair!.secret_key))).status).toBe(401)
    expect((await token(jwt({ ...good, jti: 'x3', exp: now - 10 }, a.keypair!.secret_key))).status).toBe(401)
    expect((await token(jwt({ ...good, jti: 'x4', exp: now + 3600 }, a.keypair!.secret_key))).status).toBe(401)
    expect((await token(jwt({ ...good, jti: 'x5', iss: 'someone-else', sub: 'someone-else' }, a.keypair!.secret_key))).status).toBe(401)
    const wrongGrant = await token(jwt({ ...good, jti: 'x6' }, a.keypair!.secret_key), { grant_type: 'password' })
    expect(wrongGrant.body.error).toBe('unsupported_grant_type')
    const badScope = await token(jwt({ ...good, jti: 'x7' }, a.keypair!.secret_key), { scope: 'env:prod' })
    expect(badScope.body.error).toBe('invalid_scope')
  })
})
