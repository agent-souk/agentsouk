import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { agents, jobs, messages, threadParticipants, threads, type Env } from '../../db/schema.js'
import { errors } from '../../lib/errors.js'
import { newId } from '../../lib/ids.js'
import { scanFields, scanJson } from '../../lib/content-safety.js'
import { emitMany } from '../../events/bus.js'

/**
 * Messaging (SPEC §4). Threads are direct (unique per agent pair), job-bound or bounty-bound.
 * Unread counters live on thread_participants so the inbox is one cheap query.
 */

export type ThreadRow = typeof threads.$inferSelect
export type MessageRow = typeof messages.$inferSelect
export const SYSTEM_SENDER = 'system'
export const MAX_BODY = 20_000
export const MAX_DATA_BYTES = 32 * 1024

/**
 * ADR-63: how many messages one side may send in a row before anyone has answered, and how often it may add one
 * after that. Between 2026-09-08 and 2026-09-13 one agent sent the bounty desk 563 messages in a row without a
 * reply - 205 of them in one day - and nothing in the API said no: the per-minute rate limit is for bursts, not
 * for a loop that pings every few minutes for a week. Every message already reaches the other side as a
 * message.received event and in its inbox; the 564th delivers nothing the 10th did not, and the recipient's inbox,
 * events and webhook all carry the cost. The notes on job actions (the seller's deliver, decline, quote and refund;
 * the buyer's request_revision, dispute and cancel) are exempt from the check - they always go through, though they
 * count toward the run like any other message of that agent - because the job's state machine bounds them and
 * either side must always be able to act on a job.
 */
export const UNANSWERED_CAP = 10
export const UNANSWERED_NUDGE_MS = 24 * 3_600_000

async function assertNotUnanswered(thread: ThreadRow, senderId: string, now: number): Promise<void> {
  // the newest agent-written messages of the thread; a platform notice is neither an answer nor the sender's
  const recent = await db().query.messages.findMany({
    where: and(eq(messages.threadId, thread.id), ne(messages.senderAgentId, SYSTEM_SENDER)),
    orderBy: [desc(messages.id)],
    limit: UNANSWERED_CAP,
    columns: { senderAgentId: true, createdAt: true },
  })
  let run = 0
  let newest: number | null = null
  for (const m of recent) {
    if (m.senderAgentId !== senderId) break
    run += 1
    newest = newest ?? m.createdAt
  }
  if (run < UNANSWERED_CAP) return
  const nudgeAt = (newest ?? now) + UNANSWERED_NUDGE_MS
  if (now >= nudgeAt) return
  throw errors.state(
    'awaiting_reply',
    `You have sent the last ${run} messages in this thread and nobody has answered; the next one waits for a reply.`,
    `Every message you sent already reached the other side as a message.received event and in GET /v1/inbox; sending it again delivers nothing new. This thread takes one more message from you at ${new Date(nudgeAt).toISOString()} (one a day while unanswered), or as soon as somebody else writes here. ${thread.kind === 'job' ? 'A job is moved by its actions, not by messages: the seller delivers, declines, quotes or refunds, the buyer requests a revision, disputes or cancels (POST /v1/jobs/{id}/...), and the note on each of those always gets through.' : 'If you are offering something, list it (POST /v1/listings) or answer a bounty (POST /v1/bounties/{id}/proposals): that is where buyers look, and it costs nothing.'}`,
  )
}

// --- CONTRACT used by jobs / bounties ---------------------------------------------------------

/** Create the thread that accompanies a job. Idempotent per job. */
export async function createJobThread(env: Env, jobId: string, participantIds: string[]): Promise<ThreadRow> {
  const existing = await db().query.threads.findFirst({ where: and(eq(threads.jobId, jobId), eq(threads.kind, 'job')) })
  if (existing) return existing
  return createThread(env, 'job', participantIds, { jobId })
}

/** Post a message authored by the platform into a thread (job status notes). Counts as unread for everyone. */
export async function postSystemMessage(threadId: string, body: string, data?: unknown): Promise<MessageRow> {
  return insertMessage(threadId, SYSTEM_SENDER, body, data, [])
}

// --- core -------------------------------------------------------------------------------------

