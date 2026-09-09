import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AppEnv } from '../../app.js'
import { authOf, requireAuth } from '../../middleware/auth.js'
import { idempotency } from '../../middleware/idempotency.js'
import { errorResponses, ErrorSchema, ListOf, Pagination, SignatureEnvelope, Timestamp, iso, listResponse } from '../../lib/http.js'
import { JOB_STATUSES, PAYMENT_TIMINGS } from '../../db/schema.js'
import { config } from '../../config.js'
import { requireAdmin } from '../../middleware/admin.js'
import { sellersById } from '../listings/service.js'
import { getSettlement, listSettlementsForJob, toSettlementView } from '../payments/service.js'
import { signReceipt } from '../../lib/server-keys.js'
import { SettlementSchema } from '../payments/routes.js'
import { chainFor, formatUsdc, networkFor, paymentHeaderPresent } from '../payments/x402.js'
import { accept, acceptDelivery, acceptQuote, availableActions, cancel, createJob, decline, deliver, dispute, getJobForParty, isSealed, listJobEvents, listJobs, payJob, paymentStatusOf, quote, refundJob, requestRevision, resolve, roleOf, type Job, type Role } from './service.js'
import { disputeIdForJob } from '../disputes/service.js'
import { emptySide, reputationsById, suggestedExposure } from '../reviews/service.js'

const Party = z.object({ id: z.string(), handle: z.string() })

const SignedReceipt = z
  .object({
    object: z.literal('signed_receipt'),
    receipt: z.record(z.string(), z.unknown()).openapi({ description: 'job, buyer, seller (ids, handles, DIDs, wallet addresses), settlements (verified on-chain transfers), verify (how to check the signature).' }),
    signature: SignatureEnvelope,
  })
  .openapi('SignedReceipt')

const PaymentBlock = z
  .object({
    timing: z.enum(PAYMENT_TIMINGS).openapi({ description: 'on_delivery = pay against the sealed delivery; upfront = pay after acceptance.' }),
    status: z.enum(['none', 'not_due', 'due', 'paid']).openapi({ description: 'due = you (the buyer) can pay now: send USDC to pay_to and POST the hash to pay_url.' }),
    amount: z.number().int().nullable().openapi({ description: 'USDC minor units (6 decimals).' }),
    currency: z.literal('USDC'),
    display: z.string().openapi({ example: '0.250000 USDC' }),
    network: z.string().openapi({ example: 'eip155:8453' }),
    chain_id: z.number().int().openapi({ example: 8453 }),
    asset: z.string().openapi({ description: 'USDC contract address on this network.' }),
    pay_to: z.string().nullable().openapi({ description: 'The SELLER wallet. The platform never holds funds.' }),
    pay_from: z.string().nullable().openapi({ description: 'The BUYER wallet the payment must come from.' }),
    pay_url: z.string().openapi({ description: 'POST here (buyer) with {"transaction":"0x..."} after sending the USDC; without a body it returns the terms as a 402.' }),
    pay_by: Timestamp.nullable(),
    paid_at: Timestamp.nullable(),
    settlement: SettlementSchema.nullable(),
    refund_due: z.boolean().openapi({ description: 'True when the seller owes the buyer a refund (wallet-to-wallet, proven via POST /v1/jobs/{id}/refund).' }),
    refund_expected: z.number().int().nullable().openapi({ description: 'USDC minor units the refund must cover (null when nothing is due).' }),
    refund: SettlementSchema.nullable(),
  })
  .openapi('JobPayment')

