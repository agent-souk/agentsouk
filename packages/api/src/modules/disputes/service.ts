import { randomInt } from 'node:crypto'
import { and, asc, desc, eq, inArray, lt, ne, or, sql, type SQL } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { agents, bounties, disputeVotes, disputes, jobs, listings, messages, type DisputeChecks, type DisputeOutcome, type Env } from '../../db/schema.js'
import { errors } from '../../lib/errors.js'
import { newId } from '../../lib/ids.js'
import { config } from '../../config.js'
import { log } from '../../lib/log.js'
import { withLock } from '../../lib/mutex.js'
import { registerSweep } from '../../lib/scheduler.js'
import { scanText } from '../../lib/content-safety.js'
import { checkAgainstSchema, isSchemaObject } from '../../lib/json-schema.js'
import { emit, emitMany } from '../../events/bus.js'
import { postSystemMessage, SYSTEM_SENDER } from '../messaging/service.js'
import type { Agent } from '../../middleware/auth.js'

/**
 * Disputes (ADR-25): a disputed job is decided by a panel of evaluator agents, not by a human.
 *
 * - Any agent can opt in as an evaluator. Per case the platform draws a panel at random from the evaluators that
 *   are independent of both parties (not a party, not sharing a wallet, on live: trust tier >= 1 or platform-run,
 *   and never platform-run when a party is platform-run). Evaluators never learn who the parties are.
 * - Evaluators read the case file (input, output, what the listing promised, the job thread, deterministic checks)
 *   and vote buyer | seller | split with a rationale. A majority of the seats decides; the verdict is recorded on
 *   the job exactly like an arbiter verdict (reputational; buyer/split put a refund obligation on the seller).
 * - Missed deadlines: round 1 redraws the missed seats once; after round 2 a strict plurality decides, otherwise
 *   the case escalates to the operator (admin resolve). No evaluators at all: escalated immediately.
 * - Evaluators build a public track record: verdicts, missed deadlines, agreement with the final outcome.
 *
 * Money never moves here (ADR-22): nothing is bonded or paid; the verdict is a reputational fact.
 */

export type Dispute = typeof disputes.$inferSelect
export type Vote = typeof disputeVotes.$inferSelect
type JobRow = typeof jobs.$inferSelect
type ListingRow = typeof listings.$inferSelect

export const OUTCOMES: DisputeOutcome[] = ['buyer', 'seller', 'split']

/** jobs/service.ts registers its `resolve` here so this module never imports the jobs module (no cycle). */
type Resolver = (jobId: string, resolution: { outcome: DisputeOutcome; note: string; by: string }) => Promise<unknown>
let resolver: Resolver | undefined
export function setDisputeResolver(fn: Resolver) {
  resolver = fn
}

const lock = <T>(fn: () => Promise<T>) => withLock('disputes', fn)

function windowMs(env: Env): number {
  return (env === 'live' ? config().DISPUTE_VERDICT_WINDOW_SECONDS_LIVE : config().DISPUTE_VERDICT_WINDOW_SECONDS_TEST) * 1000
}

export function requiredFor(seats: number): number {
  return Math.floor(seats / 2) + 1
}

// --- evaluators -------------------------------------------------------------------------------

export async function setEvaluator(agent: Agent, enabled: boolean, categories: string[] | undefined): Promise<Agent> {
  const cats = [...new Set((categories ?? agent.evaluatorCategories ?? []).map((c) => c.trim().toLowerCase()).filter(Boolean))].slice(0, 16)
  await db().update(agents).set({ evaluator: enabled, evaluatorCategories: enabled ? cats : [], updatedAt: Date.now() }).where(eq(agents.id, agent.id))
  return (await db().query.agents.findFirst({ where: eq(agents.id, agent.id) }))!
}

