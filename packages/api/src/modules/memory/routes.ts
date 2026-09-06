import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AppEnv } from '../../app.js'
import { authOf, requireAuth } from '../../middleware/auth.js'
import { errorResponses, ListOf, Pagination, Timestamp, iso } from '../../lib/http.js'
import { deleteMemory, getMemory, listMemory, putMemory, type MemoryRow } from './service.js'

const MemoryView = z
  .object({
    object: z.literal('memory'),
    key: z.string(),
    value: z.unknown(),
    size: z.number().int().openapi({ description: 'bytes when serialised' }),
    expires_at: Timestamp.nullable(),
    created_at: Timestamp,
    updated_at: Timestamp,
  })
  .openapi('Memory')

const MemoryKeyView = MemoryView.omit({ value: true }).openapi('MemoryKey')

const toKeyView = (m: MemoryRow) => ({ object: 'memory' as const, key: m.key, size: m.size, expires_at: iso(m.expiresAt), created_at: iso(m.createdAt)!, updated_at: iso(m.updatedAt)! })
const toView = (m: MemoryRow) => ({ ...toKeyView(m), value: m.value as z.infer<typeof MemoryView>['value'] })
const keyParam = z.object({ key: z.string().min(1).max(128).openapi({ param: { name: 'key', in: 'path' }, description: 'URL-encode the key (e.g. notes%2Fcustomer-42 for "notes/customer-42").', example: 'notes%2Fcustomer-42' }) })

export function memoryRoutes() {
  const r = new OpenAPIHono<AppEnv>()
  const security = [{ bearerAuth: [] }]

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/memory',
      tags: ['memory'],
      summary: 'List my memory keys',
      description: 'Your private, durable key-value store. Survives sessions, frameworks and key rotation. Shared between live and test (it is about you, not money). Keys may contain "/" for namespaces; URL-encode them in paths (notes%2Fcustomer-42).',
      security,
      middleware: [requireAuth],
      request: { query: Pagination.extend({ prefix: z.string().max(128).optional() }) },
      responses: { 200: { description: 'Keys', content: { 'application/json': { schema: ListOf(MemoryKeyView, 'MemoryKeyList') } } }, ...errorResponses },
    }),
    async (c) => {
      const { agent } = authOf(c)
      const q = c.req.valid('query')
      const rows = await listMemory(agent.id, q)
      const hasMore = rows.length > q.limit
      const page = hasMore ? rows.slice(0, q.limit) : rows
      return c.json({ object: 'list' as const, data: page.map(toKeyView), has_more: hasMore, next_cursor: hasMore ? page[page.length - 1]!.key : null }, 200)
    },
  )

  r.openapi(
    createRoute({ method: 'get', path: '/v1/memory/{key}', tags: ['memory'], summary: 'Read a memory value', security, middleware: [requireAuth], request: { params: keyParam }, responses: { 200: { description: 'Value', content: { 'application/json': { schema: MemoryView } } }, ...errorResponses } }),
    async (c) => {
      const { agent } = authOf(c)
      return c.json(toView(await getMemory(agent.id, c.req.valid('param').key)), 200)
    },
  )

  r.openapi(
    createRoute({
      method: 'put',
      path: '/v1/memory/{key}',
      tags: ['memory'],
      summary: 'Write a memory value (any JSON, up to 64 KB)',
      description: 'Creates or replaces. Optional ttl_seconds auto-expires the key. Up to 1000 keys per agent.',
      security,
      middleware: [requireAuth],
      request: { params: keyParam, body: { content: { 'application/json': { schema: z.object({ value: z.unknown(), ttl_seconds: z.number().int().min(1).max(365 * 86400).optional() }).openapi('PutMemoryRequest') } }, required: true } },
      responses: { 200: { description: 'Stored', content: { 'application/json': { schema: MemoryView } } }, ...errorResponses },
    }),
    async (c) => {
      const { agent } = authOf(c)
      const raw = (await c.req.json()) as { value?: unknown; ttl_seconds?: number }
      return c.json(toView(await putMemory(agent.id, c.req.valid('param').key, raw.value, raw.ttl_seconds)), 200)
    },
  )

  r.openapi(
    createRoute({ method: 'delete', path: '/v1/memory/{key}', tags: ['memory'], summary: 'Delete a memory key', security, middleware: [requireAuth], request: { params: keyParam }, responses: { 200: { description: 'Deleted', content: { 'application/json': { schema: z.object({ object: z.literal('memory'), key: z.string(), deleted: z.boolean() }) } } }, ...errorResponses } }),
    async (c) => {
      const { agent } = authOf(c)
      const key = c.req.valid('param').key
      return c.json({ object: 'memory' as const, key, deleted: await deleteMemory(agent.id, key) }, 200)
    },
  )

  return r
}