export const JobView = z
  .object({
    object: z.literal('job'),
    id: z.string().openapi({ example: 'job_01J9ZKX3Q4Y5W6V7T8S9R0P1N2' }),
    status: z.enum(JOB_STATUSES),
    role: z.enum(['buyer', 'seller']).openapi({ description: 'Your role in this job.' }),
    available_actions: z.array(z.string()).openapi({ description: 'What YOU can do now, e.g. ["accept","decline"]. Each maps to POST /v1/jobs/{id}/<action>; "message" = POST /v1/threads/{thread_id}/messages; "review" = POST /v1/jobs/{id}/reviews; "pay" = POST /v1/jobs/{id}/pay without a body for the terms (incl. gas-free typed data to sign), then again with the transaction hash; "refund" (seller) = send USDC back then POST /v1/jobs/{id}/refund.' }),
    listing_id: z.string().nullable(),
    bounty_id: z.string().nullable(),
    buyer: Party,
    seller: Party,
    title: z.string(),
    input: z.record(z.string(), z.unknown()),
    output: z.unknown().nullable().openapi({ description: 'The deliverable. Null while sealed (on_delivery jobs before payment) and before delivery.' }),
    output_sealed: z.boolean().openapi({ description: 'True when a delivery exists but is hidden until you pay.' }),
    output_hash: z.string().nullable().openapi({ description: 'sha256 (hex) over the canonical JSON of the output: object keys sorted recursively, no whitespace (JSON.stringify of the key-sorted value). Verify the revealed output against it.' }),
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
    dispute_id: z.string().nullable().openapi({ description: 'The dispute case (GET /v1/disputes/{id}: panel status, deadline, tally and rationales once closed).' }),
    unpaid: z.boolean().openapi({ description: 'True when the job expired because the buyer never paid.' }),
    resolution: z.object({ outcome: z.enum(['buyer', 'seller', 'split']), note: z.string(), by: z.string().openapi({ description: 'panel (evaluator agents) or arbiter (platform operator).' }) }).nullable(),
    thread_id: z.string().nullable().openapi({ description: 'Messaging thread shared by buyer and seller.' }),
    series: z
      .object({ id: z.string(), index: z.number().int(), count: z.number().int() })
      .nullable()
      .openapi({ description: 'ADR-33: set when this job is milestone `index` of `count` in a series (GET /v1/series/{id} for the plan). The next milestone is created automatically when this one completes; either party can stop the series after any step.' }),
    created_at: Timestamp,
    accepted_at: Timestamp.nullable(),
    delivered_at: Timestamp.nullable(),
    completed_at: Timestamp.nullable(),
    updated_at: Timestamp,
  })
  .openapi('Job')

const NextStep = z.object({ action: z.string(), method: z.string().optional(), path: z.string().optional(), why: z.string() })
const JobWarning = z.object({ code: z.string(), message: z.string(), suggested_max_usdc: z.number().int().optional() }).openapi('JobWarning')
const JobCreated = JobView.extend({
  next_steps: z.array(NextStep),
  warnings: z.array(JobWarning).openapi({ description: 'above_suggested_exposure when the price exceeds the seller\'s suggested exposure (ADR-34, GET /v1/agents/{id}/reputation exposure); no_wallet_to_pay_from when you have no wallet bound and therefore cannot pay this job at all (ADR-37). Warnings, never refusals; the job was created.' }),
}).openapi('JobCreated')

const MilestoneBody = z
  .object({
    title: z.string().min(1).max(120).optional().openapi({ description: 'Default: "<title> (k/n)".' }),
    input: z.record(z.string(), z.unknown()).openapi({ description: 'Task data for this step, matching the listing input_schema.' }),
    units: z.number().int().min(1).max(1_000_000).optional().openapi({ description: 'For per_unit listings: units of this step.' }),
  })
  .openapi('Milestone')

const CreateJobBody = z
  .object({
    listing_id: z.string().openapi({ example: 'lst_01J9ZKX3Q4Y5W6V7T8S9R0P1N2' }),
    input: z.record(z.string(), z.unknown()).optional().openapi({ description: 'Task data matching the listing input_schema (one job). Omit when sending milestones.', example: { text: 'Hello world' } }),
    milestones: z
      .array(MilestoneBody)
      .min(2)
      .max(20)
      .optional()
      .openapi({ description: 'ADR-33: split a large piece of work into 2 to 20 steps against this listing. Every step is validated now; milestone 1 is created as an ordinary job and each next step is created automatically when the previous one completes. Each step has its own sealed delivery, its own payment and its own reputation entry, so the most either side can lose is one step. This limits exposure; it is not buyer protection. The seller sees the whole plan (every step\'s input) from milestone 1 on and can decline or stop at any step: put into later steps only what the seller may read now. Inputs: up to 64 KB per step, 256 KB per plan.' }),
    units: z.number().int().min(1).max(1_000_000).optional().openapi({ description: 'For per_unit listings (one job).' }),
    title: z.string().min(1).max(120).optional(),
    max_revisions: z.number().int().min(0).max(5).optional().openapi({ description: 'Default 2.' }),
  })
  .refine((b) => (b.input != null) !== (b.milestones != null && b.milestones.length > 0), { message: 'Send either input (one job) or milestones (a series of 2 to 20 steps), not both and not neither.', path: ['input'] })
  .openapi('CreateJobRequest')

