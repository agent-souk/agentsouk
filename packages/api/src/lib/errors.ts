/**
 * Agent-friendly error model.
 *
 * Every error the API returns has the same JSON shape so an LLM agent can parse it without
 * special-casing, and every error carries a `hint` describing the NEXT ACTION the agent should
 * take. Errors are the most-read documentation an agent will ever see, so treat them as UX.
 */
export type ErrorType =
  | 'validation_error'
  | 'authentication_error'
  | 'permission_error'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'state_error'
  | 'payment_error'
  | 'internal_error'
  | 'not_implemented'

const STATUS: Record<ErrorType, number> = {
  validation_error: 400,
  authentication_error: 401,
  permission_error: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  state_error: 409,
  payment_error: 402,
  internal_error: 500,
  not_implemented: 501,
}

export interface ErrorBody {
  error: {
    type: ErrorType
    code: string
    message: string
    hint?: string
    docs?: string
    param?: string
    request_id?: string
    details?: unknown
  }
}

export class ApiError extends Error {
  readonly status: number
  constructor(
    readonly type: ErrorType,
    readonly code: string,
    message: string,
    readonly opts: { hint?: string; param?: string; details?: unknown; status?: number; docs?: string } = {},
  ) {
    super(message)
    this.status = opts.status ?? STATUS[type]
  }
  toBody(requestId?: string, docsBase?: string): ErrorBody {
    const e: ErrorBody['error'] = { type: this.type, code: this.code, message: this.message }
    if (this.opts.hint) e.hint = this.opts.hint
    const docs = this.opts.docs ?? (docsBase ? `${docsBase}/errors#${this.code}` : undefined)
    if (docs) e.docs = docs
    if (this.opts.param) e.param = this.opts.param
    if (requestId) e.request_id = requestId
    if (this.opts.details !== undefined) e.details = this.opts.details
    return { error: e }
  }
}

// Convenience constructors. Keep messages actionable.
export const errors = {
  validation: (message: string, param?: string, hint?: string, details?: unknown) =>
    new ApiError('validation_error', 'invalid_request', message, { param, hint, details }),
  unauthenticated: (
    hint = 'Send your API key as "Authorization: Bearer <api_key>". No key yet? POST /v1/agents creates an identity in one call.',
  ) => new ApiError('authentication_error', 'unauthenticated', 'Missing or invalid API key.', { hint }),
  forbidden: (message = 'You do not have permission to do this.', hint?: string) =>
    new ApiError('permission_error', 'forbidden', message, { hint }),
  notFound: (what: string, id?: string, hint?: string) =>
    new ApiError('not_found', 'not_found', id ? `${what} '${id}' not found.` : `${what} not found.`, { hint }),
  conflict: (code: string, message: string, hint?: string) => new ApiError('conflict', code, message, { hint }),
  state: (code: string, message: string, hint?: string) => new ApiError('state_error', code, message, { hint }),
  rateLimited: (retryAfterSec: number) =>
    new ApiError('rate_limited', 'rate_limited', 'Too many requests.', {
      hint: `Wait ${retryAfterSec}s and retry. Read the RateLimit-* response headers to pace yourself.`,
    }),
  internal: (requestId?: string) =>
    new ApiError('internal_error', 'internal_error', 'Something went wrong on our side.', {
      hint: `Retry with the same Idempotency-Key. If it persists, report request_id ${requestId ?? '(unknown)'} via POST /v1/support/reports.`,
    }),
  notImplemented: (what: string) =>
    new ApiError('not_implemented', 'not_implemented', `${what} is not available yet.`, {
      hint: 'Check GET /v1/changelog to see when this ships.',
    }),
}
