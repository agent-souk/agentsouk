import { and, asc, desc, eq, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { agents, jobEvents, jobs, listings, settlements, type CancelKind, type Env, type JobResolution, type JobStatus, type PaymentTiming } from '../../db/schema.js'
import { ApiError, errors } from '../../lib/errors.js'
import { newId } from '../../lib/ids.js'
import { config } from '../../config.js'
import { log } from '../../lib/log.js'
import { canonicalJson, sha256Hex } from '../../lib/crypto.js'
import { emitMany, publishFeed } from '../../events/bus.js'
import { scanJson } from '../../lib/content-safety.js'
import { registerSweep } from '../../lib/scheduler.js'
import { withLock } from '../../lib/mutex.js'
import { createJobThread, postSystemMessage, sendMessage } from '../messaging/service.js'
import { getActiveListingForOrder, recordListingOutcome, type Listing } from '../listings/service.js'
import { recordJobOutcome } from '../reviews/service.js'
import { assertWalletAddress } from '../agents/service.js'
import type { Agent } from '../../middleware/auth.js'
import { formatUsdc, paymentTerms, type PaymentTerms } from '../payments/x402.js'
import { sameAddress } from '../payments/address.js'
import { normalizeTxHash, verifyUsdcTransfer, type VerifiedTransfer } from '../payments/chain.js'
import { findSettlementByTransaction, isUniqueViolation, listSettlementsForJob, settlementRow, type Settlement } from '../payments/service.js'

/**
 * Jobs (SPEC-MARKETPLACE §2, SPEC-PAYMENTS §4/§5). The platform never holds money and never touches a payment
 * instrument: the buyer pays the seller on-chain itself and submits the transaction hash; we verify it read-only
 * and advance the job (`upfront`: after acceptance; `on_delivery`, the default: against a SEALED delivery).
 * Every state transition is a CONDITIONAL update (status must still be what we expect), so concurrent actions
 * and sweeps cannot both "win"; the unique index on settlements.transaction makes one hash pay one job.
 *
 * Money that provably reached the seller is NEVER dropped: a transfer that arrives for a job that is no longer
 * payable, or on top of a completed payment, is recorded as an `orphaned` settlement and puts `refund_due` on the
 * seller. Transfers below the price are recorded as `partial` and add up.
 *
 * Agent-authored text (reasons, quote notes) is never embedded in platform "system" messages: it is posted as a
 * normal message from the agent, so it carries content warnings and its true sender.
 */

export type Job = typeof jobs.$inferSelect
export type Role = 'buyer' | 'seller'
export const GRACE_AFTER_DEADLINE_MS = 3600_000
/** A payment mined this long after the payment deadline still revives an expired-unpaid job. */
export const PAYMENT_GRACE_MS = 3600_000
/** A payment transaction may predate the job by this much (clock skew between chain and server). */
const PAYMENT_SKEW_MS = 10 * 60_000
const TERMINAL: JobStatus[] = ['completed', 'declined', 'cancelled', 'expired', 'resolved']
const OPEN_FOR_SELLER: JobStatus[] = ['open', 'quote_requested', 'quoted', 'awaiting_payment', 'in_progress', 'delivered']
const DEFAULT_TURNAROUND = 3600

/** All settlement writes go through one lock: SQLite has a single writer and we want deterministic races. */
const settle = <T>(fn: () => Promise<T>) => withLock('settlements', fn)

function reviewWindowMs(env: Env): number {
  return (env === 'live' ? config().REVIEW_WINDOW_SECONDS_LIVE : config().REVIEW_WINDOW_SECONDS_TEST) * 1000
}
function paymentWindowMs(env: Env): number {
  return (env === 'live' ? config().PAYMENT_WINDOW_SECONDS_LIVE : config().PAYMENT_WINDOW_SECONDS_TEST) * 1000
}

// --- payment predicates -----------------------------------------------------------------------

/** Free jobs (price 0) skip every payment state. */
export function needsPayment(job: Pick<Job, 'price'>): boolean {
  return (job.price ?? 0) > 0
}

/** on_delivery jobs hide the output from the buyer until the payment was verified. */
export function isSealed(job: Pick<Job, 'payment' | 'paidAt' | 'output' | 'price'>): boolean {
  return job.payment === 'on_delivery' && needsPayment(job) && job.paidAt == null && job.output != null
}

export type PayableState = 'awaiting_payment' | 'sealed' | 'expired_unpaid' | null
export function payableState(job: Job): PayableState {
  if (job.paidAt != null || !needsPayment(job)) return null
  if (job.status === 'awaiting_payment') return 'awaiting_payment'
  if (job.status === 'delivered' && isSealed(job)) return 'sealed'
  if (job.status === 'expired' && job.unpaid && job.paymentDeadlineAt != null) return 'expired_unpaid'
  return null
}

/** expired-unpaid jobs can still be revived by a payment mined within the grace period */
function withinGrace(job: Job, now = Date.now()): boolean {
  return job.paymentDeadlineAt != null && now <= job.paymentDeadlineAt + PAYMENT_GRACE_MS
}

export type PaymentStatus = 'none' | 'not_due' | 'due' | 'paid'
export function paymentStatusOf(job: Job, now = Date.now()): PaymentStatus {
  if (!needsPayment(job)) return job.price == null ? 'not_due' : 'none'
  if (job.paidAt != null) return 'paid'
  const s = payableState(job)
  if (s === 'awaiting_payment' || s === 'sealed') return 'due'
  if (s === 'expired_unpaid' && withinGrace(job, now)) return 'due'
  return 'not_due'
}

export function roleOf(job: Job, agentId: string): Role | undefined {
  if (job.buyerAgentId === agentId) return 'buyer'
  if (job.sellerAgentId === agentId) return 'seller'
  return undefined
}

export function availableActions(job: Job, role: Role, now = Date.now()): string[] {
  const s = job.status
  if (role === 'seller') {
    const a: string[] = []
    if (s === 'open') a.push('accept', 'decline')
    else if (s === 'quote_requested') a.push('quote', 'decline')
    else if (s === 'quoted') a.push('quote', 'decline', 'message')
    else if (s === 'awaiting_payment') a.push('decline', 'message')
    else if (s === 'in_progress') a.push('deliver', 'cancel', 'message')
    else if (s === 'delivered') a.push('message')
    else if (s === 'completed' || s === 'resolved') a.push('review')
    if (job.refundDue && job.refundedAt == null) a.push('refund')
    return a
  }
  if (s === 'open' || s === 'quote_requested') return ['cancel', 'message']
  if (s === 'quoted') return ['accept_quote', 'cancel', 'message']
  if (s === 'awaiting_payment') return ['pay', 'cancel', 'message']
  if (s === 'in_progress') return job.deadlineAt && now > job.deadlineAt + GRACE_AFTER_DEADLINE_MS ? ['cancel', 'message'] : ['message']
  if (s === 'delivered') {
    if (isSealed(job)) return ['pay', 'cancel', 'message']
    const a = ['accept', 'dispute', 'message']
    if (job.revisionCount < job.maxRevisions) a.splice(1, 0, 'request_revision')
    return a
  }
  if (s === 'expired' && payableState(job) === 'expired_unpaid' && withinGrace(job, now)) return ['pay']
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
    currency: 'USDC',
    payment: job.payment,
    paid: job.paidAt != null,
    refund_due: job.refundDue && job.refundedAt == null,
    thread_id: job.threadId,
    ...extra,
  })
}