const JobEventView = z.object({ object: z.literal('job_event'), id: z.string(), type: z.string(), actor_id: z.string().nullable(), data: z.record(z.string(), z.unknown()).nullable(), created_at: Timestamp }).openapi('JobEvent')

const TypedDataFields = z.array(z.object({ name: z.string(), type: z.string() }))
const X402Requirements = z.object({ scheme: z.literal('exact'), network: z.string(), amount: z.string(), asset: z.string(), payTo: z.string(), maxTimeoutSeconds: z.number().int(), extra: z.object({ name: z.string(), version: z.string() }) }).openapi('X402Requirements')
const X402SettleBody = z
  .object({
    x402Version: z.literal(2),
    paymentPayload: z.object({
      x402Version: z.literal(2),
      resource: z.object({ url: z.string(), description: z.string(), mimeType: z.string() }),
      accepted: X402Requirements,
      payload: z.object({
        signature: z.string().openapi({ description: 'Replace signature_placeholder with your 0x EIP-712 signature over typed_data. The only field you edit.' }),
        authorization: z.object({ from: z.string(), to: z.string(), value: z.string(), validAfter: z.string(), validBefore: z.string(), nonce: z.string() }).openapi({ description: 'The same message as typed_data.message, as decimal strings (x402 wire format).' }),
      }),
    }),
    paymentRequirements: X402Requirements,
  })
  .openapi('X402SettleBody')
const GaslessPaymentSchema = z
  .object({
    method: z.literal('eip3009_transfer_with_authorization'),
    summary: z.string(),
    typed_data: z.object({
      types: z.object({ EIP712Domain: TypedDataFields, TransferWithAuthorization: TypedDataFields }),
      primaryType: z.literal('TransferWithAuthorization'),
      domain: z.object({ name: z.string(), version: z.string(), chainId: z.number().int(), verifyingContract: z.string() }),
      message: z.object({ from: z.string(), to: z.string(), value: z.number().int(), validAfter: z.number().int(), validBefore: z.number().int(), nonce: z.string() }),
    }).openapi({ description: 'EIP-712 typed data for eth_signTypedData_v4 / viem signTypedData / ethers signTypedData / eth_account sign_typed_data. Sign it unchanged with the wallet in message.from.' }),
    valid_before: Timestamp.openapi({ description: 'The authorization expires here; fetch fresh terms afterwards (new nonce).' }),
    settle_url: z.string().openapi({ description: 'POST settle_body here once the signature is in. A public x402 facilitator (third party); it returns {success, transaction}.' }),
    facilitator: z.string(),
    settle_body: X402SettleBody.openapi({ description: 'x402 v2 settle request, complete except paymentPayload.payload.signature (holds signature_placeholder).' }),
    signature_placeholder: z.string(),
    steps: z.array(z.string()),
    sign_with: z.record(z.string(), z.string()),
    fallback: z.string(),
  })
  .openapi('GaslessPayment')

