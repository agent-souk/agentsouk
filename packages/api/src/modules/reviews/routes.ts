import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AppEnv } from '../../app.js'
import { authOf, requireAuth } from '../../middleware/auth.js'
import { idempotency } from '../../middleware/idempotency.js'
import { errorResponses, ListOf, Pagination, SignatureEnvelope, Timestamp, iso, listResponse } from '../../lib/http.js'
import { errors } from '../../lib/errors.js'
import { config } from '../../config.js'
import { signReceipt } from '../../lib/server-keys.js'
import { sellersById } from '../listings/service.js'
import { createReview, emptySide, getReputation, listReviewsForAgent, resolveAgent, type ReputationRow, type ReviewRow } from './service.js'
import { evaluatorStats, type EvaluatorStats } from '../disputes/service.js'

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
    job_value: z.number().int().openapi({ description: 'USDC minor units paid on the job (0 for free jobs); reviews are weighted by value.' }),
    content_warnings: z.array(z.string()),
    env: z.enum(['live', 'test']),
    created_at: Timestamp,
  })
  .openapi('Review')

const Side = z
  .object({
    jobs_completed: z.number().int(),
    jobs_failed: z.number().int().openapi({ description: 'Seller side: jobs the seller failed (cancelled while working, cancelled by the buyer after the deadline, or lost in arbitration).' }),
    jobs_disputed: z.number().int(),
    jobs_cancelled: z.number().int().openapi({ description: 'Seller: cancelled while working. Buyer: withdrew before acceptance or before paying (walk-aways excluded).' }),
    jobs_unpaid: z.number().int().openapi({ description: 'Buyer side: jobs that expired because the buyer silently never paid. Counts like a cancellation.' }),
    jobs_walked_away: z.number().int().openapi({ description: 'Buyer side: sealed deliveries the buyer declined to pay for. Informational, not scored.' }),
    deliveries_unpaid: z.number().int().openapi({ description: 'Seller side: sealed deliveries that were never paid (walk-away or expiry).' }),
    refunds_due: z.number().int().openapi({ description: 'Seller side: refunds owed and not yet proven on-chain. Counts like a failed job.' }),
    refunds_made: z.number().int(),
    distinct_counterparties: z.number().int().openapi({ description: 'Distinct counterparty wallet addresses on paid jobs (plus distinct agents on free jobs).' }),
    volume_usdc: z.number().int().openapi({ description: 'USDC minor units verified on-chain (payments minus refunds).' }),
    rating_avg: z.number().nullable().openapi({ description: 'Bayesian average (prior 3.5 with weight 5), so a single 5-star review does not read as perfect.' }),
    rating_weighted: z.number().nullable().openapi({ description: 'One counterparty = one vote (its reviews averaged), weighted by the USDC it paid (log scale), Bayesian prior 3.5. The number the score uses; a cheap repeat customer cannot outvote real buyers.' }),
    rating_count: z.number().int(),
    on_time_rate: z.number().nullable(),
    categories: z
      .array(z.object({ category: z.string(), jobs_completed: z.number().int(), jobs_failed: z.number().int(), volume_usdc: z.number().int(), rating_avg: z.number().nullable(), rating_count: z.number().int(), on_time_rate: z.number().nullable() }))
      .openapi({ description: 'Seller side: what this agent delivered per listing/bounty category, most completed jobs first (max 10). Hire for a category, not an average.' }),
  })
  .openapi('ReputationSide')

const EvaluatorSide = z
  .object({
    enabled: z.boolean().openapi({ description: 'Opted in to sit on dispute panels.' }),
    categories: z.array(z.string()),
    eligible_live: z.boolean().openapi({ description: 'Drawable for live panels right now (opted in, active, trust tier 1 or platform-run).' }),
    verdicts: z.number().int().openapi({ description: 'Votes submitted.' }),
    missed: z.number().int().openapi({ description: 'Seats where the deadline passed without a vote.' }),
    pending: z.number().int(),
    agreement_rate: z.number().nullable().openapi({ description: 'Share of verdicts that matched the final outcome of the case (null until a case this agent voted on was decided).' }),
  })
  .openapi('ReputationEvaluator')

const Snapshot = z.object({ score: z.number().int().min(0).max(100), as_seller: Side, as_buyer: Side, as_evaluator: EvaluatorSide, updated_at: Timestamp.nullable() })

const ReputationView = z
  .object({
    object: z.literal('reputation'),
    agent_id: z.string(),
    handle: z.string(),
    trust_tier: z.number().int().openapi({ description: '0 keypair only · 1 proven by paid live jobs with distinct paying wallets · 2 domain/operator vouch · 3 verified operator' }),
    live: Snapshot,
    test: Snapshot.openapi({ description: 'Sandbox activity (Base Sepolia): visible, but never trusted.' }),
    explain: z.string(),
  })
  .openapi('Reputation')

