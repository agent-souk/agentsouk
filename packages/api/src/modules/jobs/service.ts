import { and, asc, desc, eq, inArray, lt, sql, type SQL } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { agents, jobEvents, jobs, type Env, type JobResolution, type JobStatus } from '../../db/schema.js'
import { errors } from '../../lib/errors.js'
import { newId } from '../../lib/ids.js'
import { config } from '../../config.js'
import { Ledger } from '../../ledger/ledger.js'
import { agentAccount, escrowAccount, platformAccount, CREDIT_CURRENCY } from '../wallet/service.js'
import { emitMany, publishFeed } from '../../events/bus.js'
import { scanJson } from '../../lib/content-safety.js'
import { registerSweep } from '../../lib/scheduler.js'
import { createJobThread, postSystemMessage, sendMessage } from '../messaging/service.js'
import { getActiveListingForOrder, recordListingOutcome, type Listing } from '../listings/service.js'
import { recordJobOutcome } from '../reviews/service.js'
import type { Agent } from '../../middleware/auth.js'

/**
 * Jobs with escrow (SPEC §2). Every money movement is a balanced ledger post with an idempotency key
 * derived from the job id and action, so a retried transition can never move funds twice.
 */

export type Job = typeof jobs.$inferSelect
export type Role = 'buyer' | 'seller'
export const GRACE_AFTER_DEADLINE_MS = 3600_000
const TERMINAL: JobStatus[] = ['completed', 'declined', 'cancelled', 'expired', 'resolved']
const OPEN_FOR_SELLER: JobStatus[] = ['open', 'quote_requested', 'quoted', 'in_progress', 'delivered']

const ledger = () => new Ledger(db())

export function feeFor(price: number): number {
  if (price <= 0) return 0
  return Math.max(1, Math.ceil((price * config().PLATFORM_FEE_BPS) / 10000))
}

function reviewWindowMs(env: Env): number {
  return (env === 'live' ? config().REVIEW_WINDOW_SECONDS_LIVE : config().REVIEW_WINDOW_SECONDS_TEST) * 1000
}

export function roleOf(job: Job, agentId: string): Role | undefined {
  if (job.buyerAgentId === agentId) return 'buyer'
  if (job.sellerAgentId === agentId) return 'seller'
  return undefined
}

export function availableActions(job: Job, role: Role, now = Date.now()): string[] {
  const s = job.status
  if (role === 'seller') {
    if (s === 'open') return ['accept', 'decline']
    if (s === 'quote_requested') return ['quote', 'decline']
    if (s === 'in_progress') return ['deliver', 'cancel', 'message']
    if (s === 'delivered') return ['message']
    if (s === 'completed' || s === 'resolved') return ['review']
    return []
  }
  if (s === 'open' || s === 'quote_requested') return ['cancel', 'message']
  if (s === 'quoted') return ['accept_quote', 'cancel', 'message']
  if (s === 'in_progress') return job.deadlineAt && now > job.deadlineAt + GRACE_AFTER_DEADLINE_MS ? ['cancel', 'message'] : ['message']
  if (s === 'delivered') {
    const a = ['accept', 'dispute', 'message']
    if (job.revisionCount < job.maxRevisions) a.splice(1, 0, 'request_revision')
    return a
  }
  if (s === 'completed' || s === 'resolved') return ['review']
  return []
}

async function logJobEvent(jobId: string, type: string, actorAgentId: string | null, data?: Record<string, unknown>) {
  await db().insert(jobEvents).values({ id: newId('event'), jobId, type, actorAgentId, data: data ?? null, createdAt: Date.now() })
}

async function notify(job: Job, type: string, extra: Record<string, unknown> = {}) {
  await emitMany(job.env, [job.buyerAgentId, job.sellerAgentId], `job.${type}`, {
    job_id: job.id,
    status: job.status,
    title: job.title,
    buyer_id: job.buyerAgentId,
    seller_id: job.sellerAgentId,
    price: job.price,
    thread_id: job.threadId,
    ...extra,
  })
}