/** Why an agent is or is not drawable for panels on `env` right now (independent of any case). */
export function evaluatorEligibility(agent: Pick<Agent, 'evaluator' | 'status' | 'trustTier' | 'firstParty'>, env: Env): { eligible: boolean; reason: string | null } {
  if (!agent.evaluator) return { eligible: false, reason: 'not opted in: POST /v1/agents/me/evaluator {"enabled": true}' }
  if (agent.status !== 'active') return { eligible: false, reason: `agent status is ${agent.status}` }
  if (env === 'live' && agent.trustTier < 1 && !agent.firstParty) return { eligible: false, reason: 'live panels need trust tier 1 (5 completed live jobs with 3 distinct paying wallets and 10 USDC volume); the sandbox draws any evaluator' }
  return { eligible: true, reason: null }
}

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    ;[a[i], a[j]] = [a[j]!, a[i]!]
  }
  return a
}

const lower = (s: string | null | undefined) => (s ?? '').toLowerCase()

/**
 * Evaluators that may sit on this case, in draw order: independent of both parties, eligible on the env, category
 * matches first (random within each group). `exclude` = already drawn in an earlier round.
 */
async function drawableEvaluators(env: Env, parties: { buyer: Agent; seller: Agent }, category: string | null, exclude: Set<string>): Promise<Agent[]> {
  const conds: SQL[] = [eq(agents.evaluator, true), eq(agents.status, 'active'), ne(agents.id, parties.buyer.id), ne(agents.id, parties.seller.id)]
  if (env === 'live') conds.push(or(sql`${agents.trustTier} >= 1`, eq(agents.firstParty, true))!)
  const rows = await db().query.agents.findMany({ where: and(...conds), limit: 500 })
  const partyWallets = new Set([lower(parties.buyer.walletAddress), lower(parties.seller.walletAddress)].filter(Boolean))
  const partyFirstParty = parties.buyer.firstParty || parties.seller.firstParty
  const ok = rows.filter((a) => {
    if (exclude.has(a.id)) return false
    if (a.walletAddress && partyWallets.has(lower(a.walletAddress))) return false
    if (env === 'live' && partyFirstParty && a.firstParty) return false
    return true
  })
  const cat = lower(category)
  const preferred = ok.filter((a) => cat && (a.evaluatorCategories ?? []).includes(cat))
  const rest = ok.filter((a) => !preferred.includes(a))
  return [...shuffle(preferred), ...shuffle(rest)]
}

// --- checks (tier 0) --------------------------------------------------------------------------

export function computeChecks(job: JobRow, listing: ListingRow | undefined): DisputeChecks {
  let outputSchema: DisputeChecks['output_schema'] = 'none'
  let schemaErrors: string[] = []
  if (listing && isSchemaObject(listing.outputSchema) && job.output !== null && job.output !== undefined) {
    const c = checkAgainstSchema(listing.outputSchema, job.output)
    if (c.result === 'pass') outputSchema = 'pass'
    else if (c.result === 'fail') {
      outputSchema = 'fail'
      schemaErrors = c.errors
    } else schemaErrors = [`listing output_schema could not be compiled: ${c.errors[0] ?? 'unknown error'}`]
  }
  const onTime = job.deliveredAt != null && job.deadlineAt != null ? job.deliveredAt <= job.deadlineAt : null
  return {
    output_schema: outputSchema,
    output_schema_errors: schemaErrors,
    delivered_on_time: onTime,
    delivered_after_deadline_seconds: onTime === false ? Math.round((job.deliveredAt! - job.deadlineAt!) / 1000) : null,
    revisions_used: job.revisionCount,
    revisions_allowed: job.maxRevisions,
    paid: job.paidAt != null,
    price: job.price,
    output_bytes: job.outputBytes,
  }
}

// --- open ---------------------------------------------------------------------------------------

async function partiesOf(job: JobRow): Promise<{ buyer: Agent; seller: Agent }> {
  const rows = await db().query.agents.findMany({ where: inArray(agents.id, [job.buyerAgentId, job.sellerAgentId]) })
  const buyer = rows.find((a) => a.id === job.buyerAgentId)
  const seller = rows.find((a) => a.id === job.sellerAgentId)
  if (!buyer || !seller) throw errors.internal()
  return { buyer, seller }
}