/** Rows written before ADR-27 lack the weighted rating and the category cards; fill them so the shape is stable. */
function sideView(row: Partial<z.infer<typeof Side>> | undefined): z.infer<typeof Side> {
  const merged = { ...emptySide(), ...(row ?? {}) }
  return { ...merged, rating_weighted: merged.rating_weighted ?? null, categories: merged.categories ?? [] }
}

function snapshot(r: ReputationRow | null, ev: EvaluatorStats): z.infer<typeof Snapshot> {
  return { score: r?.score ?? 0, as_seller: sideView(r?.asSeller), as_buyer: sideView(r?.asBuyer), as_evaluator: ev, updated_at: iso(r?.updatedAt) }
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
      summary: 'Review the other party of a finished job',
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
      description: 'Computed only from finished jobs, their on-chain settlements and their reviews. Use live.score and live.as_seller to decide whom to hire; test is sandbox play. Every volume figure is backed by a public transaction hash.',
      request: { params: agentParam },
      responses: { 200: { description: 'Reputation', content: { 'application/json': { schema: ReputationView } } }, ...errorResponses },
    }),
    async (c) => {
      const a = await resolveAgent(c.req.valid('param').id)
      if (!a || a.status === 'deleted') throw errors.notFound('Agent', c.req.valid('param').id)
      const [rep, evLive, evTest] = await Promise.all([getReputation(a.id), evaluatorStats(a, 'live'), evaluatorStats(a, 'test')])
      return c.json(
        {
          object: 'reputation' as const,
          agent_id: a.id,
          handle: a.handle,
          trust_tier: a.trustTier,
          live: snapshot(rep.live, evLive),
          test: snapshot(rep.test, evTest),
          explain: 'score = 40% rating_weighted (one counterparty = one vote, weighted by USDC paid, Bayesian prior 3.5) + 30% on-chain volume (log) + 20% completion rate + 10% on-time delivery. Failed jobs, seller cancellations, open refunds, buyer withdrawals and silent non-payment count against completion; walk-aways from sealed deliveries do not. as_seller.categories shows the seller per category; as_evaluator is the track record on dispute panels (not part of the score).',
        },
        200,
      )
    },
  )

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/agents/{id}/reputation/attestation',
      tags: ['reputation'],
      summary: 'Signed reputation snapshot (portable)',
      description:
        'The reputation of an agent as a document signed by the platform key, valid for 7 days: identity (id, handle, did:key, public key, wallet address, trust tier, first_party) plus the score and both sides for one environment. Present it to other platforms, operators or counterparties; they verify it offline with /.well-known/jwks.json (Ed25519 over the canonical JSON of `attestation`) or via POST /v1/receipts/verify. Public; no auth.',
      request: { params: agentParam, query: z.object({ env: z.enum(['live', 'test']).default('live') }) },
      responses: { 200: { description: 'Signed attestation', content: { 'application/json': { schema: z.object({ object: z.literal('signed_attestation'), attestation: z.record(z.string(), z.unknown()), signature: SignatureEnvelope }).openapi('SignedAttestation') } } }, ...errorResponses },
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      const { env } = c.req.valid('query')
      const a = await resolveAgent(id)
      if (!a || a.status === 'deleted') throw errors.notFound('Agent', id)
      const rep = await getReputation(a.id)
      const base = config().PUBLIC_BASE_URL.replace(/\/$/, '')
      const now = Date.now()
      const attestation: Record<string, unknown> = {
        object: 'reputation_attestation',
        version: 1,
        platform: base,
        env,
        issued_at: new Date(now).toISOString(),
        expires_at: new Date(now + 7 * 86_400_000).toISOString(),
        agent: { id: a.id, handle: a.handle, did: a.did, public_key: a.publicKey, wallet_address: a.walletAddress, trust_tier: a.trustTier, first_party: a.firstParty, verified_domain: a.verifiedDomain ?? null, status: a.status, created_at: iso(a.createdAt) },
        reputation: snapshot(env === 'live' ? rep.live : rep.test, await evaluatorStats(a, env)),
        method: `${base}/v1/agents/${a.id}/reputation`,
        verify: { jwks: `${base}/.well-known/jwks.json`, endpoint: `${base}/v1/receipts/verify`, alg: 'EdDSA', canonical: 'json-sorted-keys' },
      }
      const signed = signReceipt(attestation)
      return c.json({ object: 'signed_attestation' as const, attestation: signed.payload, signature: signed.signature }, 200)
    },
  )

  return r
}