async function reload(id: string): Promise<Job> {
  return (await db().query.jobs.findFirst({ where: eq(jobs.id, id) }))!
}

async function setJob(id: string, set: Partial<typeof jobs.$inferInsert>): Promise<Job> {
  await db().update(jobs).set({ ...set, updatedAt: Date.now() }).where(eq(jobs.id, id))
  return reload(id)
}

function validateInput(input: unknown, schema: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw errors.validation('input must be a JSON object.', 'input', 'Check the listing input_schema and example_input.')
  const required = Array.isArray(schema?.required) ? (schema!.required as unknown[]).filter((k): k is string => typeof k === 'string') : []
  const missing = required.filter((k) => !(k in (input as Record<string, unknown>)))
  if (missing.length) throw errors.validation(`input is missing required field(s): ${missing.join(', ')}.`, 'input', 'The listing input_schema lists required keys; see example_input for a valid shape.', { missing })
  const scan = scanJson(input)
  if (scan.severity === 'high') throw errors.validation('input contains instruction-injection or credential-phishing patterns and was rejected.', 'input', 'Send plain task data; do not address the seller as a model or ask for secrets.', { code: 'content_rejected', warnings: scan.warnings })
  return input as Record<string, unknown>
}

async function lockEscrow(job: Job, price: number) {
  return ledger().post({
    env: job.env,
    type: 'escrow_lock',
    currency: CREDIT_CURRENCY,
    amount: price,
    legs: [
      { account: agentAccount(job.buyerAgentId), delta: -price },
      { account: escrowAccount(job.id), delta: +price },
    ],
    initiatorAgentId: job.buyerAgentId,
    idempotencyKey: `job:${job.id}:lock`,
    referenceType: 'job',
    referenceId: job.id,
    memo: `escrow for job ${job.id}`,
  })
}

async function releaseEscrow(job: Job): Promise<string> {
  const price = job.price ?? 0
  const fee = feeFor(price)
  if (price === 0) return ''
  const legs = [
    { account: escrowAccount(job.id), delta: -price },
    { account: agentAccount(job.sellerAgentId), delta: price - fee },
  ]
  if (fee > 0) legs.push({ account: platformAccount('fees'), delta: fee })
  const t = await ledger().post({ env: job.env, type: 'escrow_release', currency: CREDIT_CURRENCY, amount: price, legs, initiatorAgentId: job.buyerAgentId, idempotencyKey: `job:${job.id}:release`, referenceType: 'job', referenceId: job.id, memo: `payout for job ${job.id} (fee ${fee})` })
  return t.id
}

async function refundEscrow(job: Job): Promise<string | null> {
  if (!job.escrowTransactionId || !job.price) return null
  const t = await ledger().post({
    env: job.env,
    type: 'escrow_refund',
    currency: CREDIT_CURRENCY,
    amount: job.price,
    legs: [
      { account: escrowAccount(job.id), delta: -job.price },
      { account: agentAccount(job.buyerAgentId), delta: +job.price },
    ],
    initiatorAgentId: job.buyerAgentId,
    idempotencyKey: `job:${job.id}:refund`,
    referenceType: 'job',
    referenceId: job.id,
    memo: `refund for job ${job.id}`,
  })
  return t.id
}

async function finalize(job: Job, listingOutcome?: 'completed' | 'failed') {
  await recordJobOutcome(job)
  if (job.listingId && listingOutcome) {
    const turnaround = job.acceptedAt && job.deliveredAt ? Math.round((job.deliveredAt - job.acceptedAt) / 1000) : undefined
    await recordListingOutcome({ listingId: job.listingId, status: listingOutcome, buyerAgentId: job.buyerAgentId, price: job.price ?? 0, turnaroundSeconds: turnaround })
  }
}

// --- creation ---------------------------------------------------------------------------------

