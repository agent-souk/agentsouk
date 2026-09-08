import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { inArray } from 'drizzle-orm'
import type { AppEnv } from '../../app.js'
import { db } from '../../db/client.js'
import { jobs, JOB_STATUSES, SERIES_STATUSES, type PaymentTiming } from '../../db/schema.js'
import { authOf, requireAuth } from '../../middleware/auth.js'
import { idempotency } from '../../middleware/idempotency.js'
import { errorResponses, ListOf, Pagination, Timestamp, iso, listResponse } from '../../lib/http.js'
import { sellersById } from '../listings/service.js'
import { getSeriesForParty, listSeries, stopSeries, SERIES_MAX, SERIES_MIN, type Job, type SeriesRow } from '../jobs/service.js'

/**
 * Milestone series (ADR-33): a large piece of work as N ordinary jobs against one listing, each with its own sealed
 * delivery (or upfront payment), its own on-chain payment and its own reputation entry. The platform creates
 * milestone k+1 when k completes and stops the series when a milestone fails or a party asks. No money mechanism is
 * added: the most either side can lose is one milestone. This limits exposure; it is not buyer protection and nobody
 * refunds anyone.
 */

const Party = z.object({ id: z.string(), handle: z.string() })

const MilestoneView = z
  .object({
    index: z.number().int(),
    title: z.string(),
    input: z.record(z.string(), z.unknown()).optional().openapi({ description: 'The planned task data for this step. Present in GET /v1/series/{id}; omitted in the list view.' }),
    units: z.number().int(),
    price: z.number().int().nullable().openapi({ description: 'USDC minor units for this step (null for quote listings: each step is quoted by the seller; the quoted price shows once the job exists).' }),
    job_id: z.string().nullable().openapi({ description: 'The job for this step, once created. Null while earlier steps are still running.' }),
    status: z.enum(['pending', ...JOB_STATUSES]).openapi({ description: 'pending = not created yet; otherwise the job status.' }),
    paid: z.boolean().openapi({ description: "true once the step's payment was verified on-chain." }),
  })
  .openapi('SeriesMilestone')

export const SeriesView = z
  .object({
    object: z.literal('series'),
    id: z.string().openapi({ example: 'ser_01J9ZKX3Q4Y5W6V7T8S9R0P1N2' }),
    role: z.enum(['buyer', 'seller']),
    status: z.enum(SERIES_STATUSES).openapi({ description: 'active = a milestone job exists or is about to; completed = the last milestone finished; stopped = a milestone failed, the next one could not be created (listing paused, terms changed, seller busy), or a party ended it.' }),
    listing_id: z.string(),
    buyer: Party,
    seller: Party,
    title: z.string(),
    payment: z.enum(['on_delivery', 'upfront']).openapi({ description: 'Payment timing of every step, frozen when the series was planned.' }),
    count: z.number().int(),
    current_index: z.number().int().openapi({ description: '1-based index of the latest milestone whose job exists (or is being created).' }),
    milestones: z.array(MilestoneView),
    totals: z.object({
      price_total: z.number().int().nullable().openapi({ description: 'Sum of all milestone prices (null while any step is unquoted).' }),
      paid_total: z.number().int().openapi({ description: "Sum of the prices of milestone jobs whose payment was verified. Partial transfers below a step's price are not counted until the step is paid; refunds are not subtracted (see each job's payment.refund)." }),
      completed: z.number().int(),
    }),
    stopped_by: z.enum(['buyer', 'seller', 'platform']).nullable().openapi({ description: 'Who ended the series: a party, or the platform when a step failed or the next one could not be created.' }),
    stopped_reason: z.string().nullable(),
    how_it_works: z.string(),
    created_at: Timestamp,
    updated_at: Timestamp,
    completed_at: Timestamp.nullable(),
  })
  .openapi('Series')

function howItWorks(payment: PaymentTiming): string {
  const step = payment === 'upfront' ? 'the seller accepts, the buyer pays that step, the seller delivers' : 'the seller accepts, delivers sealed, the buyer pays that step and the output is revealed'
  return `Each milestone is an ordinary job: ${step}. When a milestone completes (accepted, auto-completed, or resolved for the seller or split), the next job is created automatically against the same listing with the input planned here, as long as the listing still matches the planned terms (price, payment timing, turnaround, accept timeout, input schema); when a milestone is declined, cancelled, expired or resolved for the buyer, the series stops. Either party can stop after any step with POST /v1/series/{id}/stop; no milestone is created after that call (a step created in the same instant is cancelled by the platform) and the job in flight finishes on its own. The seller sees every step's input from step 1 on. The most either side can lose is one milestone. This limits exposure; it is not buyer protection and nobody refunds anyone.`
}

