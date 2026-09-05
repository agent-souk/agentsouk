import type { MiddlewareHandler } from 'hono'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { agents, apiKeys, type Env } from '../db/schema.js'
import { hashSecret } from '../lib/crypto.js'
import { errors } from '../lib/errors.js'
import { config } from '../config.js'

export type Agent = typeof agents.$inferSelect
export type ApiKey = typeof apiKeys.$inferSelect

export type AuthVariables = {
  agent?: Agent
  apiKey?: ApiKey
  /** 'live' | 'test' — derived from the API key used. Every money/marketplace object is scoped by it. */
  env?: Env
}

const TOUCH_INTERVAL_MS = 60_000

function extractKey(authorization: string | undefined, xApiKey: string | undefined): string | undefined {
  if (authorization) {
    const [scheme, token] = authorization.split(/\s+/, 2)
    if (scheme && /^bearer$/i.test(scheme) && token) return token.trim()
    // Be forgiving: agents sometimes send the raw key without "Bearer".
    if (scheme && scheme.startsWith('aw_') && !token) return scheme
  }
  if (xApiKey) return xApiKey.trim()
  return undefined
}

export async function resolveApiKey(raw: string): Promise<{ agent: Agent; apiKey: ApiKey } | undefined> {
  if (!/^aw_(live|test)_[A-Za-z0-9]{40}$/.test(raw)) return undefined
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

/** Populates agent/apiKey/env if a valid key is present; never fails. */
export const optionalAuth: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
  const raw = extractKey(c.req.header('authorization'), c.req.header('x-api-key'))
  if (raw) {
    const resolved = await resolveApiKey(raw)
    if (resolved) {
      c.set('agent', resolved.agent)
      c.set('apiKey', resolved.apiKey)
      c.set('env', resolved.apiKey.env)
    }
  }
  await next()
}

/** Requires a valid API key. */
export const requireAuth: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
  const raw = extractKey(c.req.header('authorization'), c.req.header('x-api-key'))
  if (!raw) throw errors.unauthenticated()
  const resolved = await resolveApiKey(raw)
  if (!resolved) {
    throw errors.unauthenticated(
      'The API key is unknown, revoked or expired. Keys look like aw_live_... or aw_test_.... Create a new identity with POST /v1/agents if you lost yours.',
    )
  }
  c.set('agent', resolved.agent)
  c.set('apiKey', resolved.apiKey)
  c.set('env', resolved.apiKey.env)
  await next()
}

/** Helper for handlers: guaranteed auth context (throws if middleware missing). */
export function authOf(c: { get: (k: 'agent' | 'apiKey' | 'env') => unknown }): { agent: Agent; apiKey: ApiKey; env: Env } {
  const agent = c.get('agent') as Agent | undefined
  const apiKey = c.get('apiKey') as ApiKey | undefined
  const env = c.get('env') as Env | undefined
  if (!agent || !apiKey || !env) throw errors.unauthenticated()
  return { agent, apiKey, env }
}
