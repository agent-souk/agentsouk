import { and, desc, eq, inArray, lt, or, type SQL } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { agentReputation, agents, bounties, jobs, listings, reviews, settlements, type CategoryCard, type Env, type ReputationSide } from '../../db/schema.js'
import { errors } from '../../lib/errors.js'
import { newId } from '../../lib/ids.js'
import { scanText } from '../../lib/content-safety.js'
import { emit } from '../../events/bus.js'
import { recordListingOutcome } from '../listings/service.js'
import { isBuyerCancellation, isCompletedJob, isDeliveryUnpaid, isRefundDue, isRefunded, isSellerFailure, isUnpaidExpiry, isWalkAway, paidValue } from '../jobs/outcomes.js'
import type { Agent } from '../../middleware/auth.js'
import { syncTrustTier } from '../domains/service.js'

/**
 * Reviews & reputation (SPEC-PAYMENTS §9, ADR-9/22). Reputation is computed ONLY from finished jobs: a review can
 * only exist for a job that reached completed/resolved, one per party. Volume and counterparties come from the
 * on-chain settlements the platform verified, so they cannot be claimed, only paid for.
 */

export type JobRow = typeof jobs.$inferSelect
export type ReviewRow = typeof reviews.$inferSelect
export type ReputationRow = typeof agentReputation.$inferSelect
type SettlementRow = typeof settlements.$inferSelect

const PRIOR_MEAN = 3.5
const PRIOR_WEIGHT = 5
/** T1: proven by paid live jobs. Volume in USDC minor units (10 USDC) keeps dust-priced farming from counting. */
export const TRUST_T1 = { minCompleted: 5, minCounterparties: 3, minPayingAddresses: 3, minVolumeUsdc: 10_000_000 }

export const emptySide = (): ReputationSide => ({
  rating_weighted: null,
  categories: [],
  jobs_completed: 0,
  jobs_failed: 0,
  jobs_disputed: 0,
  jobs_cancelled: 0,
  jobs_unpaid: 0,
  jobs_walked_away: 0,
  deliveries_unpaid: 0,
  refunds_due: 0,
  refunds_made: 0,
  distinct_counterparties: 0,
  first_party_counterparties: 0,
  third_party_counterparties: 0,
  volume_usdc: 0,
  third_party_volume_usdc: 0,
  rating_avg: null,
  rating_count: 0,
  on_time_rate: null,
})

export function bayesianRating(sum: number, n: number): number | null {
  if (n === 0) return null
  return Math.round(((sum + PRIOR_MEAN * PRIOR_WEIGHT) / (n + PRIOR_WEIGHT)) * 100) / 100
}

/**
 * ADR-27: one counterparty = one vote. Reviews from the same reviewer are averaged first, then each reviewer's vote is
 * weighted by the USDC it actually paid on the reviewed jobs (log scale: dust and free jobs weigh 1, 1 USDC about 3,
 * 100 USDC about 5), then the Bayesian prior applies. A cheap repeat customer cannot outvote real buyers.
 */
export function reviewWeight(valueMinorUnits: number): number {
  return Math.round((1 + Math.log10(1 + Math.max(0, valueMinorUnits) / 10_000)) * 100) / 100
}

export function weightedRating(rows: Pick<ReviewRow, 'reviewerAgentId' | 'rating' | 'jobPrice'>[]): number | null {
  if (!rows.length) return null
  const byReviewer = new Map<string, { sum: number; n: number; value: number }>()
  for (const r of rows) {
    const g = byReviewer.get(r.reviewerAgentId) ?? { sum: 0, n: 0, value: 0 }
    g.sum += r.rating
    g.n += 1
    g.value += r.jobPrice
    byReviewer.set(r.reviewerAgentId, g)
  }
  let weighted = 0
  let weights = 0
  for (const g of byReviewer.values()) {
    const w = reviewWeight(g.value)
    weighted += (g.sum / g.n) * w
    weights += w
  }
  return Math.round(((weighted + PRIOR_MEAN * PRIOR_WEIGHT) / (weights + PRIOR_WEIGHT)) * 100) / 100
}

const MAX_CATEGORY_CARDS = 10

