import type { jobs } from '../../db/schema.js'

/**
 * How a finished job counts (SPEC-PAYMENTS §9). Shared by listings stats and reputation so both agree.
 * Imports nothing from services (no cycles).
 */
type J = Pick<typeof jobs.$inferSelect, 'status' | 'resolution' | 'cancelKind' | 'acceptedAt' | 'unpaid' | 'output' | 'refundDue' | 'refundedAt' | 'paidAt' | 'price'>

/** completed, or resolved in favour of the seller / split */
export function isCompletedJob(j: J): boolean {
  return j.status === 'completed' || (j.status === 'resolved' && j.resolution?.outcome !== 'buyer')
}

/** the seller did not deliver what it promised */
export function isSellerFailure(j: J): boolean {
  if (j.status === 'resolved') return j.resolution?.outcome === 'buyer'
  if (j.status === 'cancelled') return j.cancelKind === 'seller_failed' || j.cancelKind === 'buyer_after_deadline'
  return false
}

/**
 * The seller never answered at all and the order died in its own accept window (ADR-41). Not a failed delivery -
 * nothing was ever started - but the thing that kills a marketplace fastest: on 2026-09-08 the only order that
 * ever looked like real demand between two outside agents (moneymaker -> veriton, 0.02 USDC) expired unaccepted,
 * and the seller's record stayed spotless. The window is the SELLER's own accept_timeout_seconds from its own
 * listing, so this counts nothing but a promise the seller set and did not keep. Declining is an answer and does
 * not count here.
 */
export function isSellerNoShow(j: J): boolean {
  return j.status === 'expired' && j.acceptedAt == null
}

/**
 * A deadline the seller let pass: cancelled after it (by the buyer, or by the platform an hour later) or given up
 * while working. Counted as LATE in on_time_rate (ADR-58) - until 0.5.8 such a job simply left the statistic, so
 * a seller with one punctual delivery and one abandoned revision read 100 % on time.
 */
export function isMissedDeadline(j: J): boolean {
  return j.status === 'cancelled' && (j.cancelKind === 'buyer_after_deadline' || j.cancelKind === 'seller_failed')
}

/** One description for the one counter, wherever it is published (reputation, listing card). */
export const JOBS_FAILED_DESCRIPTION = 'Jobs the seller accepted and did not deliver - cancelled by the seller while working, cancelled by the buyer after the deadline, or closed by the platform an hour after the deadline the seller set (ADR-57) - or lost in a dispute.'

/** the buyer cancelled a sealed delivery instead of paying (no mark for the buyer, informational for both) */
export function isWalkAway(j: J): boolean {
  return j.status === 'cancelled' && j.cancelKind === 'buyer_walked_away'
}

/** the buyer let the payment window pass in silence */
export function isUnpaidExpiry(j: J): boolean {
  return j.status === 'expired' && j.unpaid
}

/** a sealed delivery that was never paid (walk-away or silent expiry) */
export function isDeliveryUnpaid(j: J): boolean {
  return isWalkAway(j) || (isUnpaidExpiry(j) && j.output != null)
}

/** a buyer cancellation that is neither a walk-away nor a seller failure */
export function isBuyerCancellation(j: J): boolean {
  return j.status === 'cancelled' && j.cancelKind === 'buyer_withdrew'
}

export function isRefundDue(j: J): boolean {
  return j.refundDue && j.refundedAt == null
}

export function isRefunded(j: J): boolean {
  return j.refundedAt != null
}

/** USDC minor units the job settled for (0 for free or unpaid jobs) */
export function paidValue(j: J): number {
  return j.paidAt != null ? (j.price ?? 0) : 0
}
