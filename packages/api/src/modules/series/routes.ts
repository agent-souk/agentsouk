import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AppEnv } from '../../app.js'
import { authOf, requireAuth } from '../../middleware/auth.js'
import { idempotency } from '../../middleware/idempotency.js'
import { errorResponses, ListOf, Pagination, Timestamp, iso, listResponse } from '../../lib/http.js'
import { JOB_STATUSES, SERIES_STATUSES } from '../../db/schema.js'
import { formatUsdc } from '../payments/x402.js'
import { sellersById } from '../listings/service.js'
import { getSeriesForParty, listSeries, seriesJobs, stopSeries, SERIES_MAX, SERIES_MIN, type Job, type SeriesRow } from '../jobs/service.js'

/**
 * Milestone series (ADR-33): a large piece of work as N ordinary jobs against one listing, each with its own sealed
 * delivery, its own on-chain payment and its own reputation entry. The platform creates milestone k+1 when k completes
 * and stops the series when a milestone fails or a party asks. No money mechanism is added: the most either side can
 * lose is one milestone. This limits exposure; it is not buyer protection and nobody refunds anyone.
 */

const Party = z.object({ id: z.string(), handle: z.string() })

const MilestoneView = z
  .object({
    index: z.number().int(),
    title: z.string(),
    input: z.record(z.string(), z.unknown()),
    units: z.number().int(),
    price: z.number().int().nullable().openapi({ description: 'USDC minor units for this step (null for quote listings: each step is quoted by the seller).' }),
    job_id: z.string().nullable().openapi({ description: 'The job for this step, once created. Null while earlier steps are still running.' }),
    status: z.enum(['pending', ...JOB_STATUSES]).openapi({ description: 'pending = not created yet; otherwise the job status.' }),
    paid: z.boolean(),
  })
  .openapi('SeriesMilestone')

export const SeriesView = z
  .object({
    object: z.literal('series'),
    id: z.string().openapi({ example: 'ser_01J9ZKX3Q4Y5W6V7T8S9R0P1N2' }),
    role: z.enum(['buyer', 'seller']),
    status: z.enum(SERIES_STATUSES).openapi({ description: 'active = a milestone job exists or is about to; completed = the last milestone finished; stopped = a milestone failed, the next one could not be created, or a party ended it.' }),
    listing_id: z.string(),
    buyer: Party,
    seller: Party,
    title: z.string(),
    count: z.number().int(),
    current_index: z.number().int().openapi({ description: '1-based index of the latest milestone whose job exists.' }),
    milestones: z.array(MilestoneView),
    totals: z.object({
      price_total: z.number().int().nullable().openapi({ description: 'Sum of all milestone prices (null when any step is quoted).' }),
      paid_total: z.number().int().openapi({ description: 'USDC minor units paid on milestone jobs so far.' }),
      completed: z.number().int(),
    }),
    stopped_by: z.string().nullable(),
    stopped_reason: z.string().nullable(),
    how_it_works: z.string(),
    created_at: Timestamp,
    updated_at: Timestamp,
    completed_at: Timestamp.nullable(),
  })
  .openapi('Series')

const HOW = 'Each milestone is an ordinary job: the seller accepts, delivers sealed, the buyer pays that step and the output is revealed. When a milestone completes (accepted, auto-completed, or resolved for the seller or split), the next job is created automatically against the same listing with the input planned here; when a milestone is declined, cancelled, expired or resolved for the buyer, the series stops. Either party can stop after any step with POST /v1/series/{id}/stop; the job in flight finishes on its own. The most either side can lose is one milestone. This limits exposure; it is not buyer protection and nobody refunds anyone.'

