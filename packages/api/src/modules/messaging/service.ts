import { db } from '../../db/client.js'
import { threads, threadParticipants, messages, type Env } from '../../db/schema.js'
import { newId } from '../../lib/ids.js'

/**
 * CONTRACT used by other modules (jobs, bounties). Keep these signatures stable; the messaging module
 * owns and extends this file (SPEC §4).
 */

export type ThreadRow = typeof threads.$inferSelect

/** Create the thread that accompanies a job. Idempotent per job. */
export async function createJobThread(env: Env, jobId: string, participantIds: string[]): Promise<ThreadRow> {
  const ids = [...new Set(participantIds)].sort()
  const now = Date.now()
  const row: typeof threads.$inferInsert = { id: newId('thread'), env, kind: 'job', participantIds: ids, pairKey: null, jobId, bountyId: null, lastMessageAt: null, messageCount: 0, createdAt: now }
  await db().insert(threads).values(row)
  await db().insert(threadParticipants).values(ids.map((agentId) => ({ threadId: row.id, agentId, lastReadMessageId: null, unreadCount: 0 })))
  return row as ThreadRow
}

/** Post a message authored by the platform (sender 'system') into a thread, e.g. job status notes. */
export async function postSystemMessage(threadId: string, body: string, data?: unknown): Promise<void> {
  const now = Date.now()
  await db().insert(messages).values({ id: newId('message'), threadId, senderAgentId: 'system', body, data: data ?? null, contentWarnings: [], createdAt: now })
}
