import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AppEnv } from '../../app.js'
import { authOf, requireAuth } from '../../middleware/auth.js'
import { idempotency } from '../../middleware/idempotency.js'
import { errorResponses, ListOf, Pagination, Timestamp, iso, listResponse } from '../../lib/http.js'
import { errors } from '../../lib/errors.js'
import { sellersById } from '../listings/service.js'
import { createReview, emptySide, getReputation, listReviewsForAgent, resolveAgent, type ReputationRow, type ReviewRow } from './service.js'

const ReviewView = z
  .object({
    object: z.literal('review'),
    id: z.string(),
    job_id: z.string(),
    reviewer: z.object({ id: z.string(), handle: z.string() }),
    subject_id: z.string(),
    role: z.enum(['buyer', 'seller']).openapi({ description: 'Role of the reviewer in the job. "buyer" = a buyer rating the seller.' }),
    rating: z.number().int().min(1).max(5),
    comment: z.string().nullable(),
    job_value: z.number().int().openapi({ description: 'CRD settled on the job; reviews are weighted by value.' }),
    content_warnings: z.array(z.string()),
    env: z.enum(['live', 'test']),
    created_at: Timestamp,
  })
  .openapi('Review')

const Side = z
  .object({
    jobs_completed: z.number().int(),
    jobs_failed: z.number().int(),
    jobs_disputed: z.number().int(),
    jobs_cancelled: z.number().int(),
    distinct_counterparties: z.number().int(),
    volume_crd: z.number().int(),
    rating_avg: z.number().nullable().openapi({ description: 'Bayesian average (prior 3.5 with weight 5), so a single 5-star review does not read as perfect.' }),
    rating_count: z.number().int(),
    on_time_rate: z.number().nullable(),
  })
  .openapi('ReputationSide')

const Snapshot = z.object({ score: z.number().int().min(0).max(100), as_seller: Side, as_buyer: Side, updated_at: Timestamp.nullable() })

const ReputationView = z
  .object({
    object: z.literal('reputation'),
    agent_id: z.string(),
    handle: z.string(),
    trust_tier: z.number().int().openapi({ description: '0 keypair only · 1 proven by settled live jobs · 2 domain/operator vouch · 3 verified operator' }),
    live: Snapshot,
    test: Snapshot.openapi({ description: 'Sandbox activity: visible, but never trusted.' }),
    explain: z.string(),
  })
  .openapi('Reputation')

function snapshot(r: ReputationRow | null): z.infer<typeof Snapshot> {
  return { score: r?.score ?? 0, as_seller: r?.asSeller ?? emptySide(), as_buyer: r?.asBuyer ?? emptySide(), updated_at: iso(r?.updatedAt) }
}

async function toReview(r: ReviewRow, handles: Map<string, { handle: string }>): Promise<z.infer<typeof ReviewView>> {
  return {
    object: 'review',
    id: r.id,
    job_id: r.jobId,
    reviewer: { id: r.reviewerAgentId, handle: handles.get(r.reviewerAgentId)?.handle ?? 'unknown' },
    subject_id: r.subjectAgentId,
    role: r.role,
    rating: r.rating,
    comment: r.comment,
    job_value: r.jobPrice,
    content_warnings: r.contentWarnings,
    env: r.env,
    created_at: iso(r.createdAt)!,
  }
}

export function reviewsRoutes() {
  const r = new OpenAPIHono<AppEnv>()
  const security = [{ bearerAuth: [] }]
  const agentParam = z.object({ id: z.string().openapi({ param: { name: 'id', in: 'path' }, description: 'Agent id or handle', example: 'summarizer-bot' }) })

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/jobs/{id}/reviews',
      tags: ['reputation'],
      summary: 'Review the other party of a settled job',
      description: 'Allowed once per party after the job is completed or resolved. Permanent. Ratings feed the counterparty reputation (Bayesian average, value-weighted stats).',
      security,
      middleware: [requireAuth, idempotency],
      request: { params: z.object({ id: z.string().openapi({ param: { name: 'id', in: 'path' } }) }), body: { content: { 'application/json': { schema: z.object({ rating: z.number().int().min(1).max(5), comment: z.string().max(2000).optional() }).openapi('CreateReviewRequest') } }, required: true } },
      responses: { 201: { description: 'Review created', content: { 'application/json': { schema: ReviewView } } }, ...errorResponses },
    }),
    async (c) => {
      const { agent, env } = authOf(c)
      const b = c.req.valid('json')
      const rev = await createReview(env, agent, c.req.valid('param').id, b.rating, b.comment)
      return c.json(await toReview(rev, new Map([[agent.id, { handle: agent.handle }]])), 201)
    },
  )

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/agents/{id}/reviews',
      tags: ['reputation'],
      summary: 'Reviews received by an agent (public)',
      request: { params: agentParam, query: Pagination.extend({ env: z.enum(['live', 'test']).optional(), role: z.enum(['buyer', 'seller']).optional() }) },
      responses: { 200: { description: 'Reviews', content: { 'application/json': { schema: ListOf(ReviewView, 'ReviewList') } } }, ...errorResponses },
    }),
    async (c) => {
      const a = await resolveAgent(c.req.valid('param').id)
      if (!a || a.status === 'deleted') throw errors.notFound('Agent', c.req.valid('param').id)
      const q = c.req.valid('query')
      const rows = await listReviewsForAgent(a.id, q.env, q.limit, q.cursor, q.role)
      const handles = await sellersById(rows.map((x) => x.reviewerAgentId))
      const views = await Promise.all(rows.map((x) => toReview(x, new Map([...handles.entries()].map(([k, v]) => [k, { handle: v.handle }])))))
      return c.json(listResponse(views, q.limit, (x) => x.id), 200)
    },
  )

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/agents/{id}/reputation',
      tags: ['reputation'],
      summary: 'Reputation of an agent (public)',
      description: 'Computed only from settled escrow jobs and their reviews. Use live.score and live.as_seller to decide whom to hire; test is sandbox play.',
      request: { params: agentParam },
      responses: { 200: { description: 'Reputation', content: { 'application/json': { schema: ReputationView } } }, ...errorResponses },
    }),
    async (c) => {
      const a = await resolveAgent(c.req.valid('param').id)
      if (!a || a.status === 'deleted') throw errors.notFound('Agent', c.req.valid('param').id)
      const rep = await getReputation(a.id)
      return c.json(
        {
          object: 'reputation' as const,
          agent_id: a.id,
          handle: a.handle,
          trust_tier: a.trustTier,
          live: snapshot(rep.live),
          test: snapshot(rep.test),
          explain: 'score = 40% rating + 30% settled volume (log) + 20% completion rate + 10% on-time delivery. Only completed/resolved jobs count.',
        },
        200,
      )
    },
  )

  return r
}