async function reload(id: string): Promise<Job> {
  return (await db().query.jobs.findFirst({ where: eq(jobs.id, id) }))!
}

/** Conditional transition: applies `set` only if the job is still in one of `expected`. Returns null if it was not. */
async function setJobIf(id: string, expected: JobStatus[], set: Partial<typeof jobs.$inferInsert>): Promise<Job | null> {
  const r = await db()
    .update(jobs)
    .set({ ...set, updatedAt: Date.now() })
    .where(and(eq(jobs.id, id), inArray(jobs.status, expected)))
  if ((r.rowsAffected ?? 0) === 0) return null
  return reload(id)
}

async function listingOf(job: Job): Promise<Listing | undefined> {
  return job.listingId ? db().query.listings.findFirst({ where: eq(listings.id, job.listingId) }) : undefined
}

/** Post the agent's own words as the agent (scanned, attributed), then a neutral platform note. */
async function note(job: Job, actorId: string | null, text: string | undefined, systemText: string, data: Record<string, unknown>) {
  if (!job.threadId) return
  if (actorId && text && text.trim()) {
    try {
      await sendMessage(job.env, job.threadId, actorId, text.trim().slice(0, 4000))
    } catch (e) {
      log.warn({ err: e, job: job.id }, 'could not post agent note')
    }
  }
  await postSystemMessage(job.threadId, systemText, data)
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

async function finalize(job: Job, listingOutcome?: 'completed' | 'failed') {
  await recordJobOutcome(job)
  if (job.listingId && listingOutcome) {
    const turnaround = job.acceptedAt && job.deliveredAt ? Math.round((job.deliveredAt - job.acceptedAt) / 1000) : undefined
    await recordListingOutcome({ listingId: job.listingId, status: listingOutcome, buyerAgentId: job.buyerAgentId, price: job.price ?? 0, turnaroundSeconds: turnaround })
  }
}

const money = (price: number | null | undefined) => formatUsdc(price ?? 0)

// --- creation ---------------------------------------------------------------------------------

export type CreateJobInput = { listing_id: string; input: unknown; units?: number; title?: string; max_revisions?: number }

async function assertSellerCapacity(env: Env, sellerId: string, maxOpen: number) {
  const open = await db().select({ n: sql<number>`count(*)` }).from(jobs).where(and(eq(jobs.env, env), eq(jobs.sellerAgentId, sellerId), inArray(jobs.status, OPEN_FOR_SELLER)))
  if ((open[0]?.n ?? 0) >= maxOpen) throw errors.state('seller_busy', 'This seller has reached its concurrent job limit.', 'Try again later or pick another listing: GET /v1/listings?q=.')
}

function paymentIntro(payment: PaymentTiming, price: number | null): string {
  if (price === 0) return 'This job is free.'
  if (price == null) return ''
  return payment === 'upfront' ? `Payment (${money(price)}) is due right after the seller accepts, wallet-to-wallet in USDC.` : `Payment (${money(price)}) is due when the seller delivers: the delivery stays sealed until you pay, then it is revealed.`
}

export async function createJob(env: Env, buyer: Agent, input: CreateJobInput): Promise<Job> {
  const listing: Listing = await getActiveListingForOrder(env, input.listing_id)
  if (listing.sellerAgentId === buyer.id) throw errors.validation('You cannot order your own listing.', 'listing_id')
  const seller = await db().query.agents.findFirst({ where: eq(agents.id, listing.sellerAgentId) })
  if (!seller || seller.status !== 'active') throw errors.state('seller_unavailable', 'The seller of this listing is not active.', 'Pick another listing: GET /v1/listings?q=.')
  if (seller.walletAddress && buyer.walletAddress && sameAddress(seller.walletAddress, buyer.walletAddress)) throw errors.validation('Buyer and seller use the same wallet address; a job between them cannot be paid.', 'listing_id', 'Self-dealing does not build reputation. Use a different wallet or pick another listing.')
  const jobInput = validateInput(input.input, listing.inputSchema)
  await assertSellerCapacity(env, listing.sellerAgentId, listing.maxOpenJobs)

  let units = 1
  if (listing.pricingModel === 'per_unit') {
    units = input.units ?? 1
    if (!Number.isInteger(units) || units < 1) throw errors.validation('units must be an integer >= 1 for per-unit listings.', 'units')
  }
  const price = listing.pricingModel === 'quote' ? null : listing.pricingModel === 'per_unit' ? listing.price! * units : listing.price!
  if (price != null && !Number.isSafeInteger(price)) throw errors.validation('price overflow', 'units')
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
    payment: listing.payment,
    status,
    revisionCount: 0,
    maxRevisions: input.max_revisions ?? 2,
    turnaroundSeconds: listing.turnaroundSeconds,
    acceptDeadlineAt: now + listing.acceptTimeoutSeconds * 1000,
    deadlineAt: null,
    reviewDeadlineAt: null,
    createdAt: now,
    updatedAt: now,
  }
  await db().insert(jobs).values(row)
  const thread = await createJobThread(env, id, [buyer.id, listing.sellerAgentId])
  await db().update(jobs).set({ threadId: thread.id }).where(eq(jobs.id, id))
  await postSystemMessage(thread.id, status === 'open' ? `Job created. ${paymentIntro(listing.payment, price)} Seller: accept or decline before ${new Date(row.acceptDeadlineAt!).toISOString()}.` : `Quote requested. Seller: send a quote with POST /v1/jobs/{id}/quote. ${listing.payment === 'upfront' ? 'The buyer pays after accepting the quote.' : 'The buyer pays against the sealed delivery.'}`, { job_id: id, status })
  await logJobEvent(id, 'created', buyer.id, { price, units, listing_id: listing.id, payment: listing.payment })
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
  /** seller wallet at award time; frozen as the pay-to address for upfront jobs */
  sellerWallet: string | null
  title: string
  input: Record<string, unknown>
  price: number
  payment: PaymentTiming
  turnaroundSeconds?: number
}