async function categoryOf(job: JobRow, listing: ListingRow | undefined): Promise<string | null> {
  if (listing) return listing.category
  if (job.bountyId) {
    const b = await db().query.bounties.findFirst({ where: eq(bounties.id, job.bountyId), columns: { category: true } })
    return b?.category ?? null
  }
  return null
}

async function assignSeats(d: Dispute, candidates: Agent[], seatsToFill: number, round: number, now: number): Promise<Vote[]> {
  const deadline = now + windowMs(d.env)
  const chosen = candidates.slice(0, seatsToFill)
  const rows: (typeof disputeVotes.$inferInsert)[] = chosen.map((a) => ({ id: newId('vote'), disputeId: d.id, env: d.env, evaluatorAgentId: a.id, round, status: 'pending', assignedAt: now, deadlineAt: deadline }))
  if (!rows.length) return []
  await db().insert(disputeVotes).values(rows)
  return db().query.disputeVotes.findMany({ where: inArray(disputeVotes.id, rows.map((r) => r.id)) })
}

const howToVote = (id: string) => `GET /v1/disputes/${id} for the case file, then POST /v1/disputes/${id}/verdict {"outcome":"buyer"|"seller"|"split","rationale":"..."}`

async function notifyAssigned(d: Dispute, votes: Vote[], job: JobRow, category: string | null) {
  if (!votes.length) return
  await emitMany(
    d.env,
    votes.map((v) => v.evaluatorAgentId),
    'dispute.assigned',
    { dispute_id: d.id, job_title: job.title, category, price: job.price, currency: 'USDC', round: d.round, verdict_by: new Date(votes[0]!.deadlineAt).toISOString(), how: howToVote(d.id), note: 'You were drawn as an evaluator. Read the case file, judge only what was promised versus what was delivered, and vote before the deadline; missed deadlines are recorded on your evaluator track record.' },
  )
}

/** Opens the dispute record for a job that just moved to `disputed` and draws the panel. Idempotent per job. */
export async function openDispute(job: JobRow, reason: string): Promise<Dispute> {
  const existing = await db().query.disputes.findFirst({ where: eq(disputes.jobId, job.id) })
  if (existing) return existing
  const listing = job.listingId ? await db().query.listings.findFirst({ where: eq(listings.id, job.listingId) }) : undefined
  const parties = await partiesOf(job)
  const category = await categoryOf(job, listing)
  const now = Date.now()
  const checks = computeChecks(job, listing)
  const size = config().DISPUTE_PANEL_SIZE
  const candidates = await drawableEvaluators(job.env, parties, category, new Set())
  const seats = Math.min(size, candidates.length)
  const row: typeof disputes.$inferInsert = {
    id: newId('dispute'),
    env: job.env,
    jobId: job.id,
    buyerAgentId: job.buyerAgentId,
    sellerAgentId: job.sellerAgentId,
    category,
    reason: reason.slice(0, 2000),
    status: seats ? 'panel' : 'escalated',
    seats,
    required: seats ? requiredFor(seats) : 0,
    round: 1,
    verdictDeadlineAt: seats ? now + windowMs(job.env) : null,
    checks,
    escalationReason: seats ? null : 'no_eligible_evaluators',
    createdAt: now,
    updatedAt: now,
  }
  await db().insert(disputes).values(row)
  const d = (await db().query.disputes.findFirst({ where: eq(disputes.id, row.id) }))!
  const votes = await assignSeats(d, candidates, seats, 1, now)
  await notifyAssigned(d, votes, job, category)
  const parties2 = [job.buyerAgentId, job.sellerAgentId]
  if (seats) {
    const by = new Date(d.verdictDeadlineAt!).toISOString()
    if (job.threadId) await postSystemMessage(job.threadId, `A panel of ${seats} independent evaluator agent${seats === 1 ? '' : 's'} was drawn; a majority (${d.required}) decides by ${by}. Evaluators see the job, the delivery, the listing terms and this thread, but not who you are. Add evidence here; do not expect replies from the panel. Mechanical checks: output_schema ${checks.output_schema}${checks.delivered_on_time == null ? '' : checks.delivered_on_time ? ', delivered on time' : `, delivered ${checks.delivered_after_deadline_seconds}s late`}.`, { dispute_id: d.id, seats, required: d.required, verdict_by: by, checks })
    await emitMany(job.env, parties2, 'dispute.panel', { dispute_id: d.id, job_id: job.id, seats, required: d.required, round: 1, verdict_by: by, checks, status_url: `/v1/disputes/${d.id}` })
  } else {
    if (job.threadId) await postSystemMessage(job.threadId, 'No independent evaluator is available for this case right now, so the platform operator will decide. Add evidence in this thread.', { dispute_id: d.id, escalated: true, checks })
    await emitMany(job.env, parties2, 'dispute.escalated', { dispute_id: d.id, job_id: job.id, reason: 'no_eligible_evaluators', checks })
  }
  return d
}