/** Seller reputation per category (ADR-27): what the seller has actually delivered in the category a buyer hires for. */
export function categoryCards(sellerJobs: JobRow[], categoryOf: Map<string, string>, ratings: ReviewRow[], stl: Map<string, SettlementRow[]>): CategoryCard[] {
  const groups = new Map<string, JobRow[]>()
  for (const j of sellerJobs) {
    const cat = categoryOf.get(j.id)
    if (!cat) continue
    groups.set(cat, [...(groups.get(cat) ?? []), j])
  }
  const cards: CategoryCard[] = []
  for (const [category, list] of groups) {
    const ids = new Set(list.map((j) => j.id))
    const completed = list.filter(isCompletedJob)
    let volume = 0
    for (const j of completed) {
      const rows = stl.get(j.id) ?? []
      volume += rows.filter((s) => s.kind === 'payment' && s.status === 'settled').reduce((s, p) => s + p.amount, 0) - rows.filter((s) => s.kind === 'refund').reduce((s, p) => s + p.amount, 0)
    }
    const revs = ratings.filter((r) => ids.has(r.jobId))
    const delivered = list.filter((j) => j.deliveredAt != null && j.deadlineAt != null)
    const onTime = delivered.filter((j) => j.deliveredAt! <= j.deadlineAt!)
    cards.push({
      category,
      jobs_completed: completed.length,
      jobs_failed: list.filter(isSellerFailure).length,
      volume_usdc: Math.max(0, volume),
      rating_avg: weightedRating(revs),
      rating_count: revs.length,
      on_time_rate: delivered.length ? Math.round((onTime.length / delivered.length) * 100) / 100 : null,
    })
  }
  return cards.sort((a, b) => b.jobs_completed - a.jobs_completed || b.volume_usdc - a.volume_usdc || a.category.localeCompare(b.category)).slice(0, MAX_CATEGORY_CARDS)
}

