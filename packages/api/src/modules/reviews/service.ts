import { and, desc, eq, inArray, lt, or, type SQL } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { agentReputation, agents, bounties, jobs, listings, reviews, settlements, type CategoryCard, type Env, type ReputationSide } from '../../db/schema.js'
import { OUTSIDER_PRICE_FLOOR } from '../meta/stats.js'
import { ourFundedWallets } from '../payments/our-money.js'
import { errors } from '../../lib/errors.js'
import { newId } from '../../lib/ids.js'
import { log } from '../../lib/log.js'
import { scanText } from '../../lib/content-safety.js'
import { emit } from '../../events/bus.js'
import { recordListingOutcome } from '../listings/service.js'
import { isBuyerCancellation, isCompletedJob, isDeliveryUnpaid, isRefundDue, isRefunded, isSellerFailure, isSellerNoShow, isUnpaidExpiry, isWalkAway, paidValue } from '../jobs/outcomes.js'
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
/**
 * T1: proven by paid live jobs. Volume in USDC minor units (10 USDC) keeps dust-priced farming from counting.
 *
 * ADR-51: `minPayingAgents` is a genuinely second counter. Until now the gate read as four checks and was three -
 * `third_party_counterparties` and the paying-addresses count were assigned the same set, so one identity that
 * changed its wallet twice supplied all three "different paying wallets". Wallets are cheap; a registration is
 * not free of a payment above the floor, so the two counters together cost real money to satisfy.
 */
export const TRUST_T1 = { minCompleted: 5, minCounterparties: 3, minPayingAgents: 3, minVolumeUsdc: 10_000_000 }

/**
 * Whether ONE side of the market has earned tier 1 on its own. The gate used to add the two sides' job counts and
 * volumes together while taking the maximum of their counterparty counts - three completed sales plus two
 * purchases, and the parties of whichever side had more. That is not a sentence anyone can check. Now it is:
 * five completed live jobs as a seller, or five as a buyer, paid by three different agents at three different
 * wallets, ten USDC in total, on that same side.
 */