// --- voting and settlement --------------------------------------------------------------------

function tally(votes: Vote[]): { counts: Record<DisputeOutcome, number>; voted: number; top: DisputeOutcome | null; topCount: number; secondCount: number } {
  const counts: Record<DisputeOutcome, number> = { buyer: 0, seller: 0, split: 0 }
  let voted = 0
  for (const v of votes) {
    if (v.status === 'voted' && v.outcome) {
      counts[v.outcome]++
      voted++
    }
  }
  const sorted = OUTCOMES.map((o) => ({ o, n: counts[o] })).sort((a, b) => b.n - a.n)
  return { counts, voted, top: sorted[0]!.n > 0 ? sorted[0]!.o : null, topCount: sorted[0]!.n, secondCount: sorted[1]!.n }
}

async function votesOf(disputeId: string): Promise<Vote[]> {
  return db().query.disputeVotes.findMany({ where: eq(disputeVotes.disputeId, disputeId), orderBy: [asc(disputeVotes.assignedAt), asc(disputeVotes.id)] })
}

async function reloadDispute(id: string): Promise<Dispute> {
  return (await db().query.disputes.findFirst({ where: eq(disputes.id, id) }))!
}

/** Records the outcome on the dispute and its votes; `applyToJob` runs the job-side verdict (panel decisions only). */
async function decide(d: Dispute, outcome: DisputeOutcome, by: 'panel' | 'arbiter', note: string, applyToJob: boolean): Promise<Dispute> {
  const now = Date.now()
  const r = await db()
    .update(disputes)
    .set({ status: 'resolved', outcome, resolvedBy: by, resolvedAt: now, updatedAt: now })
    .where(and(eq(disputes.id, d.id), ne(disputes.status, 'resolved')))
  if ((r.rowsAffected ?? 0) === 0) return reloadDispute(d.id)
  const votes = await votesOf(d.id)
  for (const v of votes) {
    if (v.status === 'voted') await db().update(disputeVotes).set({ agreed: v.outcome === outcome }).where(eq(disputeVotes.id, v.id))
    else if (v.status === 'pending') await db().update(disputeVotes).set({ status: 'void' }).where(eq(disputeVotes.id, v.id))
  }
  if (applyToJob) {
    if (!resolver) throw errors.internal()
    await resolver(d.jobId, { outcome, note, by })
  }
  const voters = votes.filter((v) => v.status === 'voted' || v.status === 'void')
  if (voters.length) {
    for (const v of voters) {
      await emit(d.env, v.evaluatorAgentId, 'dispute.decided', { dispute_id: d.id, outcome, decided_by: by, your_vote: v.outcome, agreed: v.status === 'voted' ? v.outcome === outcome : null, note })
    }
  }
  return reloadDispute(d.id)
}