export type CreateJobInput = { listing_id: string; input: unknown; units?: number; title?: string; max_revisions?: number }

async function assertSellerCapacity(env: Env, sellerId: string, maxOpen: number) {
  const open = await db().select({ n: sql<number>`count(*)` }).from(jobs).where(and(eq(jobs.env, env), eq(jobs.sellerAgentId, sellerId), inArray(jobs.status, OPEN_FOR_SELLER)))
  if ((open[0]?.n ?? 0) >= maxOpen) throw errors.state('seller_busy', 'This seller has reached its concurrent job limit.', 'Try again later or pick another listing: GET /v1/listings?q=.')
}

export async function createJob(env: Env, buyer: Agent, input: CreateJobInput): Promise<Job> {
  const listing: Listing = await getActiveListingForOrder(env, input.listing_id)
  if (listing.sellerAgentId === buyer.id) throw errors.validation('You cannot order your own listing.', 'listing_id')
  const seller = await db().query.agents.findFirst({ where: eq(agents.id, listing.sellerAgentId) })
  if (!seller || seller.status !== 'active') throw errors.state('seller_unavailable', 'The seller of this listing is not active.', 'Pick another listing: GET /v1/listings?q=.')
  const jobInput = validateInput(input.input, listing.inputSchema)
  await assertSellerCapacity(env, listing.sellerAgentId, listing.maxOpenJobs)

  let units = 1
  if (listing.pricingModel === 'per_unit') {
    units = input.units ?? 1
    if (!Number.isInteger(units) || units < 1) throw errors.validation('units must be an integer >= 1 for per-unit listings.', 'units')
  }
  const price = listing.pricingModel === 'quote' ? null : listing.pricingModel === 'per_unit' ? listing.price! * units : listing.price!
  const now = Date.now()
  const id = newId('job')
  const status: JobStatus = listing.pricingModel === 'quote' ? 'quote_requested' : 'open'
  const row: typeof jobs.$inferInsert = {
    id,
    env,
    listingId: listing.id,
    bountyId: null,
    buyerAgentId: buyer.id,
    sellerAgentId: listing.sellerAgentId,
    title: (input.title ?? listing.title).slice(0, 120),
    input: jobInput,
    output: null,
    units,
    price,
    fee: price != null ? feeFor(price) : null,
    status,
    revisionCount: 0,
    maxRevisions: input.max_revisions ?? 2,
    acceptDeadlineAt: now + listing.acceptTimeoutSeconds * 1000,
    deadlineAt: null,
    reviewDeadlineAt: null,
    createdAt: now,
    updatedAt: now,
  }
  // Lock escrow before the job exists so an insufficient-funds error leaves no trace.
  let escrowTxnId: string | null = null
  if (price != null && price > 0) {
    const t = await lockEscrow(row as Job, price)
    escrowTxnId = t.id
  }
  row.escrowTransactionId = escrowTxnId
  await db().insert(jobs).values(row)
  const thread = await createJobThread(env, id, [buyer.id, listing.sellerAgentId])
  await db().update(jobs).set({ threadId: thread.id }).where(eq(jobs.id, id))
  await postSystemMessage(thread.id, status === 'open' ? `Job created. ${price} CRD locked in escrow. Seller: accept or decline before ${new Date(row.acceptDeadlineAt!).toISOString()}.` : 'Quote requested. Seller: send a quote with POST /v1/jobs/{id}/quote.', { job_id: id, status })
  await logJobEvent(id, 'created', buyer.id, { price, units, listing_id: listing.id })
  const job = await reload(id)
  await notify(job, 'created')
  return job
}

// --- CONTRACT for bounties --------------------------------------------------------------------

export type CreateJobFromBountyInput = {
  env: Env
  bountyId: string
  buyerAgentId: string
  sellerAgentId: string
  title: string
  input: Record<string, unknown>
  price: number
  turnaroundSeconds?: number
}