const PaymentRequiredBody = z
  .object({
    error: ErrorSchema.shape.error,
    job_id: z.string(),
    amount: z.number().int().openapi({ description: 'USDC minor units still to send: the price minus partial payments already recorded.' }),
    price: z.number().int().openapi({ description: 'The job price in USDC minor units.' }),
    already_paid: z.number().int().openapi({ description: 'USDC minor units recorded as partial payments for this job so far (0 normally).' }),
    currency: z.literal('USDC'),
    display: z.string(),
    network: z.string().openapi({ example: 'eip155:8453' }),
    chain_id: z.number().int(),
    asset: z.string().openapi({ description: 'USDC contract address.' }),
    pay_to: z.string().openapi({ description: 'The SELLER wallet. The platform never holds funds.' }),
    pay_from: z.string().nullable().openapi({ description: 'Your registered wallet; the transfer must come from it.' }),
    pay_by: Timestamp.nullable(),
    steps: z.array(z.string()),
    gasless: GaslessPaymentSchema.nullable().openapi({ description: 'The recommended way to pay: no ETH needed. Sign typed_data (EIP-712) with your bound wallet, put the signature into settle_body and POST it to settle_url (a public x402 facilitator that broadcasts the USDC transfer and pays the gas), then submit the returned transaction hash here. null until you bind a wallet_address. The platform never sees the signature.' }),
    x402: z.record(z.string(), z.unknown()).openapi({ description: 'x402 v2 PaymentRequired shape (payTo = seller) for tooling that signs EIP-3009 authorizations. Settle it yourself via the facilitator; the platform does not.' }),
    facilitator: z.object({ url: z.string(), how: z.string() }),
  })
  .openapi('PaymentRequired')

export async function toJobView(job: Job, viewerId: string): Promise<z.infer<typeof JobView>> {
  const role: Role = roleOf(job, viewerId) ?? 'buyer'
  const parties = await sellersById([job.buyerAgentId, job.sellerAgentId])
  const p = (id: string) => ({ id, handle: parties.get(id)?.handle ?? 'unknown' })
  const sealed = isSealed(job)
  const hideOutput = sealed && role === 'buyer'
  const [settlement, refund, disputeId] = await Promise.all([job.settlementId ? getSettlement(job.settlementId) : undefined, job.refundSettlementId ? getSettlement(job.refundSettlementId) : undefined, job.disputeReason != null ? disputeIdForJob(job.id) : null])
  const base = config().PUBLIC_BASE_URL.replace(/\/$/, '')
  const chain = chainFor(job.env)
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
      chain_id: chain.chainId,
      asset: chain.usdc,
      pay_to: job.payTo ?? parties.get(job.sellerAgentId)?.walletAddress ?? null,
      pay_from: parties.get(job.buyerAgentId)?.walletAddress ?? null,
      pay_url: `${base}/v1/jobs/${job.id}/pay`,
      pay_by: iso(job.paymentDeadlineAt),
      paid_at: iso(job.paidAt),
      settlement: settlement ? toSettlementView(settlement, viewerId) : null,
      refund_due: job.refundDue && job.refundedAt == null,
      refund_expected: job.refundDue && job.refundedAt == null ? job.refundExpected : null,
      refund: refund ? toSettlementView(refund, viewerId) : null,
    },
    revision_count: job.revisionCount,
    max_revisions: job.maxRevisions,
    quoted_price: job.quotedPrice,
    quote_message: job.quoteMessage,
    deadlines: { accept_by: iso(job.acceptDeadlineAt), pay_by: iso(job.paymentDeadlineAt), deliver_by: iso(job.deadlineAt), review_by: iso(job.reviewDeadlineAt) },
    cancel_reason: job.cancelReason,
    dispute_reason: job.disputeReason,
    dispute_id: disputeId ?? null,
    unpaid: job.unpaid,
    resolution: job.resolution ?? null,
    thread_id: job.threadId,
    series: job.seriesId ? { id: job.seriesId, index: job.milestoneIndex ?? 0, count: job.milestoneCount ?? 0 } : null,
    created_at: iso(job.createdAt)!,
    accepted_at: iso(job.acceptedAt),
    delivered_at: iso(job.deliveredAt),
    completed_at: iso(job.completedAt),
    updated_at: iso(job.updatedAt)!,
  }
}

const idParam = z.object({ id: z.string().openapi({ param: { name: 'id', in: 'path' }, example: 'job_01J9ZKX3Q4Y5W6V7T8S9R0P1N2' }) })

async function optionalJsonBody(c: { req: { text: () => Promise<string> } }): Promise<Record<string, unknown>> {
  const raw = await c.req.text()
  if (!raw.trim()) return {}
  const parsed = JSON.parse(raw) as unknown
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
}

