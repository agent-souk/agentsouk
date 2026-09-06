import { and, desc, eq, lt, or, type SQL } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { agentReputation, agents, jobs, reviews, type Env, type ReputationSide } from '../../db/schema.js'
import { errors } from '../../lib/errors.js'
import { newId } from '../../lib/ids.js'
import { scanText } from '../../lib/content-safety.js'
import { emit } from '../../events/bus.js'
import { recordListingOutcome } from '../listings/service.js'
import type { Agent } from '../../middleware/auth.js'

/**
 * Reviews & reputation (SPEC §5, ADR-9). Reputation is computed ONLY from settled jobs: a review can
 * only exist for a job that reached completed/resolved, one per party, weighted by the settled value.
 */

export type JobRow = typeof jobs.$inferSelect
export type ReviewRow = typeof reviews.$inferSelect
export type ReputationRow = typeof agentReputation.$inferSelect

const PRIOR_MEAN = 3.5
const PRIOR_WEIGHT = 5
export const TRUST_T1 = { minCompleted: 5, minCounterparties: 3 }

export const emptySide = (): ReputationSide => ({
  jobs_completed: 0,
  jobs_failed: 0,
  jobs_disputed: 0,
  jobs_cancelled: 0,
  distinct_counterparties: 0,
  volume_crd: 0,
  rating_avg: null,
  rating_count: 0,
  on_time_rate: null,
})

export function bayesianRating(sum: number, n: number): number | null {
  if (n === 0) return null
  return Math.round(((sum + PRIOR_MEAN * PRIOR_WEIGHT) / (n + PRIOR_WEIGHT)) * 100) / 100
}

function isCompleted(j: JobRow): boolean {
  return j.status === 'completed' || (j.status === 'resolved' && (j.resolution?.seller_payout ?? 0) > 0)
}
function settledValue(j: JobRow): number {
  return j.status === 'resolved' ? (j.resolution?.seller_payout ?? 0) : (j.price ?? 0)
}

function sideFromJobs(list: JobRow[], side: 'seller' | 'buyer', ratings: ReviewRow[]): ReputationSide {
  const completed = list.filter(isCompleted)
  const counterparty = (j: JobRow) => (side === 'seller' ? j.buyerAgentId : j.sellerAgentId)
  const failed = side === 'seller' ? list.filter((j) => ((j.status === 'cancelled' || j.status === 'expired') && j.acceptedAt != null) || (j.status === 'resolved' && (j.resolution?.seller_payout ?? 0) === 0)) : []
  const cancelled = side === 'seller' ? list.filter((j) => j.status === 'cancelled' && (j.cancelReason ?? '').startsWith('seller:')) : list.filter((j) => j.status === 'cancelled' && (j.cancelReason ?? '').startsWith('buyer:'))
  const disputed = list.filter((j) => j.disputeReason != null)
  const delivered = list.filter((j) => j.deliveredAt != null && j.deadlineAt != null)
  const onTime = delivered.filter((j) => j.deliveredAt! <= j.deadlineAt!)
  return {
    jobs_completed: completed.length,
    jobs_failed: failed.length,
    jobs_disputed: disputed.length,
    jobs_cancelled: cancelled.length,
    distinct_counterparties: new Set(completed.map(counterparty)).size,
    volume_crd: completed.reduce((s, j) => s + settledValue(j), 0),
    rating_avg: bayesianRating(
      ratings.reduce((s, r) => s + r.rating, 0),
      ratings.length,
    ),
    rating_count: ratings.length,
    on_time_rate: side === 'seller' && delivered.length ? Math.round((onTime.length / delivered.length) * 100) / 100 : null,
  }
}

export function scoreOf(asSeller: ReputationSide, asBuyer: ReputationSide): number {
  const rating = asSeller.rating_avg ?? asBuyer.rating_avg
  const ratingNorm = rating == null ? 0.5 : (rating - 1) / 4
  const volume = asSeller.volume_crd + asBuyer.volume_crd
  const volumeNorm = Math.min(1, Math.log10(1 + volume) / 6)
  const done = asSeller.jobs_completed + asBuyer.jobs_completed
  const bad = asSeller.jobs_failed + asSeller.jobs_cancelled + asBuyer.jobs_cancelled
  const completionRate = done + bad === 0 ? 0 : done / (done + bad)
  const onTime = asSeller.on_time_rate ?? (done ? 1 : 0)
  return Math.max(0, Math.min(100, Math.round(40 * ratingNorm + 30 * volumeNorm + 20 * completionRate + 10 * onTime)))
}

export async function recomputeReputation(env: Env, agentId: string): Promise<ReputationRow> {
  const all = await db().query.jobs.findMany({ where: and(eq(jobs.env, env), or(eq(jobs.sellerAgentId, agentId), eq(jobs.buyerAgentId, agentId))) })
  const revs = await db().query.reviews.findMany({ where: and(eq(reviews.env, env), eq(reviews.subjectAgentId, agentId)) })
  const asSeller = sideFromJobs(all.filter((j) => j.sellerAgentId === agentId), 'seller', revs.filter((r) => r.role === 'buyer'))
  const asBuyer = sideFromJobs(all.filter((j) => j.buyerAgentId === agentId), 'buyer', revs.filter((r) => r.role === 'seller'))
  const score = scoreOf(asSeller, asBuyer)
  const now = Date.now()
  await db()
    .insert(agentReputation)
    .values({ agentId, env, asSeller, asBuyer, score, updatedAt: now })
    .onConflictDoUpdate({ target: [agentReputation.agentId, agentReputation.env], set: { asSeller, asBuyer, score, updatedAt: now } })
  if (env === 'live') {
    const completed = asSeller.jobs_completed + asBuyer.jobs_completed
    const parties = Math.max(asSeller.distinct_counterparties, asBuyer.distinct_counterparties)
    if (completed >= TRUST_T1.minCompleted && parties >= TRUST_T1.minCounterparties) {
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
    throw errors.state('job_not_settled', `Reviews are possible once a job is completed or resolved (current status: ${job.status}).`, 'Finish the job first; reviews are anchored to settled escrow so they cannot be faked.')
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
    jobPrice: settledValue(job),
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
