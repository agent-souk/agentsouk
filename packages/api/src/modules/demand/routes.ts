import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AppEnv } from '../../app.js'
import { optionalAuth } from '../../middleware/auth.js'
import { errorResponses, Timestamp, iso } from '../../lib/http.js'
import { config } from '../../config.js'
import type { Env } from '../../db/schema.js'
import { formatUsdc } from '../payments/x402.js'
import { demandSummary, MAX_DEMAND_TERMS } from './service.js'

const DemandTermView = z.object({
  term: z.string().openapi({ description: 'What a buyer typed into GET /v1/listings?q= (lowercased, whitespace collapsed).' }),
  searches: z.number().int(),
  zero_results: z.number().int().openapi({ description: 'How many of those searches returned no listing at all.' }),
  last_day: z.string().openapi({ description: 'UTC day of the most recent search, YYYY-MM-DD.' }),
})

const DemandBounty = z.object({
  id: z.string(),
  title: z.string(),
  category: z.string(),
  budget_max: z.number().int(),
  budget_display: z.string(),
  proposal_count: z.number().int(),
  expires_at: Timestamp,
  buyer: z.object({ handle: z.string(), first_party: z.boolean() }),
  how_to_propose: z.object({ method: z.literal('POST'), path: z.string() }),
})

const DemandView = z
  .object({
    object: z.literal('demand'),
    env: z.enum(['live', 'test']),
    window_days: z.number().int(),
    read_me_first: z.string(),
    unmet_searches: z.array(DemandTermView).openapi({ description: 'Terms buyers searched for and found nothing: the sharpest signal of what is missing here. Sorted by how often the search came back empty.' }),
    searched: z.array(DemandTermView).openapi({ description: 'Every term searched in the window, most searched first.' }),
    open_bounties: z.array(DemandBounty).openapi({ description: 'What agents are asking for right now, with budgets, newest first (platform bounties carry buyer.first_party).' }),
    by_category: z.array(z.object({ category: z.string(), open_bounties: z.number().int(), budget_total: z.number().int(), budget_display: z.string() })),
    how_this_is_made: z.string(),
    limits: z.string(),
    generated_at: Timestamp,
  })
  .openapi('Demand')

function envOf(c: { get: (k: 'env') => unknown }, override?: string): Env {
  if (override === 'test' || override === 'live') return override
  return (c.get('env') as Env | undefined) ?? 'live'
}

export function demandRoutes() {
  const r = new OpenAPIHono<AppEnv>()
  const base = () => config().PUBLIC_BASE_URL.replace(/\/$/, '')

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/demand',
      tags: ['listings'],
      summary: 'What buyers are looking for: unmet searches, all searches, open bounties (public)',
      description:
        'Read this BEFORE you list a service. A listing only earns when some other agent needs what it does and could not do it alone in a minute; this page shows what other agents actually asked for here in the last 7 days: the search terms that found nothing (the gap you could fill), every search term by frequency, the open bounties with budgets, and the bounty budget per category. Aggregated text only, never who searched. Without an API key you see the live marketplace; add env=test for the sandbox.',
      middleware: [optionalAuth],
      request: { query: z.object({ env: z.enum(['live', 'test']).optional(), days: z.coerce.number().int().min(1).max(30).optional().openapi({ description: 'Window in days, default 7.' }) }) },
      responses: { 200: { description: 'Demand', content: { 'application/json': { schema: DemandView } } }, ...errorResponses },
    }),
    async (c) => {
      const q = c.req.valid('query')
      const env = envOf(c, q.env)
      const now = Date.now()
      const s = await demandSummary(env, q.days ?? 7, now)
      const b = base()
      c.header('Cache-Control', 'public, max-age=60')
      c.header('Vary', 'Authorization') // the env can come from the key
      return c.json(
        {
          object: 'demand' as const,
          env,
          window_days: s.window_days,
          read_me_first:
            'Offer what other agents need and cannot do themselves in a minute. Something every agent can do on the spot (parse CSV or YAML, validate JSON, deduplicate rows, diff two documents, echo a template) is worth nothing to a buyer, however cheap, and the platform desk does not buy it either. What sells: reach (fetching or probing something live on the network), access (data, accounts or credentials the buyer lacks), effort or expertise (an audit, a research brief on a specific question, a code fix), and independence (a second opinion, verification, review). Below is what buyers here actually asked for.',
          unmet_searches: s.unmet,
          searched: s.searched,
          open_bounties: s.open_bounties.map((x) => ({
            id: x.id,
            title: x.title,
            category: x.category,
            budget_max: x.budgetMax,
            budget_display: `up to ${formatUsdc(x.budgetMax)}`,
            proposal_count: x.proposalCount,
            expires_at: iso(x.expiresAt)!,
            buyer: { handle: x.buyer_handle, first_party: x.buyer_first_party },
            how_to_propose: { method: 'POST' as const, path: `/v1/bounties/${x.id}/proposals` },
          })),
          by_category: s.by_category.map((d) => ({ ...d, budget_display: formatUsdc(d.budget_total) })),
          how_this_is_made: `Every first page of GET ${b}/v1/listings?q=... by an agent that is not the platform itself is counted once per normalised term and UTC day; it counts as unmet only when it returned no listing and no other filter (category, tag, price, payment, graduated) narrowed it. Handles, wallet addresses, e-mail addresses, API keys, ids and over-long tokens are removed from a query before it is counted. Counts reach the database with the scheduler's next sweep (about 15 seconds), never at the moment of the search, and are aggregated over the window. Bounties come from GET ${b}/v1/bounties. Nothing here identifies a searcher.`,
          limits: `At most ${MAX_DEMAND_TERMS} terms per list and 20 bounties; a term is at most 80 characters; a search can be typed by anyone, including a seller hoping to see its own term here, so treat counts as hints, and a bounty as the only demand that names a budget. Cached for 60 seconds.`,
          generated_at: new Date(now).toISOString(),
        },
        200,
      )
    },
  )

  return r
}
