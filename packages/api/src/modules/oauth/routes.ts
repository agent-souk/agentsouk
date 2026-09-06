import { Hono } from 'hono'
import { base64urlnopad } from '@scure/base'
import { bytesToHex } from '@noble/hashes/utils.js'
import type { AppEnv } from '../../app.js'
import { config } from '../../config.js'
import { verify, publicKeyFromDidKey } from '../../lib/crypto.js'
import { getAgentByIdOrHandle, createApiKey } from '../agents/service.js'
import { rateLimit } from '../../middleware/ratelimit.js'
import { db } from '../../db/client.js'
import { agents, type Env } from '../../db/schema.js'
import { eq } from 'drizzle-orm'

/**
 * OAuth 2.0 token endpoint (RFC 6749 client_credentials) with `private_key_jwt` client authentication
 * (RFC 7523), as advertised in /.well-known/oauth-authorization-server. This is what MCP clients and
 * OAuth-aware agent frameworks use when an agent authenticates with its own key:
 *
 *   client_id  = https://api.agentsouk.dev/agents/<agent_id>/cimd.json  (or the agent id / handle / did:key)
 *   assertion  = JWT { alg: EdDSA } { iss: client_id, sub: client_id, aud: <token endpoint>, iat, exp (<= 5 min), jti }
 *   scope      = "env:test" (default) or "env:live"
 *
 * The access token is a short-lived (1 h) Agent Souk API key, so it works on every endpoint and in the SDKs.
 */

const SESSION_TTL_SECONDS = 3600
const usedJti = new Map<string, number>()

function oauthError(status: 400 | 401, error: string, description: string, hint?: string) {
  return { status, body: { error, error_description: description, ...(hint ? { hint } : {}) } }
}

function decodeSegment(seg: string): unknown {
  return JSON.parse(new TextDecoder().decode(base64urlnopad.decode(seg)))
}

async function readParams(c: { req: { header: (n: string) => string | undefined; text: () => Promise<string> } }): Promise<Record<string, string>> {
  const ct = c.req.header('content-type') ?? ''
  const text = await c.req.text()
  if (ct.includes('application/json')) {
    const j = JSON.parse(text || '{}') as Record<string, unknown>
    return Object.fromEntries(Object.entries(j).map(([k, v]) => [k, String(v)]))
  }
  return Object.fromEntries(new URLSearchParams(text).entries())
}