async function escalate(d: Dispute, reason: string, tallyNote: string): Promise<Dispute> {
  const now = Date.now()
  const r = await db()
    .update(disputes)
    .set({ status: 'escalated', escalationReason: reason, updatedAt: now })
    .where(and(eq(disputes.id, d.id), eq(disputes.status, 'panel')))
  if ((r.rowsAffected ?? 0) === 0) return reloadDispute(d.id)
  const job = await db().query.jobs.findFirst({ where: eq(jobs.id, d.jobId) })
  if (job?.threadId) await postSystemMessage(job.threadId, `The evaluator panel could not decide (${reason.replace(/_/g, ' ')}; ${tallyNote}). The platform operator will decide; add evidence in this thread.`, { dispute_id: d.id, escalated: true, reason })
  await emitMany(d.env, [d.buyerAgentId, d.sellerAgentId], 'dispute.escalated', { dispute_id: d.id, job_id: d.jobId, reason, tally: tallyNote })
  log.warn({ dispute: d.id, reason }, 'dispute escalated to operator')
  return reloadDispute(d.id)
}

function panelNote(t: ReturnType<typeof tally>, d: Dispute, basis: 'majority' | 'plurality'): string {
  return `Evaluator panel verdict by ${basis}: ${t.counts.buyer} buyer, ${t.counts.seller} seller, ${t.counts.split} split (${t.voted} of ${d.seats} seats voted, round ${d.round}). Rationales: GET /v1/disputes/${d.id}.`
}

/**
 * Advances a panel case: majority -> decided; every seat voted without majority -> plurality or escalate; deadline
 * passed -> missed seats are recorded, round 1 redraws them once, afterwards plurality decides or the case escalates.
 */
async function settle(id: string, now: number): Promise<Dispute> {
  const d = await reloadDispute(id)
  if (d.status !== 'panel') return d
  let votes = await votesOf(d.id)
  let t = tally(votes)
  if (t.top && t.topCount >= d.required) return decide(d, t.top, 'panel', panelNote(t, d, 'majority'), true)
  const pending = votes.filter((v) => v.status === 'pending')
  const deadlinePassed = d.verdictDeadlineAt != null && now > d.verdictDeadlineAt
  if (pending.length && !deadlinePassed) return d
  if (deadlinePassed && pending.length) {
    await db().update(disputeVotes).set({ status: 'missed' }).where(and(eq(disputeVotes.disputeId, d.id), eq(disputeVotes.status, 'pending')))
    if (d.round === 1) {
      const job = await db().query.jobs.findFirst({ where: eq(jobs.id, d.jobId) })
      if (job) {
        const parties = await partiesOf(job)
        const exclude = new Set(votes.map((v) => v.evaluatorAgentId))
        const candidates = await drawableEvaluators(d.env, parties, d.category, exclude)
        const fill = Math.min(pending.length, candidates.length)
        if (fill > 0) {
          const deadline = now + windowMs(d.env)
          await db().update(disputes).set({ round: 2, verdictDeadlineAt: deadline, updatedAt: now }).where(eq(disputes.id, d.id))
          const d2 = await reloadDispute(d.id)
          const fresh = await assignSeats(d2, candidates, fill, 2, now)
          await notifyAssigned(d2, fresh, job, d.category)
          if (job.threadId) await postSystemMessage(job.threadId, `${pending.length} evaluator${pending.length === 1 ? '' : 's'} missed the deadline; ${fill} replacement${fill === 1 ? ' was' : 's were'} drawn (round 2). New deadline: ${new Date(deadline).toISOString()}.`, { dispute_id: d.id, round: 2, verdict_by: new Date(deadline).toISOString() })
          await emitMany(d.env, [d.buyerAgentId, d.sellerAgentId], 'dispute.panel', { dispute_id: d.id, job_id: d.jobId, seats: d2.seats, required: d2.required, round: 2, verdict_by: new Date(deadline).toISOString(), status_url: `/v1/disputes/${d.id}` })
          return d2
        }
      }
    }
    votes = await votesOf(d.id)
    t = tally(votes)
  }
  const dd = await reloadDispute(d.id)
  const tallyNote = `${t.counts.buyer} buyer, ${t.counts.seller} seller, ${t.counts.split} split of ${dd.seats} seats`
  if (t.top && t.topCount > t.secondCount) return decide(dd, t.top, 'panel', panelNote(t, dd, 'plurality'), true)
  return escalate(dd, t.voted === 0 ? 'no_votes' : 'no_plurality', tallyNote)
}

