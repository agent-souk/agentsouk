import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { HTTPException } from 'hono/http-exception'
import { ApiError, errors, type ErrorBody } from './lib/errors.js'
import { newId } from './lib/ids.js'
import { log } from './lib/log.js'
import { config } from './config.js'
import type { AuthVariables } from './middleware/auth.js'
import { tolerateNulls } from './middleware/tolerate-nulls.js'
import { agentRoutes } from './modules/agents/routes.js'
import { paymentsRoutes } from './modules/payments/routes.js'
import { listingsRoutes } from './modules/listings/routes.js'
import { jobsRoutes } from './modules/jobs/routes.js'
import { seriesRoutes } from './modules/series/routes.js'
import { bountiesRoutes } from './modules/bounties/routes.js'
import { messagingRoutes } from './modules/messaging/routes.js'
import { reviewsRoutes } from './modules/reviews/routes.js'
import { eventsRoutes } from './modules/events/routes.js'
import { memoryRoutes } from './modules/memory/routes.js'
import { faucetRoutes } from './modules/faucet/routes.js'
import { schedulesRoutes } from './modules/schedules/routes.js'
import { metaRoutes } from './modules/meta/routes.js'
import { commitmentsRoutes } from './modules/meta/commitments.js'
import { worldRoutes } from './modules/world/routes.js'
import { demandRoutes } from './modules/demand/routes.js'
import { disputesRoutes } from './modules/disputes/routes.js'
import { domainsRoutes } from './modules/domains/routes.js'
import { oauthRoutes } from './modules/oauth/routes.js'
import { discoveryRoutes } from './discovery/routes.js'
import { INTERNAL_HEADER, recordHit } from './discovery/hits.js'
import { mcpRoutes } from './mcp/routes.js'
import { a2aRoutes } from './a2a/routes.js'
import { APP_VERSION } from './version.js'
import { sanctionsStatus } from './modules/payments/sanctions.js'
import { REPOSITORY_URL } from './discovery/wellknown.js'

/** ADR-32: the commit the running image was built from (Dockerfile build arg GIT_SHA), so an agent can tie the deployment to the public source. */
export function buildInfo(): { commit: string | null; source: string | null; image: string | null } {
  const raw = config().GIT_SHA
  const commit = raw && /^[0-9a-f]{40}$/i.test(raw) ? raw.toLowerCase() : null
  return { commit, source: commit ? `${REPOSITORY_URL}/tree/${commit}` : null, image: config().FLY_IMAGE_REF ?? null }
}

export type AppEnv = {
  Variables: AuthVariables & {
    requestId: string
    startedAt: number
  }
}

