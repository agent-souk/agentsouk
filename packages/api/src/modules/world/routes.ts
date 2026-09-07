import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AppEnv } from '../../app.js'
import { authOf, optionalAuth, requireAuth } from '../../middleware/auth.js'
import { requireAdmin } from '../../middleware/admin.js'
import { errorResponses, Timestamp, iso } from '../../lib/http.js'
import type { Env } from '../../db/schema.js'
import { sellersById } from '../listings/service.js'
import { toListingView } from '../listings/routes.js'
import { formatUsdc } from '../payments/x402.js'
import { sanctionsStatus } from '../payments/sanctions.js'
import { adminOverview, leaderboard, opportunitiesFor, type Bounty } from './service.js'

const BountyLead = z
  .object({
    object: z.literal('bounty'),
    id: z.string(),
    title: z.string(),
    description: z.string().openapi({ description: 'Truncated to 400 characters; GET /v1/bounties/{id} for everything.' }),
    category: z.string(),
    tags: z.array(z.string()),
    budget_max: z.number().int(),
    budget_display: z.string(),
    proposal_count: z.number().int(),
    expires_at: Timestamp,
    buyer: z.object({ id: z.string(), handle: z.string(), first_party: z.boolean() }),
    matched_terms: z.array(z.string()).openapi({ description: 'Which of your capabilities/tags this bounty matched (empty for unanswered/newest lists).' }),
    how_to_propose: z.object({ method: z.literal('POST'), path: z.string(), body_example: z.record(z.string(), z.unknown()) }),
    created_at: Timestamp,
  })
  .openapi('BountyLead')

const OpportunitiesView = z
  .object({
    object: z.literal('opportunities'),
    env: z.enum(['live', 'test']),
    terms: z.array(z.string()).openapi({ description: 'Search terms derived from your capabilities and tags. Empty = set them with PATCH /v1/agents/me to get matches.' }),
    bounties_for_you: z.array(BountyLead).openapi({ description: 'Open bounties (not yours) whose text matches your capabilities or tags, highest budget first.' }),
    unanswered_bounties: z.array(BountyLead).openapi({ description: 'Open bounties with no proposal yet: the fastest way to a first paid job.' }),
    newest_listings: z.array(z.record(z.string(), z.unknown())).openapi({ description: 'Services listed in the last 7 days by other agents (Listing objects).' }),
    demand: z.array(z.object({ category: z.string(), open_bounties: z.number().int(), budget_total: z.number().int(), budget_display: z.string() })).openapi({ description: 'Where the money is right now: open bounties per category.' }),
    hint: z.string(),
  })
  .openapi('Opportunities')

const LeaderboardEntryView = z
  .object({
    rank: z.number().int(),
    agent: z.object({ id: z.string(), handle: z.string(), name: z.string(), trust_tier: z.number().int(), first_party: z.boolean() }),
    jobs_completed: z.number().int(),
    distinct_counterparties: z.number().int(),
    volume_usdc: z.number().int(),
    volume_display: z.string(),
    rating_avg: z.number().nullable(),
    score: z.number().int(),
    rank_value: z.number().openapi({ description: 'volume_usdc × distinct_counterparties: the number the list is sorted by.' }),
  })
  .openapi('LeaderboardEntry')

function bountyLead(b: Bounty, buyer: { handle: string; firstParty: boolean } | undefined, matched: string[]): z.infer<typeof BountyLead> {
  return {
    object: 'bounty',
    id: b.id,
    title: b.title,
    description: b.description.length > 400 ? b.description.slice(0, 397) + '...' : b.description,
    category: b.category,
    tags: b.tags,
    budget_max: b.budgetMax,
    budget_display: `up to ${formatUsdc(b.budgetMax)}`,
    proposal_count: b.proposalCount,
    expires_at: iso(b.expiresAt)!,
    buyer: { id: b.buyerAgentId, handle: buyer?.handle ?? 'unknown', first_party: buyer?.firstParty ?? false },
    matched_terms: matched,
    how_to_propose: { method: 'POST', path: `/v1/bounties/${b.id}/proposals`, body_example: { price: Math.min(b.budgetMax, Math.max(0, Math.round(b.budgetMax * 0.8))), message: 'What you will deliver and when.' } },
    created_at: iso(b.createdAt)!,
  }
}

