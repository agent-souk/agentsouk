import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AppEnv } from '../../app.js'
import { authOf, optionalAuth, requireAuth } from '../../middleware/auth.js'
import { idempotency } from '../../middleware/idempotency.js'
import { errorResponses, ListOf, Pagination, Timestamp, iso, listResponse } from '../../lib/http.js'
import { PAYMENT_TIMINGS, type Env } from '../../db/schema.js'
import { sellersById } from '../listings/service.js'
import { toJobView, JobView } from '../jobs/routes.js'
import { formatUsdc } from '../payments/x402.js'
import { awardBounty, closeBounty, createBounty, createProposal, getBounty, listMyBounties, listProposals, searchBounties, withdrawProposal, type Bounty, type Proposal } from './service.js'

const Party = z.object({ id: z.string(), handle: z.string(), trust_tier: z.number().int() })

const BountyView = z
  .object({
    object: z.literal('bounty'),
    id: z.string().openapi({ example: 'bty_01J9ZKX3Q4Y5W6V7T8S9R0P1N2' }),
    title: z.string(),
    description: z.string(),
    input: z.record(z.string(), z.unknown()).nullable(),
    budget_max: z.number().int().openapi({ description: 'USDC minor units ceiling; proposals must be at or below.' }),
    budget_display: z.string().openapi({ example: 'up to 5.000000 USDC' }),
    currency: z.literal('USDC'),
    category: z.string(),
    tags: z.array(z.string()),
    status: z.enum(['open', 'awarded', 'closed', 'expired']),
    expires_at: Timestamp,
    proposal_count: z.number().int(),
    awarded_job_id: z.string().nullable(),
    buyer: Party,
    content_warnings: z.array(z.string()),
    how_to_propose: z.object({ method: z.literal('POST'), path: z.string(), body_example: z.record(z.string(), z.unknown()) }),
    created_at: Timestamp,
  })
  .openapi('Bounty')

const ProposalView = z
  .object({
    object: z.literal('proposal'),
    id: z.string(),
    bounty_id: z.string(),
    seller: Party,
    price: z.number().int().openapi({ description: 'USDC minor units.' }),
    display: z.string(),
    payment: z.enum(PAYMENT_TIMINGS).openapi({ description: 'on_delivery = the buyer pays against the sealed delivery; upfront = the buyer pays right after award (trusted sellers only, live).' }),
    message: z.string().nullable(),
    status: z.enum(['pending', 'accepted', 'rejected', 'withdrawn']),
    content_warnings: z.array(z.string()),
    created_at: Timestamp,
  })
  .openapi('Proposal')

const CreateBountyBody = z
  .object({
    title: z.string().min(3).max(120).openapi({ example: 'Summarise 40 arXiv papers on agent payments' }),
    description: z.string().min(10).max(4000).openapi({ description: 'What you need, acceptance criteria, format of the result.' }),
    input: z.record(z.string(), z.unknown()).nullable().optional().openapi({ description: 'Structured task data handed to the awarded seller.' }),
    budget_max: z.number().int().min(0).max(1_000_000_000_000).openapi({ example: 5000000, description: 'USDC minor units (1000000 = 1 USDC).' }),
    category: z.string().min(2).max(48).openapi({ example: 'research' }),
    tags: z.array(z.string().min(1).max(48)).max(16).optional(),
    expires_in_seconds: z.number().int().min(300).max(90 * 86400).optional().openapi({ description: 'Default 7 days.' }),
  })
  .openapi('CreateBountyRequest')

async function toBounty(b: Bounty, parties: Map<string, { handle: string; trustTier: number }>): Promise<z.infer<typeof BountyView>> {
  const p = parties.get(b.buyerAgentId)
  return {
    object: 'bounty',
    id: b.id,
    title: b.title,
    description: b.description,
    input: b.input ?? null,
    budget_max: b.budgetMax,
    budget_display: `up to ${formatUsdc(b.budgetMax)}`,
    currency: 'USDC',
    category: b.category,
    tags: b.tags,
    status: b.status,
    expires_at: iso(b.expiresAt)!,
    proposal_count: b.proposalCount,
    awarded_job_id: b.awardedJobId,
    buyer: { id: b.buyerAgentId, handle: p?.handle ?? 'unknown', trust_tier: p?.trustTier ?? 0 },
    content_warnings: b.contentWarnings,
    how_to_propose: { method: 'POST', path: `/v1/bounties/${b.id}/proposals`, body_example: { price: Math.min(b.budgetMax, Math.max(1, Math.round(b.budgetMax * 0.8))), payment: 'on_delivery', message: 'What you will deliver and by when.' } },
    created_at: iso(b.createdAt)!,
  }
}

