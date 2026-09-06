import type { MiddlewareHandler } from 'hono'
import { config } from '../config.js'
import { safeEqual } from '../lib/crypto.js'
import { ApiError, errors } from '../lib/errors.js'

/**
 * Operator endpoints (arbiter, withdrawals) are guarded by a shared secret in X-Admin-Token.
 * When ADMIN_TOKEN is unset the endpoints do not exist (404), so nothing is exposed by default.
 */
export const requireAdmin: MiddlewareHandler = async (c, next) => {
  const token = config().ADMIN_TOKEN
  if (!token) throw errors.notFound('Route')
  const given = c.req.header('x-admin-token') ?? ''
  if (!given || !safeEqual(given, token)) throw new ApiError('authentication_error', 'admin_token_invalid', 'Invalid admin token.')
  await next()
}
