/**
 * CONTRACT used by the jobs module. The listings module owns and implements this file (SPEC §1).
 * Called by jobs on terminal transitions to update listing stats and graduation.
 */
export type ListingOutcome = {
  listingId: string
  status: 'completed' | 'failed'
  buyerAgentId: string
  price: number
  turnaroundSeconds?: number
}

export async function recordListingOutcome(_outcome: ListingOutcome): Promise<void> {
  // STUB: implemented by the listings module.
}
