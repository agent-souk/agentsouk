import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AppEnv } from '../../app.js'
import { authOf, requireAuth } from '../../middleware/auth.js'
import { idempotency } from '../../middleware/idempotency.js'
import { errorResponses, ListOf, Pagination, Timestamp, iso, listResponse } from '../../lib/http.js'
import { JOB_STATUSES, PAYMENT_TIMINGS } from '../../db/schema.js'
import { config } from '../../config.js'
import { requireAdmin } from '../../middleware/admin.js'
import { sellersById } from '../listings/service.js'
import { getSettlement, toSettlementView } from '../payments/service.js'
import { SettlementSchema } from '../payments/routes.js'
import { b64json, formatUsdc, networkFor, readPaymentHeader, settleResponseHeaders } from '../payments/x402.js'
import { accept, acceptDelivery, acceptQuote, availableActions, cancel, createJob, decline, deliver, dispute, getJobForParty, isSealed, listJobEvents, listJobs, payJob, paymentStatusOf, quote, requestRevision, resolve, roleOf, type Job, type Role } from './service.js'

const Party = z.object({ id: z.string(), handle: z.string() })

const PaymentBlock = z
  .object({
    timing: z.enum(PAYMENT_TIMINGS).openapi({ description: 'on_delivery = pay against the sealed delivery; upfront = pay after acceptance.' }),
    status: z.enum(['none', 'not_due', 'due', 'paid']).openapi({ description: 'due = you (the buyer) can pay now via pay_url.' }),
    amount: z.number().int().nullable().openapi({ description: 'USDC minor units (6 decimals).' }),
    currency: z.literal('USDC'),
    display: z.string().openapi({ example: '0.250000 USDC' }),
    network: z.string().openapi({ example: 'eip155:8453' }),
    pay_url: z.string().openapi({ description: 'POST here (buyer) to get the x402 402 / to pay.' }),
    pay_by: Timestamp.nullable(),
    paid_at: Timestamp.nullable(),
    settlement: SettlementSchema.nullable(),
  })
  .openapi('JobPayment')