/** Award of a bounty: both sides already agreed on price, so the job starts in_progress with escrow locked. */
export async function createJobFromBountyAward(input: CreateJobFromBountyInput): Promise<Job> {
  const now = Date.now()
  const id = newId('job')
  const turnaround = (input.turnaroundSeconds ?? 3600) * 1000
  const row: typeof jobs.$inferInsert = {
    id,
    env: input.env,
    listingId: null,
    bountyId: input.bountyId,
    buyerAgentId: input.buyerAgentId,
    sellerAgentId: input.sellerAgentId,
    title: input.title.slice(0, 120),
    input: input.input,
    output: null,
    units: 1,
    price: input.price,
    fee: feeFor(input.price),
    status: 'in_progress',
    revisionCount: 0,
    maxRevisions: 2,
    acceptDeadlineAt: null,
    deadlineAt: now + turnaround,
    reviewDeadlineAt: null,
    createdAt: now,
    acceptedAt: now,
    updatedAt: now,
  }
  if (input.price > 0) row.escrowTransactionId = (await lockEscrow(row as Job, input.price)).id
  await db().insert(jobs).values(row)
  const thread = await createJobThread(input.env, id, [input.buyerAgentId, input.sellerAgentId])
  await db().update(jobs).set({ threadId: thread.id }).where(eq(jobs.id, id))
  await postSystemMessage(thread.id, `Bounty awarded. ${input.price} CRD locked in escrow. Seller: deliver before ${new Date(row.deadlineAt!).toISOString()}.`, { job_id: id, status: 'in_progress' })
  await logJobEvent(id, 'created', input.buyerAgentId, { price: input.price, bounty_id: input.bountyId })
  await logJobEvent(id, 'accepted', input.sellerAgentId)
  const job = await reload(id)
  await notify(job, 'created', { from_bounty: true })
  return job
}

// --- reads ------------------------------------------------------------------------------------

export async function getJobForParty(env: Env, agentId: string, id: string): Promise<{ job: Job; role: Role }> {
  const job = await db().query.jobs.findFirst({ where: and(eq(jobs.id, id), eq(jobs.env, env)) })
  const role = job ? roleOf(job, agentId) : undefined
  if (!job || !role) throw errors.notFound('Job', id, 'GET /v1/jobs lists your jobs. Check that you are using the key for the right environment (live/test).')
  return { job, role }
}

export async function listJobs(env: Env, agentId: string, opts: { role?: Role; status?: JobStatus; limit: number; cursor?: string }): Promise<Job[]> {
  const conds: SQL[] = [eq(jobs.env, env)]
  if (opts.role === 'buyer') conds.push(eq(jobs.buyerAgentId, agentId))
  else if (opts.role === 'seller') conds.push(eq(jobs.sellerAgentId, agentId))
  else conds.push(sql`(${jobs.buyerAgentId} = ${agentId} or ${jobs.sellerAgentId} = ${agentId})`)
  if (opts.status) conds.push(eq(jobs.status, opts.status))
  if (opts.cursor) conds.push(lt(jobs.id, opts.cursor))
  return db().query.jobs.findMany({ where: and(...conds), orderBy: [desc(jobs.id)], limit: opts.limit + 1 })
}

export async function listJobEvents(jobId: string) {
  return db().query.jobEvents.findMany({ where: eq(jobEvents.jobId, jobId), orderBy: [asc(jobEvents.createdAt), asc(jobEvents.id)] })
}

// --- transitions ------------------------------------------------------------------------------

function invalid(job: Job, role: Role, action: string): never {
  const allowed = availableActions(job, role)
  throw errors.state('invalid_transition', `Cannot ${action} a job in status '${job.status}' as ${role}.`, allowed.length ? `Available actions for you now: ${allowed.join(', ')}.` : 'No actions are available for you on this job right now.')
}

function requireRole(role: Role, needed: Role, job: Job, action: string) {
  if (role !== needed) invalid(job, role, action)
}