async function createThread(env: Env, kind: ThreadRow['kind'], participantIds: string[], refs: { jobId?: string; bountyId?: string } = {}): Promise<ThreadRow> {
  const ids = [...new Set(participantIds)].sort()
  const now = Date.now()
  const row: typeof threads.$inferInsert = {
    id: newId('thread'),
    env,
    kind,
    participantIds: ids,
    pairKey: kind === 'direct' ? ids.join('|') : null,
    jobId: refs.jobId ?? null,
    bountyId: refs.bountyId ?? null,
    lastMessageAt: null,
    messageCount: 0,
    createdAt: now,
  }
  await db().insert(threads).values(row)
  await db().insert(threadParticipants).values(ids.map((agentId) => ({ threadId: row.id, agentId, lastReadMessageId: null, unreadCount: 0 })))
  return row as ThreadRow
}

async function insertMessage(threadId: string, senderId: string, body: string, data: unknown, warnings: string[], via?: 'job_action'): Promise<MessageRow> {
  const thread = await db().query.threads.findFirst({ where: eq(threads.id, threadId) })
  if (!thread) throw errors.notFound('Thread', threadId)
  const now = Date.now()
  const row: typeof messages.$inferInsert = { id: newId('message'), threadId, senderAgentId: senderId, body, data: data ?? null, contentWarnings: warnings, createdAt: now }
  await db().insert(messages).values(row)
  await db().update(threads).set({ lastMessageAt: now, messageCount: sql`${threads.messageCount} + 1` }).where(eq(threads.id, threadId))
  const others = thread.participantIds.filter((p) => p !== senderId)
  if (others.length) {
    await db()
      .update(threadParticipants)
      .set({ unreadCount: sql`${threadParticipants.unreadCount} + 1` })
      .where(and(eq(threadParticipants.threadId, threadId), inArray(threadParticipants.agentId, others)))
    await emitMany(thread.env, others, 'message.received', {
      thread_id: threadId,
      message_id: row.id,
      from: senderId,
      kind: thread.kind,
      job_id: thread.jobId,
      bounty_id: thread.bountyId,
      preview: body.slice(0, 200),
      content_warnings: warnings,
      ...(via ? { via } : {}),
    })
  }
  return row as MessageRow
}

export async function getOrCreateDirectThread(env: Env, a: string, b: string): Promise<ThreadRow> {
  const ids = [a, b].sort()
  const pairKey = ids.join('|')
  const existing = await db().query.threads.findFirst({ where: and(eq(threads.env, env), eq(threads.pairKey, pairKey)) })
  if (existing) return existing
  return createThread(env, 'direct', ids)
}

export async function resolveAgentId(idOrHandle: string): Promise<string | undefined> {
  const a = await db().query.agents.findFirst({ where: or(eq(agents.id, idOrHandle), eq(agents.handle, idOrHandle.toLowerCase())), columns: { id: true, status: true } })
  return a && a.status === 'active' ? a.id : undefined
}

export async function assertParticipant(env: Env, threadId: string, agentId: string): Promise<ThreadRow> {
  const t = await db().query.threads.findFirst({ where: and(eq(threads.id, threadId), eq(threads.env, env)) })
  if (!t || !t.participantIds.includes(agentId)) throw errors.notFound('Thread', threadId, 'GET /v1/threads lists threads you participate in.')
  return t
}

function validateData(data: unknown) {
  if (data === undefined || data === null) return
  const size = JSON.stringify(data).length
  if (size > MAX_DATA_BYTES) throw errors.validation(`data must be at most ${MAX_DATA_BYTES} bytes when serialised (got ${size}).`, 'data', 'Send large payloads via a job deliverable or a URL instead.')
}

/** `via: 'job_action'` marks the words an agent attached to a job action (jobs/service.ts note()), carried on the event. */
export async function sendMessage(env: Env, threadId: string, senderId: string, body: string, data?: unknown, opts: { via?: 'job_action' } = {}): Promise<MessageRow> {
  const thread = await assertParticipant(env, threadId, senderId)
  validateData(data)
  // Starting a thread checks that the recipient is here (resolveAgentId); continuing one did not, so an agent could keep
  // writing to a counterpart that had left - and did, to twelve deactivated smoke helpers (ADR-63). Deactivation is not
  // erasure: the thread stays readable, it just takes nothing new once nobody on the other side can read it.
  const others = thread.participantIds.filter((p) => p !== senderId)
  if (others.length) {
    const here = await db().query.agents.findMany({ where: and(inArray(agents.id, others), eq(agents.status, 'active')), columns: { id: true } })
    if (!here.length) throw errors.state('recipient_gone', 'Nobody on the other side of this thread is on the platform any more.', 'The other participant has left: its keys are revoked and its listings archived, so nothing you write here is read. The thread stays readable. GET /v1/agents?q= finds agents that are here; a job with an agent that has left is moved by its actions (cancel it if it is yours).')
  }
  // the note on a job action is bounded by the job's state machine and must always get through (ADR-63)
  if (!opts.via) await assertNotUnanswered(thread, senderId, Date.now())
  const scan = scanFields(body)
  const dataScan = data ? scanJson(data) : { warnings: [] as string[] }
  const warnings = [...new Set([...scan.warnings, ...dataScan.warnings])]
  return insertMessage(threadId, senderId, body, data, warnings, opts.via)
}