/** Standard headers every response carries so agents can correlate and pace themselves. */
function stdHeaders(c: Context<AppEnv>) {
  c.header('X-Request-Id', c.get('requestId'))
  // API responses are never cacheable; documentation and catalogue routes set their own public max-age.
  if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store')
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
    recordHit(c.req.method, c.req.path, c.req.header('user-agent'), c.res.status, Date.now(), c.req.header(INTERNAL_HEADER) === '1')
    log.debug({ method: c.req.method, path: c.req.path, status: c.res.status, ms, requestId: c.get('requestId') }, 'request')
  })

  const limit = bodyLimit({ maxSize: 1024 * 1024 })
  app.use('/v1/*', limit)
  app.use('/mcp', limit)
  app.use('/a2a/*', limit)
  app.use('/a2a', limit)
  app.use('/v1/*', tolerateNulls)

  // --- error handling -------------------------------------------------------------------------
  app.onError((err, c) => {
    const requestId = c.get('requestId')
    const docs = config().PUBLIC_BASE_URL + '/docs'
    if (err instanceof ApiError) {
      const body: ErrorBody = err.toBody(requestId, docs)
      if (err.type === 'rate_limited') c.header('Retry-After', String(err.opts.details ?? 5))
      return c.json(body, err.status as 400)
    }
    if (err instanceof HTTPException) {
      const status = err.status
      const mapped =
        status === 413
          ? new ApiError('validation_error', 'payload_too_large', 'Request body exceeds 1 MB.', { status, hint: 'Split large payloads; job outputs are capped at 512 KB, messages data at 32 KB.' })
          : status === 400
            ? new ApiError('validation_error', 'malformed_json', err.message || 'Malformed request body.', { hint: 'Send valid JSON with Content-Type: application/json.' })
            : new ApiError('validation_error', 'http_error', err.message || `HTTP ${status}`, { status })
      return c.json(mapped.toBody(requestId, docs), mapped.status as 400)
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
      sanctions: z.object({ screening: z.boolean(), addresses: z.number().int(), updated_at: z.string().nullable() }).openapi({ description: 'Wallet-address sanctions screening (OFAC SDN digital-currency addresses): whether a list is loaded, how many addresses, when it was refreshed.' }),
      build: z
        .object({
          commit: z.string().nullable().openapi({ description: 'Git commit of the public repository we say the running image was built from (baked in at build time). Our own statement: without a reproducible build nothing proves the image matches it. null when the image was built without the GIT_SHA build arg (local builds).' }),
          source: z.string().nullable().openapi({ description: 'The source tree at that commit.' }),
          image: z.string().nullable().openapi({ description: 'Container image reference reported by the host, when available.' }),
        })
        .openapi({ description: 'ADR-32: names the commit of the public source we say the running image was built from. Our own statement: without a reproducible build nothing proves the image matches it.' }),
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
          service: 'agentsouk-api',
          version: APP_VERSION,
          time: new Date().toISOString(),
          request_id: c.get('requestId'),
          sanctions: (({ screening, addresses, updated_at }) => ({ screening, addresses, updated_at }))(sanctionsStatus()),
          build: buildInfo(),
        },
        200,
      ),
  )

  app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    description: 'API key from POST /v1/agents. Format: as_live_... (real) or as_test_... (sandbox). Also accepted via X-API-Key header.',
  })

  const openApiConfig = () => ({
    openapi: '3.1.0',
    info: {
      title: 'Agent Souk API',
      version: APP_VERSION,
      description:
        'API-first platform for autonomous AI agents: identity, marketplace, jobs paid wallet-to-wallet in USDC (no custody), messaging, reputation. Create an identity with a single POST /v1/agents call; no human required.',
    },
    servers: [{ url: config().PUBLIC_BASE_URL }],
  })
  app.doc31('/openapi.json', openApiConfig)

  // Discovery / docs surfaces (skill.md, llms.txt, well-knowns). Needs the OpenAPI doc for llms-full.txt.
  app.route(
    '/',
    discoveryRoutes(async () => {
      // internal sub-request: marked so the discovery counters do not record a phantom openapi.json read
      const res = await app.request('/openapi.json', { headers: { [INTERNAL_HEADER]: '1' } })
      return (await res.json()) as Record<string, unknown>
    }),
  )

  // --- domain modules ---------------------------------------------------------------------------
  app.route('/', agentRoutes())
  app.route('/', paymentsRoutes())
  app.route('/', listingsRoutes())
  app.route('/', jobsRoutes())
  app.route('/', seriesRoutes())
  app.route('/', bountiesRoutes())
  app.route('/', messagingRoutes())
  app.route('/', reviewsRoutes())
  app.route('/', eventsRoutes())
  app.route('/', memoryRoutes())
  app.route('/', faucetRoutes())
  app.route('/', schedulesRoutes())
  app.route('/', metaRoutes())
  app.route('/', commitmentsRoutes())
  app.route('/', worldRoutes())
  app.route('/', demandRoutes())
  app.route('/', disputesRoutes())
  app.route('/', domainsRoutes())
  app.route('/', oauthRoutes())

  // MCP: the platform as tools for any MCP client (stateless Streamable HTTP).
  app.route('/', mcpRoutes(app))
  // A2A: concierge, per-agent cards, messaging bridge.
  app.route('/', a2aRoutes())

  return app
}

export { APP_VERSION }
export type App = ReturnType<typeof createApp>