/** Award of a bounty: both sides already agreed on price, so the job starts in_progress (or awaiting_payment for upfront). */
export async function createJobFromBountyAward(input: CreateJobFromBountyInput): Promise<Job> {
  const now = Date.now()
  const id = newId('job')
  const turnaround = input.turnaroundSeconds ?? DEFAULT_TURNAROUND
  const upfront = input.payment === 'upfront' && input.price > 0
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
    payment: input.payment,
    status: upfront ? 'awaiting_payment' : 'in_progress',
    revisionCount: 0,
    maxRevisions: 2,
    turnaroundSeconds: turnaround,
    acceptDeadlineAt: null,
    deadlineAt: upfront ? null : now + turnaround * 1000,
    paymentDeadlineAt: upfront ? now + paymentWindowMs(input.env) : null,
    payTo: upfront ? input.sellerWallet : null,
    reviewDeadlineAt: null,
    createdAt: now,
    acceptedAt: now,
    updatedAt: now,
  }
  await db().insert(jobs).values(row)
  const thread = await createJobThread(input.env, id, [input.buyerAgentId, input.sellerAgentId])
  await db().update(jobs).set({ threadId: thread.id }).where(eq(jobs.id, id))
  await postSystemMessage(thread.id, upfront ? `Bounty awarded at ${money(input.price)}. Buyer: pay with POST /v1/jobs/{id}/pay before ${new Date(row.paymentDeadlineAt!).toISOString()}; the seller starts once paid.` : `Bounty awarded at ${money(input.price)}. ${paymentIntro(input.payment, input.price)} Seller: deliver before ${new Date(row.deadlineAt!).toISOString()}.`, { job_id: id, status: row.status })
  await logJobEvent(id, 'created', input.buyerAgentId, { price: input.price, bounty_id: input.bountyId, payment: input.payment })
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
  const sealedHint = job.status === 'delivered' && isSealed(job) && role === 'buyer' ? ' The delivery is sealed until you pay: POST /v1/jobs/{id}/pay.' : ''
  throw errors.state('invalid_transition', `Cannot ${action} a job in status '${job.status}' as ${role}.`, (allowed.length ? `Available actions for you now: ${allowed.join(', ')}.` : 'No actions are available for you on this job right now.') + sealedHint)
}

function requireRole(role: Role, needed: Role, job: Job, action: string) {
  if (role !== needed) invalid(job, role, action)
}

/** Conditional transition helper: idempotent if already in `target`, invalid otherwise. */
async function transition(job: Job, role: Role, action: string, from: JobStatus[], target: JobStatus, set: Partial<typeof jobs.$inferInsert>): Promise<Job> {
  const updated = await setJobIf(job.id, from, { ...set, status: target })
  if (updated) return updated
  const current = await reload(job.id)
  if (current.status === target) return current
  invalid(current, role, action)
}

/** What happens once both sides agreed on the price: start work, or wait for the upfront payment (pay-to frozen now). */
function startPatch(job: Pick<Job, 'payment' | 'turnaroundSeconds' | 'env'>, price: number | null, now: number, sellerWallet: string | null): Partial<typeof jobs.$inferInsert> {
  const upfront = job.payment === 'upfront' && (price ?? 0) > 0
  return upfront ? { status: 'awaiting_payment', acceptedAt: now, paymentDeadlineAt: now + paymentWindowMs(job.env), deadlineAt: null, payTo: sellerWallet } : { status: 'in_progress', acceptedAt: now, deadlineAt: now + job.turnaroundSeconds * 1000 }
}

export async function accept(env: Env, actor: Agent, id: string): Promise<Job> {
  const { job, role } = await getJobForParty(env, actor.id, id)
  requireRole(role, 'seller', job, 'accept')
  if (job.status === 'in_progress' || job.status === 'awaiting_payment') return job
  if (job.status !== 'open') invalid(job, role, 'accept')
  if (needsPayment(job)) assertWalletAddress(actor, 'accept a paid job (the buyer pays to it)')
  const now = Date.now()
  const patch = startPatch(job, job.price, now, actor.walletAddress)
  const updated = await setJobIf(id, ['open'], patch)
  if (!updated) {
    const current = await reload(id)
    if (current.status === 'in_progress' || current.status === 'awaiting_payment') return current
    invalid(current, role, 'accept')
  }
  await logJobEvent(id, 'accepted', actor.id)
  if (updated.status === 'awaiting_payment') {
    await note(updated, null, undefined, `Seller accepted. Buyer: pay ${money(updated.price)} with POST /v1/jobs/{id}/pay before ${new Date(updated.paymentDeadlineAt!).toISOString()}. Work starts once the payment is verified.`, { job_id: id, status: 'awaiting_payment' })
    await notify(updated, 'accepted', { payment_due: true, pay_by: new Date(updated.paymentDeadlineAt!).toISOString() })
  } else {
    await note(updated, null, undefined, `Seller accepted. Delivery due by ${new Date(updated.deadlineAt!).toISOString()}.`, { job_id: id, status: 'in_progress' })
    await notify(updated, 'accepted')
  }
  return updated
}

export async function decline(env: Env, actor: Agent, id: string, reason?: string): Promise<Job> {
  const { job, role } = await getJobForParty(env, actor.id, id)
  requireRole(role, 'seller', job, 'decline')
  if (job.status === 'declined') return job
  const from: JobStatus[] = ['open', 'quote_requested', 'quoted', 'awaiting_payment']
  if (!from.includes(job.status)) invalid(job, role, 'decline')
  // paymentDeadlineAt is kept: a transfer already in flight is still matched and recorded (refund due).
  const updated = await transition(job, role, 'decline', from, 'declined', { cancelReason: 'seller declined' })
  await logJobEvent(id, 'declined', actor.id, { reason })
  await note(updated, actor.id, reason, 'Seller declined. Nothing was charged.', { job_id: id, status: 'declined' })
  await notify(updated, 'declined', { reason })
  await finalize(updated)
  return updated
}

export async function quote(env: Env, actor: Agent, id: string, price: number, message?: string): Promise<Job> {
  const { job, role } = await getJobForParty(env, actor.id, id)
  requireRole(role, 'seller', job, 'quote')
  if (job.status === 'quoted' && job.quotedPrice === price) return job
  if (job.status !== 'quote_requested' && job.status !== 'quoted') invalid(job, role, 'quote')
  if (price > 0) assertWalletAddress(actor, 'quote a price (the buyer pays to it)')
  const listing = await listingOf(job)
  const acceptWindow = (listing?.acceptTimeoutSeconds ?? 3600) * 1000
  // The buyer's window to accept starts with the FIRST quote; re-quoting cannot push it out.
  const acceptDeadlineAt = job.status === 'quote_requested' || !job.acceptDeadlineAt ? Date.now() + acceptWindow : job.acceptDeadlineAt
  const updated = await transition(job, role, 'quote', ['quote_requested', 'quoted'], 'quoted', { quotedPrice: price, quoteMessage: message?.slice(0, 2000) ?? null, acceptDeadlineAt })
  await logJobEvent(id, 'quoted', actor.id, { price, message })
  await note(updated, actor.id, message, `Seller quoted ${money(price)}. Buyer: accept with POST /v1/jobs/{id}/accept_quote before ${new Date(updated.acceptDeadlineAt!).toISOString()}.`, { job_id: id, status: 'quoted', price })
  await notify(updated, 'quoted', { quoted_price: price })
  return updated
}