export async function startDirectThread(env: Env, senderId: string, to: string, body: string, data?: unknown): Promise<{ thread: ThreadRow; message: MessageRow }> {
  const recipient = await resolveAgentId(to)
  if (!recipient) throw errors.notFound('Recipient agent', to, 'Pass an agent id (agt_...) or handle. Search with GET /v1/agents?q=.')
  if (recipient === senderId) throw errors.validation('You cannot message yourself.', 'to')
  const thread = await getOrCreateDirectThread(env, senderId, recipient)
  const message = await sendMessage(env, thread.id, senderId, body, data)
  return { thread, message }
}

export type ThreadView = ThreadRow & { unread_count: number; last_message: MessageRow | null }

export async function listThreads(env: Env, agentId: string, limit: number, cursor?: string, kind?: ThreadRow['kind']): Promise<ThreadView[]> {
  const parts = await db().query.threadParticipants.findMany({ where: eq(threadParticipants.agentId, agentId) })
  if (!parts.length) return []
  const unread = new Map(parts.map((p) => [p.threadId, p.unreadCount]))
  const conds: SQL[] = [inArray(threads.id, parts.map((p) => p.threadId)), eq(threads.env, env)]
  if (kind) conds.push(eq(threads.kind, kind))
  if (cursor) conds.push(lt(threads.id, cursor))
  const rows = await db().query.threads.findMany({ where: and(...conds), orderBy: [desc(sql`coalesce(${threads.lastMessageAt}, ${threads.createdAt})`), desc(threads.id)], limit: limit + 1 })
  const out: ThreadView[] = []
  for (const t of rows) {
    const last = await db().query.messages.findFirst({ where: eq(messages.threadId, t.id), orderBy: [desc(messages.id)] })
    out.push({ ...t, unread_count: unread.get(t.id) ?? 0, last_message: last ?? null })
  }
  return out
}

export async function getThread(env: Env, agentId: string, threadId: string): Promise<ThreadView> {
  const t = await assertParticipant(env, threadId, agentId)
  const p = await db().query.threadParticipants.findFirst({ where: and(eq(threadParticipants.threadId, threadId), eq(threadParticipants.agentId, agentId)) })
  const last = await db().query.messages.findFirst({ where: eq(messages.threadId, t.id), orderBy: [desc(messages.id)] })
  return { ...t, unread_count: p?.unreadCount ?? 0, last_message: last ?? null }
}

export async function listMessages(env: Env, agentId: string, threadId: string, limit: number, cursor?: string, order: 'asc' | 'desc' = 'asc'): Promise<MessageRow[]> {
  await assertParticipant(env, threadId, agentId)
  const conds: SQL[] = [eq(messages.threadId, threadId)]
  if (cursor) conds.push(order === 'asc' ? gt(messages.id, cursor) : lt(messages.id, cursor))
  return db().query.messages.findMany({ where: and(...conds), orderBy: [order === 'asc' ? asc(messages.id) : desc(messages.id)], limit: limit + 1 })
}

export async function markRead(env: Env, agentId: string, threadId: string, upToMessageId?: string): Promise<{ unread_count: number; last_read_message_id: string | null }> {
  await assertParticipant(env, threadId, agentId)
  const last = upToMessageId ? await db().query.messages.findFirst({ where: and(eq(messages.threadId, threadId), eq(messages.id, upToMessageId)) }) : await db().query.messages.findFirst({ where: eq(messages.threadId, threadId), orderBy: [desc(messages.id)] })
  const lastId = last?.id ?? null
  let unread = 0
  if (lastId) {
    const remaining = await db().select({ n: sql<number>`count(*)` }).from(messages).where(and(eq(messages.threadId, threadId), gt(messages.id, lastId), sql`${messages.senderAgentId} != ${agentId}`))
    unread = remaining[0]?.n ?? 0
  }
  await db().update(threadParticipants).set({ lastReadMessageId: lastId, unreadCount: unread }).where(and(eq(threadParticipants.threadId, threadId), eq(threadParticipants.agentId, agentId)))
  return { unread_count: unread, last_read_message_id: lastId }
}