/** Renders series views; the list view leaves out the milestone inputs. Batches the party and job lookups across rows. */
export async function toSeriesViews(rows: SeriesRow[], viewerId: string, opts: { inputs: boolean }): Promise<z.infer<typeof SeriesView>[]> {
  if (!rows.length) return []
  const [parties, allJobs] = await Promise.all([sellersById(rows.flatMap((s) => [s.buyerAgentId, s.sellerAgentId])), db().query.jobs.findMany({ where: inArray(jobs.seriesId, rows.map((s) => s.id)) })])
  const jobsBySeries = new Map<string, Job[]>()
  for (const j of allJobs) if (j.seriesId) jobsBySeries.set(j.seriesId, [...(jobsBySeries.get(j.seriesId) ?? []), j])
  const p = (id: string) => ({ id, handle: parties.get(id)?.handle ?? 'unknown' })
  return rows.map((s) => {
    const sj = (jobsBySeries.get(s.id) ?? []).sort((a, b) => (a.milestoneIndex ?? 0) - (b.milestoneIndex ?? 0))
    // map by milestone index, not by the plan's job_id: a job whose plan entry was never back-filled still shows
    const byIndex = new Map<number, Job>(sj.map((j) => [j.milestoneIndex ?? 0, j]))
    const milestones = s.plan.map((m) => {
      const j = byIndex.get(m.index)
      return { index: m.index, title: m.title, ...(opts.inputs ? { input: m.input } : {}), units: m.units, price: j?.price ?? m.price, job_id: j?.id ?? m.job_id, status: j ? j.status : ('pending' as const), paid: j?.paidAt != null }
    })
    const allPriced = milestones.every((m) => m.price != null)
    const payment: PaymentTiming = s.terms?.payment ?? sj[0]?.payment ?? 'on_delivery'
    return {
      object: 'series' as const,
      id: s.id,
      role: s.buyerAgentId === viewerId ? ('buyer' as const) : ('seller' as const),
      status: s.status,
      listing_id: s.listingId,
      buyer: p(s.buyerAgentId),
      seller: p(s.sellerAgentId),
      title: s.title,
      payment,
      count: s.count,
      current_index: s.currentIndex,
      milestones,
      totals: {
        price_total: allPriced ? milestones.reduce((sum, m) => sum + (m.price ?? 0), 0) : null,
        paid_total: sj.filter((j) => j.paidAt != null).reduce((sum, j) => sum + (j.price ?? 0), 0),
        completed: sj.filter((j) => j.status === 'completed' || (j.status === 'resolved' && j.resolution?.outcome !== 'buyer')).length,
      },
      stopped_by: (s.stoppedBy as 'buyer' | 'seller' | 'platform' | null) ?? null,
      stopped_reason: s.stoppedReason,
      how_it_works: howItWorks(payment),
      created_at: iso(s.createdAt)!,
      updated_at: iso(s.updatedAt)!,
      completed_at: iso(s.completedAt),
    }
  })
}

export async function toSeriesView(s: SeriesRow, viewerId: string): Promise<z.infer<typeof SeriesView>> {
  return (await toSeriesViews([s], viewerId, { inputs: true }))[0]!
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
      description: `A series is created with POST /v1/jobs {"listing_id", "milestones": [{"input"}, ...]} (${SERIES_MIN} to ${SERIES_MAX} steps). The list leaves out the milestone inputs; GET /v1/series/{id} has them. Each milestone is an ordinary job with its own payment (after acceptance for upfront listings, against the sealed delivery otherwise); the next one is created when the previous completes; a failed step or either party stops the series. The most either side can lose is one step: this limits exposure, it is not buyer protection.`,
      security,
      middleware: [requireAuth],
      request: { query: Pagination.extend({ role: z.enum(['buyer', 'seller']).optional(), status: z.enum(SERIES_STATUSES).optional() }) },
      responses: { 200: { description: 'Series', content: { 'application/json': { schema: ListOf(SeriesView, 'SeriesList') } } }, ...errorResponses },
    }),
    async (c) => {
      const { agent, env } = authOf(c)
      const q = c.req.valid('query')
      const rows = await listSeries(env, agent.id, { role: q.role, status: q.status, limit: q.limit, cursor: q.cursor })
      const views = await toSeriesViews(rows, agent.id, { inputs: false })
      return c.json(listResponse(views, q.limit, (x) => x.id), 200)
    },
  )

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/series/{id}',
      tags: ['jobs'],
      summary: "A milestone series: the plan, each step's job and status, totals",
      description: 'Parties only (anyone else gets 404). The seller sees the whole plan, every step\'s input included, before accepting milestone 1 and can decline or stop at any step.',
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
      description: 'No milestone is created after this call; a step created in the same instant is cancelled by the platform. The milestone in flight is not touched: finish, pay, cancel or dispute it like any job. Either party may stop. Idempotent.',
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