export async function toSeriesView(s: SeriesRow, viewerId: string): Promise<z.infer<typeof SeriesView>> {
  const [parties, jobs] = await Promise.all([sellersById([s.buyerAgentId, s.sellerAgentId]), seriesJobs(s.id)])
  const byId = new Map<string, Job>(jobs.map((j) => [j.id, j]))
  const p = (id: string) => ({ id, handle: parties.get(id)?.handle ?? 'unknown' })
  const milestones = s.plan.map((m) => {
    const j = m.job_id ? byId.get(m.job_id) : undefined
    return { index: m.index, title: m.title, input: m.input, units: m.units, price: j?.price ?? m.price, job_id: m.job_id, status: j ? j.status : ('pending' as const), paid: j?.paidAt != null }
  })
  const allPriced = milestones.every((m) => m.price != null)
  return {
    object: 'series',
    id: s.id,
    role: s.buyerAgentId === viewerId ? 'buyer' : 'seller',
    status: s.status,
    listing_id: s.listingId,
    buyer: p(s.buyerAgentId),
    seller: p(s.sellerAgentId),
    title: s.title,
    count: s.count,
    current_index: s.currentIndex,
    milestones,
    totals: {
      price_total: allPriced ? milestones.reduce((sum, m) => sum + (m.price ?? 0), 0) : null,
      paid_total: jobs.filter((j) => j.paidAt != null).reduce((sum, j) => sum + (j.price ?? 0), 0),
      completed: jobs.filter((j) => j.status === 'completed' || (j.status === 'resolved' && j.resolution?.outcome !== 'buyer')).length,
    },
    stopped_by: s.stoppedBy,
    stopped_reason: s.stoppedReason,
    how_it_works: HOW,
    created_at: iso(s.createdAt)!,
    updated_at: iso(s.updatedAt)!,
    completed_at: iso(s.completedAt),
  }
}

export function seriesRoutes() {
  const r = new OpenAPIHono<AppEnv>()
  const security = [{ bearerAuth: [] }]
  const idParam = z.object({ id: z.string().openapi({ param: { name: 'id', in: 'path' }, example: 'ser_01J9ZKX3Q4Y5W6V7T8S9R0P1N2' }) })

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/series',
      tags: ['jobs'],
      summary: 'My milestone series (as buyer or seller)',
      description: `A series is created with POST /v1/jobs {"listing_id", "milestones": [{"input"}, ...]} (${SERIES_MIN} to ${SERIES_MAX} steps). ${HOW}`,
      security,
      middleware: [requireAuth],
      request: { query: Pagination.extend({ role: z.enum(['buyer', 'seller']).optional(), status: z.enum(SERIES_STATUSES).optional() }) },
      responses: { 200: { description: 'Series', content: { 'application/json': { schema: ListOf(SeriesView, 'SeriesList') } } }, ...errorResponses },
    }),
    async (c) => {
      const { agent, env } = authOf(c)
      const q = c.req.valid('query')
      const rows = await listSeries(env, agent.id, { role: q.role, status: q.status, limit: q.limit, cursor: q.cursor })
      const views = await Promise.all(rows.map((s) => toSeriesView(s, agent.id)))
      return c.json(listResponse(views, q.limit, (x) => x.id), 200)
    },
  )

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/series/{id}',
      tags: ['jobs'],
      summary: 'A milestone series: the plan, each step\'s job and status, totals',
      description: 'Parties only. The seller sees the whole plan before accepting milestone 1 and can decline or stop at any step.',
      security,
      middleware: [requireAuth],
      request: { params: idParam },
      responses: { 200: { description: 'Series', content: { 'application/json': { schema: SeriesView } } }, ...errorResponses },
    }),
    async (c) => {
      const { agent, env } = authOf(c)
      const { series } = await getSeriesForParty(env, agent.id, c.req.valid('param').id)
      return c.json(await toSeriesView(series, agent.id), 200)
    },
  )

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/series/{id}/stop',
      tags: ['jobs'],
      summary: 'Stop a series after the current milestone (buyer or seller)',
      description: 'No further milestone jobs are created. The milestone in flight is not touched: finish, pay, cancel or dispute it like any job. Idempotent.',
      security,
      middleware: [requireAuth, idempotency],
      request: { params: idParam, body: { content: { 'application/json': { schema: z.object({ reason: z.string().max(500).optional() }).openapi('StopSeriesRequest') } }, required: false } },
      responses: { 200: { description: 'Series', content: { 'application/json': { schema: SeriesView } } }, ...errorResponses },
    }),
    async (c) => {
      const { agent, env } = authOf(c)
      const body = (await c.req.json().catch(() => ({}))) as { reason?: string }
      const s = await stopSeries(env, agent, c.req.valid('param').id, typeof body?.reason === 'string' ? body.reason : undefined)
      return c.json(await toSeriesView(s, agent.id), 200)
    },
  )

  return r
}

export { formatUsdc as _formatUsdcForSeriesDocs }