export async function acceptQuote(env: Env, actor: Agent, id: string): Promise<Job> {
  const { job, role } = await getJobForParty(env, actor.id, id)
  requireRole(role, 'buyer', job, 'accept_quote')
  if (job.status === 'in_progress' || job.status === 'awaiting_payment') return job
  if (job.status !== 'quoted' || job.quotedPrice == null) invalid(job, role, 'accept_quote')
  const price = job.quotedPrice
  const seller = await db().query.agents.findFirst({ where: eq(agents.id, job.sellerAgentId), columns: { walletAddress: true } })
  const now = Date.now()
  const updated = await setJobIf(id, ['quoted'], { ...startPatch(job, price, now, seller?.walletAddress ?? null), price })
  if (!updated) {
    const current = await reload(id)
    if (current.status === 'in_progress' || current.status === 'awaiting_payment') return current
    invalid(current, role, 'accept_quote')
  }
  await logJobEvent(id, 'quote_accepted', actor.id, { price })
  if (updated.status === 'awaiting_payment') {
    await note(updated, null, undefined, `Buyer accepted the quote (${money(price)}). Buyer: pay with POST /v1/jobs/{id}/pay before ${new Date(updated.paymentDeadlineAt!).toISOString()}; work starts once the payment is verified.`, { job_id: id, status: 'awaiting_payment' })
    await notify(updated, 'accepted', { price, payment_due: true })
  } else {
    await note(updated, null, undefined, `Buyer accepted the quote (${money(price)}). ${paymentIntro(updated.payment, price)} Delivery due by ${new Date(updated.deadlineAt!).toISOString()}.`, { job_id: id, status: 'in_progress' })
    await notify(updated, 'accepted', { price })
  }
  return updated
}

// --- payment (proof of payment, ADR-22) --------------------------------------------------------

export type JobPaymentTerms = PaymentTerms & { payFrom: string | null; payBy: number | null; recipients: string[] }

/** Payment terms for a job: payTo is the seller wallet frozen when the payment became due (else the current one). */
export async function termsForJob(job: Job): Promise<JobPaymentTerms> {
  const [seller, buyer] = await Promise.all([db().query.agents.findFirst({ where: eq(agents.id, job.sellerAgentId) }), db().query.agents.findFirst({ where: eq(agents.id, job.buyerAgentId) })])
  const recipients = [...new Set([job.payTo, seller?.walletAddress].filter((a): a is string => !!a))]
  if (!recipients.length) {
    throw errors.state('seller_has_no_wallet_address', 'The seller has not set a wallet address, so this job cannot be paid yet.', `Message the seller in thread ${job.threadId} and ask them to set one (POST /v1/agents/me/wallet-address). You can cancel the job meanwhile.`)
  }
  const base = config().PUBLIC_BASE_URL.replace(/\/$/, '')
  const terms = paymentTerms({ env: job.env, amount: job.price ?? 0, payTo: recipients[0]!, resourceUrl: `${base}/v1/jobs/${job.id}/pay`, description: `Agent Souk job ${job.id}: ${job.title.slice(0, 80)}` })
  return { ...terms, payFrom: buyer?.walletAddress ?? null, payBy: job.paymentDeadlineAt, recipients }
}

export type PayResult = { job: Job; terms?: JobPaymentTerms; verified?: VerifiedTransfer; alreadyPaid?: boolean }

function alreadyUsed(): ApiError {
  return errors.conflict('transaction_already_used', 'This transaction hash was already used for another payment.', 'Every job needs its own transaction: send a fresh USDC transfer for this job and submit its hash.')
}

/** Puts (or raises) the refund obligation on the seller. `amount` is what the buyer is owed for THIS trigger. */
async function markRefundDue(jobId: string, actorId: string | null, why: string, amount: number, extra: Record<string, unknown> = {}): Promise<Job> {
  const before = await reload(jobId)
  if (before.refundedAt != null) return before // already refunded once; a second obligation would need a fresh cycle
  const expected = (before.refundDue ? (before.refundExpected ?? 0) : 0) + amount
  await db().update(jobs).set({ refundDue: true, refundExpected: expected, updatedAt: Date.now() }).where(eq(jobs.id, jobId))
  const updated = await reload(jobId)
  await logJobEvent(jobId, 'refund_due', actorId, { why, amount, expected, ...extra })
  await note(updated, null, undefined, `Refund due: ${why} Seller: send ${money(expected)} back to the buyer wallet (payment.pay_from) in ONE transfer and submit the hash with POST /v1/jobs/{id}/refund. An open refund counts against your reputation.`, { job_id: jobId, refund_due: true, refund_expected: expected, ...extra })
  await notify(updated, 'refund_due', { why, amount, refund_expected: expected, ...extra })
  return updated
}

/** Records a verified transfer that cannot pay the job (already paid, or no longer payable) and puts the refund on the seller. */
async function orphanPayment(job: Job, actor: Agent, verified: VerifiedTransfer, why: string, existingRow?: Settlement): Promise<Job> {
  const row = existingRow ?? settlementRow({ env: job.env, jobId: job.id, kind: 'payment', payerAgentId: job.buyerAgentId, payeeAgentId: job.sellerAgentId, verified, expectedAmount: job.price ?? 0, status: 'orphaned' })
  try {
    await settle(async () => {
      if (existingRow) await db().update(settlements).set({ status: 'orphaned' }).where(eq(settlements.id, row.id))
      else await db().insert(settlements).values(row)
    })
  } catch (e) {
    if (isUniqueViolation(e)) throw alreadyUsed()
    throw e
  }
  await logJobEvent(job.id, 'payment_orphaned', actor.id, { settlement_id: row.id, transaction: verified.transaction, amount: verified.amount, why })
  const marked = await markRefundDue(job.id, actor.id, `the buyer paid ${money(verified.amount)} (tx ${verified.transaction}) but ${why}.`, verified.amount, { transaction: verified.transaction })
  await recordJobOutcome(marked)
  return marked
}

/**
 * POST /v1/jobs/{id}/pay. Without a transaction hash returns the payment terms (the route answers 402). With one,
 * verifies the on-chain USDC transfer read-only and advances the job. Idempotent: an already paid job (or the
 * same hash again) returns the job. A verified transfer is never dropped: partial amounts add up, and transfers
 * that cannot pay the job become orphaned settlements with a refund obligation on the seller.
 */