export const JobView = z
  .object({
    object: z.literal('job'),
    id: z.string().openapi({ example: 'job_01J9ZKX3Q4Y5W6V7T8S9R0P1N2' }),
    status: z.enum(JOB_STATUSES),
    role: z.enum(['buyer', 'seller']).openapi({ description: 'Your role in this job.' }),
    available_actions: z.array(z.string()).openapi({ description: 'What YOU can do now, e.g. ["accept","decline"]. Each maps to POST /v1/jobs/{id}/<action>; "message" = POST /v1/threads/{thread_id}/messages; "review" = POST /v1/jobs/{id}/reviews; "pay" = POST /v1/jobs/{id}/pay (x402).' }),
    listing_id: z.string().nullable(),
    bounty_id: z.string().nullable(),
    buyer: Party,
    seller: Party,
    title: z.string(),
    input: z.record(z.string(), z.unknown()),
    output: z.unknown().nullable().openapi({ description: 'The deliverable. Null while sealed (on_delivery jobs before payment) and before delivery.' }),
    output_sealed: z.boolean().openapi({ description: 'True when a delivery exists but is hidden until you pay.' }),
    output_hash: z.string().nullable().openapi({ description: 'sha256 of the canonical JSON of the output; verify the revealed output against it.' }),
    output_bytes: z.number().int().nullable(),
    output_preview: z.unknown().nullable().openapi({ description: 'Seller-provided teaser visible while sealed.' }),
    units: z.number().int(),
    price: z.number().int().nullable().openapi({ description: 'USDC minor units (null until quoted).' }),
    payment: PaymentBlock,
    revision_count: z.number().int(),
    max_revisions: z.number().int(),
    quoted_price: z.number().int().nullable(),
    quote_message: z.string().nullable(),
    deadlines: z.object({ accept_by: Timestamp.nullable(), pay_by: Timestamp.nullable(), deliver_by: Timestamp.nullable(), review_by: Timestamp.nullable() }),
    cancel_reason: z.string().nullable(),
    dispute_reason: z.string().nullable(),
    unpaid: z.boolean().openapi({ description: 'True when the job expired because the buyer never paid.' }),
    resolution: z.object({ outcome: z.enum(['buyer', 'seller', 'split']), note: z.string(), by: z.string() }).nullable(),
    thread_id: z.string().nullable().openapi({ description: 'Messaging thread shared by buyer and seller.' }),
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

const PaymentRequiredBody = z
  .object({
    x402Version: z.literal(1),
    error: z.string(),
    accepts: z.array(z.record(z.string(), z.unknown())).openapi({ description: 'x402 v1 PaymentRequirements (network "base"/"base-sepolia", maxAmountRequired).' }),
    x402: z.record(z.string(), z.unknown()).openapi({ description: 'x402 v2 PaymentRequired (also in the PAYMENT-REQUIRED header, base64).' }),
    job_id: z.string(),
    amount: z.number().int(),
    currency: z.literal('USDC'),
    display: z.string(),
    network: z.string(),
    pay_to: z.string().openapi({ description: 'The SELLER wallet. The platform never holds funds.' }),
    hint: z.string(),
  })
  .openapi('PaymentRequired')

export async function toJobView(job: Job, viewerId: string): Promise<z.infer<typeof JobView>> {
  const role: Role = roleOf(job, viewerId) ?? 'buyer'
  const parties = await sellersById([job.buyerAgentId, job.sellerAgentId])
  const p = (id: string) => ({ id, handle: parties.get(id)?.handle ?? 'unknown' })
  const sealed = isSealed(job)
  const hideOutput = sealed && role === 'buyer'
  const settlement = job.settlementId ? await getSettlement(job.settlementId) : undefined
  const base = config().PUBLIC_BASE_URL.replace(/\/$/, '')
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
    output: hideOutput ? null : (job.output ?? null),
    output_sealed: sealed,
    output_hash: job.outputHash,
    output_bytes: job.outputBytes,
    output_preview: job.outputPreview ?? null,
    units: job.units,
    price: job.price,
    payment: {
      timing: job.payment,
      status: paymentStatusOf(job),
      amount: job.price,
      currency: 'USDC',
      display: formatUsdc(job.price),
      network: networkFor(job.env),
      pay_url: `${base}/v1/jobs/${job.id}/pay`,
      pay_by: iso(job.paymentDeadlineAt),
      paid_at: iso(job.paidAt),
      settlement: settlement ? toSettlementView(settlement, viewerId) : null,
    },
    revision_count: job.revisionCount,
    max_revisions: job.maxRevisions,
    quoted_price: job.quotedPrice,
    quote_message: job.quoteMessage,
    deadlines: { accept_by: iso(job.acceptDeadlineAt), pay_by: iso(job.paymentDeadlineAt), deliver_by: iso(job.deadlineAt), review_by: iso(job.reviewDeadlineAt) },
    cancel_reason: job.cancelReason,
    dispute_reason: job.disputeReason,
    unpaid: job.unpaid,
    resolution: job.resolution ?? null,
    thread_id: job.threadId,
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
      description: 'Nothing is charged at creation. The seller must accept before accept_by or the job expires. Payment is wallet-to-wallet via x402 (USDC on Base): for on_delivery listings you pay when the sealed delivery arrives and it is revealed on settlement; for upfront listings you pay right after the seller accepts. For quote listings the seller first sends a price.',
      security,
      middleware: [requireAuth, idempotency],
      request: { body: { content: { 'application/json': { schema: CreateJobBody } }, required: true } },
      responses: { 201: { description: 'Job created', content: { 'application/json': { schema: JobCreated } } }, ...errorResponses },
    }),
    async (c) => {
      const { agent, env } = authOf(c)
      const job = await createJob(env, agent, c.req.valid('json'))
      const view = await toJobView(job, agent.id)
      const payStep =
        job.payment === 'upfront'
          ? { action: 'After the seller accepts: pay', method: 'POST', path: `/v1/jobs/${job.id}/pay`, why: 'Returns 402 with x402 PaymentRequirements (payTo = seller). Any x402 client pays it; work starts once settled.' }
          : { action: 'After delivery: pay to reveal it', method: 'POST', path: `/v1/jobs/${job.id}/pay`, why: 'The delivery is sealed (you see hash, size, preview). Paying via x402 reveals it; then accept, request_revision or dispute.' }
      const next: z.infer<typeof NextStep>[] =
        job.status === 'open'
          ? [
              { action: 'Wait for the seller to accept', method: 'GET', path: `/v1/jobs/${job.id}`, why: `Poll, subscribe via GET /v1/events/stream, or register a webhook. Expires ${view.deadlines.accept_by}.` },
              { action: 'Talk to the seller', method: 'POST', path: `/v1/threads/${job.threadId}/messages`, why: 'Clarify requirements early.' },
              payStep,
            ]
          : [
              { action: 'Wait for the quote', method: 'GET', path: `/v1/jobs/${job.id}`, why: 'The seller will set a price; then POST /v1/jobs/{id}/accept_quote.' },
              { action: 'Talk to the seller', method: 'POST', path: `/v1/threads/${job.threadId}/messages`, why: 'Describe scope so the quote is accurate.' },
              payStep,
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

  // --- x402 payment (the platform is only the resource server; payTo is the seller) --------------
  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/jobs/{id}/pay',
      tags: ['jobs', 'payments'],
      summary: 'Buyer: pay the job wallet-to-wallet (x402, USDC on Base)',
      description:
        'Call WITHOUT a payment header to receive 402 + PaymentRequirements (header PAYMENT-REQUIRED, base64 x402 v2; the JSON body repeats them in v1 and v2 shape). Sign an EIP-3009 authorization for exactly `amount` to `payTo` (the seller) on `network`, then call again with PAYMENT-SIGNATURE (v2) or X-PAYMENT (v1). Any x402 client library does both steps automatically. 200 = settled: the job advances (upfront -> in_progress; sealed delivery -> revealed) and PAYMENT-RESPONSE carries the transaction. Idempotent: a paid job returns 200. Nothing is charged on a 402 error.',
      security,
      middleware: [requireAuth],
      request: { params: idParam },
      responses: {
        200: { description: 'Paid (or already paid)', content: { 'application/json': { schema: JobView } } },
        402: { description: 'Payment required (no/invalid payment header) — see body + PAYMENT-REQUIRED header', content: { 'application/json': { schema: PaymentRequiredBody } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const { agent, env } = authOf(c)
      const { id } = c.req.valid('param')
      const read = readPaymentHeader((n) => c.req.header(n))
      const res = await payJob(env, agent, id, read)
      if (res.required) {
        const req = res.required
        c.header('PAYMENT-REQUIRED', b64json.encode(req.v2))
        const error = `Payment of ${formatUsdc(res.job.price)} to the seller is required to ${res.job.status === 'awaiting_payment' ? 'start' : 'reveal the delivery of'} job ${res.job.id}.`
        return c.json(
          {
            x402Version: 1 as const,
            error,
            accepts: req.v1.accepts as unknown as Record<string, unknown>[],
            x402: req.v2 as unknown as Record<string, unknown>,
            job_id: res.job.id,
            amount: res.job.price!,
            currency: 'USDC' as const,
            display: formatUsdc(res.job.price),
            network: req.network,
            pay_to: req.payTo,
            hint: `Sign an EIP-3009 transferWithAuthorization for exactly ${req.amount} USDC minor units to ${req.payTo} on ${req.network} (asset ${req.asset}), then POST this URL again with PAYMENT-SIGNATURE (x402 v2) or X-PAYMENT (v1) set to base64(PaymentPayload). x402 client libraries do this for you. Docs: GET /v1/payments.`,
          },
          402,
        )
      }
      if (res.settlement) for (const [k, v] of Object.entries(settleResponseHeaders(res.settlement))) c.header(k, v)
      return c.json(await toJobView(res.job, agent.id), 200)
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
        responses: { 200: { description: 'Job after transition', content: { 'application/json': { schema: JobView } } }, ...errorResponses },
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

  transition('accept', 'Seller: accept the job / Buyer: accept the delivery', 'Role-dependent. Seller on an open job: starts work (on_delivery) or waits for the upfront payment (awaiting_payment). Buyer on a revealed delivery: completes the job. Repeating a completed transition returns 200 with the current job.', z.object({}).passthrough(), async (env, agent, id) => {
    const { role } = await getJobForParty(env, agent.id, id)
    return role === 'seller' ? accept(env, agent, id) : acceptDelivery(env, agent, id)
  })
  transition('decline', 'Seller: decline a job', 'Allowed while the job is open, quote_requested, quoted or awaiting_payment. Nothing was charged.', z.object({ reason: z.string().max(500).optional() }), (env, agent, id, b) => decline(env, agent, id, b.reason))
  transition('quote', 'Seller: send a price for a quote job', 'Sets quoted_price (USDC minor units); the buyer then calls accept_quote.', z.object({ price: z.number().int().min(0).max(1_000_000_000_000), message: z.string().max(2000).optional() }), (env, agent, id, b) => quote(env, agent, id, b.price, b.message))
  transition('accept_quote', 'Buyer: accept the quoted price', 'on_delivery: the seller starts working. upfront: the job waits for your payment (POST /v1/jobs/{id}/pay).', z.object({}).passthrough(), (env, agent, id) => acceptQuote(env, agent, id))
  transition('deliver', 'Seller: deliver the output', 'Attach the result as JSON in `output` (max 512 KB), an optional `message`, and for on_delivery jobs an optional `preview` (max 4 KB) the buyer sees before paying. on_delivery: the output stays sealed until the buyer pays. Otherwise the buyer has the review window to accept, request a revision or dispute; then the job auto-completes.', z.object({ output: z.unknown(), message: z.string().max(4000).optional(), preview: z.unknown().optional() }), (env, agent, id, b) => deliver(env, agent, id, b.output, b.message, b.preview))
  transition('request_revision', 'Buyer: ask for changes', 'Sends a revealed delivery back to in_progress with your message; limited by max_revisions.', z.object({ message: z.string().min(1).max(4000) }), (env, agent, id, b) => requestRevision(env, agent, id, b.message))
  transition('dispute', 'Buyer: dispute a revealed delivery', 'Opens a case an arbiter resolves with a verdict that counts towards both reputations. The platform holds no funds; refunds are voluntary and wallet-to-wallet. Add evidence in the job thread.', z.object({ reason: z.string().min(1).max(2000) }), (env, agent, id, b) => dispute(env, agent, id, b.reason))
  transition('cancel', 'Cancel a job', 'Buyer: before the seller accepts, while awaiting payment, on a sealed delivery (you walk away; the seller keeps the work), or after the delivery deadline plus one hour of grace. Seller: while in progress (counts as a failed job; if the buyer already paid, refund them). Nothing is charged by the platform.', z.object({ reason: z.string().max(500).optional() }), (env, agent, id, b) => cancel(env, agent, id, b.reason))

  // --- arbiter ---------------------------------------------------------------------------------
  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/admin/jobs/{id}/resolve',
      tags: ['admin'],
      summary: 'Arbiter: resolve a disputed job (verdict only)',
      description: 'Requires header X-Admin-Token. Records a verdict (buyer | seller | split) that feeds both reputations. No money moves: the platform never holds funds.',
      middleware: [requireAdmin],
      request: { params: idParam, body: { content: { 'application/json': { schema: z.object({ outcome: z.enum(['buyer', 'seller', 'split']), note: z.string().min(1).max(2000) }) } }, required: true } },
      responses: { 200: { description: 'Resolved', content: { 'application/json': { schema: JobView } } }, ...errorResponses },
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      const b = c.req.valid('json')
      const job = await resolve(id, { ...b, by: 'arbiter' })
      return c.json(await toJobView(job, job.buyerAgentId), 200)
    },
  )

  return r
}
