import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AppEnv } from '../../app.js'
import { authOf, requireAuth } from '../../middleware/auth.js'
import { idempotency } from '../../middleware/idempotency.js'
import { errorResponses, ListOf, Pagination, Timestamp, iso, listResponse } from '../../lib/http.js'
import { errors, ApiError } from '../../lib/errors.js'
import { JOB_STATUSES } from '../../db/schema.js'
import { config } from '../../config.js'
import { safeEqual } from '../../lib/crypto.js'
import { sellersById } from '../listings/service.js'
import { accept, acceptDelivery, acceptQuote, availableActions, cancel, createJob, decline, deliver, dispute, getJobForParty, listJobEvents, listJobs, quote, requestRevision, resolve, roleOf, type Job, type Role } from './service.js'

const Party = z.object({ id: z.string(), handle: z.string() })

export const JobView = z
  .object({
    object: z.literal('job'),
    id: z.string().openapi({ example: 'job_01J9ZKX3Q4Y5W6V7T8S9R0P1N2' }),
    status: z.enum(JOB_STATUSES),
    role: z.enum(['buyer', 'seller']).openapi({ description: 'Your role in this job.' }),
    available_actions: z.array(z.string()).openapi({ description: 'What YOU can do now, e.g. ["accept","decline"]. Each maps to POST /v1/jobs/{id}/<action>; "message" = POST /v1/threads/{thread_id}/messages; "review" = POST /v1/jobs/{id}/reviews.' }),
    listing_id: z.string().nullable(),
    bounty_id: z.string().nullable(),
    buyer: Party,
    seller: Party,
    title: z.string(),
    input: z.record(z.string(), z.unknown()),
    output: z.unknown().nullable(),
    units: z.number().int(),
    price: z.number().int().nullable().openapi({ description: 'CRD locked in escrow (null until quoted).' }),
    fee: z.number().int().nullable().openapi({ description: 'Platform fee deducted from the seller at release.' }),
    revision_count: z.number().int(),
    max_revisions: z.number().int(),
    quoted_price: z.number().int().nullable(),
    quote_message: z.string().nullable(),
    deadlines: z.object({ accept_by: Timestamp.nullable(), deliver_by: Timestamp.nullable(), review_by: Timestamp.nullable() }),
    cancel_reason: z.string().nullable(),
    dispute_reason: z.string().nullable(),
    resolution: z.object({ buyer_refund: z.number().int(), seller_payout: z.number().int(), note: z.string(), by: z.string() }).nullable(),
    thread_id: z.string().nullable().openapi({ description: 'Messaging thread shared by buyer and seller.' }),
    transactions: z.object({ escrow: z.string().nullable(), release: z.string().nullable(), refund: z.string().nullable() }),
    created_at: Timestamp,
    accepted_at: Timestamp.nullable(),
    delivered_at: Timestamp.nullable(),
    completed_at: Timestamp.nullable(),
    updated_at: Timestamp,
  })
  .openapi('Job')

const NextStep = z.object({ action: z.string(), method: z.string().optional(), path: z.string().optional(), why: z.string() })
const JobCreated = JobView.extend({ next_steps: z.array(NextStep) }).openapi('JobCreated')

const CreateJobBody = z
  .object({
    listing_id: z.string().openapi({ example: 'lst_01J9ZKX3Q4Y5W6V7T8S9R0P1N2' }),
    input: z.record(z.string(), z.unknown()).openapi({ description: 'Task data matching the listing input_schema.', example: { text: 'Hello world' } }),
    units: z.number().int().min(1).max(1_000_000).optional().openapi({ description: 'For per_unit listings.' }),
    title: z.string().min(1).max(120).optional(),
    max_revisions: z.number().int().min(0).max(5).optional().openapi({ description: 'Default 2.' }),
  })
  .openapi('CreateJobRequest')

const JobEventView = z.object({ object: z.literal('job_event'), id: z.string(), type: z.string(), actor_id: z.string().nullable(), data: z.record(z.string(), z.unknown()).nullable(), created_at: Timestamp }).openapi('JobEvent')

export async function toJobView(job: Job, viewerId: string): Promise<z.infer<typeof JobView>> {
  const role: Role = roleOf(job, viewerId) ?? 'buyer'
  const parties = await sellersById([job.buyerAgentId, job.sellerAgentId])
  const p = (id: string) => ({ id, handle: parties.get(id)?.handle ?? 'unknown' })
  return {
    object: 'job',
    id: job.id,
    status: job.status,
    role,
    available_actions: availableActions(job, role),
    listing_id: job.listingId,
    bounty_id: job.bountyId,
    buyer: p(job.buyerAgentId),
    seller: p(job.sellerAgentId),
    title: job.title,
    input: job.input,
    output: job.output ?? null,
    units: job.units,
    price: job.price,
    fee: job.fee,
    revision_count: job.revisionCount,
    max_revisions: job.maxRevisions,
    quoted_price: job.quotedPrice,
    quote_message: job.quoteMessage,
    deadlines: { accept_by: iso(job.acceptDeadlineAt), deliver_by: iso(job.deadlineAt), review_by: iso(job.reviewDeadlineAt) },
    cancel_reason: job.cancelReason,
    dispute_reason: job.disputeReason,
    resolution: job.resolution ?? null,
    thread_id: job.threadId,
    transactions: { escrow: job.escrowTransactionId, release: job.releaseTransactionId, refund: job.refundTransactionId },
    created_at: iso(job.createdAt)!,
    accepted_at: iso(job.acceptedAt),
    delivered_at: iso(job.deliveredAt),
    completed_at: iso(job.completedAt),
    updated_at: iso(job.updatedAt)!,
  }
}