export async function payJob(env: Env, actor: Agent, id: string, transaction: unknown, x402Header?: string): Promise<PayResult> {
  const { job, role } = await getJobForParty(env, actor.id, id)
  requireRole(role, 'buyer', job, 'pay')
  const wantsTerms = transaction === undefined || transaction === null || transaction === ''
  if (wantsTerms || x402Header) {
    if (job.paidAt != null) return { job, alreadyPaid: true }
    if (!payableState(job)) invalid(job, role, 'pay')
    const terms = await termsForJob(job)
    if (x402Header) {
      throw new ApiError('payment_error', 'settle_it_yourself', 'Agent Souk does not settle x402 authorizations (it never touches payment instruments). Broadcast your signed authorization yourself, then submit the transaction hash.', {
        hint: `POST the body in details.settle_body to ${terms.facilitator}/settle (a public facilitator; gas-free). It returns {success, transaction}. Then POST this URL again with {"transaction":"<that hash>"} and no ${x402Header.toUpperCase()} header.`,
        details: { settle_body: { x402Version: 2, paymentPayload: '<the PaymentPayload you put in the header, decoded>', paymentRequirements: terms.x402.accepts[0] }, facilitator: terms.facilitator },
      })
    }
    return { job, terms }
  }
  const txHash = normalizeTxHash(transaction)
  if (!txHash) throw errors.validation('transaction must be a 32-byte hex transaction hash (0x + 64 hex characters).', 'transaction', 'Send the hash your wallet returned after the USDC transfer. Smart wallets (ERC-4337): the mined transaction hash from the receipt, not the userOperation hash.')
  if (job.price == null) invalid(job, role, 'pay')

  // --- a hash we have seen before -------------------------------------------------------------
  const known = await findSettlementByTransaction(txHash)
  if (known && (known.jobId !== job.id || known.kind !== 'payment')) throw alreadyUsed()
  if (known?.status === 'settled' && job.paidAt != null) return { job, alreadyPaid: true }
  if (known?.status === 'orphaned') {
    if (!job.refundDue && job.refundedAt == null) await markRefundDue(job.id, actor.id, `the buyer paid ${money(known.amount)} (tx ${known.transaction}) but the job could not be paid.`, known.amount, { transaction: known.transaction })
    if (job.paidAt != null) return { job: await reload(job.id), alreadyPaid: true }
    throw errors.state('job_not_payable', `This transfer was verified earlier, but the job is '${job.status}' and cannot be paid.`, 'The seller owes you a refund (refund_due=true on the job). Watch for the job.refunded event or message the seller in the job thread.')
  }

  const payFrom = assertWalletAddress(actor, 'pay a job (the transfer must come from the wallet you proved control of)')
  const state = payableState(job)
  const seller = await db().query.agents.findFirst({ where: eq(agents.id, job.sellerAgentId), columns: { walletAddress: true } })
  const recipients = [...new Set([job.payTo, seller?.walletAddress].filter((a): a is string => !!a))]
  if (!recipients.length) throw errors.state('seller_has_no_wallet_address', 'The seller has no wallet address, so nothing can be verified for this job.', `Message the seller in thread ${job.threadId}.`)
  if (recipients.some((r) => sameAddress(payFrom, r))) {
    throw new ApiError('payment_error', 'payment_invalid', 'Your wallet address equals the seller wallet address; self-payments are not accepted.', { hint: 'Use a wallet that is not the seller wallet, or pick another seller.', details: { reason: 'self_payment' } })
  }

  // Verify (or reuse a settled/partial row for this job after a crash between the two writes).
  const verified: VerifiedTransfer = known
    ? { transaction: known.transaction, from: known.payerAddress, to: known.payTo, amount: known.amount, asset: known.asset, network: known.network as VerifiedTransfer['network'], blockNumber: known.blockNumber, blockTimestamp: known.blockTimestamp, confirmations: 0 }
    : await verifyUsdcTransfer(env, txHash, { from: payFrom, to: recipients, minAmount: job.price, notBefore: job.createdAt - PAYMENT_SKEW_MS, allowPartial: true })

  // --- the job cannot take a payment any more: the seller received USDC, so a refund is due ----
  if (job.paidAt != null) {
    const marked = await orphanPayment(job, actor, verified, 'the job was already paid by another transaction', known ?? undefined)
    return { job: marked, alreadyPaid: true }
  }
  if (!state) {
    const marked = await orphanPayment(job, actor, verified, `the job is '${job.status}' and no longer payable`, known ?? undefined)
    throw errors.state('job_not_payable', `The payment was verified on-chain, but the job is '${marked.status}' and cannot be paid.`, 'The seller has been told to refund you (refund_due=true on the job). Watch for the job.refunded event or message the seller in the job thread.')
  }
  if (state === 'expired_unpaid' && verified.blockTimestamp > job.paymentDeadlineAt! + PAYMENT_GRACE_MS) {
    await orphanPayment(job, actor, verified, 'the job had expired unpaid and the transfer was mined after the grace period', known ?? undefined)
    throw errors.state('job_not_payable', 'The job expired unpaid and this payment was mined after the grace period; it cannot revive the job.', 'The seller has been told to refund you (refund_due=true). Pay before pay_by next time, or order again.')
  }

  // --- partial payments add up -------------------------------------------------------------------
  const partials = (await listSettlementsForJob(job.id)).filter((s) => s.kind === 'payment' && s.status === 'partial' && s.id !== known?.id)
  const total = partials.reduce((s, p) => s + p.amount, 0) + verified.amount
  if (total < job.price) {
    if (!known) {
      const row = settlementRow({ env, jobId: job.id, kind: 'payment', payerAgentId: job.buyerAgentId, payeeAgentId: job.sellerAgentId, verified, expectedAmount: job.price, status: 'partial' })
      try {
        await settle(() => db().insert(settlements).values(row))
      } catch (e) {
        if (isUniqueViolation(e)) throw alreadyUsed()
        throw e
      }
      await logJobEvent(job.id, 'payment_partial', actor.id, { settlement_id: row.id, transaction: verified.transaction, amount: verified.amount, total, required: job.price })
      await note(job, null, undefined, `Partial payment recorded: ${money(verified.amount)} (tx ${verified.transaction}), ${money(total)} of ${money(job.price)} so far. Buyer: send the remaining ${money(job.price - total)} and submit that hash.`, { job_id: job.id, partial: true, transaction: verified.transaction })
    }
    throw new ApiError('payment_error', 'payment_invalid', `The transfer covers ${money(total)} of the ${money(job.price)} required; it was recorded as a partial payment.`, {
      hint: `Send the remaining ${job.price - total} USDC minor units (${money(job.price - total)}) from your wallet to the seller wallet and submit that hash. Every partial transfer is kept; nothing is lost.`,
      details: { reason: 'amount_too_low', transferred: total, required: job.price, remaining: job.price - total, recorded: true },
    })
  }

  // --- pay the job: settlement row(s) + conditional job update under the settlement lock ---------
  const now = Date.now()
  const row = known ?? settlementRow({ env, jobId: job.id, kind: 'payment', payerAgentId: job.buyerAgentId, payeeAgentId: job.sellerAgentId, verified, expectedAmount: job.price, status: 'settled', now })
  const startsWork = job.output == null
  const patch: Partial<typeof jobs.$inferInsert> = startsWork
    ? { status: 'in_progress', paidAt: now, settlementId: row.id, paymentDeadlineAt: null, unpaid: false, deadlineAt: now + job.turnaroundSeconds * 1000, updatedAt: now }
    : { status: 'delivered', paidAt: now, settlementId: row.id, paymentDeadlineAt: null, unpaid: false, reviewDeadlineAt: now + reviewWindowMs(env), updatedAt: now }
  // Two single-statement writes under one lock instead of a transaction: SQLite has one writer, and an open
  // transaction on this single-threaded node would deadlock against any other request's write. The settlement row
  // goes first (the unique hash is the fence); the job update is conditional and also accepts a job that a sweep
  // expired unpaid meanwhile (the transfer was on time, so it revives it).
  let won = false
  try {
    await settle(async () => {
      if (!known) await db().insert(settlements).values(row)
      else if (known.status === 'partial') await db().update(settlements).set({ status: 'settled' }).where(eq(settlements.id, known.id))
      const r = await db()
        .update(jobs)
        .set(patch)
        .where(and(eq(jobs.id, job.id), inArray(jobs.status, ['awaiting_payment', 'delivered', 'expired']), isNull(jobs.paidAt), or(sql`${jobs.status} != 'expired'`, eq(jobs.unpaid, true))!))
      won = (r.rowsAffected ?? 0) > 0
      if (won && partials.length) await db().update(settlements).set({ status: 'settled' }).where(inArray(settlements.id, partials.map((p) => p.id)))
    })
  } catch (e) {
    if (isUniqueViolation(e)) throw alreadyUsed()
    throw e
  }
  if (!won) {
    const current = await reload(job.id)
    const why = current.paidAt != null ? 'the job was already paid by another transaction' : `the job is '${current.status}' and no longer payable`
    const marked = await orphanPayment(current, actor, verified, why, (await findSettlementByTransaction(txHash)) ?? undefined)
    if (current.paidAt != null) return { job: marked, alreadyPaid: true }
    throw errors.state('job_not_payable', `The payment was verified on-chain, but the job is now '${current.status}' and cannot be paid.`, 'The seller has been told to refund you (refund_due=true on the job). Watch for the job.refunded event or message the seller in the job thread.')
  }

  const updated = await reload(job.id)
  const revealed = !startsWork
  await logJobEvent(job.id, 'paid', actor.id, { settlement_id: row.id, transaction: verified.transaction, network: verified.network, amount: verified.amount, total, payer: verified.from, output_revealed: revealed, revived: job.status === 'expired', repaired: !!known, partials: partials.length })
  await note(
    updated,
    null,
    undefined,
    revealed ? `Paid ${money(total)} (tx ${verified.transaction}). The delivery is now revealed. Buyer: accept, request a revision or dispute before ${new Date(updated.reviewDeadlineAt!).toISOString()}; otherwise the job auto-completes.` : `Paid ${money(total)} (tx ${verified.transaction}). Seller: deliver before ${new Date(updated.deadlineAt!).toISOString()}.`,
    { job_id: job.id, status: updated.status, transaction: verified.transaction },
  )
  await notify(updated, 'paid', { settlement_id: row.id, transaction: verified.transaction, network: verified.network, amount: total, output_revealed: revealed })
  if (job.status === 'expired') await recordJobOutcome(updated)
  return { job: updated, verified }
}

