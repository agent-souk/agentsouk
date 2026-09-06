import { and, desc, eq, inArray, lt, or, type SQL } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { agentReputation, agents, jobs, reviews, settlements, type Env, type ReputationSide } from '../../db/schema.js'
import { errors } from '../../lib/errors.js'
import { newId } from '../../lib/ids.js'
import { scanText } from '../../lib/content-safety.js'
import { emit } from '../../events/bus.js'
import { recordListingOutcome } from '../listings/service.js'
import { isBuyerCancellation, isCompletedJob, isDeliveryUnpaid, isRefundDue, isRefunded, isSellerFailure, isUnpaidExpiry, isWalkAway, paidValue } from '../jobs/outcomes.js'
import type { Agent } from '../../middleware/auth.js'

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
export const TRUST_T1 = { minCompleted: 5, minCounterparties: 3, minPayingAddresses: 3 }

export const emptySide = (): ReputationSide => ({
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
  volume_usdc: 0,
  rating_avg: null,
  rating_count: 0,
  on_time_rate: null,
})

export function bayesianRating(sum: number, n: number): number | null {
  if (n === 0) return null
  return Math.round(((sum + PRIOR_MEAN * PRIOR_WEIGHT) / (n + PRIOR_WEIGHT)) * 100) / 100
}

type SideResult = { side: ReputationSide; payingAddresses: number }

function sideFromJobs(list: JobRow[], side: 'seller' | 'buyer', ratings: ReviewRow[], stl: Map<string, SettlementRow[]>): SideResult {
  const completed = list.filter(isCompletedJob)
  const counterpartyId = (j: JobRow) => (side === 'seller' ? j.buyerAgentId : j.sellerAgentId)
  const settledPayments = (j: JobRow) => (stl.get(j.id) ?? []).filter((s) => s.kind === 'payment' && s.status === 'settled')
  const refundsOf = (j: JobRow) => (stl.get(j.id) ?? []).filter((s) => s.kind === 'refund')
  // Counterparties: distinct wallet addresses on paid jobs; agents met only through free jobs count by id.
  const addresses = new Set<string>()
  const paidIds = new Set<string>()
  const freeIds = new Set<string>()
  let volume = 0
  for (const j of completed) {
    const pays = settledPayments(j)
    if (pays.length) {
      for (const s of pays) addresses.add((side === 'seller' ? s.payerAddress : s.payTo).toLowerCase())
      paidIds.add(counterpartyId(j))
      volume += pays.reduce((sum, s) => sum + s.amount, 0) - refundsOf(j).reduce((sum, s) => sum + s.amount, 0)
    } else if (paidValue(j) === 0) freeIds.add(counterpartyId(j))
  }
  const ids = new Set([...freeIds].filter((id) => !paidIds.has(id)))
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
    volume_usdc: Math.max(0, volume),
    rating_avg: bayesianRating(
      ratings.reduce((s, r) => s + r.rating, 0),
      ratings.length,
    ),
    rating_count: ratings.length,
    on_time_rate: side === 'seller' && delivered.length ? Math.round((onTime.length / delivered.length) * 100) / 100 : null,
  }
  return { side: sideStats, payingAddresses: addresses.size }
}

export function scoreOf(asSeller: ReputationSide, asBuyer: ReputationSide): number {
  const rating = asSeller.rating_avg ?? asBuyer.rating_avg
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
  const seller = sideFromJobs(all.filter((j) => j.sellerAgentId === agentId), 'seller', revs.filter((r) => r.role === 'buyer'), stl)
  const buyer = sideFromJobs(all.filter((j) => j.buyerAgentId === agentId), 'buyer', revs.filter((r) => r.role === 'seller'), stl)
  const asSeller = seller.side
  const asBuyer = buyer.side
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
    if (completed >= TRUST_T1.minCompleted && parties >= TRUST_T1.minCounterparties && paying >= TRUST_T1.minPayingAddresses) {
      const a = await db().query.agents.findFirst({ where: eq(agents.id, agentId), columns: { trustTier: true } })
      if (a && a.trustTier < 1) await db().update(agents).set({ trustTier: 1, updatedAt: now }).where(eq(agents.id, agentId))
    }
  }
  return (await db().query.agentReputation.findFirst({ where: and(eq(agentReputation.agentId, agentId), eq(agentReputation.env, env)) }))!
}

// --- CONTRACT used by jobs ---------------------------------------------------------------------

export async function recordJobOutcome(job: JobRow): Promise<void> {
  await recomputeReputation(job.env, job.sellerAgentId)
  await recomputeReputation(job.env, job.buyerAgentId)
}

// --- reviews ----------------------------------------------------------------------------------

export async function createReview(env: Env, reviewer: Agent, jobId: string, rating: number, comment?: string): Promise<ReviewRow> {
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
    createdAt: Date.now(),
  }
  await db().insert(reviews).values(row)
  await recomputeReputation(env, subject)
  if (job.listingId) await recordListingOutcome({ listingId: job.listingId, status: 'completed', buyerAgentId: job.buyerAgentId, price: job.price ?? 0 })
  await emit(env, subject, 'review.received', { review_id: row.id, job_id: jobId, from: reviewer.id, role, rating, comment: row.comment, content_warnings: scan.warnings })
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

export async function getReputation(agentId: string): Promise<{ live: ReputationRow | null; test: ReputationRow | null }> {
  const rows = await db().query.agentReputation.findMany({ where: eq(agentReputation.agentId, agentId) })
  return { live: rows.find((r) => r.env === 'live') ?? null, test: rows.find((r) => r.env === 'test') ?? null }
}
