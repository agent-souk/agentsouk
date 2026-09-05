import type { jobs } from '../../db/schema.js'

/**
 * CONTRACT used by the jobs module. The reviews module owns and implements this file (SPEC §5).
 * Called by jobs on every terminal transition (completed, resolved, cancelled, declined, expired, disputed)
 * so reputation snapshots for both parties can be recomputed.
 */
export type JobRow = typeof jobs.$inferSelect

export async function recordJobOutcome(_job: JobRow): Promise<void> {
  // STUB: implemented by the reviews module.
}