/** POST /v1/jobs/{id}/refund: the seller proves an on-chain refund to the buyer (ADR-22 §8). Idempotent. */
export async function refundJob(env: Env, actor: Agent, id: string, transaction: unknown, noteText?: string): Promise<{ job: Job; verified?: VerifiedTransfer; alreadyRefunded?: boolean }> {
  const { job, role } = await getJobForParty(env, actor.id, id)
  requireRole(role, 'seller', job, 'refund')
  if (job.refundedAt != null) return { job, alreadyRefunded: true }
  const paymentsIn = (await listSettlementsForJob(job.id)).filter((s) => s.kind === 'payment')
  if (!paymentsIn.length) throw errors.state('not_paid', 'This job never received a verified payment, so there is nothing to refund.', 'Refunds are only possible on jobs with a recorded payment (payment.status == "paid" or refund_due == true).')
  const from = assertWalletAddress(actor, 'refund a job (the transfer must come from your registered wallet)')
  const buyer = await db().query.agents.findFirst({ where: eq(agents.id, job.buyerAgentId) })
  const recipients = [...new Set([...paymentsIn.map((p) => p.payerAddress), buyer?.walletAddress].filter((a): a is string => !!a))]
  const expected = job.refundExpected ?? paymentsIn.reduce((s, p) => s + p.amount, 0)
  const txHash = normalizeTxHash(transaction)
  if (!txHash) throw errors.validation('transaction must be a 32-byte hex transaction hash (0x + 64 hex characters).', 'transaction', 'Send the hash your wallet returned after the USDC transfer to the buyer.')
  const known = await findSettlementByTransaction(txHash)
  if (known) {
    if (known.jobId === job.id && known.kind === 'refund') return { job: await reload(job.id), alreadyRefunded: true }
    throw errors.conflict('transaction_already_used', 'This transaction hash was already used.', 'Send a fresh USDC transfer to the buyer wallet and submit its hash.')
  }
  const notBefore = Math.min(...paymentsIn.map((p) => p.blockTimestamp))
  const verified = await verifyUsdcTransfer(env, txHash, { from, to: recipients, minAmount: expected, notBefore })
  const now = Date.now()
  const row = settlementRow({ env, jobId: job.id, kind: 'refund', payerAgentId: job.sellerAgentId, payeeAgentId: job.buyerAgentId, verified, expectedAmount: expected, status: 'settled', now })
  let won = false
  try {
    await settle(async () => {
      await db().insert(settlements).values(row)
      const r = await db()
        .update(jobs)
        .set({ refundDue: false, refundedAt: now, refundSettlementId: row.id, updatedAt: now })
        .where(and(eq(jobs.id, job.id), isNull(jobs.refundedAt)))
      won = (r.rowsAffected ?? 0) > 0
    })
  } catch (e) {
    if (isUniqueViolation(e)) throw errors.conflict('transaction_already_used', 'This transaction hash was already used.', 'Send a fresh USDC transfer to the buyer wallet and submit its hash.')
    throw e
  }
  if (!won) return { job: await reload(job.id), alreadyRefunded: true } // a second refund transfer: recorded as a settlement, the job keeps the first
  const updated = await reload(job.id)
  await logJobEvent(job.id, 'refunded', actor.id, { settlement_id: row.id, transaction: verified.transaction, amount: verified.amount, expected, note: noteText })
  await note(updated, actor.id, noteText, `Seller refunded ${money(verified.amount)} to the buyer (tx ${verified.transaction}).`, { job_id: job.id, status: updated.status, transaction: verified.transaction, refunded: true })
  await notify(updated, 'refunded', { settlement_id: row.id, transaction: verified.transaction, amount: verified.amount })
  await recordJobOutcome(updated)
  return { job: updated, verified }
}

// --- delivery and review ----------------------------------------------------------------------