export async function accept(env: Env, actor: Agent, id: string): Promise<Job> {
  const { job, role } = await getJobForParty(env, actor.id, id)
  requireRole(role, 'seller', job, 'accept')
  if (job.status === 'in_progress') return job
  if (job.status !== 'open') invalid(job, role, 'accept')
  const now = Date.now()
  const listing = job.listingId ? await db().query.listings.findFirst({ where: eq(sql`id`, job.listingId) }) : undefined
  const turnaround = (listing?.turnaroundSeconds ?? 3600) * 1000
  const updated = await setJob(id, { status: 'in_progress', acceptedAt: now, deadlineAt: now + turnaround })
  await logJobEvent(id, 'accepted', actor.id)
  if (updated.threadId) await postSystemMessage(updated.threadId, `Seller accepted. Delivery due by ${new Date(updated.deadlineAt!).toISOString()}.`, { job_id: id, status: 'in_progress' })
  await notify(updated, 'accepted')
  return updated
}

export async function decline(env: Env, actor: Agent, id: string, reason?: string): Promise<Job> {
  const { job, role } = await getJobForParty(env, actor.id, id)
  requireRole(role, 'seller', job, 'decline')
  if (job.status === 'declined') return job
  if (job.status !== 'open' && job.status !== 'quote_requested') invalid(job, role, 'decline')
  const refundTxn = await refundEscrow(job)
  const updated = await setJob(id, { status: 'declined', cancelReason: reason ? `seller: ${reason}`.slice(0, 500) : 'seller declined', refundTransactionId: refundTxn })
  await logJobEvent(id, 'declined', actor.id, { reason })
  if (updated.threadId) await postSystemMessage(updated.threadId, `Seller declined${reason ? `: ${reason}` : ''}. Escrow refunded.`, { job_id: id, status: 'declined' })
  await notify(updated, 'declined', { reason })
  await finalize(updated)
  return updated
}

export async function quote(env: Env, actor: Agent, id: string, price: number, message?: string): Promise<Job> {
  const { job, role } = await getJobForParty(env, actor.id, id)
  requireRole(role, 'seller', job, 'quote')
  if (job.status === 'quoted' && job.quotedPrice === price) return job
  if (job.status !== 'quote_requested' && job.status !== 'quoted') invalid(job, role, 'quote')
  const listing = job.listingId ? await db().query.listings.findFirst({ where: eq(sql`id`, job.listingId) }) : undefined
  const acceptWindow = (listing?.acceptTimeoutSeconds ?? 3600) * 1000
  const updated = await setJob(id, { status: 'quoted', quotedPrice: price, quoteMessage: message?.slice(0, 2000) ?? null, acceptDeadlineAt: Date.now() + acceptWindow })
  await logJobEvent(id, 'quoted', actor.id, { price, message })
  if (updated.threadId) await postSystemMessage(updated.threadId, `Seller quoted ${price} CRD${message ? `: ${message}` : ''}. Buyer: accept with POST /v1/jobs/{id}/accept_quote before ${new Date(updated.acceptDeadlineAt!).toISOString()}.`, { job_id: id, status: 'quoted', price })
  await notify(updated, 'quoted', { quoted_price: price })
  return updated
}

export async function acceptQuote(env: Env, actor: Agent, id: string): Promise<Job> {
  const { job, role } = await getJobForParty(env, actor.id, id)
  requireRole(role, 'buyer', job, 'accept_quote')
  if (job.status === 'in_progress') return job
  if (job.status !== 'quoted' || job.quotedPrice == null) invalid(job, role, 'accept_quote')
  const price = job.quotedPrice
  const listing = job.listingId ? await db().query.listings.findFirst({ where: eq(sql`id`, job.listingId) }) : undefined
  const escrow = price > 0 ? await lockEscrow(job, price) : null
  const now = Date.now()
  const updated = await setJob(id, { status: 'in_progress', price, fee: feeFor(price), escrowTransactionId: escrow?.id ?? null, acceptedAt: now, deadlineAt: now + (listing?.turnaroundSeconds ?? 3600) * 1000 })
  await logJobEvent(id, 'quote_accepted', actor.id, { price })
  if (updated.threadId) await postSystemMessage(updated.threadId, `Buyer accepted the quote. ${price} CRD locked in escrow. Delivery due by ${new Date(updated.deadlineAt!).toISOString()}.`, { job_id: id, status: 'in_progress' })
  await notify(updated, 'accepted', { price })
  return updated
}

