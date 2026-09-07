import { z } from '@hono/zod-openapi'

/** Shared request/response building blocks. Keep every list and object shape uniform for agents. */

export const Pagination = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20).openapi({ description: 'Max items to return (1-100).', example: 20 }),
  cursor: z.string().optional().openapi({ description: 'Opaque cursor from a previous response `next_cursor`.' }),
})

export function ListOf<T extends z.ZodTypeAny>(item: T, name: string) {
  return z
    .object({
      object: z.literal('list'),
      data: z.array(item),
      has_more: z.boolean(),
      next_cursor: z.string().nullable(),
    })
    .openapi(name)
}

export function listResponse<T>(data: T[], limit: number, cursorOf: (last: T) => string) {
  const hasMore = data.length > limit
  const page = hasMore ? data.slice(0, limit) : data
  const last = page[page.length - 1]
  return { object: 'list' as const, data: page, has_more: hasMore, next_cursor: hasMore && last ? cursorOf(last) : null }
}

export const ErrorSchema = z
  .object({
    error: z.object({
      type: z.string().openapi({ example: 'validation_error' }),
      code: z.string().openapi({ example: 'invalid_request' }),
      message: z.string(),
      hint: z.string().optional().openapi({ description: 'What to do next. Always read this.' }),
      docs: z.string().optional(),
      param: z.string().optional(),
      request_id: z.string().optional(),
      details: z.unknown().optional(),
    }),
  })
  .openapi('Error')

export const errorResponses = {
  400: { description: 'Validation error', content: { 'application/json': { schema: ErrorSchema } } },
  401: { description: 'Missing/invalid API key', content: { 'application/json': { schema: ErrorSchema } } },
  403: { description: 'Forbidden', content: { 'application/json': { schema: ErrorSchema } } },
  404: { description: 'Not found', content: { 'application/json': { schema: ErrorSchema } } },
  409: { description: 'Conflict / invalid state', content: { 'application/json': { schema: ErrorSchema } } },
  429: { description: 'Rate limited', content: { 'application/json': { schema: ErrorSchema } } },
} as const

export const Timestamp = z.string().datetime().openapi({ description: 'ISO-8601 UTC timestamp', example: '2026-09-05T12:00:00.000Z' })
export const iso = (ms: number | null | undefined) => (ms == null ? null : new Date(ms).toISOString())

export const Handle = z
  .string()
  .min(3)
  .max(32)
  .regex(/^[a-z0-9][a-z0-9_-]*[a-z0-9]$/, 'lowercase letters, digits, "_" or "-"; must start and end alphanumeric')
  .openapi({ description: 'Unique, URL-safe name (3-32 chars, lowercase).', example: 'summarizer-bot' })

export const IdParam = (prefix: string, example: string) =>
  z
    .string()
    .regex(new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`))
    .openapi({ param: { name: 'id', in: 'path' }, example })

/** Detached platform signature (see lib/server-keys.ts signReceipt): verify with /.well-known/jwks.json. */
export const SignatureEnvelope = z
  .object({
    alg: z.literal('EdDSA'),
    kid: z.string().openapi({ description: 'Key id in /.well-known/jwks.json (JWK thumbprint).' }),
    did: z.string().openapi({ description: 'did:key of the platform signing key.' }),
    sig: z.string().openapi({ description: 'hex Ed25519 signature over the canonical JSON of the signed object.' }),
    canonical: z.literal('json-sorted-keys').openapi({ description: 'Canonicalisation: JSON with object keys sorted recursively, no whitespace, UTF-8.' }),
  })
  .openapi('SignatureEnvelope')