export async function deliver(env: Env, actor: Agent, id: string, output: unknown, message?: string, preview?: unknown): Promise<Job> {
  const { job, role } = await getJobForParty(env, actor.id, id)
  requireRole(role, 'seller', job, 'deliver')
  if (job.status === 'delivered') return job
  if (job.status !== 'in_progress') invalid(job, role, 'deliver')
  if (output === undefined) throw errors.validation('output is required.', 'output', 'Send the deliverable as JSON (any shape; follow the listing output_schema if present).')
  const serialised = JSON.stringify(output)
  if (serialised.length > 512 * 1024) throw errors.validation('output must be at most 512 KB when serialised.', 'output', 'Return a URL or split the deliverable.')
  if (preview !== undefined && preview !== null && JSON.stringify(preview).length > 4096) throw errors.validation('preview must be at most 4 KB when serialised.', 'preview', 'The preview is a teaser the buyer sees before paying; keep it short.')
  const willSeal = job.payment === 'on_delivery' && needsPayment(job) && job.paidAt == null
  if (willSeal) assertWalletAddress(actor, 'deliver a paid job (the buyer pays to it)')
  const scan = scanJson(output)
  const now = Date.now()
  const set: Partial<typeof jobs.$inferInsert> = {
    output,
    outputHash: sha256Hex(canonicalJson(output)),
    outputBytes: Buffer.byteLength(serialised, 'utf8'),
    outputPreview: preview ?? null,
    deliveredAt: now,
    reviewDeadlineAt: willSeal ? null : now + reviewWindowMs(env),
    paymentDeadlineAt: willSeal ? now + reviewWindowMs(env) : null,
    // the pay-to address is frozen now so a later wallet change cannot invalidate a transfer in flight
    ...(willSeal ? { payTo: actor.walletAddress } : {}),
  }
  const updated = await transition(job, role, 'deliver', ['in_progress'], 'delivered', set)
  if (updated.deliveredAt !== now) return updated
  await logJobEvent(id, 'delivered', actor.id, { on_time: job.deadlineAt ? now <= job.deadlineAt : true, sealed: willSeal, output_hash: set.outputHash, content_warnings: scan.warnings })
  await note(
    updated,
    actor.id,
    message,
    willSeal ? `Delivered (sealed, sha256 ${set.outputHash}). Buyer: pay ${money(updated.price)} with POST /v1/jobs/{id}/pay before ${new Date(updated.paymentDeadlineAt!).toISOString()} to reveal it; otherwise the job expires unpaid.` : `Delivered. Buyer: accept, request a revision or dispute before ${new Date(updated.reviewDeadlineAt!).toISOString()}; otherwise the job auto-completes.`,
    { job_id: id, status: 'delivered', sealed: willSeal },
  )
  await notify(updated, 'delivered', { sealed: willSeal, output_hash: set.outputHash, payment_due: willSeal, content_warnings: scan.warnings })
  return updated
}

export async function acceptDelivery(env: Env, actor: Agent, id: string): Promise<Job> {
  const { job, role } = await getJobForParty(env, actor.id, id)
  requireRole(role, 'buyer', job, 'accept')
  if (job.status === 'completed') return job
  if (job.status !== 'delivered' || isSealed(job)) invalid(job, role, 'accept')
  return complete(job, actor.id, 'buyer accepted')
}

async function complete(job: Job, actorId: string | null, noteText: string): Promise<Job> {
  const flipped = await setJobIf(job.id, ['delivered'], { status: 'completed', completedAt: Date.now() })
  if (!flipped) {
    const current = await reload(job.id)
    if (current.status === 'completed') return current
    if (actorId) invalid(current, 'buyer', 'accept')
    return current
  }
  await logJobEvent(job.id, 'completed', actorId, { note: noteText })
  await note(flipped, null, undefined, `Completed (${noteText}). Both sides can now leave a review: POST /v1/jobs/{id}/reviews.`, { job_id: job.id, status: 'completed' })
  await notify(flipped, 'completed')
  await publishFeed(flipped.env, 'job.completed', { job_id: flipped.id, title: flipped.title, price_rounded: Math.round((flipped.price ?? 0) / 10000) * 10000, currency: 'USDC', seller_id: flipped.sellerAgentId, buyer_id: flipped.buyerAgentId })
  await finalize(flipped, 'completed')
  return flipped
}

export async function requestRevision(env: Env, actor: Agent, id: string, message: string): Promise<Job> {
  const { job, role } = await getJobForParty(env, actor.id, id)
  requireRole(role, 'buyer', job, 'request_revision')
  if (job.status !== 'delivered' || isSealed(job)) invalid(job, role, 'request_revision')
  if (job.revisionCount >= job.maxRevisions) throw errors.state('revisions_exhausted', `This job allows ${job.maxRevisions} revision(s) and they are used up.`, 'Accept the delivery (POST /v1/jobs/{id}/accept) or open a dispute (POST /v1/jobs/{id}/dispute).')
  const now = Date.now()
  const updated = await transition(job, role, 'request_revision', ['delivered'], 'in_progress', { revisionCount: job.revisionCount + 1, deadlineAt: now + job.turnaroundSeconds * 1000, reviewDeadlineAt: null })
  await logJobEvent(id, 'revision_requested', actor.id, { message, revision: updated.revisionCount })
  await note(updated, actor.id, message, `Revision ${updated.revisionCount}/${updated.maxRevisions} requested. Seller: deliver again by ${new Date(updated.deadlineAt!).toISOString()}.`, { job_id: id, status: 'in_progress' })
  await notify(updated, 'revision_requested', { revision: updated.revisionCount })
  return updated
}

export async function dispute(env: Env, actor: Agent, id: string, reason: string): Promise<Job> {
  const { job, role } = await getJobForParty(env, actor.id, id)
  requireRole(role, 'buyer', job, 'dispute')
  if (job.status === 'disputed') return job
  if (job.status !== 'delivered' || isSealed(job)) invalid(job, role, 'dispute')
  const updated = await transition(job, role, 'dispute', ['delivered'], 'disputed', { disputeReason: reason.slice(0, 2000), reviewDeadlineAt: null })
  await logJobEvent(id, 'disputed', actor.id, { reason })
  await note(updated, actor.id, reason, 'Buyer opened a dispute. An arbiter will record a verdict that counts towards both reputations; the platform holds no funds, so any refund is voluntary and settled wallet-to-wallet. Both sides: add evidence in this thread.', { job_id: id, status: 'disputed' })
  await notify(updated, 'disputed', { reason })
  await finalize(updated)
  return updated
}

/** USDC the buyer actually paid on this job (settled payments), used to size refund obligations. */
async function paidAmount(job: Job): Promise<number> {
  const rows = await listSettlementsForJob(job.id)
  const paid = rows.filter((s) => s.kind === 'payment' && s.status === 'settled').reduce((s, p) => s + p.amount, 0)
  return paid || job.price || 0
}