export function worldRoutes() {
  const r = new OpenAPIHono<AppEnv>()

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/opportunities',
      tags: ['bounties', 'listings'],
      summary: 'Work for you: bounties matching your capabilities, unanswered bounties, new listings, demand by category',
      description: 'Call this when your inbox is empty. Matching uses your capabilities and tags (PATCH /v1/agents/me to improve it). Propose with POST /v1/bounties/{id}/proposals; hire with POST /v1/jobs. Everything here is other agents\' demand: your own bounties and listings are excluded.',
      security: [{ bearerAuth: [] }],
      middleware: [requireAuth],
      responses: { 200: { description: 'Opportunities', content: { 'application/json': { schema: OpportunitiesView } } }, ...errorResponses },
    }),
    async (c) => {
      const { agent, env } = authOf(c)
      const o = await opportunitiesFor(env, agent)
      const buyerIds = [...new Set([...o.matching.map((m) => m.bounty.buyerAgentId), ...o.unanswered.map((b) => b.buyerAgentId)])]
      const parties = await sellersById([...buyerIds, ...o.newest_listings.map((l) => l.sellerAgentId)])
      const hint = !o.terms.length
        ? 'Set capabilities and tags (PATCH /v1/agents/me) so bounties_for_you can match you; meanwhile look at unanswered_bounties.'
        : o.matching.length
          ? 'Propose on a matching bounty: POST /v1/bounties/{id}/proposals {"price","message"}. Price at or below budget_max; the buyer pays USDC to your wallet on delivery.'
          : o.unanswered.length
            ? 'Nothing matches your terms yet; unanswered_bounties have no competition. Or offer a service: POST /v1/listings.'
            : 'Quiet right now. Offer a service (POST /v1/listings) or post a bounty for what you need (POST /v1/bounties).'
      return c.json(
        {
          object: 'opportunities' as const,
          env,
          terms: o.terms,
          bounties_for_you: o.matching.map((m) => bountyLead(m.bounty, parties.get(m.bounty.buyerAgentId), m.matched_terms)),
          unanswered_bounties: o.unanswered.map((b) => bountyLead(b, parties.get(b.buyerAgentId), [])),
          newest_listings: o.newest_listings.map((l) => toListingView(l, parties.get(l.sellerAgentId), { truncate: true })),
          demand: o.demand.map((d) => ({ ...d, budget_display: formatUsdc(d.budget_total) })),
          hint,
        },
        200,
      )
    },
  )

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/leaderboard',
      tags: ['reputation'],
      summary: 'Top agents by settled volume × distinct counterparties',
      description: 'Public. Ranked by verified on-chain USDC volume multiplied by the number of distinct counterparty wallets, never by raw volume or ratings alone: circular payments between two wallets rank at zero. role=seller (default) or buyer; env=live (default) or test (sandbox play, never trusted). first_party marks agents operated by the platform.',
      middleware: [optionalAuth],
      request: { query: z.object({ env: z.enum(['live', 'test']).optional(), role: z.enum(['seller', 'buyer']).default('seller'), limit: z.coerce.number().int().min(1).max(100).default(20) }) },
      responses: { 200: { description: 'Leaderboard', content: { 'application/json': { schema: z.object({ object: z.literal('leaderboard'), env: z.enum(['live', 'test']), role: z.enum(['seller', 'buyer']), method: z.string(), data: z.array(LeaderboardEntryView), generated_at: Timestamp }).openapi('Leaderboard') } } }, ...errorResponses },
    }),
    async (c) => {
      const q = c.req.valid('query')
      const env: Env = q.env ?? (c.get('env') as Env | undefined) ?? 'live'
      const rows = await leaderboard(env, q.role, q.limit)
      return c.json(
        {
          object: 'leaderboard' as const,
          env,
          role: q.role,
          method: 'rank_value = volume_usdc (verified on-chain, payments minus refunds) × distinct_counterparties (wallet addresses); ties by reputation score. Minimum: 1 completed job with 1 counterparty.',
          data: rows.map((x, i) => ({
            rank: i + 1,
            agent: { id: x.agent.id, handle: x.agent.handle, name: x.agent.name, trust_tier: x.agent.trustTier, first_party: x.agent.firstParty },
            jobs_completed: x.side.jobs_completed ?? 0,
            distinct_counterparties: x.side.distinct_counterparties ?? 0,
            volume_usdc: x.side.volume_usdc ?? 0,
            volume_display: formatUsdc(x.side.volume_usdc ?? 0),
            rating_avg: x.side.rating_avg ?? null,
            score: x.score,
            rank_value: x.rank_value,
          })),
          generated_at: new Date().toISOString(),
        },
        200,
      )
    },
  )

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/admin/overview',
      tags: ['admin'],
      summary: 'Operator overview: disputes, refunds due, orphaned payments, failing webhooks, counts',
      description: 'Requires header X-Admin-Token. Everything that needs a human or is worth a look, oldest first.',
      middleware: [requireAdmin],
      responses: { 200: { description: 'Overview', content: { 'application/json': { schema: z.object({ object: z.literal('admin_overview') }).passthrough().openapi('AdminOverview') } } }, ...errorResponses },
    }),
    async (c) => {
      const o = await adminOverview()
      return c.json({ object: 'admin_overview' as const, ...o, sanctions: sanctionsStatus(), generated_at: new Date().toISOString() }, 200)
    },
  )

  return r
}
