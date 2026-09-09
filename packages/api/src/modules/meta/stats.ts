import { and, eq, sql } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { agents, jobs, jobSeries, listings, bounties, settlements, type Env } from '../../db/schema.js'
import { isOurWallet, ourFundedWallets } from '../payments/our-money.js'

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
   *
   * ADR-43/44: a job only counts once money the buyer owned actually moved and stayed moved. Every subtraction
   * is published in `excluded` so the arithmetic can be checked from outside rather than believed. See
   * betweenOutsiders() for the rule; `volume_usdc_completed` is NET (gross is next to it, so wash trading is
   * visible as the gap between them).
   */
  between_outsiders: {
    /**
     * ADR-46: orders ever PLACED with us on neither side, whatever became of them. Published because everything
     * else here counts finished work, so a marketplace nobody ever orders from and one whose orders all fail look
     * the same. It is the widest mouth of the funnel and the least demanding number on this page.
     */
    orders: number
    orders_from_distinct_wallets: number
    jobs_completed: number
    volume_usdc_completed: number
    gross_volume_usdc: number
    distinct_buyers: number
    distinct_sellers: number
    excluded: { no_money_moved: number; below_price_floor: number; funded_by_us: number; refunded: number }
  }
  generated_at: string
}

/**
 * ADR-44: below this, a "purchase" is not evidence of anything. Two free registrations and one millionth of a
 * dollar used to be enough to move every headline field of between_outsiders off zero.
 */
export const OUTSIDER_PRICE_FLOOR = 10_000 // 0.01 USDC

/**
 * The one figure the go/no-go decision reads, computed so that neither we nor a single operator with two
 * registrations can move it for free (ADR-39, corrected by ADR-43 and ADR-44).
 *
 * A job counts only if all of these hold:
 *   - neither party was operated by Agent Souk WHEN THE JOB WAS CREATED (the frozen jobs.first_party_involved,
 *     never the live agents.first_party, which one admin call could flip to reclassify our whole history);
 *   - at least OUTSIDER_PRICE_FLOOR of USDC was actually settled on chain for it;
 *   - the buyer was not spending money that came from us - our sandbox faucet, or anything our own agents have
 *     paid out, followed through every further payment we can see;
 *   - it was not refunded in full.
 *
 * Buyers, sellers and volume are then counted on NET position, not on gross transfers: a wallet is a buyer only
 * if it ended up poorer across the counted set, a seller only if it ended up richer. A ring of wallets passing
 * one coin around nets to zero for everyone and therefore reports nothing, which is what it is.
 */
async function betweenOutsiders(env: Env): Promise<PlatformStats['between_outsiders']> {
  // One definition of "money that came from us", shared with the per-agent reputation (ADR-45): the two drifting
  // apart is how ADR-43 happened. See modules/payments/our-money.ts for what the trail does and does not cover.
  const our = await ourFundedWallets(env)
  const paidOn = sql`(select coalesce(sum(st.amount), 0) from settlements st where st.job_id = j.id and st.kind = 'payment' and st.status = 'settled')`
  const refundedOn = sql`(select coalesce(sum(st.amount), 0) from settlements st where st.job_id = j.id and st.kind = 'refund' and st.status = 'settled')`
  const fromUs = sql`exists (select 1 from settlements st where st.job_id = j.id and st.kind = 'payment' and st.status = 'settled' and ${isOurWallet(sql`st.payer_address`, our)})`
  const outsiderJobs = sql`from jobs j where j.env = ${env} and j.status in ('completed','resolved') and j.first_party_involved = 0`

  const row = await db().get<{ jobs: number; buyers: number; sellers: number; net: number; gross: number; ex_no_money: number; ex_floor: number; ex_ours: number; ex_refunded: number; orders: number; order_wallets: number }>(sql`
    with counted as (select j.id ${outsiderJobs} and ${paidOn} >= ${OUTSIDER_PRICE_FLOOR} and not ${fromUs} and ${refundedOn} < ${paidOn}),
    flows as (
        select lower(st.payer_address) addr, -st.amount delta from settlements st join counted c on c.id = st.job_id where st.status = 'settled'
      union all
        select lower(st.pay_to) addr, st.amount delta from settlements st join counted c on c.id = st.job_id where st.status = 'settled'
    ),
    net as (select addr, sum(delta) n from flows group by addr)
    select
      (select count(*) from counted) jobs,
      (select count(*) from net where n < 0) buyers,
      (select count(*) from net where n > 0) sellers,
      (select coalesce(-sum(n), 0) from net where n < 0) net,
      (select coalesce(sum(st.amount), 0) from settlements st join counted c on c.id = st.job_id where st.kind = 'payment' and st.status = 'settled') gross,
      (select count(*) ${outsiderJobs} and ${paidOn} = 0) ex_no_money,
      (select count(*) ${outsiderJobs} and ${paidOn} > 0 and ${paidOn} < ${OUTSIDER_PRICE_FLOOR}) ex_floor,
      (select count(*) ${outsiderJobs} and ${paidOn} >= ${OUTSIDER_PRICE_FLOOR} and ${fromUs}) ex_ours,
      (select count(*) ${outsiderJobs} and ${paidOn} >= ${OUTSIDER_PRICE_FLOOR} and not ${fromUs} and ${refundedOn} >= ${paidOn}) ex_refunded,
      (select count(*) from jobs j where j.env = ${env} and j.first_party_involved = 0) orders,
      (select count(distinct coalesce(lower(b.wallet_address), 'agent:' || j.buyer_agent_id)) from jobs j join agents b on b.id = j.buyer_agent_id
         where j.env = ${env} and j.first_party_involved = 0) order_wallets
  `)
  return {
    orders: row?.orders ?? 0,
    orders_from_distinct_wallets: row?.order_wallets ?? 0,
    jobs_completed: row?.jobs ?? 0,
    volume_usdc_completed: row?.net ?? 0,
    gross_volume_usdc: row?.gross ?? 0,
    distinct_buyers: row?.buyers ?? 0,
    distinct_sellers: row?.sellers ?? 0,
    excluded: { no_money_moved: row?.ex_no_money ?? 0, below_price_floor: row?.ex_floor ?? 0, funded_by_us: row?.ex_ours ?? 0, refunded: row?.ex_refunded ?? 0 },
  }
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
  const outsiders = await betweenOutsiders(env)
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
    between_outsiders: outsiders,
    generated_at: new Date(now).toISOString(),
  }
}
