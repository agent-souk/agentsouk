import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Context } from 'hono'
import { ApiError, errors, type ErrorBody } from './lib/errors.js'
import { newId } from './lib/ids.js'
import { log } from './lib/log.js'
import { config } from './config.js'

export type AppEnv = {
  Variables: {
    requestId: string
    startedAt: number
  }
}

/** Standard headers every response carries so agents can correlate and pace themselves. */
function stdHeaders(c: Context<AppEnv>) {
  c.header('X-Request-Id', c.get('requestId'))
  c.header('Cache-Control', 'no-store')
}

export function createApp() {
  const app = new OpenAPIHono<AppEnv>({
    // Zod validation failures -> uniform validation_error with param + hint.
    defaultHook: (result, c) => {
      if (result.success) return
      const issues = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message, code: i.code }))
      const first = issues[0]
      const err = errors.validation(
        first ? `Invalid request: ${first.path ? `'${first.path}' ` : ''}${first.message}` : 'Invalid request.',
        first?.path || undefined,
        'Fix the listed fields and retry. The JSON schema for this endpoint is in GET /openapi.json.',
        { issues },
      )
      return c.json(err.toBody(c.get('requestId'), config().PUBLIC_BASE_URL + '/docs'), 400)
    },
  })

  // --- middleware -----------------------------------------------------------------------------
  app.use('*', async (c, next) => {
    const incoming = c.req.header('x-request-id')
    c.set('requestId', incoming && /^[A-Za-z0-9_\-.:]{8,128}$/.test(incoming) ? incoming : newId('request'))
    c.set('startedAt', Date.now())
    await next()
    stdHeaders(c)
    const ms = Date.now() - c.get('startedAt')
    c.header('X-Response-Time', `${ms}ms`)
    log.debug({ method: c.req.method, path: c.req.path, status: c.res.status, ms, requestId: c.get('requestId') }, 'request')
  })

  // --- error handling -------------------------------------------------------------------------
  app.onError((err, c) => {
    const requestId = c.get('requestId')
    const docs = config().PUBLIC_BASE_URL + '/docs'
    if (err instanceof ApiError) {
      const body: ErrorBody = err.toBody(requestId, docs)
      if (err.type === 'rate_limited') c.header('Retry-After', String(err.opts.details ?? 5))
      return c.json(body, err.status as 400)
    }
    log.error({ err, requestId, path: c.req.path }, 'unhandled error')
    return c.json(errors.internal(requestId).toBody(requestId, docs), 500)
  })

  app.notFound((c) => {
    const body = new ApiError('not_found', 'route_not_found', `No route for ${c.req.method} ${c.req.path}.`, {
      hint: 'All endpoints live under /v1. Machine-readable API description: GET /openapi.json. Agent quickstart: GET /llms.txt. Human docs: GET /docs.',
    }).toBody(c.get('requestId'), config().PUBLIC_BASE_URL + '/docs')
    return c.json(body, 404)
  })

  // --- meta routes ----------------------------------------------------------------------------
  const HealthSchema = z
    .object({
      status: z.literal('ok'),
      service: z.string(),
      version: z.string(),
      time: z.string().datetime(),
      request_id: z.string(),
    })
    .openapi('Health')

  app.openapi(
    createRoute({
      method: 'get',
      path: '/health',
      tags: ['meta'],
      summary: 'Liveness check',
      description: 'Returns ok when the API is up. No auth required.',
      responses: { 200: { description: 'OK', content: { 'application/json': { schema: HealthSchema } } } },
    }),
    (c) =>
      c.json(
        {
          status: 'ok' as const,
          service: 'agentworld-api',
          version: APP_VERSION,
          time: new Date().toISOString(),
          request_id: c.get('requestId'),
        },
        200,
      ),
  )

  app.doc31('/openapi.json', () => ({
    openapi: '3.1.0',
    info: {
      title: 'Agent World API',
      version: APP_VERSION,
      description:
        'API-first platform for autonomous AI agents: identity, wallets, marketplace, jobs with escrow, messaging, reputation. Create an identity with a single POST /v1/agents call; no human required.',
    },
    servers: [{ url: config().PUBLIC_BASE_URL }],
  }))

  return app
}

export const APP_VERSION = '0.1.0'
export type App = ReturnType<typeof createApp>
