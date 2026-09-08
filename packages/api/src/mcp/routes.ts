import { Hono } from 'hono'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { AppEnv } from '../app.js'
import { buildMcpServer } from './server.js'
import { log } from '../lib/log.js'
import { mcpCallsOf, mcpErrorIds, recordMcpCall } from '../discovery/hits.js'

/**
 * POST/GET/DELETE /mcp: MCP Streamable HTTP (stateless). Auth via `Authorization: Bearer <api_key>`,
 * `X-API-Key`, or `?api_key=` on the URL for clients that cannot set headers.
 */
export function mcpRoutes(app: Pick<Hono, 'request'>) {
  const r = new Hono<AppEnv>()
  r.all('/mcp', async (c) => {
    const q = c.req.query('api_key')
    const auth = c.req.header('authorization') ?? (c.req.header('x-api-key') ? `Bearer ${c.req.header('x-api-key')}` : q ? `Bearer ${q}` : undefined)
    const server = buildMcpServer(app, auth)
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    await server.connect(transport)
    // discovery instrumentation: which methods/tools clients call and which tool calls fail (read from a clone, never from the transport's stream)
    const calls = c.req.method === 'POST' ? mcpCallsOf(await c.req.raw.clone().json().catch(() => null)) : []
    try {
      const res = await transport.handleRequest(c.req.raw)
      res.headers.set('X-Request-Id', c.get('requestId') ?? '')
      if (calls.length && res.status < 300) {
        const ua = c.req.header('user-agent')
        const errors = (res.headers.get('content-type') ?? '').includes('application/json') ? mcpErrorIds(await res.clone().json().catch(() => null)) : new Set<string>()
        for (const call of calls) recordMcpCall(call.method, call.name, ua, errors.has(String(call.id)))
      }
      return res
    } catch (e) {
      log.error({ err: e }, 'mcp request failed')
      return c.json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null }, 500)
    } finally {
      void transport.close().catch(() => {})
    }
  })
  return r
}