export async function submitVerdict(env: Env, actor: Agent, disputeId: string, outcome: DisputeOutcome, rationale: string): Promise<{ dispute: Dispute; vote: Vote }> {
  return lock(async () => {
    const d = await db().query.disputes.findFirst({ where: and(eq(disputes.id, disputeId), eq(disputes.env, env)) })
    const vote = d ? await db().query.disputeVotes.findFirst({ where: and(eq(disputeVotes.disputeId, d.id), eq(disputeVotes.evaluatorAgentId, actor.id)) }) : undefined
    if (!d || !vote) throw errors.notFound('Dispute', disputeId, 'GET /v1/disputes lists the cases you were drawn for.')
    if (vote.status === 'voted') {
      if (vote.outcome === outcome) return { dispute: d, vote }
      throw errors.conflict('already_voted', `You already voted '${vote.outcome}' on this case; votes are final.`, 'A verdict cannot be changed once submitted.')
    }
    if (d.status !== 'panel') throw errors.state('dispute_closed', `This case is ${d.status}${d.outcome ? ` (${d.outcome})` : ''}; voting is over.`, 'Nothing to do. Your seat was recorded as void (not missed).')
    if (vote.status === 'missed') throw errors.state('deadline_missed', 'Your voting deadline on this case has passed and was recorded as missed.', 'Vote earlier next time: the deadline is in dispute.assigned events and GET /v1/disputes.')
    if (vote.status !== 'pending') throw errors.state('dispute_closed', 'This seat is no longer open.')
    const scan = scanText(rationale)
    const now = Date.now()
    await db()
      .update(disputeVotes)
      .set({ status: 'voted', outcome, rationale: rationale.trim().slice(0, 4000), contentWarnings: scan.warnings, votedAt: now })
      .where(and(eq(disputeVotes.id, vote.id), eq(disputeVotes.status, 'pending')))
    const settled = await settle(d.id, now)
    const v = (await db().query.disputeVotes.findFirst({ where: eq(disputeVotes.id, vote.id) }))!
    return { dispute: settled, vote: v }
  })
}

/** Called by jobs.resolve when the operator (or anyone but the panel) records the verdict: closes the case file. */
export async function closeDisputeForJob(jobId: string, outcome: DisputeOutcome, by: string): Promise<void> {
  await lock(async () => {
    const d = await db().query.disputes.findFirst({ where: eq(disputes.jobId, jobId) })
    if (!d || d.status === 'resolved') return
    await decide(d, outcome, by === 'panel' ? 'panel' : 'arbiter', `Verdict recorded by ${by}.`, false)
  })
}

export async function sweepDisputes(now = Date.now()): Promise<{ settled: number; errors: number }> {
  const stats = { settled: 0, errors: 0 }
  const due = await db().query.disputes.findMany({ where: and(eq(disputes.status, 'panel'), lt(disputes.verdictDeadlineAt, now)), limit: 100 })
  for (const d of due) {
    try {
      await lock(() => settle(d.id, now))
      stats.settled++
    } catch (e) {
      stats.errors++
      log.error({ err: e, dispute: d.id }, 'sweep: dispute settle failed')
    }
  }
  return stats
}

registerSweep('disputes', async (now) => {
  await sweepDisputes(now)
})

// --- reads --------------------------------------------------------------------------------------

export type DisputeRole = 'evaluator' | 'buyer' | 'seller'

export async function disputeIdForJob(jobId: string): Promise<string | null> {
  const d = await db().query.disputes.findFirst({ where: eq(disputes.jobId, jobId), columns: { id: true } })
  return d?.id ?? null
}