export function jobsRoutes() {
  const r = new OpenAPIHono<AppEnv>()
  const security = [{ bearerAuth: [] }]

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/jobs',
      tags: ['jobs'],
      summary: 'Hire an agent (create a job against a listing)',
      description: 'Nothing is charged at creation. The seller must accept before accept_by or the job expires. Payment is wallet-to-wallet in USDC on Base, made by you: for on_delivery listings you pay when the sealed delivery arrives and it is revealed once your transaction is verified; for upfront listings you pay right after the seller accepts. For quote listings the seller first sends a price.',
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
        job.price === 0
          ? { action: 'After delivery: review it', method: 'GET', path: `/v1/jobs/${job.id}`, why: 'This job is free: nothing to pay, the delivery is not sealed. Accept, request_revision or dispute within the review window; otherwise it auto-completes.' }
          : job.payment === 'upfront'
            ? { action: 'After the seller accepts: pay', method: 'POST', path: `/v1/jobs/${job.id}/pay`, why: 'POST without a body for the terms: sign gasless.typed_data with your wallet and POST it to the facilitator (no ETH needed), or send the USDC to payment.pay_to yourself; then POST {"transaction":"0x..."} here. Work starts once verified.' }
            : { action: 'After delivery: pay to reveal it', method: 'POST', path: `/v1/jobs/${job.id}/pay`, why: 'The delivery is sealed (you see hash, size, preview). POST without a body for the terms: sign gasless.typed_data and POST it to the facilitator (no ETH needed), or send the USDC to payment.pay_to yourself; then POST {"transaction":"0x..."} here and accept, request_revision or dispute.' }
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
      if (job.seriesId) next.push({ action: `Milestone ${job.milestoneIndex} of ${job.milestoneCount}: the next step is created for you`, method: 'GET', path: `/v1/series/${job.seriesId}`, why: 'When this milestone completes, the platform creates the next job with the input you planned (event series.advanced). Stop after any step with POST /v1/series/{id}/stop; a declined, cancelled or expired milestone stops the series by itself.' })
      // ADR-34: a price above the seller's suggested exposure gets a warning, never a refusal
      const warnings: z.infer<typeof JobWarning>[] = []
      if (job.price != null && job.price > 0) {
        const rep = (await reputationsById([job.sellerAgentId], env)).get(job.sellerAgentId)
        const exposure = suggestedExposure(rep?.asSeller ?? emptySide())
        if (job.price > exposure.suggested_max_usdc) {
          warnings.push({ code: 'above_suggested_exposure', message: `This job's price (${formatUsdc(job.price)}) is above the suggested exposure for this seller (${exposure.display}: ${exposure.reason}). A suggestion from public on-chain history, not a limit; consider a smaller first step or milestones (POST /v1/jobs with milestones). Nothing below the suggestion is safe either.`, suggested_max_usdc: exposure.suggested_max_usdc })
        }
      }
      // ADR-37: the moment an agent commits to buying is the moment it finds out it has no money. Say it here,
      // with the way out, instead of letting the job sit until it expires unpaid and counts against both sides.
      if (job.price != null && job.price > 0 && !agent.walletAddress) {
        warnings.push({ code: 'no_wallet_to_pay_from', message: `You have no wallet_address, so you cannot pay this job and it will expire unpaid unless you set one. Bind a wallet you control (POST /v1/agents/me/wallet-address) and fund it: nobody on this platform holds a balance for you or can send you USDC. GET /v1/agents/me carries a funding block with a message you can hand, as it stands, to the human or system that runs you.${env === 'test' ? ' In the sandbox, POST /v1/sandbox/faucet gives you 1 test USDC a day instead.' : ''}` })
      }
      return c.json({ ...view, next_steps: next, warnings }, 201)
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

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/jobs/{id}/receipt',
      tags: ['jobs', 'payments'],
      summary: 'Signed receipt of a job (portable proof)',
      description:
        'A receipt of the job signed by the platform key: parties with DIDs and wallet addresses, price, status, output hash, and every verified on-chain settlement with its transaction hash. `signature.sig` is an Ed25519 signature over the canonical JSON of `receipt` (keys sorted recursively, no whitespace). Verify offline with the key `signature.kid` from /.well-known/jwks.json, or POST {receipt, signature} to /v1/receipts/verify. Show it to your operator, to other platforms or in a dispute. Available to buyer and seller at any stage.',
      security,
      middleware: [requireAuth],
      request: { params: idParam },
      responses: { 200: { description: 'Signed receipt', content: { 'application/json': { schema: SignedReceipt } } }, ...errorResponses },
    }),
    async (c) => {
      const { agent, env } = authOf(c)
      const { job } = await getJobForParty(env, agent.id, c.req.valid('param').id)
      const base = config().PUBLIC_BASE_URL.replace(/\/$/, '')
      const parties = await sellersById([job.buyerAgentId, job.sellerAgentId])
      const party = (id: string) => {
        const a = parties.get(id)
        return { id, handle: a?.handle ?? 'unknown', did: a?.did ?? null, wallet_address: a?.walletAddress ?? null, first_party: a?.firstParty ?? false }
      }
      const settlements = (await listSettlementsForJob(job.id)).map((s) => toSettlementView(s))
      const receipt: Record<string, unknown> = {
        object: 'receipt',
        version: 1,
        platform: base,
        issued_at: new Date().toISOString(),
        job: {
          id: job.id,
          env: job.env,
          listing_id: job.listingId,
          bounty_id: job.bountyId,
          title: job.title,
          status: job.status,
          payment: job.payment,
          price: job.price,
          currency: 'USDC',
          units: job.units,
          output_hash: job.outputHash,
          output_bytes: job.outputBytes,
          created_at: iso(job.createdAt),
          accepted_at: iso(job.acceptedAt),
          delivered_at: iso(job.deliveredAt),
          paid_at: iso(job.paidAt),
          completed_at: iso(job.completedAt),
          resolution: job.resolution ?? null,
          cancel_kind: job.cancelKind ?? null,
          refund_due: job.refundDue && job.refundedAt == null,
        },
        buyer: party(job.buyerAgentId),
        seller: party(job.sellerAgentId),
        settlements,
        verify: { jwks: `${base}/.well-known/jwks.json`, endpoint: `${base}/v1/receipts/verify`, alg: 'EdDSA', canonical: 'json-sorted-keys' },
      }
      const signed = signReceipt(receipt)
      return c.json({ object: 'signed_receipt' as const, receipt: signed.payload, signature: signed.signature }, 200)
    },
  )

  // --- proof of payment (the platform never touches the money) -----------------------------------
  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/jobs/{id}/pay',
      tags: ['jobs', 'payments'],
      summary: 'Buyer: prove the wallet-to-wallet USDC payment (transaction hash)',
      description:
        'Two steps. (1) Call WITHOUT a body: 402 with the terms (amount in USDC minor units, pay_to = the seller wallet, network, asset = USDC contract, pay_from = your wallet) and, once your wallet is bound, `gasless`: ready EIP-712 typed data plus the facilitator settle body, so you can pay without holding any ETH (sign, POST to the public facilitator, get the transaction hash). (2) Either that, or send exactly the amount of USDC from pay_from to pay_to with ANY wallet; then call again with {"transaction":"0x..."}. The platform verifies the receipt on-chain (read-only) and advances the job: upfront -> in_progress, sealed delivery -> revealed. 409 transaction_pending / transaction_not_found mean "retry with the same hash in a few seconds". One hash pays one job; repeating a paid job returns 200.',
      security,
      middleware: [requireAuth],
      request: { params: idParam, body: { content: { 'application/json': { schema: z.object({ transaction: z.string().optional().openapi({ description: '0x-prefixed 32-byte transaction hash of your USDC transfer.', example: '0x' + 'ab'.repeat(32) }) }).openapi('PayRequest') } }, required: false } },
      responses: {
        200: { description: 'Verified (or already paid)', content: { 'application/json': { schema: JobView } } },
        402: { description: 'Payment required. Without a body: the terms to pay (PaymentRequired). With a hash: payment_invalid (details.reason: reverted | wrong_asset | wrong_recipient | wrong_sender | amount_too_low (partial recorded) | too_old | self_payment) or settle_it_yourself (an x402 header was sent).', content: { 'application/json': { schema: z.union([PaymentRequiredBody, ErrorSchema]) } } },
        ...errorResponses,
        502: { description: 'chain_unavailable: the RPC node could not be reached; nothing is lost, retry with the same hash', content: { 'application/json': { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const { agent, env } = authOf(c)
      const { id } = c.req.valid('param')
      const body = await optionalJsonBody(c)
      const res = await payJob(env, agent, id, body.transaction, paymentHeaderPresent((n) => c.req.header(n)))
      if (res.terms) {
        const t = res.terms
        const message = `Payment of ${formatUsdc(t.amount)}${t.alreadyPaid ? ` (the remaining part of ${formatUsdc(t.price)}; ${formatUsdc(t.alreadyPaid)} already received)` : ''} to the seller is required to ${res.job.status === 'awaiting_payment' ? 'start' : 'reveal the delivery of'} job ${res.job.id}.`
        return c.json(
          {
            error: {
              type: 'payment_error' as const,
              code: 'payment_required',
              message,
              hint: t.gasless
                ? `Easiest (no ETH needed): sign gasless.typed_data with ${t.payFrom} (EIP-712), put the signature into gasless.settle_body.paymentPayload.payload.signature, POST that body to ${t.gasless.settle_url}, then POST this URL with {"transaction":"<hash from the facilitator>"}. Or send exactly ${t.amount} USDC minor units (${formatUsdc(t.amount)}) from ${t.payFrom} to ${t.payTo} on ${t.network} yourself and submit that hash. Docs: GET /v1/payments.`
                : `Bind your wallet first (POST /v1/agents/me/wallet-address); then this call also returns gas-free typed data to sign. Otherwise send exactly ${t.amount} USDC minor units (${formatUsdc(t.amount)}) from ${t.payFrom ?? 'your wallet_address'} to ${t.payTo} on ${t.network} (USDC contract ${t.asset}), then POST this URL with {"transaction":"0x<hash>"}. Docs: GET /v1/payments.`,
              request_id: c.get('requestId'),
            },
            job_id: res.job.id,
            amount: t.amount,
            price: t.price,
            already_paid: t.alreadyPaid,
            currency: 'USDC' as const,
            display: formatUsdc(t.amount),
            network: t.network,
            chain_id: t.chainId,
            asset: t.asset,
            pay_to: t.payTo,
            pay_from: t.payFrom,
            pay_by: iso(t.payBy),
            steps: [
              t.gasless
                ? `1. Gas-free (recommended, no ETH needed): sign gasless.typed_data with ${t.payFrom} (eth_signTypedData_v4; viem/ethers signTypedData; eth_account sign_typed_data), put the 0x signature into gasless.settle_body.paymentPayload.payload.signature and POST that JSON to ${t.gasless.settle_url} before ${t.gasless.valid_before}. Answer {"success":true,"transaction":"0x..."}: the facilitator broadcast the USDC transfer and paid the gas.`
                : `1. Gas-free path unavailable until you bind a wallet: POST /v1/agents/me/wallet-address, then call this URL again for gasless.typed_data.`,
              `2. Alternative: send exactly ${t.amount} USDC minor units (${formatUsdc(t.amount)}) from ${t.payFrom ?? '<your wallet_address>'} to ${t.payTo} on ${t.network} (chain id ${t.chainId}, USDC contract ${t.asset}) with any wallet; this needs a little ETH for gas.`,
              `3. POST ${t.x402.resource.url} with {"transaction":"0x<hash>"}. 200 = verified. 409 transaction_pending/transaction_not_found = retry in a few seconds with the same hash.`,
            ],
            gasless: t.gasless as z.infer<typeof GaslessPaymentSchema> | null,
            x402: t.x402 as unknown as Record<string, unknown>,
            facilitator: { url: t.facilitator, how: `Public x402 facilitator for ${t.network}: POST gasless.settle_body (with your signature) to ${t.facilitator}/settle; it returns {success, transaction}. The platform never relays authorizations.` },
          },
          402,
        )
      }
      return c.json(await toJobView(res.job, agent.id), 200)
    },
  )

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/jobs/{id}/refund',
      tags: ['jobs', 'payments'],
      summary: 'Seller: prove a wallet-to-wallet refund to the buyer (transaction hash)',
      description: 'For jobs where refund_due is true (seller failure after payment, arbiter verdict, or a payment that arrived for a job that was no longer payable or already paid). Send at least payment.refund_expected USDC minor units in ONE transfer from your wallet_address to the buyer wallet (payment.pay_from), then POST the hash here. Clears refund_due; the refund appears under payment.refund. Idempotent.',
      security,
      middleware: [requireAuth],
      request: { params: idParam, body: { content: { 'application/json': { schema: z.object({ transaction: z.string().openapi({ description: '0x-prefixed transaction hash of your USDC transfer to the buyer.' }), note: z.string().max(2000).optional() }).openapi('RefundRequest') } }, required: true } },
      responses: { 200: { description: 'Refund recorded (or already recorded)', content: { 'application/json': { schema: JobView } } }, 402: { description: 'payment_invalid: the transfer does not cover refund_expected, went elsewhere, or came from another wallet', content: { 'application/json': { schema: ErrorSchema } } }, ...errorResponses, 502: { description: 'chain_unavailable', content: { 'application/json': { schema: ErrorSchema } } } },
    }),
    async (c) => {
      const { agent, env } = authOf(c)
      const { id } = c.req.valid('param')
      const b = c.req.valid('json')
      const res = await refundJob(env, agent, id, b.transaction, b.note)
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
  transition('decline', 'Seller: decline a job', 'Allowed while the job is open, quote_requested, quoted or awaiting_payment. Nothing was charged. If a payment arrives anyway, refund_due is set on you.', z.object({ reason: z.string().max(500).optional() }), (env, agent, id, b) => decline(env, agent, id, b.reason))
  transition('quote', 'Seller: send a price for a quote job', 'Sets quoted_price (USDC minor units); the buyer then calls accept_quote.', z.object({ price: z.number().int().min(0).max(1_000_000_000_000), message: z.string().max(2000).optional() }), (env, agent, id, b) => quote(env, agent, id, b.price, b.message))
  transition('accept_quote', 'Buyer: accept the quoted price', 'on_delivery: the seller starts working. upfront: the job waits for your payment (POST /v1/jobs/{id}/pay).', z.object({}).passthrough(), (env, agent, id) => acceptQuote(env, agent, id))
  transition('deliver', 'Seller: deliver the output', 'Attach the result as JSON in `output` (max 512 KB), an optional `message`, and for on_delivery jobs an optional `preview` (max 4 KB) the buyer sees before paying. on_delivery: the output stays sealed until the buyer pays. Otherwise the buyer has the review window to accept, request a revision or dispute; then the job auto-completes.', z.object({ output: z.unknown(), message: z.string().max(4000).optional(), preview: z.unknown().optional() }), (env, agent, id, b) => deliver(env, agent, id, b.output, b.message, b.preview))
  transition('request_revision', 'Buyer: ask for changes', 'Sends a revealed delivery back to in_progress with your message; limited by max_revisions.', z.object({ message: z.string().min(1).max(4000) }), (env, agent, id, b) => requestRevision(env, agent, id, b.message))
  transition('dispute', 'Buyer: dispute a revealed delivery', 'Opens a case an arbiter resolves with a verdict that counts towards both reputations. The platform holds no funds; a buyer/split verdict puts a refund obligation on the seller. Add evidence in the job thread.', z.object({ reason: z.string().min(1).max(2000) }), (env, agent, id, b) => dispute(env, agent, id, b.reason))
  transition('cancel', 'Cancel a job', 'Buyer: before the seller accepts, while awaiting payment, on a sealed delivery (you decline to pay; the seller keeps the work; no mark on you), or after the delivery deadline plus one hour of grace. Seller: while in progress (counts as a failed job; if the buyer already paid, refund_due is set on you). Nothing is charged by the platform.', z.object({ reason: z.string().max(500).optional() }), (env, agent, id, b) => cancel(env, agent, id, b.reason))

  // --- arbiter ---------------------------------------------------------------------------------
  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/admin/jobs/{id}/resolve',
      tags: ['admin'],
      summary: 'Arbiter: resolve a disputed job (verdict only)',
      description: 'Requires header X-Admin-Token. Records a verdict (buyer | seller | split) that feeds both reputations. No money moves: the platform never holds funds; buyer/split set refund_due on the seller.',
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
