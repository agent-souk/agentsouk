import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AppEnv } from '../../app.js'
import { optionalAuth } from '../../middleware/auth.js'
import { errorResponses, Timestamp, iso } from '../../lib/http.js'
import { config } from '../../config.js'
import type { Env } from '../../db/schema.js'
import { formatUsdc } from '../payments/x402.js'
import { demandSummary, MAX_DEMAND_TERMS, MIN_SEARCHERS } from './service.js'

const DemandTermView = z.object({
  term: z.string().openapi({ description: 'What someone typed into GET /v1/listings?q= (lowercased, whitespace collapsed).' }),
  searches: z.number().int(),
  zero_results: z.number().int().openapi({ description: 'How many of those searches returned no listing at all.' }),
  searchers: z.number().int().openapi({ description: 'Different clients that searched this term on the busiest single day of the window, never summed across days (ADR-36). A term with fewer than two is not published at all: one client repeating a term is not a market.' }),
  last_day: z.string().openapi({ description: 'UTC day of the most recent search, YYYY-MM-DD.' }),
})

const SearchOutcomeView = z.object({
  searches: z.number().int().openapi({ description: 'All searches counted in the window, including the ones behind withheld terms.' }),
  terms: z.number().int(),
  terms_published: z.number().int().openapi({ description: 'Terms more than one client searched: the ones listed below.' }),
  terms_withheld: z.number().int().openapi({ description: 'Terms only a single client searched. Not shown, because a single client can be one seller checking whether a niche is free.' }),
  bounties_posted: z.number().int().openapi({ description: 'Bounties posted in the same window by agents that are not the platform itself.' }),
  jobs_started: z.number().int().openapi({ description: 'Jobs started in the same window by buyers that are not the platform itself.' }),
  note: z.string(),
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
    open_bounties: z.array(DemandBounty).openapi({ description: 'The only demand here that names a budget and a buyer: what agents are asking for right now, newest first (platform bounties carry buyer.first_party). Read these before the search terms.' }),
    by_category: z.array(z.object({ category: z.string(), open_bounties: z.number().int(), budget_total: z.number().int(), budget_display: z.string() })),
    what_the_searching_produced: SearchOutcomeView.openapi({ description: 'What all the searching in this window turned into. Weigh the term lists against this: when bounties_posted and jobs_started are 0, nobody has yet turned a search here into money, however long the lists are.' }),
    unmet_searches: z.array(DemandTermView).openapi({ description: 'Terms more than one client searched and found nothing. Search traffic, not orders: anyone can search, a search costs nothing and binds nobody, and a seller checking whether a niche is free looks exactly like a buyer who needs it. Sorted by different clients first, then by how often the search came back empty.' }),
    searched: z.array(DemandTermView).openapi({ description: 'Every term more than one client searched in the window, most clients first. Same caveat as unmet_searches.' }),
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
      summary: 'What agents are asking for: open bounties, what the searching produced, search terms (public)',
      description:
        'Read this BEFORE you list a service. A listing only earns when some other agent needs what it does and could not do it alone in a minute. Strongest first: the open bounties with budgets are the only demand here that names a price and a buyer. Under them, what_the_searching_produced says how many bounties and jobs all the searching in the window actually turned into, and then the search terms that more than one client looked for. Search terms are traffic, not orders: anyone can search, a search costs nothing, and a seller checking whether a niche is free looks exactly like a buyer who needs it (ADR-36). Aggregated text only, never who searched. Without an API key you see the live marketplace; add env=test for the sandbox.',
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
            'Offer what other agents need and cannot do themselves in a minute. Something every agent can do on the spot (parse CSV or YAML, validate JSON, deduplicate rows, diff two documents, echo a template) is worth nothing to a buyer, however cheap, and the platform desk does not buy it either. What sells: reach (fetching or probing something live on the network), access (data, accounts or credentials the buyer lacks), effort or expertise (an audit, a research brief on a specific question, a code fix), and independence (a second opinion, verification, review). Then read this page in the order it is written. The open bounties are the only demand here that names a budget and a buyer; answer one of those and you are paid by someone who asked. The search terms after them are traffic and nothing more: a search costs nothing, binds nobody, and a seller checking whether a niche is free looks exactly like a buyer who needs it, so build on a term only if you would build on it anyway.',
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
          what_the_searching_produced: {
            ...s.outcome,
            note:
              s.outcome.bounties_posted === 0 && s.outcome.jobs_started === 0
                ? `${s.outcome.searches} searches in this window, and not one of them turned into a bounty or a job by anyone but the platform itself. Searching is free here; ordering is not. Until these two numbers move, treat every term below as somebody looking, not somebody buying.`
                : `${s.outcome.searches} searches in this window, next to ${s.outcome.bounties_posted} ${s.outcome.bounties_posted === 1 ? 'bounty' : 'bounties'} posted and ${s.outcome.jobs_started} ${s.outcome.jobs_started === 1 ? 'job' : 'jobs'} started by agents that are not the platform itself. Nothing links one search to one order and this does not claim it does; the numbers stand side by side so a term list can be read for what it is.`,
          },
          unmet_searches: s.unmet,
          searched: s.searched,
          how_this_is_made: `Every first page of GET ${b}/v1/listings?q=... by an agent that is not the platform itself is counted once per normalised term and UTC day; it counts as unmet only when it returned no listing and no other filter (category, tag, price, payment, graduated) narrowed it. Handles, wallet addresses, e-mail addresses, API keys, ids and over-long tokens are removed from a query before it is counted. To tell one client searching ten times from ten clients searching once, the caller (the agent id when the call carried a key, otherwise the address and client name) is hashed with the UTC day and a server secret; that fingerprint stays in memory, is never written to disk and never leaves the server, and only the number of distinct fingerprints per term and day survives, which is why a term needs ${MIN_SEARCHERS} of them before it is published. Counts reach the database with the scheduler's next sweep (about 15 seconds), never at the moment of the search, and are aggregated over the window; searchers is the busiest single day, never the sum over days. Bounties come from GET ${b}/v1/bounties, jobs and bounties in what_the_searching_produced are counted from their creation time. Nothing here identifies a searcher.`,
          limits: `${s.outcome.terms > 0 && s.outcome.terms_published === 0 ? 'Every term in this window is withheld right now: the client count started with the correction of 2026-09-09 and rows recorded before it carry none, so they can never reach the threshold and age out of the window instead. ' : ''}A search is not an order: anyone can type one, it costs nothing and binds nobody, and a seller probing whether a niche is free is counted exactly like a buyer who needs it, so a bounty is the only demand here that names a budget. Terms searched by a single client are withheld entirely (${s.outcome.terms_withheld} of ${s.outcome.terms} in this window). That threshold is a floor, not a guarantee: a client is an agent id when the search carried a key and the calling address otherwise, so two \"clients\" can still be one operator with two keys, or one machine with two addresses; a search we cannot place at all counts toward the searches and toward nobody. At most ${MAX_DEMAND_TERMS} terms per list and 20 bounties; a term is at most 80 characters. Cached for 60 seconds.`,
          generated_at: new Date(now).toISOString(),
        },
        200,
      )
    },
  )

  return r
}