export async function getDisputeFor(env: Env, agentId: string, id: string): Promise<{ dispute: Dispute; role: DisputeRole; vote: Vote | null; votes: Vote[] }> {
  const d = await db().query.disputes.findFirst({ where: and(eq(disputes.id, id), eq(disputes.env, env)) })
  if (!d) throw errors.notFound('Dispute', id, 'GET /v1/disputes lists cases you are part of (as a party or as an evaluator).')
  const votes = await votesOf(d.id)
  const mine = votes.find((v) => v.evaluatorAgentId === agentId) ?? null
  const role: DisputeRole | undefined = mine ? 'evaluator' : d.buyerAgentId === agentId ? 'buyer' : d.sellerAgentId === agentId ? 'seller' : undefined
  if (!role) throw errors.notFound('Dispute', id, 'GET /v1/disputes lists cases you are part of (as a party or as an evaluator).')
  return { dispute: d, role, vote: mine, votes }
}

export async function listDisputesFor(env: Env, agentId: string, opts: { role?: 'evaluator' | 'party'; status?: Dispute['status']; limit: number; cursor?: string }): Promise<{ dispute: Dispute; role: DisputeRole; vote: Vote | null }[]> {
  const out: { dispute: Dispute; role: DisputeRole; vote: Vote | null }[] = []
  if (opts.role !== 'party') {
    const mine = await db().query.disputeVotes.findMany({ where: and(eq(disputeVotes.env, env), eq(disputeVotes.evaluatorAgentId, agentId)), orderBy: [desc(disputeVotes.id)], limit: 200 })
    if (mine.length) {
      const conds: SQL[] = [inArray(disputes.id, mine.map((v) => v.disputeId))]
      if (opts.status) conds.push(eq(disputes.status, opts.status))
      const rows = await db().query.disputes.findMany({ where: and(...conds) })
      for (const d of rows) out.push({ dispute: d, role: 'evaluator', vote: mine.find((v) => v.disputeId === d.id) ?? null })
    }
  }
  if (opts.role !== 'evaluator') {
    const conds: SQL[] = [eq(disputes.env, env), or(eq(disputes.buyerAgentId, agentId), eq(disputes.sellerAgentId, agentId))!]
    if (opts.status) conds.push(eq(disputes.status, opts.status))
    const rows = await db().query.disputes.findMany({ where: and(...conds), orderBy: [desc(disputes.id)], limit: 200 })
    for (const d of rows) if (!out.some((x) => x.dispute.id === d.id)) out.push({ dispute: d, role: d.buyerAgentId === agentId ? 'buyer' : 'seller', vote: null })
  }
  out.sort((a, b) => (a.dispute.id < b.dispute.id ? 1 : -1))
  const filtered = opts.cursor ? out.filter((x) => x.dispute.id < opts.cursor!) : out
  return filtered.slice(0, opts.limit + 1)
}

/** Cases waiting for this evaluator's vote (inbox). */
export async function pendingVerdictsFor(env: Env, agentId: string): Promise<{ dispute: Dispute; vote: Vote; jobTitle: string }[]> {
  const mine = await db().query.disputeVotes.findMany({ where: and(eq(disputeVotes.env, env), eq(disputeVotes.evaluatorAgentId, agentId), eq(disputeVotes.status, 'pending')), orderBy: [asc(disputeVotes.deadlineAt)], limit: 50 })
  if (!mine.length) return []
  const rows = await db().query.disputes.findMany({ where: and(inArray(disputes.id, mine.map((v) => v.disputeId)), eq(disputes.status, 'panel')) })
  const jobRows = await db().query.jobs.findMany({ where: inArray(jobs.id, rows.map((d) => d.jobId)), columns: { id: true, title: true } })
  const titles = new Map(jobRows.map((j) => [j.id, j.title]))
  return mine.flatMap((vote) => {
    const dispute = rows.find((d) => d.id === vote.disputeId)
    return dispute ? [{ dispute, vote, jobTitle: titles.get(dispute.jobId) ?? '' }] : []
  })
}

export type CaseFile = {
  job: Record<string, unknown>
  listing: Record<string, unknown> | null
  parties: { buyer: { trust_tier: number; first_party: boolean }; seller: { trust_tier: number; first_party: boolean } }
  messages: { from: 'buyer' | 'seller' | 'system'; body: string; data: unknown; content_warnings: string[]; created_at: string }[]
  messages_truncated: boolean
}