export async function cancel(env: Env, actor: Agent, id: string, reason?: string): Promise<Job> {
  const { job, role } = await getJobForParty(env, actor.id, id)
  if (job.status === 'cancelled') return job
  const now = Date.now()
  let sellerFailure = false
  let walkAway = false
  let kind: CancelKind
  let from: JobStatus[]
  let noteText: string
  if (role === 'buyer') {
    if (job.status === 'in_progress') {
      if (!job.deadlineAt || now <= job.deadlineAt + GRACE_AFTER_DEADLINE_MS) {
        throw errors.state('cannot_cancel_in_progress', 'The seller is working on this job and the deadline has not passed.', `You can cancel after ${job.deadlineAt ? new Date(job.deadlineAt + GRACE_AFTER_DEADLINE_MS).toISOString() : 'the deadline plus one hour'}, or message the seller in thread ${job.threadId}.`)
      }
      sellerFailure = true
      kind = 'buyer_after_deadline'
      from = ['in_progress']
      noteText = job.paidAt ? 'Cancelled by buyer after the delivery deadline passed. The buyer already paid: a refund is due.' : 'Cancelled by buyer after the delivery deadline passed. Nothing was charged.'
    } else if (job.status === 'delivered' && isSealed(job)) {
      walkAway = true
      kind = 'buyer_walked_away'
      from = ['delivered']
      noteText = 'Buyer declined to pay for the sealed delivery. The seller keeps the work; nothing was charged.'
    } else if (['open', 'quote_requested', 'quoted', 'awaiting_payment'].includes(job.status)) {
      kind = 'buyer_withdrew'
      from = ['open', 'quote_requested', 'quoted', 'awaiting_payment']
      noteText = 'Cancelled by buyer. Nothing was charged.'
    } else invalid(job, role, 'cancel')
  } else {
    if (job.status === 'in_progress') {
      sellerFailure = true
      kind = 'seller_failed'
      from = ['in_progress']
      noteText = job.paidAt ? 'Cancelled by seller while in progress. The buyer already paid: a refund is due; this counts as a failed job.' : 'Cancelled by seller while in progress. Nothing was charged; this counts as a failed job.'
    } else if (['open', 'quote_requested', 'quoted', 'awaiting_payment'].includes(job.status)) return decline(env, actor, id, reason)
    else invalid(job, role, 'cancel')
  }
  // The payment deadline is kept: a transfer already in flight is still matched and recorded (refund due).
  const updated = await transition(job, role, 'cancel', from, 'cancelled', { cancelReason: `${role}: ${reason ?? 'cancelled'}`.slice(0, 500), cancelKind: kind, reviewDeadlineAt: null })
  await logJobEvent(id, 'cancelled', actor.id, { reason, seller_failure: sellerFailure, walk_away: walkAway, refund_due: sellerFailure && updated.paidAt != null })
  await note(updated, actor.id, reason, noteText, { job_id: id, status: 'cancelled' })
  await notify(updated, 'cancelled', { by: role, reason, walk_away: walkAway, refund_due: sellerFailure && updated.paidAt != null })
  const final = sellerFailure && updated.paidAt != null ? await markRefundDue(updated.id, actor.id, `the job was cancelled by the ${role} after the buyer paid.`, await paidAmount(updated)) : updated
  await finalize(final, sellerFailure ? 'failed' : undefined)
  return final
}

/** Arbiter verdict (ADR-21 §8): reputational only; buyer/split verdicts put a refund obligation on the seller. */
export async function resolve(id: string, resolution: { outcome: JobResolution['outcome']; note: string; by: string }): Promise<Job> {
  const job = await db().query.jobs.findFirst({ where: eq(jobs.id, id) })
  if (!job) throw errors.notFound('Job', id)
  if (job.status === 'resolved') return job
  if (job.status !== 'disputed') throw errors.state('not_disputed', `Job ${id} is '${job.status}', only disputed jobs can be resolved.`)
  const res: JobResolution = { outcome: resolution.outcome, note: resolution.note.slice(0, 2000), by: resolution.by }
  const flipped = await setJobIf(id, ['disputed'], { status: 'resolved', resolution: res, completedAt: Date.now() })
  if (!flipped) return reload(id)
  await logJobEvent(id, 'resolved', null, { ...res })
  const verdict = res.outcome === 'buyer' ? 'in favour of the buyer (counts as a failed job for the seller; a full refund is due)' : res.outcome === 'seller' ? 'in favour of the seller (counts as completed)' : 'split (counts as completed; half of the payment is due back)'
  await note(flipped, null, undefined, `Dispute resolved by ${res.by} ${verdict}. Note: ${res.note.slice(0, 500)}`, { job_id: id, status: 'resolved', outcome: res.outcome })
  await notify(flipped, 'resolved', { outcome: res.outcome })
  let final = flipped
  if (res.outcome !== 'seller' && flipped.paidAt != null) {
    const paid = await paidAmount(flipped)
    final = await markRefundDue(flipped.id, null, `the arbiter ruled '${res.outcome}'.`, res.outcome === 'split' ? Math.ceil(paid / 2) : paid, { outcome: res.outcome })
  }
  await finalize(final, res.outcome === 'buyer' ? 'failed' : 'completed')
  return final
}

// --- sweeps -----------------------------------------------------------------------------------

export async function sweepJobs(now = Date.now()): Promise<{ expired: number; expired_unpaid: number; auto_completed: number; errors: number }> {
  const stats = { expired: 0, expired_unpaid: 0, auto_completed: 0, errors: 0 }
  const toExpire = await db().query.jobs.findMany({ where: and(inArray(jobs.status, ['open', 'quote_requested', 'quoted']), lt(jobs.acceptDeadlineAt, now)), limit: 200 })
  for (const job of toExpire) {
    try {
      const flipped = await setJobIf(job.id, ['open', 'quote_requested', 'quoted'], { status: 'expired' })
      if (!flipped) continue
      await logJobEvent(job.id, 'expired', null)
      await note(flipped, null, undefined, 'Expired: no response in time. Nothing was charged.', { job_id: job.id, status: 'expired' })
      await notify(flipped, 'expired')
      await finalize(flipped)
      stats.expired++
    } catch (e) {
      stats.errors++
      log.error({ err: e, job: job.id }, 'sweep: expiry failed')
    }
  }
  // Buyer never paid: upfront jobs waiting for payment, and sealed deliveries. The payment deadline is KEPT so a
  // payment mined within the grace period can still revive the job (ADR-22 §4).
  const unpaid = await db().query.jobs.findMany({ where: and(inArray(jobs.status, ['awaiting_payment', 'delivered']), isNull(jobs.paidAt), lt(jobs.paymentDeadlineAt, now)), limit: 200 })
  for (const job of unpaid) {
    try {
      const flipped = await setJobIf(job.id, ['awaiting_payment', 'delivered'], { status: 'expired', unpaid: true })
      if (!flipped) continue
      await logJobEvent(job.id, 'expired', null, { unpaid: true })
      await note(flipped, null, undefined, job.status === 'delivered' ? `Expired unpaid: the buyer did not pay for the sealed delivery in time. The seller keeps the work; this is recorded on the buyer's reputation. A payment mined within ${PAYMENT_GRACE_MS / 60000} minutes of the deadline still revives the job.` : `Expired unpaid: the buyer did not pay in time. Recorded on the buyer's reputation. A payment mined within ${PAYMENT_GRACE_MS / 60000} minutes of the deadline still revives the job.`, { job_id: job.id, status: 'expired', unpaid: true })
      await notify(flipped, 'expired', { unpaid: true })
      await finalize(flipped)
      stats.expired_unpaid++
    } catch (e) {
      stats.errors++
      log.error({ err: e, job: job.id }, 'sweep: unpaid expiry failed')
    }
  }
  const toComplete = await db().query.jobs.findMany({ where: and(eq(jobs.status, 'delivered'), lt(jobs.reviewDeadlineAt, now)), limit: 200 })
  for (const job of toComplete) {
    try {
      if (isSealed(job)) continue
      await complete(job, null, 'auto-accepted after review window')
      stats.auto_completed++
    } catch (e) {
      stats.errors++
      log.error({ err: e, job: job.id }, 'sweep: auto-complete failed')
    }
  }
  return stats
}

registerSweep('jobs', async (now) => {
  await sweepJobs(now)
})

export { TERMINAL as TERMINAL_STATUSES }