export async function deliver(env: Env, actor: Agent, id: string, output: unknown, message?: string): Promise<Job> {
  const { job, role } = await getJobForParty(env, actor.id, id)
  requireRole(role, 'seller', job, 'deliver')
  if (job.status === 'delivered') return job
  if (job.status !== 'in_progress') invalid(job, role, 'deliver')
  if (output === undefined) throw errors.validation('output is required.', 'output', 'Send the deliverable as JSON (any shape; follow the listing output_schema if present).')
  const size = JSON.stringify(output).length
  if (size > 512 * 1024) throw errors.validation('output must be at most 512 KB when serialised.', 'output', 'Return a URL or split the deliverable.')
  const scan = scanJson(output)
  const now = Date.now()
  const updated = await setJob(id, { status: 'delivered', output, deliveredAt: now, reviewDeadlineAt: now + reviewWindowMs(env) })
  await logJobEvent(id, 'delivered', actor.id, { on_time: job.deadlineAt ? now <= job.deadlineAt : true, content_warnings: scan.warnings })
  if (updated.threadId) {
    if (message) await sendMessage(env, updated.threadId, actor.id, message)
    await postSystemMessage(updated.threadId, `Delivered. Buyer: accept, request a revision or dispute before ${new Date(updated.reviewDeadlineAt!).toISOString()}; otherwise the job auto-completes.`, { job_id: id, status: 'delivered' })
  }
  await notify(updated, 'delivered', { content_warnings: scan.warnings })
  return updated
}

export async function acceptDelivery(env: Env, actor: Agent, id: string): Promise<Job> {
  const { job, role } = await getJobForParty(env, actor.id, id)
  requireRole(role, 'buyer', job, 'accept')
  if (job.status === 'completed') return job
  if (job.status !== 'delivered') invalid(job, role, 'accept')
  return complete(job, actor.id, 'buyer accepted')
}

async function complete(job: Job, actorId: string | null, note: string): Promise<Job> {
  const releaseTxn = await releaseEscrow(job)
  const updated = await setJob(job.id, { status: 'completed', completedAt: Date.now(), releaseTransactionId: releaseTxn || null, fee: feeFor(job.price ?? 0) })
  await logJobEvent(job.id, 'completed', actorId, { note, fee: updated.fee })
  if (updated.threadId) await postSystemMessage(updated.threadId, `Completed (${note}). ${(updated.price ?? 0) - (updated.fee ?? 0)} CRD paid to seller, ${updated.fee ?? 0} CRD platform fee. Both sides can now leave a review: POST /v1/jobs/{id}/reviews.`, { job_id: job.id, status: 'completed' })
  await notify(updated, 'completed', { fee: updated.fee })
  await publishFeed(updated.env, 'job.completed', { job_id: updated.id, title: updated.title, price_rounded: Math.round((updated.price ?? 0) / 100) * 100, seller_id: updated.sellerAgentId, buyer_id: updated.buyerAgentId })
  await finalize(updated, 'completed')
  return updated
}

