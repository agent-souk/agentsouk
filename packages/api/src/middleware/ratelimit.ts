import type { MiddlewareHandler } from 'hono'
import { errors } from '../lib/errors.js'
import { config } from '../config.js'
import type { AuthVariables } from './auth.js'

/**
 * Fixed-window in-memory rate limiter (MVP). Emits IETF RateLimit-* headers so agents can pace
 * themselves without guessing. Production note (ADR): replace the store with Redis when running
 * more than one instance.
 */

type Bucket = { count: number; resetAt: number }
const store = new Map<string, Bucket>()
let lastSweep = 0

function sweep(now: number) {
  if (now - lastSweep < 60_000) return
  lastSweep = now
  for (const [k, b] of store) if (b.resetAt <= now) store.delete(k)
}

export type RateLimitOptions = {
  /** requests per window */
  limit: number
  /** window in seconds */
  windowSec: number
  /** bucket key: defaults to agent id, else client IP */
  keyOf?: (c: Parameters<MiddlewareHandler>[0]) => string
  name?: string
}

/**
 * Client IP for rate limiting and the distinct-searcher count. Forwarded headers are only trusted when
 * TRUST_PROXY=true (a reverse proxy we control sets them); otherwise they are attacker-controlled and ignored.
 *
 * Even then, only the part our own proxy wrote may be believed. X-Forwarded-For is a chain a caller can send with
 * anything already in it, and a proxy APPENDS what it saw rather than replacing the header: the rightmost entry is
 * ours, everything left of it came from outside. Reading [0] hands the caller its own rate-limit bucket, its own
 * faucet allowance and, since ADR-36, as many distinct "searchers" as it likes. Fly's own Fly-Client-IP is set by
 * the proxy and overwrites whatever the caller sent, so it is preferred where it exists.
 */
export function clientIp(c: { req: { header: (n: string) => string | undefined }; env?: unknown }): string {
  if (config().TRUST_PROXY) {
    const fly = c.req.header('fly-client-ip')?.trim()
    if (fly) return fly
    const xff = c.req.header('x-forwarded-for')
    if (xff) {
      const hops = xff.split(',').map((s) => s.trim()).filter(Boolean)
      if (hops.length) return hops[hops.length - 1]!
    }
    const real = c.req.header('x-real-ip')?.trim()
    if (real) return real
  }
  try {
    const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined
    return env?.incoming?.socket?.remoteAddress ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

export function rateLimit(opts: RateLimitOptions): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const now = Date.now()
    sweep(now)
    const agent = c.get('agent')
    const id = opts.keyOf ? opts.keyOf(c) : agent ? `agent:${agent.id}` : `ip:${clientIp(c)}`
    const key = `${opts.name ?? 'default'}:${id}`
    let b = store.get(key)
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + opts.windowSec * 1000 }
      store.set(key, b)
    }
    b.count++
    const remaining = Math.max(0, opts.limit - b.count)
    const resetSec = Math.ceil((b.resetAt - now) / 1000)
    c.header('RateLimit-Limit', String(opts.limit))
    c.header('RateLimit-Remaining', String(remaining))
    c.header('RateLimit-Reset', String(resetSec))
    c.header('RateLimit-Policy', `${opts.limit};w=${opts.windowSec}`)
    if (b.count > opts.limit) {
      c.header('Retry-After', String(resetSec))
      const err = errors.rateLimited(resetSec)
      err.opts.details = resetSec
      throw err
    }
    await next()
  }
}

/** Test helper. */
export function _resetRateLimits() {
  store.clear()
}