export function oauthRoutes() {
  const r = new Hono<AppEnv>()
  const base = () => config().PUBLIC_BASE_URL.replace(/\/$/, '')

  r.post('/v1/oauth/token', rateLimit({ name: 'oauth-token', limit: 60, windowSec: 60 }), async (c) => {
    let p: Record<string, string>
    try {
      p = await readParams(c)
    } catch {
      const e = oauthError(400, 'invalid_request', 'Body must be application/x-www-form-urlencoded or JSON.')
      return c.json(e.body, e.status)
    }
    if (p.grant_type !== 'client_credentials') {
      const e = oauthError(400, 'unsupported_grant_type', 'Only grant_type=client_credentials is supported.')
      return c.json(e.body, e.status)
    }
    if (p.client_assertion_type !== 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer' || !p.client_assertion) {
      const e = oauthError(401, 'invalid_client', 'Authenticate with private_key_jwt: client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer and client_assertion=<EdDSA JWT>.', 'Sign a JWT with your Ed25519 secret key: header {"alg":"EdDSA"}, payload {iss, sub (= your client_id), aud: "' + base() + '/v1/oauth/token", iat, exp (max 5 min), jti}.')
      return c.json(e.body, e.status)
    }
    const parts = p.client_assertion.split('.')
    if (parts.length !== 3) return c.json(oauthError(401, 'invalid_client', 'client_assertion is not a JWT.').body, 401)
    let header: { alg?: string; kid?: string }
    let claims: { iss?: string; sub?: string; aud?: string | string[]; exp?: number; iat?: number; jti?: string }
    try {
      header = decodeSegment(parts[0]!) as typeof header
      claims = decodeSegment(parts[1]!) as typeof claims
    } catch {
      return c.json(oauthError(401, 'invalid_client', 'client_assertion is not valid base64url JSON.').body, 401)
    }
    if (header.alg !== 'EdDSA') return c.json(oauthError(401, 'invalid_client', `Unsupported alg ${header.alg}; use EdDSA (Ed25519).`).body, 401)
    const clientId = p.client_id ?? claims.sub ?? claims.iss
    if (!clientId || claims.iss !== claims.sub) return c.json(oauthError(401, 'invalid_client', 'iss and sub must both equal your client_id.').body, 401)
    const now = Math.floor(Date.now() / 1000)
    if (typeof claims.exp !== 'number' || claims.exp < now || claims.exp > now + 300) return c.json(oauthError(401, 'invalid_client', 'exp must be in the future and at most 5 minutes ahead.').body, 401)
    const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    if (!auds.some((a) => a === `${base()}/v1/oauth/token` || a === base())) return c.json(oauthError(401, 'invalid_client', `aud must be ${base()}/v1/oauth/token.`).body, 401)
    if (!claims.jti) return c.json(oauthError(401, 'invalid_client', 'jti is required (single use).').body, 401)
    for (const [k, exp] of usedJti) if (exp < now) usedJti.delete(k)
    if (usedJti.has(`${clientId}:${claims.jti}`)) return c.json(oauthError(401, 'invalid_client', 'jti already used.').body, 401)

    // Resolve the agent from client_id: CIMD URL, agent id, handle or did:key.
    let idOrHandle = clientId
    const m = /\/agents\/([^/]+)\/cimd\.json$/.exec(clientId)
    if (m) idOrHandle = m[1]!
    let agent = clientId.startsWith('did:key:') ? undefined : await getAgentByIdOrHandle(idOrHandle)
    if (!agent && clientId.startsWith('did:key:')) {
      const pk = publicKeyFromDidKey(clientId)
      if (pk) agent = await db().query.agents.findFirst({ where: eq(agents.publicKey, pk) })
    }
    if (!agent || agent.status !== 'active') return c.json(oauthError(401, 'invalid_client', 'Unknown client_id.', 'client_id is https://api.../agents/<agent_id>/cimd.json, your agent id, handle or did:key.').body, 401)
    const signingInput = `${parts[0]}.${parts[1]}`
    let sigHex: string
    try {
      sigHex = bytesToHex(base64urlnopad.decode(parts[2]!))
    } catch {
      return c.json(oauthError(401, 'invalid_client', 'Signature is not valid base64url.').body, 401)
    }
    if (!verify(sigHex, signingInput, agent.publicKey)) return c.json(oauthError(401, 'invalid_client', 'JWT signature does not verify against your registered Ed25519 key.', 'Sign base64url(header).base64url(payload) with the raw 32-byte seed from registration; rotate with POST /v1/agents/me/rotate-key if you lost it.').body, 401)
    usedJti.set(`${clientId}:${claims.jti}`, claims.exp)

    const scope = (p.scope ?? 'env:test').split(/[\s,]+/).filter(Boolean)
    const envScope = scope.find((s) => s.startsWith('env:'))?.slice(4) ?? 'test'
    if (envScope !== 'test' && envScope !== 'live') return c.json(oauthError(400, 'invalid_scope', 'scope must be env:test or env:live.').body, 400)
    const env: Env = envScope
    const { raw } = await createApiKey(agent.id, env, 'oauth-session', ['*'], Date.now() + SESSION_TTL_SECONDS * 1000)
    c.header('Cache-Control', 'no-store')
    return c.json({ access_token: raw, token_type: 'Bearer', expires_in: SESSION_TTL_SECONDS, scope: `env:${env}`, agent_id: agent.id }, 200)
  })

  return r
}

/** Test helper. */
export function _resetJti() {
  usedJti.clear()
}
