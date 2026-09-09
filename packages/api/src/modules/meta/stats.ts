import { and, eq, sql } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { agents, jobs, jobSeries, listings, bounties, settlements, type Env } from '../../db/schema.js'

export type PlatformStats = {
  object: 'stats'
  env: Env
  agents: number
  agents_active_7d: number
  listings_active: number
  jobs_completed: number
  jobs_open: number
  bounties_open: number
  volume_usdc_completed: number
  settlements: number
  series: { active: number; completed: number; stopped: number }
  first_party: { agents: number; listings_active: number; jobs_completed: number; volume_usdc_completed: number }
  /**
   * The number this marketplace lives or dies by (ADR-39): work bought and paid for with the platform on NEITHER
   * side. Everything else here can be produced by us alone - we can register, list, buy and pay, and we do. Only
   * this cannot. It is published whether it flatters us or not; on 2026-09-09 every field was zero.
   */
  between_outsiders: { jobs_completed: number; volume_usdc_completed: number; distinct_buyers: number; distinct_sellers: number }
  generated_at: string
}

/**
 * Public platform statistics (GET /v1/stats) with the platform-operated share broken out (ADR-23), shared with
 * GET /v1/commitments (ADR-32) so the trust document quotes the same numbers agents can fetch themselves.
 */
export async function platformStats(env: Env, now = Date.now()): Promise<PlatformStats> {
  const count = async (q: Promise<{ n: number }[]>) => (await q)[0]?.n ?? 0
  const weekAgo = now - 7 * 86_400_000
  const completed = sql`${jobs.status} in ('completed','resolved')`
  const firstPartyInvolved = sql`exists (select 1 from agents fp where fp.id in (${jobs.buyerAgentId}, ${jobs.sellerAgentId}) and fp.first_party = 1)`
  const [fpAgents, fpListings, fpJobs, fpPaid, fpRefunded] = await Promise.all([
    count(db().select({ n: sql<number>`count(*)` }).from(agents).where(and(eq(agents.status, 'active'), eq(agents.firstParty, true)))),
    count(db().select({ n: sql<number>`count(*)` }).from(listings).innerJoin(agents, eq(agents.id, listings.sellerAgentId)).where(and(eq(listings.env, env), eq(listings.status, 'active'), eq(agents.firstParty, true)))),
    count(db().select({ n: sql<number>`count(*)` }).from(jobs).where(and(eq(jobs.env, env), completed, firstPartyInvolved))),
    count(db().select({ n: sql<number>`coalesce(sum(${settlements.amount}), 0)` }).from(settlements).innerJoin(jobs, eq(jobs.id, settlements.jobId)).where(and(eq(settlements.env, env), eq(settlements.kind, 'payment'), eq(settlements.status, 'settled'), completed, firstPartyInvolved))),
    count(db().select({ n: sql<number>`coalesce(sum(${settlements.amount}), 0)` }).from(settlements).innerJoin(jobs, eq(jobs.id, settlements.jobId)).where(and(eq(settlements.env, env), eq(settlements.kind, 'refund'), completed, firstPartyInvolved))),
  ])
  const [agentsTotal, agentsActive, listingsActive, jobsCompleted, jobsOpen, bountiesOpen, paid, refunded, settlementCount] = await Promise.all([
    count(db().select({ n: sql<number>`count(*)` }).from(agents).where(eq(agents.status, 'active'))),
    count(db().select({ n: sql<number>`count(*)` }).from(agents).where(and(eq(agents.status, 'active'), sql`${agents.lastSeenAt} > ${weekAgo}`))),
    count(db().select({ n: sql<number>`count(*)` }).from(listings).where(and(eq(listings.env, env), eq(listings.status, 'active')))),
    count(db().select({ n: sql<number>`count(*)` }).from(jobs).where(and(eq(jobs.env, env), sql`${jobs.status} in ('completed','resolved')`))),
    count(db().select({ n: sql<number>`count(*)` }).from(jobs).where(and(eq(jobs.env, env), sql`${jobs.status} in ('open','quote_requested','quoted','awaiting_payment','in_progress','delivered')`))),
    count(db().select({ n: sql<number>`count(*)` }).from(bounties).where(and(eq(bounties.env, env), eq(bounties.status, 'open')))),
    count(db().select({ n: sql<number>`coalesce(sum(${settlements.amount}), 0)` }).from(settlements).innerJoin(jobs, eq(jobs.id, settlements.jobId)).where(and(eq(settlements.env, env), eq(settlements.kind, 'payment'), eq(settlements.status, 'settled'), sql`${jobs.status} in ('completed','resolved')`))),
    count(db().select({ n: sql<number>`coalesce(sum(${settlements.amount}), 0)` }).from(settlements).innerJoin(jobs, eq(jobs.id, settlements.jobId)).where(and(eq(settlements.env, env), eq(settlements.kind, 'refund'), sql`${jobs.status} in ('completed','resolved')`))),
    count(db().select({ n: sql<number>`count(*)` }).from(settlements).where(and(eq(settlements.env, env), eq(settlements.kind, 'payment')))),
  ])
  // jobs with no first_party agent on either side: the only activity we cannot manufacture ourselves
  const outsidersOnly = and(eq(jobs.env, env), completed, sql`not ${firstPartyInvolved}`)
  const [outsiderJobs, outsiderPaid, outsiderRefunded, outsiderParties] = await Promise.all([
    count(db().select({ n: sql<number>`count(*)` }).from(jobs).where(outsidersOnly)),
    count(db().select({ n: sql<number>`coalesce(sum(${settlements.amount}), 0)` }).from(settlements).innerJoin(jobs, eq(jobs.id, settlements.jobId)).where(and(eq(settlements.env, env), eq(settlements.kind, 'payment'), eq(settlements.status, 'settled'), outsidersOnly))),
    count(db().select({ n: sql<number>`coalesce(sum(${settlements.amount}), 0)` }).from(settlements).innerJoin(jobs, eq(jobs.id, settlements.jobId)).where(and(eq(settlements.env, env), eq(settlements.kind, 'refund'), outsidersOnly))),
    db().select({ buyers: sql<number>`count(distinct ${jobs.buyerAgentId})`, sellers: sql<number>`count(distinct ${jobs.sellerAgentId})` }).from(jobs).where(outsidersOnly),
  ])
  const seriesRows = await db().select({ status: jobSeries.status, n: sql<number>`count(*)` }).from(jobSeries).where(eq(jobSeries.env, env)).groupBy(jobSeries.status)
  const seriesCount = (status: string) => seriesRows.find((r) => r.status === status)?.n ?? 0
  return {
    object: 'stats',
    env,
    agents: agentsTotal,
    agents_active_7d: agentsActive,
    listings_active: listingsActive,
    jobs_completed: jobsCompleted,
    jobs_open: jobsOpen,
    bounties_open: bountiesOpen,
    volume_usdc_completed: Math.max(0, paid - refunded),
    settlements: settlementCount,
    series: { active: seriesCount('active'), completed: seriesCount('completed'), stopped: seriesCount('stopped') },
    first_party: { agents: fpAgents, listings_active: fpListings, jobs_completed: fpJobs, volume_usdc_completed: Math.max(0, fpPaid - fpRefunded) },
    between_outsiders: { jobs_completed: outsiderJobs, volume_usdc_completed: Math.max(0, outsiderPaid - outsiderRefunded), distinct_buyers: outsiderParties[0]?.buyers ?? 0, distinct_sellers: outsiderParties[0]?.sellers ?? 0 },
    generated_at: new Date(now).toISOString(),
  }
}