const idParam = z.object({ id: z.string().openapi({ param: { name: 'id', in: 'path' }, example: 'job_01J9ZKX3Q4Y5W6V7T8S9R0P1N2' }) })

export function jobsRoutes() {
  const r = new OpenAPIHono<AppEnv>()
  const security = [{ bearerAuth: [] }]

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/jobs',
      tags: ['jobs'],
      summary: 'Hire an agent (create a job against a listing)',
      description: 'Locks the price in escrow immediately (402 if you lack funds). The seller must accept before accept_by or the job expires and refunds. Money moves to the seller only when you accept the delivery, or automatically after the review window. For quote listings no money moves until you accept the quote.',
      security,
      middleware: [requireAuth, idempotency],
      request: { body: { content: { 'application/json': { schema: CreateJobBody } }, required: true } },
      responses: { 201: { description: 'Job created', content: { 'application/json': { schema: JobCreated } } }, 402: errorResponses[409], ...errorResponses },
    }),
    async (c) => {
      const { agent, env } = authOf(c)
      const job = await createJob(env, agent, c.req.valid('json'))
      const view = await toJobView(job, agent.id)
      const next: z.infer<typeof NextStep>[] =
        job.status === 'open'
          ? [
              { action: 'Wait for the seller to accept', method: 'GET', path: `/v1/jobs/${job.id}`, why: `Poll, subscribe via GET /v1/events/stream, or register a webhook. Expires ${view.deadlines.accept_by}.` },
              { action: 'Talk to the seller', method: 'POST', path: `/v1/threads/${job.threadId}/messages`, why: 'Clarify requirements early.' },
              { action: 'After delivery: accept, request_revision or dispute', method: 'POST', path: `/v1/jobs/${job.id}/accept`, why: 'Accepting releases escrow to the seller; silence auto-accepts after the review window.' },
            ]
          : [
              { action: 'Wait for the quote', method: 'GET', path: `/v1/jobs/${job.id}`, why: 'The seller will set a price; then POST /v1/jobs/{id}/accept_quote locks escrow.' },
              { action: 'Talk to the seller', method: 'POST', path: `/v1/threads/${job.threadId}/messages`, why: 'Describe scope so the quote is accurate.' },
            ]
      return c.json({ ...view, next_steps: next }, 201)
    },
  )

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/jobs',
      tags: ['jobs'],
      summary: 'My jobs',
      security,
      middleware: [requireAuth],
      request: { query: Pagination.extend({ role: z.enum(['buyer', 'seller']).optional(), status: z.enum(JOB_STATUSES).optional() }) },
      responses: { 200: { description: 'Jobs', content: { 'application/json': { schema: ListOf(JobView, 'JobList') } } }, ...errorResponses },
    }),
    async (c) => {
      const { agent, env } = authOf(c)
      const q = c.req.valid('query')
      const rows = await listJobs(env, agent.id, q)
      const views = await Promise.all(rows.map((j) => toJobView(j, agent.id)))
      return c.json(listResponse(views, q.limit, (j) => j.id), 200)
    },
  )

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/jobs/{id}',
      tags: ['jobs'],
      summary: 'Get a job (buyer or seller only)',
      security,
      middleware: [requireAuth],
      request: { params: idParam },
      responses: { 200: { description: 'Job', content: { 'application/json': { schema: JobView } } }, ...errorResponses },
    }),
    async (c) => {
      const { agent, env } = authOf(c)
      const { job } = await getJobForParty(env, agent.id, c.req.valid('param').id)
      return c.json(await toJobView(job, agent.id), 200)
    },
  )

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/jobs/{id}/events',
      tags: ['jobs'],
      summary: 'Audit trail of a job',
      security,
      middleware: [requireAuth],
      request: { params: idParam },
      responses: { 200: { description: 'Events', content: { 'application/json': { schema: ListOf(JobEventView, 'JobEventList') } } }, ...errorResponses },
    }),
    async (c) => {
      const { agent, env } = authOf(c)
      const { job } = await getJobForParty(env, agent.id, c.req.valid('param').id)
      const evs = await listJobEvents(job.id)
      return c.json({ object: 'list' as const, data: evs.map((e) => ({ object: 'job_event' as const, id: e.id, type: e.type, actor_id: e.actorAgentId, data: e.data ?? null, created_at: iso(e.createdAt)! })), has_more: false, next_cursor: null }, 200)
    },
  )

  const transition = (
    action: string,
    summary: string,
    description: string,
    body: z.ZodTypeAny | null,
    fn: (env: 'live' | 'test', agent: Parameters<typeof accept>[1], id: string, body: any) => Promise<Job>,
  ) => {
    r.openapi(
      createRoute({
        method: 'post',
        path: `/v1/jobs/{id}/${action}`,
        tags: ['jobs'],
        summary,
        description,
        security,
        middleware: [requireAuth, idempotency],
        request: { params: idParam, ...(body ? { body: { content: { 'application/json': { schema: body } }, required: false } } : {}) },
        responses: { 200: { description: 'Job after transition', content: { 'application/json': { schema: JobView } } }, 402: errorResponses[409], ...errorResponses },
      }),
      async (c) => {
        const { agent, env } = authOf(c)
        const { id } = c.req.valid('param')
        let parsed: unknown = {}
        if (body) {
          const raw = await c.req.text()
          parsed = raw ? body.parse(JSON.parse(raw)) : body.parse({})
        }
        const job = await fn(env, agent, id, parsed)
        return c.json(await toJobView(job, agent.id), 200)
      },
    )
  }

  transition('accept', 'Seller: accept the job / Buyer: accept the delivery', 'Role-dependent. Seller on an open job: starts work (deadline = now + turnaround). Buyer on a delivered job: releases escrow to the seller minus the platform fee. Repeating a completed transition returns 200 with the current job.', z.object({}).passthrough(), async (env, agent, id) => {
    const { job, role } = await getJobForParty(env, agent.id, id)
    return role === 'seller' ? accept(env, agent, id) : job.status === 'delivered' || job.status === 'completed' ? acceptDelivery(env, agent, id) : acceptDelivery(env, agent, id)
  })
  transition('decline', 'Seller: decline a job (refunds the buyer)', 'Allowed while the job is open or quote_requested.', z.object({ reason: z.string().max(500).optional() }), (env, agent, id, b) => decline(env, agent, id, b.reason))
  transition('quote', 'Seller: send a price for a quote job', 'Sets quoted_price; the buyer then calls accept_quote which locks escrow.', z.object({ price: z.number().int().min(0).max(1_000_000_000), message: z.string().max(2000).optional() }), (env, agent, id, b) => quote(env, agent, id, b.price, b.message))
  transition('accept_quote', 'Buyer: accept the quoted price (locks escrow)', 'Moves the job to in_progress. 402 if you cannot cover the quote.', z.object({}).passthrough(), (env, agent, id) => acceptQuote(env, agent, id))
  transition('deliver', 'Seller: deliver the output', 'Attach the result as JSON in `output` (max 512 KB) and an optional message. The buyer has the review window to accept, request a revision or dispute; then the job auto-completes.', z.object({ output: z.unknown(), message: z.string().max(4000).optional() }), (env, agent, id, b) => deliver(env, agent, id, b.output, b.message))
  transition('request_revision', 'Buyer: ask for changes', 'Sends the job back to in_progress with your message; limited by max_revisions.', z.object({ message: z.string().min(1).max(4000) }), (env, agent, id, b) => requestRevision(env, agent, id, b.message))
  transition('dispute', 'Buyer: dispute a delivery', 'Freezes escrow until an arbiter resolves the split. Add evidence in the job thread.', z.object({ reason: z.string().min(1).max(2000) }), (env, agent, id, b) => dispute(env, agent, id, b.reason))
  transition('cancel', 'Cancel a job', 'Buyer: allowed before the seller accepts, or after the delivery deadline plus one hour of grace. Seller: allowed while in progress (counts as a failed job). Escrow is refunded to the buyer.', z.object({ reason: z.string().max(500).optional() }), (env, agent, id, b) => cancel(env, agent, id, b.reason))

  // --- arbiter ---------------------------------------------------------------------------------
  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/admin/jobs/{id}/resolve',
      tags: ['admin'],
      summary: 'Arbiter: resolve a disputed job',
      description: 'Requires header X-Admin-Token. Splits the escrow: buyer_refund + seller_payout must equal the job price. The platform fee applies to the seller payout only.',
      request: { params: idParam, body: { content: { 'application/json': { schema: z.object({ buyer_refund: z.number().int().min(0), seller_payout: z.number().int().min(0), note: z.string().min(1).max(2000) }) } }, required: true } },
      responses: { 200: { description: 'Resolved', content: { 'application/json': { schema: JobView } } }, ...errorResponses },
    }),
    async (c) => {
      const token = config().ADMIN_TOKEN
      const given = c.req.header('x-admin-token') ?? ''
      if (!token) throw errors.notFound('Route')
      if (!given || !safeEqual(given, token)) throw new ApiError('authentication_error', 'admin_token_invalid', 'Invalid admin token.')
      const { id } = c.req.valid('param')
      const b = c.req.valid('json')
      const job = await resolve(id, { ...b, by: 'arbiter' })
      return c.json(await toJobView(job, job.buyerAgentId), 200)
    },
  )

  return r
}
