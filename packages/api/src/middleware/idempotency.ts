import type { MiddlewareHandler } from 'hono'
import { and, eq, lt } from 'drizzle-orm'
import { db } from '../db/client.js'
import { idempotencyKeys } from '../db/schema.js'
import { sha256Hex } from '../lib/crypto.js'
import { newId } from '../lib/ids.js'
import { ApiError } from '../lib/errors.js'
import type { AuthVariables } from './auth.js'

const TTL_MS = 24 * 60 * 60 * 1000
let lastSweep = 0

/**
 * Idempotency-Key support (Stripe semantics) for authenticated mutating requests.
 * - Same key + same request → the stored response is replayed (header `Idempotent-Replayed: true`).
 * - Same key + different request → 409 `idempotency_key_reused`.
 * - Same key while the first request is still running → 409 `idempotency_in_progress`.
 * Keys are scoped per agent and expire after 24h.
 */
export const idempotency: MiddlewareHandler<{ Variables: AuthVariables & { requestId: string } }> = async (c, next) => {
  const key = c.req.header('idempotency-key')
  const agent = c.get('agent')
  const method = c.req.method.toUpperCase()
  if (!key || !agent || !['POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) return next()
  if (key.length > 255) throw new ApiError('validation_error', 'invalid_idempotency_key', 'Idempotency-Key must be at most 255 characters.')

  const now = Date.now()
  if (now - lastSweep > 10 * 60_000) {
    lastSweep = now
    await db().delete(idempotencyKeys).where(lt(idempotencyKeys.createdAt, now - TTL_MS))
  }

  const bodyText = await c.req.raw.clone().text()
  const requestHash = sha256Hex(`${method} ${c.req.path}\n${bodyText}`)
  const existing = await db().query.idempotencyKeys.findFirst({ where: and(eq(idempotencyKeys.agentId, agent.id), eq(idempotencyKeys.key, key)) })

  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new ApiError('conflict', 'idempotency_key_reused', 'This Idempotency-Key was already used with a different request.', {
        hint: 'Use a fresh Idempotency-Key (e.g. a UUID) for every distinct operation; reuse a key only to safely retry the exact same request.',
      })
    }
    if (existing.status == null) {
      throw new ApiError('conflict', 'idempotency_in_progress', 'A request with this Idempotency-Key is still being processed.', {
        hint: 'Wait a moment and retry with the same key to receive the stored result.',
      })
    }
    c.header('Idempotent-Replayed', 'true')
    return c.body(existing.responseBody ?? '', existing.status as 200, { 'content-type': 'application/json' })
  }

  const id = newId('request')
  await db().insert(idempotencyKeys).values({ id, agentId: agent.id, key, method, path: c.req.path, requestHash, createdAt: now })

  try {
    await next()
  } catch (e) {
    await db().delete(idempotencyKeys).where(eq(idempotencyKeys.id, id))
    throw e
  }

  const res = c.res
  const status = res.status
  // Only persist successful outcomes; failures should be retryable with the same key.
  if (status >= 200 && status < 300) {
    const text = await res.clone().text()
    await db().update(idempotencyKeys).set({ status, responseBody: text }).where(eq(idempotencyKeys.id, id))
  } else {
    await db().delete(idempotencyKeys).where(eq(idempotencyKeys.id, id))
  }
}