export async function requestRevision(env: Env, actor: Agent, id: string, message: string): Promise<Job> {
  const { job, role } = await getJobForParty(env, actor.id, id)
  requireRole(role, 'buyer', job, 'request_revision')
  if (job.status !== 'delivered') invalid(job, role, 'request_revision')
  if (job.revisionCount >= job.maxRevisions) throw errors.state('revisions_exhausted', `This job allows ${job.maxRevisions} revision(s) and they are used up.`, 'Accept the delivery (POST /v1/jobs/{id}/accept) or open a dispute (POST /v1/jobs/{id}/dispute).')
  const listing = job.listingId ? await db().query.listings.findFirst({ where: eq(sql`id`, job.listingId) }) : undefined
  const now = Date.now()
  const updated = await setJob(id, { status: 'in_progress', revisionCount: job.revisionCount + 1, deadlineAt: now + (listing?.turnaroundSeconds ?? 3600) * 1000, reviewDeadlineAt: null })
  await logJobEvent(id, 'revision_requested', actor.id, { message, revision: updated.revisionCount })
  if (updated.threadId) {
    await sendMessage(env, updated.threadId, actor.id, message)
    await postSystemMessage(updated.threadId, `Revision ${updated.revisionCount}/${updated.maxRevisions} requested. Seller: deliver again by ${new Date(updated.deadlineAt!).toISOString()}.`, { job_id: id, status: 'in_progress' })
  }
  await notify(updated, 'revision_requested', { revision: updated.revisionCount })
  return updated
}

export async function dispute(env: Env, actor: Agent, id: string, reason: string): Promise<Job> {
  const { job, role } = await getJobForParty(env, actor.id, id)
  requireRole(role, 'buyer', job, 'dispute')
  if (job.status === 'disputed') return job
  if (job.status !== 'delivered') invalid(job, role, 'dispute')
  const updated = await setJob(id, { status: 'disputed', disputeReason: reason.slice(0, 2000), reviewDeadlineAt: null })
  await logJobEvent(id, 'disputed', actor.id, { reason })
  if (updated.threadId) await postSystemMessage(updated.threadId, `Buyer opened a dispute: ${reason.slice(0, 500)}. Escrow stays locked until an arbiter resolves it. Both sides: add evidence in this thread.`, { job_id: id, status: 'disputed' })
  await notify(updated, 'disputed', { reason })
  await finalize(updated)
  return updated
}

export async function cancel(env: Env, actor: Agent, id: string, reason?: string): Promise<Job> {
  const { job, role } = await getJobForParty(env, actor.id, id)
  if (job.status === 'cancelled') return job
  const now = Date.now()
  let sellerFailure = false
  if (role === 'buyer') {
    if (job.status === 'in_progress') {
      if (!job.deadlineAt || now <= job.deadlineAt + GRACE_AFTER_DEADLINE_MS) {
        throw errors.state('cannot_cancel_in_progress', 'The seller is working on this job and the deadline has not passed.', `You can cancel after ${job.deadlineAt ? new Date(job.deadlineAt + GRACE_AFTER_DEADLINE_MS).toISOString() : 'the deadline plus one hour'}, or message the seller in thread ${job.threadId}.`)
      }
      sellerFailure = true
    } else if (!['open', 'quote_requested', 'quoted'].includes(job.status)) invalid(job, role, 'cancel')
  } else {
    if (job.status === 'in_progress') sellerFailure = true
    else if (job.status === 'open' || job.status === 'quote_requested') return decline(env, actor, id, reason)
    else invalid(job, role, 'cancel')
  }
  const refundTxn = await refundEscrow(job)
  const updated = await setJob(id, { status: 'cancelled', cancelReason: `${role}: ${reason ?? 'cancelled'}`.slice(0, 500), refundTransactionId: refundTxn })
  await logJobEvent(id, 'cancelled', actor.id, { reason, seller_failure: sellerFailure })
  if (updated.threadId) await postSystemMessage(updated.threadId, `Cancelled by ${role}${reason ? `: ${reason}` : ''}. Escrow refunded to buyer.`, { job_id: id, status: 'cancelled' })
  await notify(updated, 'cancelled', { by: role, reason })
  await finalize(updated, sellerFailure ? 'failed' : undefined)
  return updated
}

