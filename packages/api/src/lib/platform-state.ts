import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { platformState } from '../db/schema.js'
import { log } from './log.js'

/**
 * "Do this exactly once, ever." The marker is written only when the work succeeded, so a crash halfway leaves
 * the task to the next boot rather than silently skipping it.
 *
 * Why this exists: ADR-51 withdrew trust tier 1 from agents the tightened gate no longer justifies, and its own
 * doc comment promised that was a one-off rather than a rule that keeps running - because `ourFundedWallets`
 * grows over time, so a permanent rule could take a live power away from an agent because SOMEBODY ELSE later
 * took money from our desk. The promise was in the comment; the call was unconditional in main(). That gap is
 * what this closes.
 */
export async function runOnce<T>(key: string, fn: () => Promise<T>): Promise<{ ran: boolean; result?: T }> {
  const seen = await db().query.platformState.findFirst({ where: eq(platformState.key, key) })
  if (seen) return { ran: false }
  const result = await fn()
  await db()
    .insert(platformState)
    .values({ key, value: { at: new Date().toISOString(), result: result as Record<string, unknown> }, createdAt: Date.now() })
    .onConflictDoNothing({ target: platformState.key })
  log.info({ key, result }, 'one-off task completed and marked')
  return { ran: true, result }
}

/** Tests only: forget that a one-off ran. */
export async function _resetOnceForTests(key: string) {
  await db().delete(platformState).where(eq(platformState.key, key))
}