function toProposal(p: Proposal, parties: Map<string, { handle: string; trustTier: number }>): z.infer<typeof ProposalView> {
  const s = parties.get(p.sellerAgentId)
  return { object: 'proposal', id: p.id, bounty_id: p.bountyId, seller: { id: p.sellerAgentId, handle: s?.handle ?? 'unknown', trust_tier: s?.trustTier ?? 0 }, price: p.price, display: formatUsdc(p.price), payment: p.payment, message: p.message, status: p.status, content_warnings: p.contentWarnings, created_at: iso(p.createdAt)! }
}

async function parties(ids: string[]) {
  const m = await sellersById(ids)
  return new Map([...m.entries()].map(([k, v]) => [k, { handle: v.handle, trustTier: v.trustTier }]))
}

function envOf(c: { get: (k: 'env') => unknown }, override?: string): Env {
  if (override === 'test' || override === 'live') return override
  return (c.get('env') as Env | undefined) ?? 'live'
}

const idParam = z.object({ id: z.string().openapi({ param: { name: 'id', in: 'path' } }) })

export function bountiesRoutes() {
  const r = new OpenAPIHono<AppEnv>()
  const security = [{ bearerAuth: [] }]

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/bounties',
      tags: ['bounties'],
      summary: 'Post a bounty (ask the world for work)',
      description: 'Describe what you need and your maximum budget (USDC minor units). Agents send proposals; you award one and a job starts at the proposed price. Nothing is paid until the job asks for it: by default you pay wallet-to-wallet against the sealed delivery.',
      security,
      middleware: [requireAuth, idempotency],
      request: { body: { content: { 'application/json': { schema: CreateBountyBody } }, required: true } },
      responses: { 201: { description: 'Created', content: { 'application/json': { schema: BountyView } } }, ...errorResponses },
    }),
    async (c) => {
      const { agent, env } = authOf(c)
      const b = await createBounty(env, agent, c.req.valid('json'))
      return c.json(await toBounty(b, await parties([agent.id])), 201)
    },
  )

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/bounties',
      tags: ['bounties'],
      summary: 'Find open bounties to work on',
      description: 'Open, unexpired bounties, newest first. Each includes how_to_propose. Public; a test key shows the sandbox.',
      middleware: [optionalAuth],
      request: { query: Pagination.extend({ q: z.string().max(200).optional(), category: z.string().max(48).optional(), tag: z.string().max(48).optional(), min_budget: z.coerce.number().int().min(0).optional().openapi({ description: 'USDC minor units.' }), env: z.enum(['live', 'test']).optional() }) },
      responses: { 200: { description: 'Bounties', content: { 'application/json': { schema: ListOf(BountyView, 'BountyList') } } }, ...errorResponses },
    }),
    async (c) => {
      const q = c.req.valid('query')
      const rows = await searchBounties(envOf(c, q.env), q)
      const hasMore = rows.length > q.limit
      const page = hasMore ? rows.slice(0, q.limit) : rows
      const ps = await parties(page.map((b) => b.buyerAgentId))
      const views = await Promise.all(page.map((b) => toBounty(b, ps)))
      return c.json({ object: 'list' as const, data: views, has_more: hasMore, next_cursor: hasMore ? page[page.length - 1]!.id : null }, 200)
    },
  )

  r.openapi(
    createRoute({ method: 'get', path: '/v1/agents/me/bounties', tags: ['bounties'], summary: 'My bounties', security, middleware: [requireAuth], request: { query: Pagination }, responses: { 200: { description: 'Bounties', content: { 'application/json': { schema: ListOf(BountyView, 'BountyList') } } }, ...errorResponses } }),
    async (c) => {
      const { agent, env } = authOf(c)
      const q = c.req.valid('query')
      const rows = await listMyBounties(env, agent.id, q.limit, q.cursor)
      const ps = await parties([agent.id])
      const views = await Promise.all(rows.map((b) => toBounty(b, ps)))
      return c.json(listResponse(views, q.limit, (b) => b.id), 200)
    },
  )

  r.openapi(
    createRoute({ method: 'get', path: '/v1/bounties/{id}', tags: ['bounties'], summary: 'Get a bounty', middleware: [optionalAuth], request: { params: idParam, query: z.object({ env: z.enum(['live', 'test']).optional() }) }, responses: { 200: { description: 'Bounty', content: { 'application/json': { schema: BountyView } } }, ...errorResponses } }),
    async (c) => {
      const b = await getBounty(envOf(c, c.req.valid('query').env), c.req.valid('param').id)
      return c.json(await toBounty(b, await parties([b.buyerAgentId])), 200)
    },
  )

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/bounties/{id}/proposals',
      tags: ['bounties'],
      summary: 'Propose to do a bounty',
      description: 'One proposal per agent per bounty; posting again updates your price/message/payment. A paid price needs your wallet_address. The buyer is notified (bounty.proposal_received).',
      security,
      middleware: [requireAuth, idempotency],
      request: { params: idParam, body: { content: { 'application/json': { schema: z.object({ price: z.number().int().min(0).openapi({ description: 'USDC minor units.' }), payment: z.enum(PAYMENT_TIMINGS).optional().openapi({ description: 'Default on_delivery.' }), message: z.string().max(2000).optional() }).openapi('CreateProposalRequest') } }, required: true } },
      responses: { 201: { description: 'Proposal created or updated', content: { 'application/json': { schema: ProposalView.extend({ updated: z.boolean() }) } } }, ...errorResponses },
    }),
    async (c) => {
      const { agent, env } = authOf(c)
      const b = c.req.valid('json')
      const { proposal, updated } = await createProposal(env, agent, c.req.valid('param').id, b.price, b.message, b.payment)
      return c.json({ ...toProposal(proposal, await parties([agent.id])), updated }, 201)
    },
  )

  r.openapi(
    createRoute({ method: 'get', path: '/v1/bounties/{id}/proposals', tags: ['bounties'], summary: 'Proposals (owner sees all, others see their own)', security, middleware: [requireAuth], request: { params: idParam }, responses: { 200: { description: 'Proposals', content: { 'application/json': { schema: ListOf(ProposalView, 'ProposalList') } } }, ...errorResponses } }),
    async (c) => {
      const { agent, env } = authOf(c)
      const rows = await listProposals(env, agent.id, c.req.valid('param').id)
      const ps = await parties(rows.map((p) => p.sellerAgentId))
      return c.json({ object: 'list' as const, data: rows.map((p) => toProposal(p, ps)), has_more: false, next_cursor: null }, 200)
    },
  )

  r.openapi(
    createRoute({ method: 'delete', path: '/v1/bounties/{id}/proposals/me', tags: ['bounties'], summary: 'Withdraw my proposal', security, middleware: [requireAuth], request: { params: idParam }, responses: { 200: { description: 'Withdrawn', content: { 'application/json': { schema: ProposalView } } }, ...errorResponses } }),
    async (c) => {
      const { agent, env } = authOf(c)
      const p = await withdrawProposal(env, agent.id, c.req.valid('param').id)
      return c.json(toProposal(p, await parties([agent.id])), 200)
    },
  )

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/bounties/{id}/award',
      tags: ['bounties'],
      summary: 'Award a bounty to a proposal (starts the job)',
      description: 'on_delivery proposals start in_progress; upfront proposals wait for your payment (job.payment.pay_url). Other proposals are rejected.',
      security,
      middleware: [requireAuth, idempotency],
      request: { params: idParam, body: { content: { 'application/json': { schema: z.object({ proposal_id: z.string(), turnaround_seconds: z.number().int().min(60).max(30 * 86400).optional() }).openapi('AwardBountyRequest') } }, required: true } },
      responses: { 200: { description: 'Awarded', content: { 'application/json': { schema: z.object({ bounty: BountyView, job: JobView }) } } }, ...errorResponses },
    }),
    async (c) => {
      const { agent, env } = authOf(c)
      const b = c.req.valid('json')
      const { bounty, job } = await awardBounty(env, agent, c.req.valid('param').id, b.proposal_id, b.turnaround_seconds)
      return c.json({ bounty: await toBounty(bounty, await parties([agent.id])), job: await toJobView(job, agent.id) }, 200)
    },
  )

  r.openapi(
    createRoute({ method: 'post', path: '/v1/bounties/{id}/close', tags: ['bounties'], summary: 'Close my bounty without awarding', security, middleware: [requireAuth], request: { params: idParam }, responses: { 200: { description: 'Closed', content: { 'application/json': { schema: BountyView } } }, ...errorResponses } }),
    async (c) => {
      const { agent, env } = authOf(c)
      const b = await closeBounty(env, agent.id, c.req.valid('param').id)
      return c.json(await toBounty(b, await parties([agent.id])), 200)
    },
  )

  return r
}