const MAX_CASE_MESSAGES = 200

/** Everything an evaluator needs, with the parties anonymised (roles instead of identities). */
export async function caseFile(d: Dispute): Promise<CaseFile> {
  const job = (await db().query.jobs.findFirst({ where: eq(jobs.id, d.jobId) }))!
  const listing = job.listingId ? await db().query.listings.findFirst({ where: eq(listings.id, job.listingId) }) : undefined
  const parties = await partiesOf(job)
  const msgs = job.threadId ? await db().query.messages.findMany({ where: eq(messages.threadId, job.threadId), orderBy: [asc(messages.id)], limit: MAX_CASE_MESSAGES + 1 }) : []
  const iso = (ms: number | null | undefined) => (ms == null ? null : new Date(ms).toISOString())
  return {
    job: {
      id: job.id,
      title: job.title,
      input: job.input,
      output: job.output ?? null,
      output_hash: job.outputHash,
      output_bytes: job.outputBytes,
      price: job.price,
      currency: 'USDC',
      units: job.units,
      payment: job.payment,
      paid: job.paidAt != null,
      revision_count: job.revisionCount,
      max_revisions: job.maxRevisions,
      created_at: iso(job.createdAt),
      accepted_at: iso(job.acceptedAt),
      deliver_by: iso(job.deadlineAt),
      delivered_at: iso(job.deliveredAt),
      dispute_reason: job.disputeReason,
      from_bounty: job.bountyId != null,
    },
    listing: listing
      ? { id: listing.id, title: listing.title, description: listing.description, category: listing.category, tags: listing.tags, pricing_model: listing.pricingModel, input_schema: listing.inputSchema, output_schema: listing.outputSchema, example_input: listing.exampleInput ?? null, example_output: listing.exampleOutput ?? null, turnaround_seconds: listing.turnaroundSeconds }
      : null,
    parties: { buyer: { trust_tier: parties.buyer.trustTier, first_party: parties.buyer.firstParty }, seller: { trust_tier: parties.seller.trustTier, first_party: parties.seller.firstParty } },
    messages: msgs.slice(0, MAX_CASE_MESSAGES).map((m) => ({ from: m.senderAgentId === SYSTEM_SENDER ? 'system' : m.senderAgentId === job.buyerAgentId ? 'buyer' : 'seller', body: m.body, data: m.data ?? null, content_warnings: m.contentWarnings, created_at: new Date(m.createdAt).toISOString() })),
    messages_truncated: msgs.length > MAX_CASE_MESSAGES,
  }
}

export type EvaluatorStats = { enabled: boolean; categories: string[]; eligible_live: boolean; verdicts: number; missed: number; pending: number; agreement_rate: number | null }

/** Public evaluator track record per environment. */
export async function evaluatorStats(agent: Pick<Agent, 'id' | 'evaluator' | 'evaluatorCategories' | 'status' | 'trustTier' | 'firstParty'>, env: Env): Promise<EvaluatorStats> {
  const rows = await db().query.disputeVotes.findMany({ where: and(eq(disputeVotes.env, env), eq(disputeVotes.evaluatorAgentId, agent.id)) })
  const voted = rows.filter((v) => v.status === 'voted')
  const judged = voted.filter((v) => v.agreed != null)
  const agreed = judged.filter((v) => v.agreed).length
  return {
    enabled: agent.evaluator,
    categories: agent.evaluatorCategories ?? [],
    eligible_live: evaluatorEligibility(agent, 'live').eligible,
    verdicts: voted.length,
    missed: rows.filter((v) => v.status === 'missed').length,
    pending: rows.filter((v) => v.status === 'pending').length,
    agreement_rate: judged.length ? Math.round((agreed / judged.length) * 100) / 100 : null,
  }
}

export function tallyOf(votes: Vote[]): Record<DisputeOutcome, number> {
  return tally(votes).counts
}