export async function resolve(id: string, resolution: { buyer_refund: number; seller_payout: number; note: string; by: string }): Promise<Job> {
  const job = await db().query.jobs.findFirst({ where: eq(jobs.id, id) })
  if (!job) throw errors.notFound('Job', id)
  if (job.status === 'resolved') return job
  if (job.status !== 'disputed') throw errors.state('not_disputed', `Job ${id} is '${job.status}', only disputed jobs can be resolved.`)
  const price = job.price ?? 0
  if (resolution.buyer_refund + resolution.seller_payout !== price) throw errors.validation(`buyer_refund + seller_payout must equal the job price (${price}).`, 'seller_payout')
  if (resolution.buyer_refund < 0 || resolution.seller_payout < 0) throw errors.validation('amounts must be >= 0')
  const fee = feeFor(resolution.seller_payout)
  let txnId: string | null = null
  if (price > 0) {
    const legs = [{ account: escrowAccount(job.id), delta: -price }]
    if (resolution.buyer_refund > 0) legs.push({ account: agentAccount(job.buyerAgentId), delta: resolution.buyer_refund })
    if (resolution.seller_payout - fee > 0) legs.push({ account: agentAccount(job.sellerAgentId), delta: resolution.seller_payout - fee })
    if (fee > 0) legs.push({ account: platformAccount('fees'), delta: fee })
    const t = await ledger().post({ env: job.env, type: 'escrow_release', currency: CREDIT_CURRENCY, amount: price, legs, initiatorAgentId: null, idempotencyKey: `job:${job.id}:resolve`, referenceType: 'job', referenceId: job.id, memo: `dispute resolution: ${resolution.note}`.slice(0, 500) })
    txnId = t.id
  }
  const res: JobResolution = { ...resolution }
  const updated = await setJob(id, { status: 'resolved', resolution: res, releaseTransactionId: txnId, completedAt: Date.now(), fee })
  await logJobEvent(id, 'resolved', null, { ...res })
  if (updated.threadId) await postSystemMessage(updated.threadId, `Dispute resolved by ${resolution.by}: buyer refunded ${resolution.buyer_refund} CRD, seller paid ${resolution.seller_payout - fee} CRD (fee ${fee}). Note: ${resolution.note}`, { job_id: id, status: 'resolved' })
  await notify(updated, 'resolved', { buyer_refund: resolution.buyer_refund, seller_payout: resolution.seller_payout })
  await finalize(updated, resolution.seller_payout > 0 ? 'completed' : 'failed')
  return updated
}

// --- sweeps -----------------------------------------------------------------------------------

export async function sweepJobs(now = Date.now()): Promise<{ expired: number; auto_completed: number }> {
  let expired = 0
  let autoCompleted = 0
  const toExpire = await db().query.jobs.findMany({ where: and(inArray(jobs.status, ['open', 'quote_requested', 'quoted']), lt(jobs.acceptDeadlineAt, now)), limit: 200 })
  for (const job of toExpire) {
    const refundTxn = await refundEscrow(job)
    const updated = await setJob(job.id, { status: 'expired', refundTransactionId: refundTxn })
    await logJobEvent(job.id, 'expired', null)
    if (updated.threadId) await postSystemMessage(updated.threadId, 'Expired: no response in time. Escrow refunded.', { job_id: job.id, status: 'expired' })
    await notify(updated, 'expired')
    await finalize(updated)
    expired++
  }
  const toComplete = await db().query.jobs.findMany({ where: and(eq(jobs.status, 'delivered'), lt(jobs.reviewDeadlineAt, now)), limit: 200 })
  for (const job of toComplete) {
    await complete(job, null, 'auto-accepted after review window')
    autoCompleted++
  }
  return { expired, auto_completed: autoCompleted }
}

registerSweep('jobs', async (now) => {
  await sweepJobs(now)
})

export { TERMINAL as TERMINAL_STATUSES }
