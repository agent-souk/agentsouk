/**
 * OperatorRuntime: the bounty desk (ADR-23, demand side). One first-party identity posts the catalogue as
 * bounties, awards the best proposal, pays the sealed delivery in USDC from its own wallet (proof-of-payment like
 * every other buyer), grades the revealed work, reviews the seller, and re-posts until the catalogue is used up.
 *
 * Money rules, enforced here and not by the model: pay only from the operator wallet bound to this identity,
 * only the job's own pay_to and price, never above the per-transfer cap, the daily cap or the lifetime budget
 * (in-flight transfers count), never twice for one job (state is re-read and a lease is taken right before the
 * transfer; the hash is persisted before it is submitted), never a bounty the wallet could not pay on top of every
 * open commitment, and never before the preview passed the mechanical checks (schema, receipt, repository,
 * duplicates). A transfer that provably did not leave the wallet is retried; one whose fate is unknown stops the
 * job for a human. State lives in the platform's own memory KV, so a restart continues where it stopped.
 */
import { createHash } from 'node:crypto'
import { AgentSouk, type Job } from 'agentsouk'
import { validateDocuments } from '../services/validate-json.js'
import { safeFetch } from '../ssrf.js'
import { bountyTag, pathValue, summaryOf, type BountySpec } from './catalog.js'
import type { FirstBuyer } from './firstbuy.js'
import { Judge, type CheckResult, type ProposalScore, type Triage, type Verdict } from './judge.js'
import { formatUsdc, isAddress, sameAddress, TransferError, UsdcWallet } from './usdc.js'

export type Env = 'live' | 'test'
export type Logger = (msg: string, extra?: Record<string, unknown>) => void

export type OperatorConfig = {
  /** lifetime spend of this desk, USDC minor units */
  totalBudget: bigint
  /** USDC minor units per UTC day */
  dailyCap: bigint
  /** award the best acceptable proposal once the bounty is this old ... */
  considerationHours: number
  /** ... or once this many eligible proposals from distinct sellers are in */
  minProposals: number
  /** minimum judge score to award at all */
  awardScore: number
  /** a proposal at or above this is awarded immediately (sellers with a track record, or after half the consideration window) */
  instantScore: number
  /** a proposal scoring at least this but below awardScore gets one concrete question from the desk (direct thread) and is re-scored with the answer */
  clarifyScore: number
  /** walk away from a sealed delivery this close to the payment deadline when it is still not payable */
  walkAwayBeforeDeadlineMs: number
  /** how many times the desk looks at one sealed delivery (initial triage plus re-looks after seller messages) */
  maxTriages: number
  /** a broadcast transfer not mined after this long is re-broadcast with higher fees */
  replaceAfterMs: number
}

export const DEFAULT_CONFIG: OperatorConfig = { totalBudget: 50_000_000n, dailyCap: 20_000_000n, considerationHours: 12, minProposals: 3, awardScore: 60, instantScore: 85, clarifyScore: 40, walkAwayBeforeDeadlineMs: 60 * 60_000, maxTriages: 3, replaceAfterMs: 10 * 60_000 }

/** What the desk remembers about one proposal: the judge's score plus the clarification round, keyed by the proposal id in platform memory. */
type ProposalRecord = ProposalScore & {
  /** the desk told the seller where its proposal stands (once per proposal) */
  informed_at?: string
  /** hash of price, payment and message at scoring time; a changed proposal is scored again */
  fingerprint: string
  /** when the desk asked its question in a direct thread (null thread = the question could not be delivered) */
  asked_at?: string
  thread_id?: string | null
  /** the one re-score with the seller's answer has happened */
  rescored_at?: string
}

export type BountyState = {
  bounty_id: string | null
  job_id: string | null
  awards_paid: number
  paid_distinct: string[]
  paid_summaries: string[]
  /** sellers that were paid or that failed to deliver on this bounty: not awarded again */
  awarded_to: string[]
  /** proposals the platform refused to award (e.g. seller without wallet) */
  skipped_proposals: string[]
  used_receipts: string[]
  /** set before the transfer is signed; a restart with pay_attempt but no pay_hash needs a human look, never a second transfer */
  pay_attempt: { at: string; job_id: string } | null
  pay_hash: string | null
  pay_nonce: number | null
  pay_fees: { maxFeePerGas: string; maxPriorityFeePerGas: string } | null
  pay_sent_at: string | null
  pay_replacements: number
  triage: (Triage & { output_hash: string | null; seller_messages: number; at: string; count: number }) | null
  triage_history: { decision: string; message: string; at: string }[]
  asked_at: string | null
  verdict: (Verdict & { output_hash: string | null; at: string; acted: boolean }) | null
  revealed: { distinct: string | null; summary: string; receipt_job: string | null } | null
  reviewed: boolean
  needs_operator: string | null
  last_error: string | null
  history: { job_id: string; seller: string; price: number; hash: string | null; rating: number | null; outcome: string; at: string }[]
}

/** SDK errors by shape, not by class: the runtime and its tests may load two copies of the SDK module. */
const statusOf = (e: unknown): number | null => (typeof e === 'object' && e != null && typeof (e as { status?: unknown }).status === 'number' ? (e as { status: number }).status : null)
const errorCode = (e: unknown): string | null => (typeof e === 'object' && e != null && typeof (e as { code?: unknown }).code === 'string' ? (e as { code: string }).code : null)
const msg = (e: unknown) => String((e as Error)?.message ?? e)

const freshState = (): BountyState => ({
  bounty_id: null,
  job_id: null,
  awards_paid: 0,
  paid_distinct: [],
  paid_summaries: [],
  awarded_to: [],
  skipped_proposals: [],
  used_receipts: [],
  pay_attempt: null,
  pay_hash: null,
  pay_nonce: null,
  pay_fees: null,
  pay_sent_at: null,
  pay_replacements: 0,
  triage: null,
  triage_history: [],
  asked_at: null,
  verdict: null,
  revealed: null,
  reviewed: false,
  needs_operator: null,
  last_error: null,
  history: [],
})

type Proposal = { id: string; seller: { id: string; handle: string; trust_tier: number }; price: number; payment: string; message: string | null; status: string; created_at: string }
type BountyView = { id: string; status: string; awarded_job_id: string | null; created_at: string; proposal_count: number }
type Ledger = { sent: { job_id: string; amount: string; hash: string; at: string; replaced?: boolean }[] }

export const OPERATOR_EVENTS = ['schedule.fired', 'bounty.proposal_received', 'job.delivered', 'job.completed', 'job.cancelled', 'job.expired', 'job.declined', 'job.disputed', 'job.resolved', 'job.paid']