/** Listing or bounty category per job id. */
async function categoriesOf(list: JobRow[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const listingIds = [...new Set(list.map((j) => j.listingId).filter((x): x is string => !!x))]
  const bountyIds = [...new Set(list.map((j) => j.bountyId).filter((x): x is string => !!x))]
  const [ls, bs] = await Promise.all([
    listingIds.length ? db().query.listings.findMany({ where: inArray(listings.id, listingIds), columns: { id: true, category: true } }) : [],
    bountyIds.length ? db().query.bounties.findMany({ where: inArray(bounties.id, bountyIds), columns: { id: true, category: true } }) : [],
  ])
  const lcat = new Map(ls.map((l) => [l.id, l.category]))
  const bcat = new Map(bs.map((b) => [b.id, b.category]))
  for (const j of list) {
    const cat = (j.listingId && lcat.get(j.listingId)) || (j.bountyId && bcat.get(j.bountyId)) || null
    if (cat) out.set(j.id, cat.toLowerCase())
  }
  return out
}

type SideResult = { side: ReputationSide; payingAddresses: number; thirdPartyPayingAddresses: number }

/**
 * One side of an agent's reputation from its jobs. `firstPartyIds` are the agents the platform operates (ADR-23):
 * counterparties and volume are also reported without them (ADR-32), because the desk buys every new listing once
 * and a seller nobody but the platform has paid must not look like one with demand.
 */
function sideFromJobs(list: JobRow[], side: 'seller' | 'buyer', ratings: ReviewRow[], stl: Map<string, SettlementRow[]>, firstPartyIds: Set<string> = new Set()): SideResult {
  const completed = list.filter(isCompletedJob)
  const counterpartyId = (j: JobRow) => (side === 'seller' ? j.buyerAgentId : j.sellerAgentId)
  const settledPayments = (j: JobRow) => (stl.get(j.id) ?? []).filter((s) => s.kind === 'payment' && s.status === 'settled')
  const refundsOf = (j: JobRow) => (stl.get(j.id) ?? []).filter((s) => s.kind === 'refund')
  // Counterparties: distinct wallet addresses on paid jobs; agents met only through free jobs count by id.
  const addresses = new Set<string>()
  const thirdPartyAddresses = new Set<string>()
  const firstPartyAddresses = new Set<string>()
  const paidIds = new Set<string>()
  const freeIds = new Set<string>()
  let volume = 0
  let thirdPartyVolume = 0
  for (const j of completed) {
    const pays = settledPayments(j)
    const firstParty = firstPartyIds.has(counterpartyId(j))
    if (pays.length) {
      for (const s of pays) {
        const address = (side === 'seller' ? s.payerAddress : s.payTo).toLowerCase()
        addresses.add(address)
        ;(firstParty ? firstPartyAddresses : thirdPartyAddresses).add(address)
      }
      paidIds.add(counterpartyId(j))
      const net = pays.reduce((sum, s) => sum + s.amount, 0) - refundsOf(j).reduce((sum, s) => sum + s.amount, 0)
      volume += net
      if (!firstParty) thirdPartyVolume += net
    } else if (paidValue(j) === 0) freeIds.add(counterpartyId(j))
  }
  const ids = new Set([...freeIds].filter((id) => !paidIds.has(id)))
  const thirdPartyIds = [...ids].filter((id) => !firstPartyIds.has(id))
  const failed = side === 'seller' ? list.filter(isSellerFailure) : []
  const cancelled = side === 'seller' ? list.filter((j) => j.status === 'cancelled' && j.cancelKind === 'seller_failed') : list.filter(isBuyerCancellation)
  const disputed = list.filter((j) => j.disputeReason != null)
  const delivered = list.filter((j) => j.deliveredAt != null && j.deadlineAt != null)
  const onTime = delivered.filter((j) => j.deliveredAt! <= j.deadlineAt!)
  const sideStats: ReputationSide = {
    jobs_completed: completed.length,
    jobs_failed: failed.length,
    jobs_disputed: disputed.length,
    jobs_cancelled: cancelled.length,
    jobs_unpaid: side === 'buyer' ? list.filter(isUnpaidExpiry).length : 0,
    jobs_walked_away: side === 'buyer' ? list.filter(isWalkAway).length : 0,
    deliveries_unpaid: side === 'seller' ? list.filter(isDeliveryUnpaid).length : 0,
    refunds_due: side === 'seller' ? list.filter(isRefundDue).length : 0,
    refunds_made: side === 'seller' ? list.filter(isRefunded).length : 0,
    distinct_counterparties: addresses.size + ids.size,
    first_party_counterparties: firstPartyAddresses.size + (ids.size - thirdPartyIds.length),
    third_party_counterparties: thirdPartyAddresses.size + thirdPartyIds.length,
    volume_usdc: Math.max(0, volume),
    third_party_volume_usdc: Math.max(0, thirdPartyVolume),
    rating_avg: bayesianRating(
      ratings.reduce((s, r) => s + r.rating, 0),
      ratings.length,
    ),
    rating_count: ratings.length,
    rating_weighted: weightedRating(ratings),
    on_time_rate: side === 'seller' && delivered.length ? Math.round((onTime.length / delivered.length) * 100) / 100 : null,
  }
  return { side: sideStats, payingAddresses: addresses.size, thirdPartyPayingAddresses: thirdPartyAddresses.size }
}

/** Ids of the agents the platform operates (ADR-23); a handful of rows, read per recomputation. */
export async function firstPartyAgentIds(): Promise<Set<string>> {
  const rows = await db().query.agents.findMany({ where: eq(agents.firstParty, true), columns: { id: true } })
  return new Set(rows.map((r) => r.id))
}

export function scoreOf(asSeller: ReputationSide, asBuyer: ReputationSide): number {
  const rating = asSeller.rating_weighted ?? asSeller.rating_avg ?? asBuyer.rating_weighted ?? asBuyer.rating_avg
  const ratingNorm = rating == null ? 0.5 : (rating - 1) / 4
  const volume = asSeller.volume_usdc + asBuyer.volume_usdc
  // log10 over USDC (not minor units): 1 USDC -> ~0.05, 100 USDC -> 0.33, 1M USDC -> 1
  const volumeNorm = Math.min(1, Math.log10(1 + volume / 1_000_000) / 6)
  const done = asSeller.jobs_completed + asBuyer.jobs_completed
  const bad = asSeller.jobs_failed + asSeller.jobs_cancelled + asSeller.refunds_due + asBuyer.jobs_cancelled + asBuyer.jobs_unpaid
  const completionRate = done + bad === 0 ? 0 : done / (done + bad)
  const onTime = asSeller.on_time_rate ?? (done ? 1 : 0)
  return Math.max(0, Math.min(100, Math.round(40 * ratingNorm + 30 * volumeNorm + 20 * completionRate + 10 * onTime)))
}

export async function recomputeReputation(env: Env, agentId: string): Promise<ReputationRow> {
  const all = await db().query.jobs.findMany({ where: and(eq(jobs.env, env), or(eq(jobs.sellerAgentId, agentId), eq(jobs.buyerAgentId, agentId))) })
  const revs = await db().query.reviews.findMany({ where: and(eq(reviews.env, env), eq(reviews.subjectAgentId, agentId)) })
  const jobIds = all.map((j) => j.id)
  const stlRows = jobIds.length ? await db().query.settlements.findMany({ where: inArray(settlements.jobId, jobIds) }) : []
  const stl = new Map<string, SettlementRow[]>()
  for (const s of stlRows) stl.set(s.jobId, [...(stl.get(s.jobId) ?? []), s])
  const firstParty = await firstPartyAgentIds()
  const seller = sideFromJobs(all.filter((j) => j.sellerAgentId === agentId), 'seller', revs.filter((r) => r.role === 'buyer'), stl, firstParty)
  const buyer = sideFromJobs(all.filter((j) => j.buyerAgentId === agentId), 'buyer', revs.filter((r) => r.role === 'seller'), stl, firstParty)
  const sellerJobs = all.filter((j) => j.sellerAgentId === agentId)
  const asSeller: ReputationSide = { ...seller.side, categories: categoryCards(sellerJobs, await categoriesOf(sellerJobs), revs.filter((r) => r.role === 'buyer'), stl) }
  const asBuyer: ReputationSide = { ...buyer.side, categories: [] }
  const score = scoreOf(asSeller, asBuyer)
  const now = Date.now()
  await db()
    .insert(agentReputation)
    .values({ agentId, env, asSeller, asBuyer, score, updatedAt: now })
    .onConflictDoUpdate({ target: [agentReputation.agentId, agentReputation.env], set: { asSeller, asBuyer, score, updatedAt: now } })
  if (env === 'live') {
    const completed = asSeller.jobs_completed + asBuyer.jobs_completed
    const parties = Math.max(asSeller.distinct_counterparties, asBuyer.distinct_counterparties)
    const paying = Math.max(seller.payingAddresses, buyer.payingAddresses)
    const volume = asSeller.volume_usdc + asBuyer.volume_usdc
    if (completed >= TRUST_T1.minCompleted && parties >= TRUST_T1.minCounterparties && paying >= TRUST_T1.minPayingAddresses && volume >= TRUST_T1.minVolumeUsdc) {
      const a = await db().query.agents.findFirst({ where: eq(agents.id, agentId), columns: { trustTier: true } })
      if (a && a.trustTier < 1) {
        await db().update(agents).set({ trustTier: 1, updatedAt: now }).where(eq(agents.id, agentId))
        await syncTrustTier(agentId) // a verified domain lifts a fresh tier 1 to tier 2 (ADR-26)
      }
    }
  }
  return (await db().query.agentReputation.findFirst({ where: and(eq(agentReputation.agentId, agentId), eq(agentReputation.env, env)) }))!
}

/**
 * ADR-32 rollout: reputation rows written before the first/third-party split lack the new fields; recompute them
 * once at startup so no profile reports "0 third-party counterparties" merely because it was never recomputed.
 * Idempotent (rows that already carry the field are skipped), bounded by the number of reputation rows.
 */
export async function backfillReputation(): Promise<{ recomputed: number; errors: number }> {
  const rows = await db().query.agentReputation.findMany({ columns: { agentId: true, env: true, asSeller: true } })
  let recomputed = 0
  let errors = 0
  for (const r of rows) {
    if (r.asSeller.third_party_counterparties != null) continue
    try {
      await recomputeReputation(r.env, r.agentId)
      recomputed += 1
    } catch {
      errors += 1
    }
  }
  return { recomputed, errors }
}

// --- CONTRACT used by jobs ---------------------------------------------------------------------

export async function recordJobOutcome(job: JobRow): Promise<void> {
  await recomputeReputation(job.env, job.sellerAgentId)
  await recomputeReputation(job.env, job.buyerAgentId)
}

// --- reviews ----------------------------------------------------------------------------------

export async function createReview(env: Env, reviewer: Agent, jobId: string, rating: number, comment?: string, machineGenerated = false): Promise<ReviewRow> {
  const job = await db().query.jobs.findFirst({ where: and(eq(jobs.id, jobId), eq(jobs.env, env)) })
  const role = job ? (job.buyerAgentId === reviewer.id ? 'buyer' : job.sellerAgentId === reviewer.id ? 'seller' : undefined) : undefined
  if (!job || !role) throw errors.notFound('Job', jobId, 'You can only review jobs you were part of. GET /v1/jobs lists them.')
  if (job.status !== 'completed' && job.status !== 'resolved') {
    throw errors.state('job_not_settled', `Reviews are possible once a job is completed or resolved (current status: ${job.status}).`, 'Finish the job first; reviews are anchored to finished jobs so they cannot be faked.')
  }
  const existing = await db().query.reviews.findFirst({ where: and(eq(reviews.jobId, jobId), eq(reviews.reviewerAgentId, reviewer.id)) })
  if (existing) throw errors.conflict('already_reviewed', 'You already reviewed this job.', 'Reviews are permanent: one per party per job.')
  const scan = scanText(comment)
  const subject = role === 'buyer' ? job.sellerAgentId : job.buyerAgentId
  const row: typeof reviews.$inferInsert = {
    id: newId('review'),
    env,
    jobId,
    reviewerAgentId: reviewer.id,
    subjectAgentId: subject,
    role,
    rating,
    comment: comment?.trim().slice(0, 2000) || null,
    jobPrice: paidValue(job),
    contentWarnings: scan.warnings,
    machineGenerated,
    createdAt: Date.now(),
  }
  await db().insert(reviews).values(row)
  await recomputeReputation(env, subject)
  if (job.listingId) await recordListingOutcome({ listingId: job.listingId, status: 'completed', buyerAgentId: job.buyerAgentId, price: job.price ?? 0 })
  await emit(env, subject, 'review.received', { review_id: row.id, job_id: jobId, from: reviewer.id, role, rating, comment: row.comment, machine_generated: machineGenerated, content_warnings: scan.warnings })
  return row as ReviewRow
}

export async function resolveAgent(idOrHandle: string): Promise<Agent | undefined> {
  return db().query.agents.findFirst({ where: or(eq(agents.id, idOrHandle), eq(agents.handle, idOrHandle.toLowerCase())) })
}

export async function listReviewsForAgent(agentId: string, env: Env | undefined, limit: number, cursor?: string, role?: 'buyer' | 'seller'): Promise<ReviewRow[]> {
  const conds: SQL[] = [eq(reviews.subjectAgentId, agentId)]
  if (env) conds.push(eq(reviews.env, env))
  if (role) conds.push(eq(reviews.role, role))
  if (cursor) conds.push(lt(reviews.id, cursor))
  return db().query.reviews.findMany({ where: and(...conds), orderBy: [desc(reviews.id)], limit: limit + 1 })
}

/** Reputation rows for many agents in one environment (listing search, seller summaries). */
export async function reputationsById(ids: string[], env: Env): Promise<Map<string, ReputationRow>> {
  const unique = [...new Set(ids)]
  if (!unique.length) return new Map()
  const rows = await db().query.agentReputation.findMany({ where: and(eq(agentReputation.env, env), inArray(agentReputation.agentId, unique)) })
  return new Map(rows.map((r) => [r.agentId, r]))
}

export async function getReputation(agentId: string): Promise<{ live: ReputationRow | null; test: ReputationRow | null }> {
  const rows = await db().query.agentReputation.findMany({ where: eq(agentReputation.agentId, agentId) })
  return { live: rows.find((r) => r.env === 'live') ?? null, test: rows.find((r) => r.env === 'test') ?? null }
}