export function qualifiesT1(side: ReputationSide | undefined | null): boolean {
  if (!side) return false
  return (
    (side.jobs_completed ?? 0) >= TRUST_T1.minCompleted &&
    (side.third_party_counterparties ?? 0) >= TRUST_T1.minCounterparties &&
    (side.third_party_paying_agents ?? 0) >= TRUST_T1.minPayingAgents &&
    (side.third_party_volume_usdc ?? 0) >= TRUST_T1.minVolumeUsdc
  )
}

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
  orders_ignored: 0,
  response_rate: null,
  refunds_due: 0,
  refunds_made: 0,
  distinct_counterparties: 0,
  first_party_counterparties: 0,
  third_party_counterparties: 0,
  third_party_paying_agents: 0,
  counterparties_without_payment: 0,
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
function sideFromJobs(
  list: JobRow[],
  side: 'seller' | 'buyer',
  ratings: ReviewRow[],
  stl: Map<string, SettlementRow[]>,
  firstPartyIds: Set<string> = new Set(),
  ourWallets: Set<string> = new Set(),
  walletOf: Map<string, string | null> = new Map(),
): SideResult {
  const completed = list.filter(isCompletedJob)
  const counterpartyId = (j: JobRow) => (side === 'seller' ? j.buyerAgentId : j.sellerAgentId)
  const settledPayments = (j: JobRow) => (stl.get(j.id) ?? []).filter((s) => s.kind === 'payment' && s.status === 'settled')
  const refundsOf = (j: JobRow) => (stl.get(j.id) ?? []).filter((s) => s.kind === 'refund')
  // Counterparties: distinct wallet addresses on paid jobs; agents met only through free jobs count separately.
  const addresses = new Set<string>()
  const thirdPartyAddresses = new Set<string>()
  const paidIds = new Set<string>()
  // ADR-51: the same counterparties as thirdPartyAddresses, counted by AGENT instead of by wallet. Three wallets
  // belonging to one agent that rotated are three here-and-one-there; the gap between the two numbers is the point.
  const thirdPartyPaidIds = new Set<string>()
  const freeIds = new Set<string>()
  let volume = 0
  let thirdPartyVolume = 0
  for (const j of completed) {
    const pays = settledPayments(j)
    const firstParty = firstPartyIds.has(counterpartyId(j))
    // ADR-45, the same rule as between_outsiders one level down: a payment below the floor is not a purchase, and
    // money that came from us is not a third party's money - whichever side of the job this agent was on, the
    // wallet that PAID is the one that has to be independent.
    const paidTotal = pays.reduce((sum, s) => sum + s.amount, 0)
    const ourMoney = pays.some((s) => ourWallets.has(s.payerAddress.toLowerCase()))
    // Volume stays a plain fact: everything that settled, minus refunds, floor or no floor. Only the party COUNTS
    // carry the floor, because that is where dust bought something - a name in a list a buyer reads as demand.
    const net = paidTotal - refundsOf(j).reduce((sum, s) => sum + s.amount, 0)
    if (pays.length) {
      volume += net
      if (!firstParty && !ourMoney) thirdPartyVolume += net
    }
    if (pays.length && paidTotal >= OUTSIDER_PRICE_FLOOR) {
      for (const s of pays) {
        const address = (side === 'seller' ? s.payerAddress : s.payTo).toLowerCase()
        addresses.add(address)
        if (!firstParty && !ourMoney) thirdPartyAddresses.add(address)
      }
      paidIds.add(counterpartyId(j))
      if (!firstParty && !ourMoney) thirdPartyPaidIds.add(counterpartyId(j))
    } else freeIds.add(counterpartyId(j))
  }
  // ADR-45: counterparties met without money are counted, and named, on their own. They used to be added straight
  // into third_party_counterparties by agent id - the field GET /v1/commitments calls the honest demand signal -
  // so N throwaway registrations doing N jobs at a price of zero produced N "third parties that paid this seller".
  const ids = new Set([...freeIds].filter((id) => !paidIds.has(id)))
  const thirdPartyIds: string[] = []
  const failed = side === 'seller' ? list.filter(isSellerFailure) : []
  const cancelled = side === 'seller' ? list.filter((j) => j.status === 'cancelled' && j.cancelKind === 'seller_failed') : list.filter(isBuyerCancellation)
  /*
   * Answering an order at all (accepting or declining) against letting it die unanswered in one's own window.
   * ADR-45: counted by distinct BUYER WALLET, and only for buyers that had a wallet bound at all. Ordering costs
   * nothing, so counting raw orders handed every agent here a weapon: order from a competitor five times, let each
   * expire, and its public response_rate - printed on every one of its listings - falls to zero at no cost. Now one
   * buyer can move a seller's record by at most one, and a buyer that could never have paid moves it not at all.
   */
  const buyerWallet = (j: JobRow) => walletOf.get(j.buyerAgentId)?.toLowerCase() ?? null
  const walletsOf = (js: JobRow[]) => new Set(js.map(buyerWallet).filter((w): w is string => w != null))
  const answered = side === 'seller' ? walletsOf(list.filter((j) => j.acceptedAt != null || j.status === 'declined')) : new Set<string>()
  // Never answered at all, not "answered less often than it ordered": the two sets are disjoint, so a buyer this
  // seller has ever replied to does not also count against it. The case ADR-41 was built for is the seller that
  // leaves a buyer with no answer at all inside its own accept window.
  const ignored = side === 'seller' ? new Set([...walletsOf(list.filter(isSellerNoShow))].filter((w) => !answered.has(w))) : new Set<string>()
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
    orders_ignored: side === 'seller' ? ignored.size : 0,
    response_rate: side === 'seller' && answered.size + ignored.size > 0 ? Math.round((answered.size / (answered.size + ignored.size)) * 100) / 100 : null,
    refunds_due: side === 'seller' ? list.filter(isRefundDue).length : 0,
    refunds_made: side === 'seller' ? list.filter(isRefunded).length : 0,
    distinct_counterparties: addresses.size + ids.size,
    // A partition of distinct_counterparties (ADR-45): wallets that paid, split by whose money it was, plus the
    // counterparties no money ever passed between. first + third + without_payment = distinct.
    first_party_counterparties: addresses.size - thirdPartyAddresses.size,
    third_party_counterparties: thirdPartyAddresses.size,
    // ADR-51: of those wallets, how many DIFFERENT AGENTS they belonged to. Lower than the wallet count exactly
    // when someone changed wallet; trust tier 1 needs three of each.
    third_party_paying_agents: thirdPartyPaidIds.size,
    counterparties_without_payment: ids.size,
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

/** ADR-34: floor and cap of the suggested exposure, USDC minor units (0.10 and 100 USDC). */
export const EXPOSURE_FLOOR = 100_000
export const EXPOSURE_CAP = 100_000_000
export const EXPOSURE_METHOD = 'suggested_max_usdc = clamp(0.10 USDC, 0.10 USDC + 0.5 × third_party_volume_usdc × (1 − failure_rate), 100 USDC); failure_rate = jobs_failed / (jobs_completed + jobs_failed), where jobs_failed already includes seller cancellations and buyer verdicts; an open refund obligation pins it to the floor. Only third-party volume counts: purchases by the platform desk add nothing.'
export const EXPOSURE_NOTE = 'A suggestion computed from public on-chain history, not a limit anyone enforces, and not a promise that anything below it is safe. Start small; every completed step raises it.'

export type Exposure = {
  suggested_max_usdc: number
  display: string
  basis: { third_party_volume_usdc: number; third_party_counterparties: number; jobs_completed: number; jobs_failed: number; jobs_cancelled: number; refunds_due: number }
  reason: string
}

/**
 * ADR-34: how much a buyer might sensibly put at risk with this seller in one step, from what third parties have
 * verifiably paid it and how often it failed. Pure information: nothing enforces it (a buyer ordering above it gets
 * a warning, not a refusal), and it says nothing about safety below it.
 */
export function suggestedExposure(side: ReputationSide): Exposure {
  const volume = Math.max(0, side.third_party_volume_usdc ?? 0)
  // jobs_failed already counts seller cancellations (cancelKind seller_failed) and buyer verdicts; jobs_cancelled is a subset
  const failed = side.jobs_failed
  const total = side.jobs_completed + failed
  const failureRate = total ? failed / total : 0
  const basis = { third_party_volume_usdc: volume, third_party_counterparties: side.third_party_counterparties ?? 0, jobs_completed: side.jobs_completed, jobs_failed: side.jobs_failed, jobs_cancelled: side.jobs_cancelled, refunds_due: side.refunds_due }
  let suggested: number
  let reason: string
  if (side.refunds_due > 0) {
    suggested = EXPOSURE_FLOOR
    reason = `${side.refunds_due} refund obligation(s) open: pinned to the floor until they are settled on-chain.`
  } else {
    suggested = Math.min(EXPOSURE_CAP, Math.max(EXPOSURE_FLOOR, Math.round(EXPOSURE_FLOOR + 0.5 * volume * (1 - failureRate))))
    reason = volume === 0 ? 'no verified payment from a third party yet (purchases by the platform desk do not count): the floor.' : `${basis.third_party_counterparties} third-party wallet(s) paid ${(volume / 1_000_000).toFixed(6)} USDC in total${failed ? `; ${failed} of ${total} jobs failed or were cancelled` : ''}.`
  }
  return { suggested_max_usdc: suggested, display: `${(suggested / 1_000_000).toFixed(6)} USDC`, basis, reason }
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
  // ADR-45: the same "money that came from us" set the headline figure uses, and the counterparties' wallets, so a
  // buyer that could never have paid cannot damage a seller's public response rate.
  const ourWallets = await ourFundedWallets(env)
  const partyIds = [...new Set(all.flatMap((j) => [j.buyerAgentId, j.sellerAgentId]))]
  const partyRows = partyIds.length ? await db().query.agents.findMany({ where: inArray(agents.id, partyIds), columns: { id: true, walletAddress: true } }) : []
  const walletOf = new Map(partyRows.map((a) => [a.id, a.walletAddress]))
  const seller = sideFromJobs(all.filter((j) => j.sellerAgentId === agentId), 'seller', revs.filter((r) => r.role === 'buyer'), stl, firstParty, ourWallets, walletOf)
  const buyer = sideFromJobs(all.filter((j) => j.buyerAgentId === agentId), 'buyer', revs.filter((r) => r.role === 'seller'), stl, firstParty, ourWallets, walletOf)
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
    // ADR-32: only third parties count toward tier 1; the platform desk buying from a seller is not evidence of
    // demand. ADR-51: and the whole gate must be met on ONE side of the market, by three different agents at
    // three different wallets. Promote-only at runtime: a demotion here would take a live power away from an
    // agent because someone ELSE later took money from our desk (ourFundedWallets follows our money forward), so
    // the only lowering that ever happens is the one-time backfill in backfillTrustTier().
    if (qualifiesT1(asSeller) || qualifiesT1(asBuyer)) {
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
/**
 * Fields added to a stored reputation row after it was written. Each one reports null until the row is recomputed,
 * and this list is what the startup backfill looks at: it used to check only the ADR-32 split, so every field added
 * afterwards stayed null on old rows forever - including, for ADR-41, the very seller whose ignored order made the
 * field necessary. Add new nullable fields here.
 */
function needsRecompute(s: { third_party_counterparties?: number | null; orders_ignored?: number | null; counterparties_without_payment?: number | null; third_party_paying_agents?: number | null }): boolean {
  return s.third_party_counterparties == null || s.orders_ignored == null || s.counterparties_without_payment == null || s.third_party_paying_agents == null
}

/**
 * ADR-51, once: take tier 1 away from anyone whose live record does not meet the tightened gate.
 *
 * This is the only demotion this platform has ever performed, and it is deliberately a one-off at startup rather
 * than a rule that keeps running. A permanent demotion rule would let an agent lose a live power because someone
 * ELSE later took money from our desk - `ourFundedWallets` follows our own money forward, so a counterparty can
 * stop counting as a third party through no act of the agent whose tier it is. Tightening the entrance once is a
 * correction; a moving floor under a power an agent already has is a different and worse thing.
 *
 * Runs after backfillReputation(), because it reads the recomputed sides.
 */
export async function backfillTrustTier(): Promise<{ checked: number; demoted: number; errors: number }> {
  const rows = await db().query.agents.findMany({ where: eq(agents.trustTier, 1), columns: { id: true, handle: true } })
  let demoted = 0
  let errors = 0
  for (const a of rows) {
    try {
      const rep = await db().query.agentReputation.findFirst({ where: and(eq(agentReputation.agentId, a.id), eq(agentReputation.env, 'live')) })
      if (qualifiesT1(rep?.asSeller) || qualifiesT1(rep?.asBuyer)) continue
      await db().update(agents).set({ trustTier: 0, updatedAt: Date.now() }).where(and(eq(agents.id, a.id), eq(agents.trustTier, 1)))
      demoted += 1
      log.warn({ agentId: a.id, handle: a.handle }, 'ADR-51: trust tier 1 withdrawn, the live record does not meet the tightened gate')
    } catch (err) {
      errors += 1
      log.warn({ err, agentId: a.id }, 'trust tier backfill row failed')
    }
  }
  return { checked: rows.length, demoted, errors }
}

export async function backfillReputation(): Promise<{ recomputed: number; errors: number }> {
  const rows = await db().query.agentReputation.findMany({ columns: { agentId: true, env: true, asSeller: true } })
  let recomputed = 0
  let errors = 0
  for (const r of rows) {
    if (!needsRecompute(r.asSeller)) continue
    try {
      await recomputeReputation(r.env, r.agentId)
      recomputed += 1
    } catch (err) {
      errors += 1
      // the row keeps reporting null for the split until its next job outcome or review; make that visible in the deploy log
      log.warn({ err, agentId: r.agentId, env: r.env }, 'reputation backfill row failed')
    }
  }
  return { recomputed, errors }
}

/**
 * ADR-32: the first/third-party split is classified by the counterparty's first_party flag at recompute time, so
 * flagging or un-flagging an agent (POST /v1/admin/agents/{id}/first-party) recomputes everyone it ever traded with.
 * Admin-only and rare; the loop is bounded by the agent's distinct counterparties.
 */
export async function recomputeCounterpartiesOf(agentId: string): Promise<number> {
  const rows = await db().query.jobs.findMany({ where: or(eq(jobs.sellerAgentId, agentId), eq(jobs.buyerAgentId, agentId)), columns: { env: true, sellerAgentId: true, buyerAgentId: true } })
  const seen = new Set<string>()
  for (const j of rows) {
    const other = j.sellerAgentId === agentId ? j.buyerAgentId : j.sellerAgentId
    const key = `${j.env}:${other}`
    if (seen.has(key)) continue
    seen.add(key)
    await recomputeReputation(j.env, other)
  }
  for (const env of ['live', 'test'] as const) if (rows.some((j) => j.env === env)) await recomputeReputation(env, agentId)
  return seen.size
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
  // ADR-32 / AI Act Art. 50: everything a platform-operated agent writes here comes from its automated judge, so the
  // API applies the public label itself rather than trusting the client to send it
  const machine = machineGenerated || reviewer.firstParty === true
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
    machineGenerated: machine,
    createdAt: Date.now(),
  }
  await db().insert(reviews).values(row)
  await recomputeReputation(env, subject)
  if (job.listingId) await recordListingOutcome({ listingId: job.listingId, status: 'completed', buyerAgentId: job.buyerAgentId, price: job.price ?? 0 })
  await emit(env, subject, 'review.received', { review_id: row.id, job_id: jobId, from: reviewer.id, role, rating, comment: row.comment, machine_generated: machine, content_warnings: scan.warnings })
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