/** Pages the desk must never accept as "the integration": our own code, packages and docs. */
const OWN_HOSTS = [/(^|\.)agentsouk\.dev$/i, /^github\.com$/i, /^(www\.)?npmjs\.com$/i, /^pypi\.org$/i]
const OWN_PATHS = [/^\/agent-souk\//i, /^\/package\/agentsouk/i, /^\/project\/agentsouk/i]

export class OperatorRuntime {
  me: { id: string; handle: string; wallet_address: string | null } | null = null
  paymentsEnabled = false
  /** the first-buy programme (ADR-31), ticked after the catalogue; shares this desk's identity, wallet and caps */
  firstBuyer: FirstBuyer | null = null
  private ready = false
  private readonly states = new Map<string, BountyState>()
  private readonly proposalScores = new Map<string, ProposalRecord>()
  private ticking = false
  private dirty = false
  private balances: { usdc: bigint; eth: bigint; at: number } | null = null
  private spend: { total: bigint; today: bigint; at: number } | null = null

  constructor(
    readonly client: AgentSouk,
    readonly wallet: UsdcWallet | null,
    readonly judge: Judge,
    readonly catalog: BountySpec[],
    readonly env: Env,
    readonly log: Logger = () => undefined,
    readonly config: OperatorConfig = DEFAULT_CONFIG,
    private readonly deps: { now?: () => number; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {},
  ) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private iso(): string {
    return new Date(this.now()).toISOString()
  }

  // --- lifecycle --------------------------------------------------------------------------------------------

  async init(): Promise<void> {
    const me = await this.client.agents.me()
    this.me = { id: me.id, handle: me.handle, wallet_address: me.wallet_address ?? null }
    if (!me.first_party) this.log('warning: the bounty desk is not flagged first_party (ADR-23)', { env: this.env, agent: me.handle })
    if (this.wallet) {
      if (me.wallet_address && sameAddress(me.wallet_address, this.wallet.address)) this.paymentsEnabled = true
      else this.log('payments disabled: the operator wallet does not match the wallet bound to this identity', { env: this.env, bound: me.wallet_address, wallet: this.wallet.address })
    } else this.log('payments disabled: no operator wallet key; bounties are not posted', { env: this.env })
    for (const spec of this.catalog) this.states.set(spec.key, await this.load(spec.key))
    this.ready = true
  }

  /** Signed webhook for the events that move a bounty, plus a recurring wake-up so a sleeping host still ticks. */
  async ensureWakeups(publicUrl: string, secret: string, intervalSeconds = 1800): Promise<void> {
    const url = `${publicUrl.replace(/\/$/, '')}/webhooks/agentsouk/${this.env}/operator`
    const hooks = await this.client.webhooks.list()
    if (!hooks.data.some((h) => (h as { url?: string; status?: string }).url === url && (h as { status?: string }).status === 'active')) {
      await this.client.webhooks.create({ url, event_types: OPERATOR_EVENTS, secret })
      this.log('operator webhook registered', { env: this.env, url })
    }
    const schedules = await this.client.schedules.list({ status: 'active', limit: 100 })
    if (!schedules.data.some((s) => (s as { name?: string }).name === 'operator-tick')) {
      await this.client.schedules.create({ name: 'operator-tick', in_seconds: intervalSeconds, interval_seconds: intervalSeconds, payload: { tick: true } })
      this.log('operator wake-up schedule created', { env: this.env, interval_seconds: intervalSeconds })
    }
  }

  /** A webhook event; returns true when it triggered a tick. Events before init() finished are ignored (the init tick covers them). */
  async handleEvent(event: { type: string; data?: Record<string, unknown> }): Promise<boolean> {
    if (!this.ready || !OPERATOR_EVENTS.includes(event.type)) return false
    if (this.me && event.data && 'buyer_id' in event.data && event.data.buyer_id !== this.me.id) return false
    await this.tick()
    return true
  }

  /** One pass over the catalogue. Re-entrant: a tick requested while one runs is folded into a second pass. */
  async tick(): Promise<void> {
    if (!this.ready) return
    if (this.ticking) {
      this.dirty = true
      return
    }
    this.ticking = true
    try {
      this.balances = null
      this.spend = null
      for (const spec of this.catalog) {
        const state = this.states.get(spec.key) ?? freshState()
        this.states.set(spec.key, state)
        const errorBefore = state.last_error
        try {
          await this.ensureBounty(spec, state)
          if (state.job_id) await this.driveJob(spec, state)
          else if (state.bounty_id) await this.considerProposals(spec, state)
          if (state.last_error && state.last_error === errorBefore) {
            // a clean pass clears an OLD failure so /health shows the current state, not history; a soft failure
            // recorded during this very pass (e.g. "transfer not sent", retried next tick) stays visible
            state.last_error = null
            await this.save(spec.key, state).catch(() => undefined)
          }
        } catch (e) {
          state.last_error = `${this.iso()} ${msg(e)}`.slice(0, 500)
          this.log('bounty pass failed', { env: this.env, key: spec.key, error: state.last_error })
          await this.save(spec.key, state).catch(() => undefined)
        }
      }
      if (this.paymentsEnabled && this.firstBuyer) await this.firstBuyer.tick().catch((e: unknown) => this.log('first-buy tick failed', { env: this.env, error: msg(e) }))
      if (this.paymentsEnabled) await Promise.all([this.refreshSpend(), this.refreshBalances()]).catch(() => undefined)
    } finally {
      this.ticking = false
      if (this.dirty) {
        this.dirty = false
        await this.tick()
      }
    }
  }

  status() {
    return {
      env: this.env,
      agent: this.me?.handle ?? null,
      payments_enabled: this.paymentsEnabled,
      wallet: this.wallet ? { address: this.wallet.address, usdc: this.balances ? formatUsdc(this.balances.usdc) : null, eth_wei: this.balances ? this.balances.eth.toString() : null } : null,
      spend: this.spend ? { total: formatUsdc(this.spend.total), today: formatUsdc(this.spend.today), total_budget: formatUsdc(this.config.totalBudget), daily_cap: formatUsdc(this.config.dailyCap) } : null,
      firstbuy: this.firstBuyer ? this.firstBuyer.status() : null,
      bounties: this.catalog.map((spec) => {
        const s = this.states.get(spec.key) ?? freshState()
        return { key: spec.key, bounty_id: s.bounty_id, job_id: s.job_id, awards_paid: s.awards_paid, max_awards: spec.max_awards, paid_distinct: s.paid_distinct, pay_hash: s.pay_hash, needs_operator: s.needs_operator, last_error: s.last_error }
      }),
    }
  }

  // --- posting ----------------------------------------------------------------------------------------------

  private async ensureBounty(spec: BountySpec, state: BountyState): Promise<void> {
    if (state.bounty_id) {
      const b = (await this.client.bounties.get(state.bounty_id).catch((e: unknown) => (statusOf(e) === 404 ? null : Promise.reject(e)))) as BountyView | null
      if (!b) state.bounty_id = null
      else if (b.status === 'awarded') {
        if (!state.job_id && b.awarded_job_id) state.job_id = b.awarded_job_id
      } else if (b.status !== 'open') {
        this.log('bounty ended without award', { env: this.env, key: spec.key, bounty_id: b.id, status: b.status })
        state.bounty_id = null
      }
      if (state.bounty_id) return
      await this.save(spec.key, state)
    }
    if (state.job_id || state.awards_paid >= spec.max_awards) return
    if (state.pay_attempt) {
      // a transfer of unknown fate on a job we no longer track: a human must look at the wallet history first
      state.needs_operator = `unresolved transfer attempt for job ${state.pay_attempt.job_id} at ${state.pay_attempt.at}; check the wallet history, then clear pay_attempt in memory ${this.memKey(spec.key)}`
      await this.save(spec.key, state)
      return
    }
    const why = await this.unpayableReason(spec)
    if (why) {
      this.log('bounty not posted', { env: this.env, key: spec.key, reason: why })
      return
    }
    const covered = state.paid_distinct.length ? `\n\nAlready covered and not paid again: ${state.paid_distinct.join(', ')}.` : ''
    const b = (await this.client.bounties.create({
      title: spec.title,
      description: (spec.description + covered).slice(0, 4000),
      budget_max: spec.budget_max,
      category: spec.category,
      tags: [...spec.tags, 'first-party', bountyTag(spec.key)],
      expires_in_seconds: spec.expires_days * 86400,
      input: {
        deliverable_schema: spec.output_schema,
        preview_schema: spec.preview_schema,
        preview_requirements: spec.preview_requirements,
        checks: spec.checks,
        distinct_by: spec.distinct_by ?? null,
        already_covered: state.paid_distinct,
        round: state.awards_paid + 1,
        operator_confirmation_before_payment: spec.needs_operator_confirmation === true,
        review_policy: this.reviewPolicy(this.now()),
      },
    })) as { id: string }
    state.bounty_id = b.id
    await this.save(spec.key, state)
    this.log('bounty posted', { env: this.env, key: spec.key, bounty_id: b.id, budget: formatUsdc(spec.budget_max), round: state.awards_paid + 1 })
  }

  /**
   * Why this bounty must not be posted or awarded right now, or null. Every other open bounty and every awarded,
   * unpaid job is a commitment that stays reserved; this bounty's own budget is added once.
   */
  private async unpayableReason(spec: BountySpec): Promise<string | null> {
    if (!this.paymentsEnabled || !this.wallet) return 'payments disabled'
    const bal = await this.refreshBalances()
    if (bal.eth === 0n) return 'no ETH for gas on the operator wallet'
    let committed = 0n
    for (const s of this.catalog) {
      if (s.key === spec.key) continue
      const st = this.states.get(s.key)
      if (st && (st.bounty_id || st.job_id) && !st.pay_hash) committed += BigInt(s.budget_max)
    }
    const need = committed + BigInt(spec.budget_max)
    if (bal.usdc < need) return `wallet holds ${formatUsdc(bal.usdc)}, ${formatUsdc(need)} needed with open commitments`
    const spend = await this.refreshSpend()
    if (spend.total + need > this.config.totalBudget) return `lifetime budget ${formatUsdc(this.config.totalBudget)} would be exceeded (${formatUsdc(spend.total)} spent, ${formatUsdc(committed)} committed elsewhere)`
    return null
  }

  /** Whether `amount` fits under the lifetime budget and the daily cap on top of everything already paid or in flight. */
  async canSpend(amount: bigint): Promise<boolean> {
    if (!this.paymentsEnabled) return false
    const spend = await this.refreshSpend()
    return spend.total + amount <= this.config.totalBudget && spend.today + amount <= this.config.dailyCap
  }

  private async refreshBalances(): Promise<{ usdc: bigint; eth: bigint }> {
    if (this.balances && this.now() - this.balances.at < 60_000) return this.balances
    if (!this.wallet) return { usdc: 0n, eth: 0n }
    const [usdc, eth] = await Promise.all([this.wallet.usdcBalance(), this.wallet.ethBalance()])
    this.balances = { usdc, eth, at: this.now() }
    return this.balances
  }

  /**
   * What this desk has paid, lifetime and today: the platform's settled payments from the operator wallet, or the
   * desk's own ledger of broadcast transfers, whichever is higher (a transfer counts the moment it is sent).
   */
  private async refreshSpend(): Promise<{ total: bigint; today: bigint }> {
    if (this.spend && this.now() - this.spend.at < 60_000) return this.spend
    const day = this.iso().slice(0, 10)
    let total = 0n
    let today = 0n
    if (this.wallet) {
      let cursor: string | undefined
      for (let page = 0; page < 20; page++) {
        const res = await this.client.payments.settlements({ limit: 100, cursor })
        for (const s of res.data) {
          if (s.kind !== 'payment' || s.status !== 'settled' || !sameAddress(s.payer_address, this.wallet.address)) continue
          total += BigInt(s.amount)
          if ((s.settled_at ?? s.created_at).slice(0, 10) === day) today += BigInt(s.amount)
        }
        cursor = (res as { next_cursor?: string | null }).next_cursor ?? undefined
        if (!cursor) break
      }
    }
    const ledger = await this.loadLedger()
    let ledgerTotal = 0n
    let ledgerToday = 0n
    for (const e of ledger.sent) {
      if (e.replaced) continue
      ledgerTotal += BigInt(e.amount)
      if (e.at.slice(0, 10) === day) ledgerToday += BigInt(e.amount)
    }
    this.spend = { total: total > ledgerTotal ? total : ledgerTotal, today: today > ledgerToday ? today : ledgerToday, at: this.now() }
    return this.spend
  }

  // --- proposals --------------------------------------------------------------------------------------------

  private async considerProposals(spec: BountySpec, state: BountyState): Promise<void> {
    if (!state.bounty_id) return
    const bounty = (await this.client.bounties.get(state.bounty_id)) as BountyView
    const all = (await this.client.bounties.proposals(state.bounty_id)).data as unknown as Proposal[]
    const candidates = all.filter((p) => p.status === 'pending' && p.price <= spec.budget_max && p.payment === 'on_delivery' && !state.awarded_to.includes(p.seller.id) && !state.skipped_proposals.includes(p.id))
    if (!candidates.length) return
    const scored: { p: Proposal; s: ProposalScore }[] = []
    // the moment the desk decides at the latest: the policy the bounty was posted with, else derived from its creation time
    const policy = (bounty as { input?: { review_policy?: { earliest_decision_at?: unknown } } }).input?.review_policy
    const earliest = typeof policy?.earliest_decision_at === 'string' ? policy.earliest_decision_at : bounty.created_at ? new Date(Date.parse(bounty.created_at) + this.config.considerationHours * 3_600_000).toISOString() : null
    for (const p of candidates) scored.push({ p, s: await this.scoreProposal(spec, p, state.bounty_id, earliest) })
    scored.sort((a, b) => b.s.score - a.s.score || a.p.price - b.p.price)
    const best = scored[0]!
    const distinctSellers = new Set(candidates.map((p) => p.seller.id)).size
    const ageHours = (this.now() - Date.parse(bounty.created_at)) / 3_600_000
    const instant = best.s.score >= this.config.instantScore && (best.p.seller.trust_tier >= 1 || ageHours >= this.config.considerationHours / 2)
    const ready = instant || (best.s.score >= this.config.awardScore && (distinctSellers >= this.config.minProposals || ageHours >= this.config.considerationHours))
    if (!ready) {
      this.log('proposals considered, waiting', { env: this.env, key: spec.key, best_score: best.s.score, sellers: distinctSellers, age_hours: Math.round(ageHours * 10) / 10 })
      return
    }
    const why = await this.unpayableReason(spec)
    if (why) {
      this.log('award postponed', { env: this.env, key: spec.key, reason: why })
      return
    }
    let job: Job
    try {
      job = (await this.client.bounties.award(state.bounty_id, best.p.id, spec.turnaround_seconds)).job
    } catch (e) {
      const status = statusOf(e)
      if (status == null || status >= 500) throw e // transient: the next tick retries the same proposal
      state.skipped_proposals.push(best.p.id) // e.g. the seller has no wallet; the runner-up gets its turn next tick
      await this.save(spec.key, state)
      this.log('award refused by the platform, proposal skipped', { env: this.env, key: spec.key, seller: best.p.seller.handle, error: msg(e) })
      return
    }
    state.job_id = job.id
    this.resetJobFields(state)
    await this.save(spec.key, state)
    this.log('bounty awarded', { env: this.env, key: spec.key, job_id: job.id, seller: best.p.seller.handle, price: formatUsdc(best.p.price), score: best.s.score })
    await this.message(job, `Awarded. Deliver the JSON described in the bounty as the job output. The delivery preview must carry: ${spec.preview_requirements}. A sealed delivery cannot be re-delivered, so get the preview right; the desk checks it mechanically, then reviews it${spec.needs_operator_confirmation ? ', then a human operator confirms' : ''}, then pays, then grades the full output against the rubric and rates you. Questions are answered in this thread.`)
  }

  /**
   * The judge's score for a proposal, remembered per proposal id. A proposal that the seller changed (price,
   * payment or message) is scored again. A middling score (clarifyScore..awardScore) earns one concrete question
   * in a direct thread; the answer (or an updated proposal) triggers exactly one re-score.
   */
  /**
   * How the desk decides, in the bounty's input (machine-readable) and in its messages: the first outside seller
   * had to read this runtime's source to learn about the 12-hour consideration window (2026-09-08).
   */
  reviewPolicy(postedAt: number) {
    const c = this.config
    return {
      consideration_hours: c.considerationHours,
      min_proposals: c.minProposals,
      award_score: c.awardScore,
      instant_score: c.instantScore,
      clarify_score: c.clarifyScore,
      earliest_decision_at: new Date(postedAt + c.considerationHours * 3_600_000).toISOString(),
      note: `Every proposal is scored 0-100 by the desk's reviewer (specificity to this task, feasibility, price, track record). The best proposal at or above ${c.awardScore} is awarded once ${c.minProposals} distinct sellers proposed or earliest_decision_at has passed; ${c.instantScore}+ from a seller with trust tier 1 (or after half the window) is awarded at once; between ${c.clarifyScore} and ${c.awardScore} the desk asks one question in a direct thread and scores again with the answer. A changed proposal is scored afresh.`,
    }
  }

  /** Where a proposal stands after its first scoring, for the seller (one message per proposal; appended to the question when one is asked). */
  private standingNote(spec: BountySpec, rec: ProposalScore, bountyId: string | null, earliest: string | null): string | null {
    const c = this.config
    const when = earliest ? `at the earliest at ${earliest} (${c.considerationHours} h after the bounty was posted), or as soon as ${c.minProposals} distinct sellers proposed` : `once ${c.minProposals} distinct sellers proposed or the ${c.considerationHours}-hour consideration window has passed`
    if (rec.score >= c.instantScore) return null
    if (rec.score >= c.awardScore) return `Your proposal on "${spec.title}" is in the running: the desk decides ${when}, awarding the best proposal that clears the bar. Nothing to do until then; a changed proposal (POST /v1/bounties/${bountyId ?? '<bounty_id>'}/proposals replaces it) is scored afresh. The rules are in the bounty's input.review_policy.`
    if (rec.score >= c.clarifyScore) return `The desk decides ${when}.`
    return `Your proposal on "${spec.title}" did not clear the desk's bar (it scores specificity to this task, feasibility, price and track record). A more concrete proposal (POST /v1/bounties/${bountyId ?? '<bounty_id>'}/proposals replaces it) is scored afresh; the desk decides ${when}. The rules are in the bounty's input.review_policy.`
  }

  private async scoreProposal(spec: BountySpec, p: Proposal, bountyId: string | null, earliestDecisionAt: string | null = null): Promise<ProposalScore> {
    const fp = createHash('sha256').update(`${p.price}|${p.payment}|${p.message ?? ''}`).digest('hex').slice(0, 32)
    const key = `operator/${this.env}/proposal/${p.id}`
    let rec: ProposalRecord | undefined = this.proposalScores.get(p.id)
    if (!rec) {
      const stored = await this.client.memory.get<ProposalRecord>(key).catch(() => null)
      if (stored?.value && typeof stored.value.score === 'number') rec = stored.value
    }
    const facts = async (clarification?: string) => ({ price: p.price, payment: p.payment, message: p.message, seller: { handle: p.seller.handle, trust_tier: p.seller.trust_tier, reputation: await this.client.agents.reputation(p.seller.handle).catch(() => undefined) }, clarification })
    const remember = async (r: ProposalRecord) => {
      this.proposalScores.set(p.id, r)
      await this.client.memory.set(key, r, 90 * 86400).catch(() => undefined)
    }
    // records from before the clarification round (no fingerprint, no question) and changed proposals are scored afresh
    if (rec && (rec.fingerprint !== fp || typeof rec.question !== 'string')) {
      if (rec.fingerprint && rec.fingerprint !== fp) this.log('proposal changed, scoring again', { env: this.env, key: spec.key, proposal_id: p.id, seller: p.seller.handle })
      rec = undefined
    }
    if (rec && rec.asked_at && rec.thread_id && !rec.rescored_at) {
      const answer = await this.sellerReplySince(rec.thread_id, p.seller.id, rec.asked_at)
      if (answer) {
        const s = await this.judge.scoreProposal(spec, await facts(answer))
        rec = { ...s, fingerprint: fp, asked_at: rec.asked_at, thread_id: rec.thread_id, rescored_at: new Date(this.now()).toISOString() }
        await remember(rec)
        this.log('proposal re-scored with the seller answer', { env: this.env, key: spec.key, proposal_id: p.id, seller: p.seller.handle, score: s.score, red_flags: s.red_flags })
      }
    }
    if (!rec) {
      const s = await this.judge.scoreProposal(spec, await facts())
      rec = { ...s, fingerprint: fp }
      await remember(rec)
      this.log('proposal scored', { env: this.env, key: spec.key, proposal_id: p.id, seller: p.seller.handle, score: s.score, red_flags: s.red_flags, question: s.question || undefined })
    }
    if (!rec.asked_at && rec.question && rec.score >= this.config.clarifyScore && rec.score < this.config.awardScore) {
      const body = `Thanks for your proposal on "${spec.title}". Before the desk awards, one question: ${rec.question} Reply in this thread, or post your proposal again with more detail (POST /v1/bounties/${bountyId ?? '<bounty_id>'}/proposals replaces it). The desk scores your proposal again after your answer; the award goes to the best proposal that clears the bar. ${this.standingNote(spec, rec, bountyId, earliestDecisionAt) ?? ''}`.trim()
      try {
        const started = await this.client.threads.start(p.seller.id, body.slice(0, 4000))
        rec = { ...rec, asked_at: new Date(this.now()).toISOString(), informed_at: new Date(this.now()).toISOString(), thread_id: (started.thread as { id?: string }).id ?? null }
        this.log('proposal clarification asked', { env: this.env, key: spec.key, proposal_id: p.id, seller: p.seller.handle, thread_id: rec.thread_id })
      } catch (e) {
        const status = statusOf(e)
        if (status == null || status >= 500) throw e
        rec = { ...rec, asked_at: new Date(this.now()).toISOString(), thread_id: null } // e.g. the seller is gone; do not retry every tick
        this.log('proposal clarification could not be sent', { env: this.env, key: spec.key, proposal_id: p.id, seller: p.seller.handle, error: msg(e) })
      }
      await remember(rec)
    } else if (!rec.informed_at && !rec.asked_at) {
      // no question to ask: still tell the seller where it stands and when the desk decides (once)
      const note = this.standingNote(spec, rec, bountyId, earliestDecisionAt)
      rec = { ...rec, informed_at: new Date(this.now()).toISOString() }
      if (note) {
        try {
          await this.client.threads.start(p.seller.id, note.slice(0, 4000))
          this.log('proposal standing sent', { env: this.env, key: spec.key, proposal_id: p.id, seller: p.seller.handle, score: rec.score })
        } catch (e) {
          const status = statusOf(e)
          if (status == null || status >= 500) throw e
          this.log('proposal standing could not be sent', { env: this.env, key: spec.key, proposal_id: p.id, seller: p.seller.handle, error: msg(e) })
        }
      }
      await remember(rec)
    }
    this.proposalScores.set(p.id, rec)
    return rec
  }

  /** What the seller wrote in the direct thread after the desk's question (bodies joined, bounded), or null. */
  private async sellerReplySince(threadId: string, sellerId: string, since: string): Promise<string | null> {
    const res = await this.client.threads.messages(threadId, { order: 'asc', limit: 100 }).catch(() => null)
    const items = ((res as { data?: { sender?: { id?: string }; body?: string; created_at?: string }[] } | null)?.data ?? []).filter((m) => m.sender?.id === sellerId && typeof m.created_at === 'string' && m.created_at > since && typeof m.body === 'string' && m.body.trim())
    if (!items.length) return null
    return items
      .map((m) => m.body!.trim())
      .join('\n\n')
      .slice(0, 4000)
  }

  // --- the awarded job ----------------------------------------------------------------------------------------

  private async driveJob(spec: BountySpec, state: BountyState): Promise<void> {
    if (!state.job_id) return
    const job = await this.client.jobs.get(state.job_id).catch((e: unknown) => (statusOf(e) === 404 ? null : Promise.reject(e)))
    if (!job) {
      await this.finishJob(spec, state, null, 'vanished')
      return
    }
    switch (job.status) {
      case 'delivered':
        if (job.output_sealed) await this.handleSealed(spec, state, job)
        else await this.handleRevealed(spec, state, job)
        return
      case 'completed':
      case 'resolved':
        await this.handleCompleted(spec, state, job)
        return
      case 'cancelled':
      case 'declined':
      case 'expired':
        await this.handleEnded(spec, state, job)
        return
      case 'in_progress':
        if (job.deadlines.deliver_by && this.now() > Date.parse(job.deadlines.deliver_by) && job.available_actions.includes('cancel')) {
          if (state.pay_hash) {
            // paid, revision requested, seller went silent: the money is gone, the platform's refund rules apply; count it, never cancel a paid job
            this.log('ATTENTION: paid job not re-delivered after a revision; counted as a paid award, job left to the platform', { env: this.env, key: spec.key, job_id: job.id, hash: state.pay_hash })
            await this.countAward(spec, state, job, state.revealed?.distinct ?? null, state.revealed?.summary ?? '')
            await this.finishJob(spec, state, job, 'paid_no_redelivery', state.verdict?.rating ?? null)
            return
          }
          await this.client.jobs.cancel(job.id, 'The delivery deadline passed without a delivery; the bounty is re-opened.')
          state.awarded_to.push(job.seller.id)
          await this.finishJob(spec, state, job, 'no_delivery')
          this.log('job cancelled: deadline passed', { env: this.env, key: spec.key, job_id: job.id })
        }
        return
      case 'disputed':
        this.log('job in dispute, waiting for the panel', { env: this.env, key: spec.key, job_id: job.id })
        return
      default:
        return
    }
  }

  private async handleSealed(spec: BountySpec, state: BountyState, job: Job): Promise<void> {
    if (state.pay_hash) {
      await this.submitPayment(spec, state, job)
      return
    }
    if (state.pay_attempt && state.pay_attempt.job_id === job.id) {
      state.needs_operator = `a transfer for job ${job.id} was attempted at ${state.pay_attempt.at} and its fate is unknown; check the wallet history (nonce, recent transfers) before paying again, then clear pay_attempt in memory ${this.memKey(spec.key)}`
      await this.save(spec.key, state)
      this.log('ATTENTION: unresolved payment attempt', { env: this.env, key: spec.key, job_id: job.id })
      return
    }
    const notes = await this.sellerNotes(job)
    const fresh = !state.triage || state.triage.output_hash !== job.output_hash
    const newMessages = !fresh && state.triage!.seller_messages < notes.count
    if (fresh || newMessages) {
      const count = fresh ? 1 : state.triage!.count + 1
      if (count > this.config.maxTriages) {
        this.log('preview looked at enough times, waiting for the deadline', { env: this.env, key: spec.key, job_id: job.id })
      } else {
        const t = await this.triage(spec, state, job, notes.text)
        const firstSeen = fresh ? this.iso() : state.triage!.at
        state.triage = { ...t, output_hash: job.output_hash, seller_messages: notes.count, at: firstSeen, count }
        state.triage_history = [...(fresh ? [] : state.triage_history), { decision: t.decision, message: t.message, at: this.iso() }].slice(-6)
        if (t.decision !== 'ask') state.asked_at = null
        else if (!fresh) state.asked_at = null // a new seller message earned a fresh answer
        await this.save(spec.key, state)
        this.log('preview triaged', { env: this.env, key: spec.key, job_id: job.id, decision: t.decision, duplicate_of: t.duplicate_of, look: count, seller_messages: notes.count })
      }
    }
    if (!state.triage) return
    const deadlineClose = this.deadlineClose(job, state)
    if (state.triage.decision === 'walk_away') {
      await this.walkAway(spec, state, job, state.triage.message || 'This delivery does not match the bounty; walking away without a mark against you.')
      return
    }
    if (state.triage.decision === 'ask') {
      if (!state.asked_at) {
        await this.message(job, `${state.triage.message} Answer in this thread (a sealed delivery cannot be re-delivered); the desk looks again before the payment deadline (${job.payment.pay_by ?? 'see the job'}).`)
        state.asked_at = this.iso()
        await this.save(spec.key, state)
      } else if (deadlineClose) await this.walkAway(spec, state, job, 'The preview still misses what the bounty asks for; walking away before the payment deadline. You may propose again on the next round.')
      return
    }
    if (spec.needs_operator_confirmation && !(await this.confirmed(job.id))) {
      if (!state.asked_at) {
        await this.message(job, 'Preview accepted by the desk; a human operator reproduces security findings before payment, usually within a day.')
        state.asked_at = this.iso()
        state.needs_operator = `confirm job ${job.id} before ${job.payment.pay_by ?? 'the payment deadline'}: PUT memory operator/confirm/${job.id} = true. Preview: ${JSON.stringify(job.output_preview).slice(0, 2500)}`
        await this.save(spec.key, state)
        this.log('ATTENTION: operator confirmation needed', { env: this.env, key: spec.key, job_id: job.id, pay_by: job.payment.pay_by })
      } else if (deadlineClose) await this.walkAway(spec, state, job, 'No operator confirmation arrived before the payment deadline; walking away without a mark against you. The desk will reach out if the finding is confirmed later.')
      return
    }
    await this.pay(spec, state, job)
  }

  /** Mechanical preview checks first (no model involved); the judge only sees previews that passed. */
  private async triage(spec: BountySpec, state: BountyState, job: Job, sellerText: string | null): Promise<Triage> {
    const preview = job.output_preview
    const mechanical = await this.previewChecks(spec, state, preview, job.seller.id)
    const dup = mechanical.find((c) => c.check === 'duplicate' && !c.ok)
    if (dup) return { decision: 'walk_away', message: `This item was already paid for (${dup.detail}); the bounty pays each one once.`, duplicate_of: dup.detail }
    const failed = mechanical.filter((c) => !c.ok)
    if (failed.length) return { decision: 'ask', message: `The preview does not pass the mechanical checks yet: ${failed.map((c) => `${c.check}: ${c.detail}`).join('; ')}.`, duplicate_of: null }
    return this.judge.triagePreview(spec, { preview, message: sellerText, seller_handle: job.seller.handle, paid_distinct: state.paid_distinct, paid_summaries: state.paid_summaries, previous: state.triage_history })
  }

  private async previewChecks(spec: BountySpec, state: BountyState, preview: unknown, sellerId: string): Promise<CheckResult[]> {
    const results: CheckResult[] = []
    if (!preview || typeof preview !== 'object' || Array.isArray(preview)) return [{ check: 'schema', ok: false, detail: 'the preview must be a JSON object with the fields listed in the bounty' }]
    const schema = validateDocuments(spec.preview_schema, [preview])
    const errs = schema.results[0]?.errors ?? []
    results.push({ check: 'schema', ok: !schema.schema_error && errs.length === 0, detail: schema.schema_error ?? (errs.length ? errs.slice(0, 8).map((e) => `${e.path} ${e.message}`).join('; ') : 'valid') })
    if (spec.preview_distinct_field) {
      const v = pathValue(preview, spec.preview_distinct_field)
      if (typeof v === 'string' && state.paid_distinct.includes(v)) results.push({ check: 'duplicate', ok: false, detail: v })
      else results.push({ check: 'duplicate', ok: true, detail: 'not paid before' })
    }
    const obj = preview as Record<string, unknown>
    for (const check of spec.checks) results.push(await this.runCheck(check, obj, spec, state, null, sellerId))
    return results
  }

  private async pay(spec: BountySpec, state: BountyState, job: Job): Promise<void> {
    if (!this.paymentsEnabled || !this.wallet) throw new Error('payments disabled')
    if (job.price == null || job.price <= 0 || job.price > spec.budget_max) throw new Error(`refusing to pay ${job.price} for ${spec.key} (budget ${spec.budget_max})`)
    if (!isAddress(job.payment.pay_to)) throw new Error('job has no pay_to address')
    if (job.payment.pay_from && !sameAddress(job.payment.pay_from, this.wallet.address)) throw new Error(`job expects payment from ${job.payment.pay_from}, wallet is ${this.wallet.address}`)
    const amount = BigInt(job.price)
    const spend = await this.refreshSpend()
    if (spend.total + amount > this.config.totalBudget || spend.today + amount > this.config.dailyCap) {
      this.log('payment held by spending cap', { env: this.env, key: spec.key, job_id: job.id, total: formatUsdc(spend.total), today: formatUsdc(spend.today) })
      if (this.deadlineClose(job, state)) await this.walkAway(spec, state, job, 'The desk hit its spending cap for today and cannot pay before the deadline; walking away without a mark against you. Please propose again.')
      return
    }
    // Another process may have got here first: re-read the persisted state and take a short lease on the job.
    const persisted = await this.load(spec.key)
    if (persisted.pay_hash || persisted.pay_attempt) {
      Object.assign(state, { pay_hash: persisted.pay_hash, pay_attempt: persisted.pay_attempt, pay_nonce: persisted.pay_nonce, pay_fees: persisted.pay_fees, pay_sent_at: persisted.pay_sent_at })
      this.log('payment already in progress elsewhere; adopted the persisted state', { env: this.env, key: spec.key, job_id: job.id, hash: state.pay_hash })
      return
    }
    const leaseKey = `operator/${this.env}/lease/${job.id}`
    const lease = await this.client.memory.get<{ at: string }>(leaseKey).catch(() => null)
    if (lease?.value) {
      this.log('payment lease held elsewhere; waiting', { env: this.env, key: spec.key, job_id: job.id })
      return
    }
    await this.client.memory.set(leaseKey, { at: this.iso() }, 600)
    state.pay_attempt = { at: this.iso(), job_id: job.id }
    await this.save(spec.key, state)
    let sent
    try {
      sent = await this.wallet.transfer(job.payment.pay_to, amount)
    } catch (e) {
      if (e instanceof TransferError && !e.broadcast) {
        // nothing left the wallet: retry on a later tick
        state.pay_attempt = null
        state.last_error = `${this.iso()} transfer not sent: ${e.message}`.slice(0, 500)
        await this.save(spec.key, state)
        await this.client.memory.delete(leaseKey).catch(() => undefined)
        this.log('transfer not sent, will retry', { env: this.env, key: spec.key, job_id: job.id, error: e.message })
        return
      }
      state.needs_operator = `transfer for job ${job.id} may have been broadcast (${msg(e)}); check the wallet history before paying again, then clear pay_attempt in memory ${this.memKey(spec.key)}`
      await this.save(spec.key, state)
      this.log('ATTENTION: transfer fate unknown', { env: this.env, key: spec.key, job_id: job.id, error: msg(e) })
      return
    }
    state.pay_hash = sent.hash
    state.pay_nonce = sent.nonce
    state.pay_fees = { maxFeePerGas: sent.maxFeePerGas.toString(), maxPriorityFeePerGas: sent.maxPriorityFeePerGas.toString() }
    state.pay_sent_at = this.iso()
    state.pay_replacements = 0
    state.needs_operator = null
    await this.save(spec.key, state)
    await this.appendLedger({ job_id: job.id, amount: amount.toString(), hash: sent.hash, at: this.iso() })
    this.log('payment sent', { env: this.env, key: spec.key, job_id: job.id, hash: sent.hash, amount: formatUsdc(amount), explorer: sent.explorer })
    this.spend = null
    this.balances = null
    const receipt = await this.wallet.waitForReceipt(sent.hash, { timeoutMs: 90_000 }).catch(() => null)
    if (receipt?.status === 'reverted') {
      await this.transferReverted(spec, state, sent.hash)
      return
    }
    await this.submitPayment(spec, state, job)
  }

  private async transferReverted(spec: BountySpec, state: BountyState, hash: string): Promise<void> {
    this.log('ATTENTION: transfer reverted', { env: this.env, key: spec.key, hash })
    await this.markLedgerReplaced(hash)
    state.pay_hash = null
    state.pay_attempt = null
    state.pay_nonce = null
    state.pay_fees = null
    state.pay_sent_at = null
    state.last_error = `transfer ${hash} reverted`
    await this.save(spec.key, state)
  }

  /** Submits the hash to the platform; a transfer that is not mined for too long is re-broadcast with higher fees. */
  private async submitPayment(spec: BountySpec, state: BountyState, job: Job): Promise<void> {
    if (!state.pay_hash) return
    try {
      const paid = await this.client.jobs.pay(job.id, state.pay_hash)
      state.pay_attempt = null
      state.needs_operator = null
      state.last_error = null
      await this.save(spec.key, state)
      await this.client.memory.delete(`operator/${this.env}/lease/${job.id}`).catch(() => undefined)
      this.log('payment verified by the platform', { env: this.env, key: spec.key, job_id: job.id, hash: state.pay_hash, status: paid.status })
      return
    } catch (e) {
      const code = errorCode(e)
      if (code === 'transaction_pending' || code === 'chain_unavailable') {
        this.log('payment submitted, platform still waiting for confirmations', { env: this.env, job_id: job.id, hash: state.pay_hash, code })
        return
      }
      if (code === 'transaction_not_found') {
        await this.maybeReplace(spec, state, job)
        return
      }
      state.needs_operator = `payment ${state.pay_hash} for job ${job.id} was rejected by the platform: ${msg(e)}`.slice(0, 500)
      await this.save(spec.key, state)
      this.log('ATTENTION: payment rejected', { env: this.env, key: spec.key, job_id: job.id, hash: state.pay_hash, error: msg(e) })
    }
  }

  private async maybeReplace(spec: BountySpec, state: BountyState, job: Job): Promise<void> {
    if (!this.wallet || !state.pay_hash || !state.pay_sent_at || state.pay_nonce == null || !state.pay_fees) return
    const receipt = await this.wallet.rpc<{ status?: string; blockNumber?: string } | null>('eth_getTransactionReceipt', [state.pay_hash]).catch(() => null)
    if (receipt?.blockNumber) {
      if (receipt.status === '0x0') await this.transferReverted(spec, state, state.pay_hash)
      else this.log('transfer mined, platform not caught up yet', { env: this.env, job_id: job.id, hash: state.pay_hash })
      return
    }
    if (this.now() - Date.parse(state.pay_sent_at) < this.config.replaceAfterMs) return
    if (state.pay_replacements >= 3) {
      state.needs_operator = `transfer ${state.pay_hash} (nonce ${state.pay_nonce}) for job ${job.id} is stuck after 3 fee bumps; check the wallet`
      await this.save(spec.key, state)
      return
    }
    const amount = BigInt(job.price ?? 0)
    const prevHash = state.pay_hash
    let sent
    try {
      sent = await this.wallet.replaceTransfer(job.payment.pay_to!, amount, { nonce: state.pay_nonce, maxFeePerGas: BigInt(state.pay_fees.maxFeePerGas), maxPriorityFeePerGas: BigInt(state.pay_fees.maxPriorityFeePerGas) })
    } catch (e) {
      this.log('replacement not sent', { env: this.env, job_id: job.id, error: msg(e) })
      return
    }
    state.pay_hash = sent.hash
    state.pay_fees = { maxFeePerGas: sent.maxFeePerGas.toString(), maxPriorityFeePerGas: sent.maxPriorityFeePerGas.toString() }
    state.pay_sent_at = this.iso()
    state.pay_replacements += 1
    await this.save(spec.key, state)
    await this.markLedgerReplaced(prevHash)
    await this.appendLedger({ job_id: job.id, amount: amount.toString(), hash: sent.hash, at: this.iso() })
    this.log('stuck transfer replaced with higher fees', { env: this.env, key: spec.key, job_id: job.id, old_hash: prevHash, hash: sent.hash, nonce: sent.nonce })
  }

  private async handleRevealed(spec: BountySpec, state: BountyState, job: Job): Promise<void> {
    if (state.verdict && state.verdict.output_hash === job.output_hash) {
      if (!state.verdict.acted) await this.act(spec, state, job)
      return
    }
    const checks = await this.runChecks(spec, state, job)
    const failed = checks.filter((c) => !c.ok)
    const revisionsLeft = job.available_actions.includes('request_revision') ? Math.max(0, job.max_revisions - job.revision_count) : 0
    let v: Verdict
    if (failed.length) {
      // mechanical failures bind the verdict; the model is not asked
      const detail = failed.map((c) => `${c.check}: ${c.detail}`).join('; ')
      v = revisionsLeft > 0 ? { decision: 'revise', rating: 2, message: `The delivery fails mechanical checks: ${detail}. Please fix exactly these and re-deliver.`, rubric_scores: [] } : { decision: 'dispute', rating: 1, message: `The delivery fails mechanical checks that the bounty requires: ${detail}.`, rubric_scores: [] }
    } else v = await this.judge.evaluateDelivery(spec, { output: job.output, message: (await this.sellerNotes(job)).text, seller_handle: job.seller.handle, checks, revisions_left: revisionsLeft })
    const distinct = spec.distinct_by ? pathValue(job.output, spec.distinct_by) : undefined
    const receiptJob = ((job.output as Record<string, unknown> | null)?.receipt as { receipt?: { job?: { id?: string } } } | undefined)?.receipt?.job?.id ?? null
    state.revealed = { distinct: typeof distinct === 'string' ? distinct : null, summary: summaryOf(spec, job.output), receipt_job: receiptJob }
    state.verdict = { ...v, output_hash: job.output_hash, at: this.iso(), acted: false }
    await this.save(spec.key, state)
    this.log('delivery graded', { env: this.env, key: spec.key, job_id: job.id, decision: v.decision, rating: v.rating, failed_checks: failed.map((c) => c.check) })
    await this.act(spec, state, job)
  }

  /** Performs the verdict's platform action; retried on later ticks until it succeeded (never re-judged). */
  private async act(spec: BountySpec, state: BountyState, job: Job): Promise<void> {
    const v = state.verdict!
    const actions = job.available_actions
    if (v.decision === 'revise' && actions.includes('request_revision')) await this.client.jobs.requestRevision(job.id, v.message || 'Please address the gaps listed by the desk.')
    else if (v.decision === 'dispute' && actions.includes('dispute')) await this.client.jobs.dispute(job.id, v.message || 'The delivery does not do what the bounty asked.')
    else if (actions.includes('accept')) await this.client.jobs.accept(job.id)
    else {
      this.log('verdict cannot be acted on in this job state, will retry', { env: this.env, key: spec.key, job_id: job.id, status: job.status, actions })
      return
    }
    state.verdict = { ...v, acted: true }
    await this.save(spec.key, state)
  }

  private async handleCompleted(spec: BountySpec, state: BountyState, job: Job): Promise<void> {
    const upheld = job.status === 'completed' || job.resolution?.outcome !== 'buyer'
    const paid = state.pay_hash != null || job.payment.status === 'paid'
    const rating = upheld ? (state.verdict?.rating ?? 4) : 1
    if (!state.reviewed) {
      await this.client.jobs.review(job.id, rating, upheld ? state.verdict?.message?.slice(0, 1000) || 'Delivered as asked.' : 'The dispute panel found the delivery did not do what the bounty asked.').catch((e: unknown) => this.log('review failed', { env: this.env, job_id: job.id, error: msg(e) }))
      state.reviewed = true
    }
    if (paid && upheld) await this.countAward(spec, state, job, state.revealed?.distinct ?? null, state.revealed?.summary ?? '')
    else if (paid) state.awarded_to.push(job.seller.id) // paid, then lost the dispute: refund_due on their side, no award
    await this.finishJob(spec, state, job, paid ? (upheld ? 'paid' : 'paid_refund_due') : job.status, rating)
    this.log('award completed', { env: this.env, key: spec.key, job_id: job.id, paid, upheld, rating, awards_paid: state.awards_paid })
  }

  private async handleEnded(spec: BountySpec, state: BountyState, job: Job): Promise<void> {
    if (state.pay_hash) {
      // the platform records our transfer as orphaned with refund_due; the money is gone, so the award counts
      this.log('ATTENTION: job ended after we paid; the transfer is orphaned with refund_due', { env: this.env, key: spec.key, job_id: job.id, hash: state.pay_hash, status: job.status })
      await this.countAward(spec, state, job, state.revealed?.distinct ?? null, state.revealed?.summary ?? '')
      await this.finishJob(spec, state, job, `paid_then_${job.status}`, state.verdict?.rating ?? null)
      return
    }
    if (job.status !== 'declined' && !job.cancel_reason?.startsWith('buyer:')) state.awarded_to.push(job.seller.id) // the seller let it expire or cancelled: no second chance on this bounty
    await this.finishJob(spec, state, job, job.status)
  }

  private async countAward(spec: BountySpec, state: BountyState, job: Job, distinct: string | null, summary: string): Promise<void> {
    state.awards_paid += 1
    if (distinct && !state.paid_distinct.includes(distinct)) state.paid_distinct.push(distinct)
    if (summary) state.paid_summaries = [...state.paid_summaries, summary].slice(-20)
    if (state.revealed?.receipt_job && !state.used_receipts.includes(state.revealed.receipt_job)) state.used_receipts.push(state.revealed.receipt_job)
    if (!state.awarded_to.includes(job.seller.id)) state.awarded_to.push(job.seller.id)
  }

  private resetJobFields(state: BountyState): void {
    state.pay_attempt = null
    state.pay_hash = null
    state.pay_nonce = null
    state.pay_fees = null
    state.pay_sent_at = null
    state.pay_replacements = 0
    state.triage = null
    state.triage_history = []
    state.asked_at = null
    state.verdict = null
    state.revealed = null
    state.reviewed = false
    state.needs_operator = null
  }

  private async finishJob(spec: BountySpec, state: BountyState, job: Job | null, outcome: string, rating: number | null = null): Promise<void> {
    if (job) state.history = [...state.history, { job_id: job.id, seller: job.seller.handle, price: job.price ?? 0, hash: state.pay_hash, rating, outcome, at: this.iso() }].slice(-20)
    if (job) await this.client.memory.delete(`operator/${this.env}/lease/${job.id}`).catch(() => undefined)
    state.job_id = null
    state.bounty_id = null
    this.resetJobFields(state)
    await this.save(spec.key, state)
  }

  private async walkAway(spec: BountySpec, state: BountyState, job: Job, message: string): Promise<void> {
    if (state.pay_hash || state.pay_attempt) throw new Error('refusing to walk away from a job with a transfer in flight')
    await this.client.jobs.cancel(job.id, message.slice(0, 500))
    this.log('walked away from a sealed delivery', { env: this.env, key: spec.key, job_id: job.id })
    await this.finishJob(spec, state, job, 'walked_away')
  }

  // --- mechanical checks --------------------------------------------------------------------------------------

  async runChecks(spec: BountySpec, state: BountyState, job: Job): Promise<CheckResult[]> {
    const out = job.output as Record<string, unknown> | null
    const results: CheckResult[] = []
    const schema = validateDocuments(spec.output_schema, [out ?? null])
    const errs = schema.results[0]?.errors ?? []
    results.push({ check: 'schema', ok: !schema.schema_error && errs.length === 0, detail: schema.schema_error ?? (errs.length ? errs.slice(0, 8).map((e) => `${e.path} ${e.message}`).join('; ') : 'valid') })
    if (spec.distinct_by) {
      const v = pathValue(out, spec.distinct_by)
      const previewV = spec.preview_distinct_field ? pathValue(job.output_preview, spec.preview_distinct_field) : undefined
      if (typeof v === 'string' && state.paid_distinct.includes(v)) results.push({ check: 'duplicate', ok: false, detail: `${v} was already paid for` })
      else if (previewV !== undefined && v !== previewV) results.push({ check: 'duplicate', ok: false, detail: `the output says ${String(v)} but the preview said ${String(previewV)}` })
      else results.push({ check: 'duplicate', ok: true, detail: 'not paid before, matches the preview' })
    }
    for (const check of spec.checks) results.push(await this.runCheck(check, out ?? {}, spec, state, job.output_preview, job.seller.id))
    return results
  }

  private async runCheck(check: 'receipt' | 'repo_url', obj: Record<string, unknown>, spec: BountySpec, state: BountyState, preview: unknown, sellerId: string): Promise<CheckResult> {
    try {
      if (check === 'receipt') return await this.checkReceipt(obj.receipt, state, preview, sellerId)
      return await this.checkRepoUrl(obj.repo_url, String(obj.framework ?? (preview as Record<string, unknown> | null)?.framework ?? ''))
    } catch (e) {
      return { check, ok: false, detail: msg(e).slice(0, 300) }
    }
  }

  private async checkReceipt(receipt: unknown, state: BountyState, preview: unknown, sellerId: string): Promise<CheckResult> {
    const r = receipt as { receipt?: Record<string, unknown>; signature?: Record<string, unknown> } | undefined
    if (!r || !r.receipt || !r.signature) return { check: 'receipt', ok: false, detail: 'no signed receipt' }
    const v = await this.client.receipts.verify({ receipt: r.receipt, signature: r.signature })
    if (!v.valid) return { check: 'receipt', ok: false, detail: `receipt signature invalid: ${v.reason ?? 'unknown'}` }
    const rj = r.receipt.job as { id?: string; env?: string; status?: string } | undefined
    const parties = [(r.receipt.buyer as { id?: string } | undefined)?.id, (r.receipt.seller as { id?: string } | undefined)?.id]
    if (!parties.includes(sellerId)) return { check: 'receipt', ok: false, detail: 'the receipt is valid but the delivering agent is not a party of that job' }
    if (rj?.env && rj.env !== 'test') return { check: 'receipt', ok: false, detail: `the receipt is for a ${rj.env} job; a sandbox (test) job is required` }
    if (rj?.status && !['completed', 'delivered', 'resolved'].includes(rj.status)) return { check: 'receipt', ok: false, detail: `the receipt's job is ${rj.status}; it must have been delivered or completed` }
    const used = new Set<string>([...state.used_receipts, ...[...this.states.values()].flatMap((s) => s.used_receipts)])
    if (rj?.id && used.has(rj.id)) return { check: 'receipt', ok: false, detail: `receipt of job ${rj.id} was already used for a paid award` }
    const previewReceiptJob = ((preview as Record<string, unknown> | null)?.receipt as { receipt?: { job?: { id?: string } } } | undefined)?.receipt?.job?.id
    if (preview && previewReceiptJob && rj?.id && previewReceiptJob !== rj.id) return { check: 'receipt', ok: false, detail: 'the output receipt is not the receipt shown in the preview' }
    return { check: 'receipt', ok: true, detail: `valid platform receipt for job ${rj?.id ?? '?'} (${rj?.env ?? 'env unknown'}, ${rj?.status ?? 'status unknown'}), agent is a party` }
  }

  private async checkRepoUrl(url: unknown, framework: string): Promise<CheckResult> {
    if (typeof url !== 'string' || !/^https:\/\//.test(url)) return { check: 'repo_url', ok: false, detail: 'repo_url is not an https URL' }
    let u: URL
    try {
      u = new URL(url)
    } catch {
      return { check: 'repo_url', ok: false, detail: 'repo_url is not a valid URL' }
    }
    if (OWN_HOSTS.some((h) => h.test(u.hostname)) && (u.hostname.endsWith('agentsouk.dev') || OWN_PATHS.some((p) => p.test(u.pathname)))) return { check: 'repo_url', ok: false, detail: "repo_url points at Agent Souk's own code or packages, not at an integration" }
    const page = await safeFetch(url, { fetchImpl: this.deps.fetchImpl, timeoutMs: 15_000 })
    if (page.status !== 200) return { check: 'repo_url', ok: false, detail: `repository page answered HTTP ${page.status}` }
    const body = page.body.toLowerCase()
    if (!/agent\s?souk/.test(body)) return { check: 'repo_url', ok: false, detail: 'the repository page does not mention Agent Souk' }
    const fw = framework.trim().toLowerCase()
    if (fw.length >= 3 && !body.includes(fw.split(/[\s/]+/)[0]!)) return { check: 'repo_url', ok: false, detail: `the repository page does not mention the framework "${framework}"` }
    return { check: 'repo_url', ok: true, detail: `public page reachable (${page.body.length} bytes), mentions Agent Souk and the framework` }
  }

  // --- plumbing -----------------------------------------------------------------------------------------------

  private memKey(key: string) {
    return `operator/${this.env}/bounty/${key}`
  }

  private async load(key: string): Promise<BountyState> {
    const r = await this.client.memory.get<Partial<BountyState>>(this.memKey(key)).catch((e: unknown) => (statusOf(e) === 404 ? null : Promise.reject(e)))
    return { ...freshState(), ...(r?.value ?? {}) }
  }

  private async save(key: string, state: BountyState): Promise<void> {
    await this.client.memory.set(this.memKey(key), state)
  }

  private ledgerKey() {
    return `operator/${this.env}/ledger`
  }

  private async loadLedger(): Promise<Ledger> {
    const r = await this.client.memory.get<Ledger>(this.ledgerKey()).catch(() => null)
    return r?.value && Array.isArray(r.value.sent) ? r.value : { sent: [] }
  }

  private async appendLedger(entry: Ledger['sent'][number]): Promise<void> {
    const l = await this.loadLedger()
    l.sent = [...l.sent, entry].slice(-200)
    await this.client.memory.set(this.ledgerKey(), l)
  }

  private async markLedgerReplaced(hash: string): Promise<void> {
    const l = await this.loadLedger()
    for (const e of l.sent) if (e.hash === hash) e.replaced = true
    await this.client.memory.set(this.ledgerKey(), l)
  }

  private async confirmed(jobId: string): Promise<boolean> {
    const r = await this.client.memory.get<unknown>(`operator/confirm/${jobId}`).catch(() => null)
    return r?.value === true
  }

  /**
   * Close to the payment deadline: within walkAwayBeforeDeadlineMs, but never more than a quarter of the window that
   * was left when the delivery was first triaged (the sandbox window is minutes, the live window days).
   */
  private deadlineClose(job: Job, state: BountyState): boolean {
    if (!job.payment.pay_by) return false
    const payBy = Date.parse(job.payment.pay_by)
    const since = state.triage ? Date.parse(state.triage.at) : this.now()
    const margin = Math.min(this.config.walkAwayBeforeDeadlineMs, Math.floor(Math.max(0, payBy - since) / 4))
    return payBy - this.now() < margin
  }

  /** What the seller wrote in the job thread (oldest first); platform notices and our own messages are skipped. */
  private async sellerNotes(job: Job): Promise<{ count: number; text: string | null }> {
    if (!job.thread_id) return { count: 0, text: null }
    const res = await this.client.threads.messages(job.thread_id, { order: 'asc', limit: 100 }).catch(() => null)
    const theirs = (res?.data ?? []).filter((m) => (m as { sender?: { id?: string } }).sender?.id === job.seller.id && typeof (m as { body?: unknown }).body === 'string') as { body: string; created_at: string }[]
    if (!theirs.length) return { count: 0, text: null }
    return { count: theirs.length, text: theirs.map((m) => `[${m.created_at}] ${m.body}`).join('\n').slice(-6000) }
  }

  private async message(job: Job, body: string): Promise<void> {
    if (!job.thread_id) return
    await this.client.threads.send(job.thread_id, body.slice(0, 4000)).catch((e: unknown) => this.log('message failed', { env: this.env, job_id: job.id, error: msg(e) }))
  }

  /** Test/ops helper: the in-memory state of one catalogue entry. */
  stateOf(key: string): BountyState | undefined {
    return this.states.get(key)
  }
}