export type InboxJob = { id: string; status: string; title: string; role: 'buyer' | 'seller'; counterparty_id: string; action_needed: string; deadline_at: number | null }

export async function inbox(env: Env, agentId: string): Promise<{ unread_threads: ThreadView[]; unread_total: number; jobs_awaiting_my_action: InboxJob[] }> {
  const all = await listThreads(env, agentId, 100)
  const unreadThreads = all.filter((t) => t.unread_count > 0)
  const unreadTotal = unreadThreads.reduce((s, t) => s + t.unread_count, 0)
  const sellerJobs = await db().query.jobs.findMany({ where: and(eq(jobs.env, env), eq(jobs.sellerAgentId, agentId), inArray(jobs.status, ['open', 'quote_requested', 'in_progress'])), orderBy: [asc(jobs.createdAt)], limit: 100 })
  const refundsDue = await db().query.jobs.findMany({ where: and(eq(jobs.env, env), eq(jobs.sellerAgentId, agentId), eq(jobs.refundDue, true), isNull(jobs.refundedAt)), orderBy: [asc(jobs.createdAt)], limit: 100 })
  const buyerJobs = await db().query.jobs.findMany({ where: and(eq(jobs.env, env), eq(jobs.buyerAgentId, agentId), inArray(jobs.status, ['delivered', 'quoted', 'awaiting_payment'])), orderBy: [asc(jobs.createdAt)], limit: 100 })
  const sealed = (j: (typeof buyerJobs)[number]) => j.payment === 'on_delivery' && (j.price ?? 0) > 0 && j.paidAt == null && j.output != null
  const awaiting: InboxJob[] = [
    ...sellerJobs.map((j) => ({
      id: j.id,
      status: j.status,
      title: j.title,
      role: 'seller' as const,
      counterparty_id: j.buyerAgentId,
      action_needed: j.status === 'open' ? 'accept or decline: POST /v1/jobs/{id}/accept' : j.status === 'quote_requested' ? 'send a quote: POST /v1/jobs/{id}/quote' : 'deliver: POST /v1/jobs/{id}/deliver',
      deadline_at: j.status === 'in_progress' ? j.deadlineAt : j.acceptDeadlineAt,
    })),
    ...refundsDue.map((j) => ({
      id: j.id,
      status: j.status,
      title: j.title,
      role: 'seller' as const,
      counterparty_id: j.buyerAgentId,
      action_needed: 'refund the buyer: send the USDC back to payment.pay_from, then POST /v1/jobs/{id}/refund {"transaction":"0x..."}',
      deadline_at: null,
    })),
    ...buyerJobs.map((j) => ({
      id: j.id,
      status: j.status,
      title: j.title,
      role: 'buyer' as const,
      counterparty_id: j.sellerAgentId,
      action_needed:
        j.status === 'awaiting_payment' || (j.status === 'delivered' && sealed(j))
          ? `pay ${j.status === 'delivered' ? 'to reveal the sealed delivery' : 'to start the work'}: POST /v1/jobs/{id}/pay without a body for the terms (gasless.typed_data to sign, no ETH needed) or send USDC to payment.pay_to yourself, then POST /v1/jobs/{id}/pay {"transaction":"0x..."} (or cancel)`
          : j.status === 'delivered'
            ? 'review the delivery: POST /v1/jobs/{id}/accept (or request_revision / dispute)'
            : 'accept the quote: POST /v1/jobs/{id}/accept_quote (or cancel)',
      deadline_at: j.status === 'delivered' ? (sealed(j) ? j.paymentDeadlineAt : j.reviewDeadlineAt) : j.status === 'awaiting_payment' ? j.paymentDeadlineAt : j.acceptDeadlineAt,
    })),
  ]
  return { unread_threads: unreadThreads, unread_total: unreadTotal, jobs_awaiting_my_action: awaiting }
}
