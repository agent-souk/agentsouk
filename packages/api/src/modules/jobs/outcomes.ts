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
