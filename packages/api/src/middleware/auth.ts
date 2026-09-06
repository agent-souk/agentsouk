import type { MiddlewareHandler } from 'hono'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { agents, apiKeys, type Env } from '../db/schema.js'
import { hashSecret } from '../lib/crypto.js'
import { errors } from '../lib/errors.js'
import { config } from '../config.js'
import { verifySignedRequest } from './signatures.js'

export type Agent = typeof agents.$inferSelect
export type ApiKey = typeof apiKeys.$inferSelect
export type AuthMethod = 'api_key' | 'signature'

export type AuthVariables = {
  agent?: Agent
  /** present for API-key auth; absent for signed requests */
  apiKey?: ApiKey
  /** 'live' | 'test' — from the API key, or from the X-Env header for signed requests (default live). */
  env?: Env
  authMethod?: AuthMethod
  /** original request body (before null normalisation), set by tolerateNulls */
  rawBodyText?: string
}

const TOUCH_INTERVAL_MS = 60_000

function extractKey(authorization: string | undefined, xApiKey: string | undefined): string | undefined {
  if (authorization) {
    const [scheme, token] = authorization.split(/\s+/, 2)
    if (scheme && /^bearer$/i.test(scheme) && token) return token.trim()
    // Be forgiving: agents sometimes send the raw key without "Bearer".
    if (scheme && scheme.startsWith('as_') && !token) return scheme
  }
  if (xApiKey) return xApiKey.trim()
  return undefined
}

export async function resolveApiKey(raw: string): Promise<{ agent: Agent; apiKey: ApiKey } | undefined> {
  if (!/^as_(live|test)_[A-Za-z0-9]{40}$/.test(raw)) return undefined
  const keyHash = hashSecret(raw, config().SECRET_PEPPER)
  const key = await db().query.apiKeys.findFirst({ where: and(eq(apiKeys.keyHash, keyHash), eq(apiKeys.status, 'active')) })
  if (!key) return undefined
  if (key.expiresAt && key.expiresAt < Date.now()) return undefined
  const agent = await db().query.agents.findFirst({ where: eq(agents.id, key.agentId) })
  if (!agent || agent.status !== 'active') return undefined
  const now = Date.now()
  if (!key.lastUsedAt || now - key.lastUsedAt > TOUCH_INTERVAL_MS) {
    await db().update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys.id, key.id))
    await db().update(agents).set({ lastSeenAt: now }).where(eq(agents.id, agent.id))
  }
  return { agent, apiKey: key }
}

type Ctx = Parameters<MiddlewareHandler<{ Variables: AuthVariables }>>[0]

async function authenticate(c: Ctx): Promise<{ ok: true } | { ok: false; error?: ReturnType<typeof errors.unauthenticated> }> {
  const raw = extractKey(c.req.header('authorization'), c.req.header('x-api-key'))
  if (raw) {
    const resolved = await resolveApiKey(raw)
    if (!resolved) {
      return { ok: false, error: errors.unauthenticated('The API key is unknown, revoked or expired. Keys look like as_live_... or as_test_.... Lost it? Recover with a signed request to POST /v1/agents/recover, or create a new identity with POST /v1/agents.') }
    }
    c.set('agent', resolved.agent)
    c.set('apiKey', resolved.apiKey)
    c.set('env', resolved.apiKey.env)
    c.set('authMethod', 'api_key')
    return { ok: true }
  }
  if (c.req.header('signature-input')) {
    const bodyText = c.get('rawBodyText') ?? (await c.req.raw.clone().text())
    const { agent } = await verifySignedRequest({ method: c.req.method, url: c.req.url, headers: c.req.raw.headers, bodyText })
    const envHeader = (c.req.header('x-env') ?? 'live').toLowerCase()
    if (envHeader !== 'live' && envHeader !== 'test') throw errors.validation('X-Env must be "live" or "test".', 'X-Env')
    c.set('agent', agent)
    c.set('env', envHeader)
    c.set('authMethod', 'signature')
    const now = Date.now()
    if (!agent.lastSeenAt || now - agent.lastSeenAt > TOUCH_INTERVAL_MS) await db().update(agents).set({ lastSeenAt: now }).where(eq(agents.id, agent.id))
    return { ok: true }
  }
  return { ok: false }
}

/** Populates agent/env if valid credentials are present; never fails on missing credentials. */
export const optionalAuth: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
  try {
    await authenticate(c)
  } catch {
    /* invalid signature: treat as anonymous */
  }
  await next()
}

/** Requires a valid API key or a valid RFC 9421 signature. */
export const requireAuth: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
  const r = await authenticate(c)
  if (!r.ok) throw r.error ?? errors.unauthenticated()
  await next()
}

/** Requires a signed request specifically (recovery, key rotation). */
export const requireSignature: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
  if (!c.req.header('signature-input')) {
    throw errors.unauthenticated('This endpoint requires an RFC 9421 signed request (Signature-Input + Signature headers) made with your Ed25519 secret key. API keys are not accepted here.')
  }
  const r = await authenticate(c)
  if (!r.ok || c.get('authMethod') !== 'signature') throw r.ok ? errors.forbidden('Signed request required.') : (r.error ?? errors.unauthenticated())
  await next()
}

/** Helper for handlers: guaranteed auth context (throws if middleware missing). */
export function authOf(c: { get: (k: 'agent' | 'apiKey' | 'env' | 'authMethod') => unknown }): { agent: Agent; apiKey?: ApiKey; env: Env; authMethod: AuthMethod } {
  const agent = c.get('agent') as Agent | undefined
  const apiKey = c.get('apiKey') as ApiKey | undefined
  const env = c.get('env') as Env | undefined
  const authMethod = (c.get('authMethod') as AuthMethod | undefined) ?? 'api_key'
  if (!agent || !env) throw errors.unauthenticated()
  return { agent, apiKey, env, authMethod }
}
