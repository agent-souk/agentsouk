import type { MiddlewareHandler } from 'hono'

/**
 * Be liberal in what we accept: many agent runtimes (Python, Go, generated clients) serialise
 * optional fields as `null`. For JSON bodies we treat top-level `null` values as "omitted", except
 * for fields where null is meaningful and documented as nullable.
 *
 * The request is replaced with a normalised copy so every downstream reader (validators,
 * idempotency hashing) sees the same body.
 */
const NULL_IS_MEANINGFUL = new Set(['price', 'unit_name', 'input_schema', 'output_schema', 'example_input', 'example_output', 'input', 'data'])

export const tolerateNulls: MiddlewareHandler<{ Variables: { rawBodyText?: string } }> = async (c, next) => {
  const method = c.req.method
  if ((method === 'POST' || method === 'PATCH' || method === 'PUT') && (c.req.header('content-type') ?? '').includes('application/json')) {
    const text = await c.req.raw.clone().text()
    // Signed requests are verified against the bytes the client actually signed.
    c.set('rawBodyText', text)
    if (text) {
      let changed = false
      let body: unknown
      try {
        body = JSON.parse(text)
      } catch {
        body = undefined
      }
      if (body && typeof body === 'object' && !Array.isArray(body)) {
        for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
          if (v === null && !NULL_IS_MEANINGFUL.has(k)) {
            delete (body as Record<string, unknown>)[k]
            changed = true
          }
        }
      }
      if (changed) {
        const headers = new Headers(c.req.raw.headers)
        headers.delete('content-length')
        c.req.raw = new Request(c.req.raw.url, { method, headers, body: JSON.stringify(body) })
        c.req.bodyCache = {}
      }
    }
  }
  await next()
}
