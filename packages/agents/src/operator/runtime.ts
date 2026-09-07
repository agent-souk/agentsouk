/**
 * OperatorRuntime: the bounty desk (ADR-23, demand side). One first-party identity posts the catalogue as
 * bounties, awards the best proposal, pays the sealed delivery in USDC from its own wallet (proof-of-payment like
 * every other buyer), grades the revealed work, reviews the seller, and re-posts until the catalogue is used up.
 *
 * Money rules, enforced here and not by the model: pay only from the operator wallet bound to this identity,
 * only the job's own pay_to and price, never above the per-transfer cap, the daily cap or the lifetime budget,
 * never twice for one job (the transaction hash is persisted before it is submitted), and never a bounty the
 * wallet could not pay. State lives in the platform's own memory KV, so a restart continues where it stopped.
 */
import { AgentSouk, type Job } from 'agentsouk'
import { validateDocuments } from '../services/validate-json.js'
import { safeFetch } from '../ssrf.js'
import { bountyTag, pathValue, type BountySpec } from './catalog.js'
import { Judge, type CheckResult, type ProposalScore, type Triage, type Verdict } from './judge.js'
import { formatUsdc, isAddress, sameAddress, UsdcWallet } from './usdc.js'

export type Env = 'live' | 'test'
export type Logger = (msg: string, extra?: Record<string, unknown>) => void

export type OperatorConfig = {
  /** lifetime spend of this desk, USDC minor units */
  totalBudget: bigint
  /** USDC minor units per UTC day */
  dailyCap: bigint
  /** award the best acceptable proposal once the bounty is this old ... */
  considerationHours: number
  /** ... or once this many proposals are in */
  minProposals: number
  /** minimum judge score to award at all */
  awardScore: number
  /** a proposal at or above this is awarded immediately */
  instantScore: number
  /** walk away from a sealed delivery this close to the payment deadline when it is still not payable */
  walkAwayBeforeDeadlineMs: number
}

export const DEFAULT_CONFIG: OperatorConfig = { totalBudget: 50_000_000n, dailyCap: 20_000_000n, considerationHours: 12, minProposals: 3, awardScore: 60, instantScore: 85, walkAwayBeforeDeadlineMs: 60 * 60_000 }

export type BountyState = {
  bounty_id: string | null
  job_id: string | null
  awards_paid: number
  paid_distinct: string[]
  awarded_to: string[]
  /** set before the transfer is signed; a restart with pay_attempt but no pay_hash needs a human look, never a second transfer */
  pay_attempt: { at: string; job_id: string } | null
  pay_hash: string | null
  triage: (Triage & { output_hash: string | null; seller_messages?: number; at: string }) | null
  asked_at: string | null
  verdict: (Verdict & { output_hash: string | null; at: string }) | null
  reviewed: boolean
  needs_operator: string | null
  last_error: string | null
  history: { job_id: string; seller: string; price: number; hash: string | null; rating: number | null; outcome: string; at: string }[]
}

/** SDK errors by shape, not by class: the runtime and its tests may load two copies of the SDK module. */
const isStatus = (e: unknown, status: number) => typeof e === 'object' && e != null && (e as { status?: unknown }).status === status
const errorCode = (e: unknown): string | null => (typeof e === 'object' && e != null && typeof (e as { code?: unknown }).code === 'string' ? (e as { code: string }).code : null)

const freshState = (): BountyState => ({ bounty_id: null, job_id: null, awards_paid: 0, paid_distinct: [], awarded_to: [], pay_attempt: null, pay_hash: null, triage: null, asked_at: null, verdict: null, reviewed: false, needs_operator: null, last_error: null, history: [] })

type Proposal = { id: string; seller: { id: string; handle: string; trust_tier: number }; price: number; payment: string; message: string | null; status: string; created_at: string }
type BountyView = { id: string; status: string; awarded_job_id: string | null; created_at: string; proposal_count: number }

export const OPERATOR_EVENTS = ['schedule.fired', 'bounty.proposal_received', 'job.delivered', 'job.completed', 'job.cancelled', 'job.expired', 'job.declined', 'job.disputed', 'job.resolved', 'job.paid']

export class OperatorRuntime {
  me: { id: string; handle: string; wallet_address: string | null } | null = null
  paymentsEnabled = false
  private readonly states = new Map<string, BountyState>()
  private readonly proposalScores = new Map<string, ProposalScore>()
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

  /** A webhook event; returns true when it triggered a tick. */
  async handleEvent(event: { type: string; data?: Record<string, unknown> }): Promise<boolean> {
    if (!OPERATOR_EVENTS.includes(event.type)) return false
    if (this.me && event.data && 'buyer_id' in event.data && event.data.buyer_id !== this.me.id) return false
    await this.tick()
    return true
  }

  /** One pass over the catalogue. Re-entrant: a tick requested while one runs is folded into a second pass. */
  async tick(): Promise<void> {
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
        try {
          await this.ensureBounty(spec, state)
          if (state.job_id) await this.driveJob(spec, state)
          else if (state.bounty_id) await this.considerProposals(spec, state)
        } catch (e) {
          state.last_error = `${new Date(this.now()).toISOString()} ${String((e as Error).message ?? e)}`.slice(0, 500)
          this.log('bounty pass failed', { env: this.env, key: spec.key, error: state.last_error })
          await this.save(spec.key, state).catch(() => undefined)
        }
      }
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
      bounties: this.catalog.map((spec) => {
        const s = this.states.get(spec.key) ?? freshState()
        return { key: spec.key, bounty_id: s.bounty_id, job_id: s.job_id, awards_paid: s.awards_paid, max_awards: spec.max_awards, needs_operator: s.needs_operator, last_error: s.last_error }
      }),
    }
  }

  // --- posting ----------------------------------------------------------------------------------------------

  private async ensureBounty(spec: BountySpec, state: BountyState): Promise<void> {
    if (state.bounty_id) {
      const b = (await this.client.bounties.get(state.bounty_id).catch(() => null)) as BountyView | null
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
    if (state.job_id || state.awards_paid >= spec.max_awards || state.needs_operator) return
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
      input: { deliverable_schema: spec.output_schema, preview_requirements: spec.preview_requirements, checks: spec.checks, distinct_by: spec.distinct_by ?? null, already_covered: state.paid_distinct, round: state.awards_paid + 1, operator_confirmation_before_payment: spec.needs_operator_confirmation === true },
    })) as { id: string }
    state.bounty_id = b.id
    await this.save(spec.key, state)
    this.log('bounty posted', { env: this.env, key: spec.key, bounty_id: b.id, budget: formatUsdc(spec.budget_max), round: state.awards_paid + 1 })
  }

  /** Why this bounty must not be posted right now, or null. Commitments of open bounties and awarded jobs are reserved. */
  private async unpayableReason(spec: BountySpec): Promise<string | null> {
    if (!this.paymentsEnabled || !this.wallet) return 'payments disabled'
    const bal = await this.refreshBalances()
    if (bal.eth === 0n) return 'no ETH for gas on the operator wallet'
    let committed = 0n
    for (const s of this.catalog) {
      const st = this.states.get(s.key)
      if (st && (st.bounty_id || st.job_id) && !st.pay_hash) committed += BigInt(s.budget_max)
    }
    const need = committed + BigInt(spec.budget_max)
    if (bal.usdc < need) return `wallet holds ${formatUsdc(bal.usdc)}, ${formatUsdc(need)} needed with open commitments`
    const spend = await this.refreshSpend()
    if (spend.total + need > this.config.totalBudget) return `lifetime budget ${formatUsdc(this.config.totalBudget)} would be exceeded (${formatUsdc(spend.total)} spent, ${formatUsdc(committed)} committed)`
    return null
  }

  private async refreshBalances(): Promise<{ usdc: bigint; eth: bigint }> {
    if (this.balances && this.now() - this.balances.at < 60_000) return this.balances
    if (!this.wallet) return { usdc: 0n, eth: 0n }
    const [usdc, eth] = await Promise.all([this.wallet.usdcBalance(), this.wallet.ethBalance()])
    this.balances = { usdc, eth, at: this.now() }
    return this.balances
  }

  /** What this desk has verifiably paid (settled payments from the operator wallet), lifetime and today. */
  private async refreshSpend(): Promise<{ total: bigint; today: bigint }> {
    if (this.spend && this.now() - this.spend.at < 60_000) return this.spend
    let total = 0n
    let today = 0n
    const day = new Date(this.now()).toISOString().slice(0, 10)
    let cursor: string | undefined
    for (let page = 0; page < 20; page++) {
      const res = await this.client.payments.settlements({ limit: 100, cursor })
      for (const s of res.data) {
        if (s.kind !== 'payment' || s.status !== 'settled' || !this.wallet || !sameAddress(s.payer_address, this.wallet.address)) continue
        total += BigInt(s.amount)
        if ((s.settled_at ?? s.created_at).slice(0, 10) === day) today += BigInt(s.amount)
      }
      cursor = (res as { next_cursor?: string | null }).next_cursor ?? undefined
      if (!cursor) break
    }
    this.spend = { total, today, at: this.now() }
    return this.spend
  }

  // --- proposals --------------------------------------------------------------------------------------------

  private async considerProposals(spec: BountySpec, state: BountyState): Promise<void> {
    if (!state.bounty_id) return
    const bounty = (await this.client.bounties.get(state.bounty_id)) as BountyView
    const all = (await this.client.bounties.proposals(state.bounty_id)).data as unknown as Proposal[]
    const pending = all.filter((p) => p.status === 'pending')
    const candidates = pending.filter((p) => p.price <= spec.budget_max && p.payment === 'on_delivery' && !state.awarded_to.includes(p.seller.id))
    if (!candidates.length) return
    const scored: { p: Proposal; s: ProposalScore }[] = []
    for (const p of candidates) scored.push({ p, s: await this.scoreProposal(spec, p) })
    scored.sort((a, b) => b.s.score - a.s.score || a.p.price - b.p.price)
    const best = scored[0]!
    const ageHours = (this.now() - Date.parse(bounty.created_at)) / 3_600_000
    const ready = best.s.score >= this.config.instantScore || (best.s.score >= this.config.awardScore && (pending.length >= this.config.minProposals || ageHours >= this.config.considerationHours))
    if (!ready) {
      this.log('proposals considered, waiting', { env: this.env, key: spec.key, best_score: best.s.score, pending: pending.length, age_hours: Math.round(ageHours * 10) / 10 })
      return
    }
    const why = await this.unpayableReason(spec)
    if (why && !why.includes('committed')) {
      // The bounty itself is already committed; only a wallet that lost its funds or gas blocks the award.
      this.log('award postponed', { env: this.env, key: spec.key, reason: why })
      return
    }
    let job: Job
    try {
      job = (await this.client.bounties.award(state.bounty_id, best.p.id, spec.turnaround_seconds)).job
    } catch (e) {
      // e.g. the seller has no wallet: remember it and let the next tick pick the runner-up
      state.awarded_to.push(best.p.seller.id)
      await this.save(spec.key, state)
      this.log('award failed, seller skipped', { env: this.env, key: spec.key, seller: best.p.seller.handle, error: String((e as Error).message ?? e) })
      return
    }
    state.job_id = job.id
    state.awarded_to.push(best.p.seller.id)
    state.triage = null
    state.asked_at = null
    state.verdict = null
    state.reviewed = false
    state.pay_hash = null
    state.pay_attempt = null
    await this.save(spec.key, state)
    this.log('bounty awarded', { env: this.env, key: spec.key, job_id: job.id, seller: best.p.seller.handle, price: formatUsdc(best.p.price), score: best.s.score })
    await this.message(job, `Awarded. Deliver the JSON described in the bounty as the job output. The delivery preview must state: ${spec.preview_requirements}. We pay the sealed delivery from the preview${spec.needs_operator_confirmation ? ' after a human operator confirmed it' : ''}, then review the full output against the rubric and rate you.`)
  }

  private async scoreProposal(spec: BountySpec, p: Proposal): Promise<ProposalScore> {
    const cached = this.proposalScores.get(p.id)
    if (cached) return cached
    const key = `operator/${this.env}/proposal/${p.id}`
    const stored = await this.client.memory.get<ProposalScore>(key).catch(() => null)
    if (stored?.value && typeof stored.value.score === 'number') {
      this.proposalScores.set(p.id, stored.value)
      return stored.value
    }
    const reputation = await this.client.agents.reputation(p.seller.handle).catch(() => undefined)
    const s = await this.judge.scoreProposal(spec, { price: p.price, payment: p.payment, message: p.message, seller: { handle: p.seller.handle, trust_tier: p.seller.trust_tier, reputation } })
    this.proposalScores.set(p.id, s)
    await this.client.memory.set(key, s, 90 * 86400).catch(() => undefined)
    this.log('proposal scored', { env: this.env, key: spec.key, proposal_id: p.id, seller: p.seller.handle, score: s.score, red_flags: s.red_flags })
    return s
  }

  // --- the awarded job ----------------------------------------------------------------------------------------

  private async driveJob(spec: BountySpec, state: BountyState): Promise<void> {
    if (!state.job_id) return
    const job = await this.client.jobs.get(state.job_id).catch((e: unknown) => (isStatus(e, 404) ? null : Promise.reject(e)))
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
        if (state.pay_hash) this.log('ATTENTION: job ended after we paid; the platform records the transfer as orphaned with refund_due', { env: this.env, key: spec.key, job_id: job.id, hash: state.pay_hash, status: job.status })
        await this.finishJob(spec, state, job, job.status)
        return
      case 'in_progress':
        if (job.available_actions.includes('cancel') && job.deadlines.deliver_by && this.now() > Date.parse(job.deadlines.deliver_by)) {
          await this.client.jobs.cancel(job.id, 'The delivery deadline passed without a delivery; the bounty is re-opened.')
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
      state.needs_operator = `a transfer for job ${job.id} was attempted at ${state.pay_attempt.at} but its hash was not recorded; check the wallet history before paying again`
      await this.save(spec.key, state)
      this.log('ATTENTION: unresolved payment attempt', { env: this.env, key: spec.key, job_id: job.id })
      return
    }
    // A sealed delivery cannot be re-delivered; what the seller can still add are thread messages, so they are
    // part of the triage and a new seller message triggers a fresh look.
    const notes = await this.sellerNotes(job)
    if (!state.triage || state.triage.output_hash !== job.output_hash || (state.triage.seller_messages ?? 0) < notes.count) {
      const t = await this.judge.triagePreview(spec, { preview: job.output_preview, message: notes.text, seller_handle: job.seller.handle, paid_distinct: state.paid_distinct })
      const firstSeen = state.triage && state.triage.output_hash === job.output_hash ? state.triage.at : new Date(this.now()).toISOString()
      state.triage = { ...t, output_hash: job.output_hash, seller_messages: notes.count, at: firstSeen }
      if (t.decision !== 'ask') state.asked_at = null
      await this.save(spec.key, state)
      this.log('preview triaged', { env: this.env, key: spec.key, job_id: job.id, decision: t.decision, duplicate_of: t.duplicate_of, seller_messages: notes.count })
    }
    const deadlineClose = this.deadlineClose(job, state)
    if (state.triage.decision === 'walk_away') {
      await this.walkAway(spec, state, job, state.triage.message || 'This delivery does not match the bounty; walking away without a mark against you.')
      return
    }
    if (state.triage.decision === 'ask') {
      if (!state.asked_at) {
        await this.message(job, `${state.triage.message} Reply in this thread with the missing facts and the desk will look again before the payment deadline (${job.payment.pay_by ?? 'see the job'}).`)
        state.asked_at = new Date(this.now()).toISOString()
        await this.save(spec.key, state)
      } else if (deadlineClose) await this.walkAway(spec, state, job, 'The preview still misses what the bounty asks for; walking away before the payment deadline. Feel free to propose again.')
      return
    }
    if (spec.needs_operator_confirmation && !(await this.confirmed(job.id))) {
      if (!state.asked_at) {
        await this.message(job, 'Preview accepted by the desk; a human operator confirms security findings before payment, usually within a day.')
        state.asked_at = new Date(this.now()).toISOString()
        state.needs_operator = `confirm job ${job.id} before ${job.payment.pay_by ?? 'the payment deadline'}: PUT memory operator/confirm/${job.id} = true`
        await this.save(spec.key, state)
        this.log('ATTENTION: operator confirmation needed', { env: this.env, key: spec.key, job_id: job.id, pay_by: job.payment.pay_by })
      } else if (deadlineClose) await this.walkAway(spec, state, job, 'No operator confirmation arrived before the payment deadline; walking away without a mark against you. The desk will reach out if the finding is confirmed later.')
      return
    }
    await this.pay(spec, state, job)
  }

  private async pay(spec: BountySpec, state: BountyState, job: Job): Promise<void> {
    if (!this.paymentsEnabled || !this.wallet) throw new Error('payments disabled')
    if (job.price == null || job.price <= 0 || job.price > spec.budget_max) throw new Error(`refusing to pay ${job.price} for ${spec.key} (budget ${spec.budget_max})`)
    if (!isAddress(job.payment.pay_to)) throw new Error('job has no pay_to address')
    if (job.payment.pay_from && !sameAddress(job.payment.pay_from, this.wallet.address)) throw new Error(`job expects payment from ${job.payment.pay_from}, wallet is ${this.wallet.address}`)
    const amount = BigInt(job.price)
    const spend = await this.refreshSpend()
    if (spend.total + amount > this.config.totalBudget || spend.today + amount > this.config.dailyCap) {
      const deadlineClose = this.deadlineClose(job, state)
      this.log('payment held by spending cap', { env: this.env, key: spec.key, job_id: job.id, total: formatUsdc(spend.total), today: formatUsdc(spend.today) })
      if (deadlineClose) await this.walkAway(spec, state, job, 'The desk hit its spending cap for today and cannot pay before the deadline; walking away without a mark against you. Please propose again.')
      return
    }
    state.pay_attempt = { at: new Date(this.now()).toISOString(), job_id: job.id }
    await this.save(spec.key, state)
    const sent = await this.wallet.transfer(job.payment.pay_to, amount)
    state.pay_hash = sent.hash
    await this.save(spec.key, state)
    this.log('payment sent', { env: this.env, key: spec.key, job_id: job.id, hash: sent.hash, amount: formatUsdc(amount), explorer: sent.explorer })
    const receipt = await this.wallet.waitForReceipt(sent.hash).catch((e: unknown) => {
      this.log('receipt not seen yet, will retry submission', { env: this.env, job_id: job.id, hash: sent.hash, error: String((e as Error).message ?? e) })
      return null
    })
    if (receipt?.status === 'reverted') {
      this.log('ATTENTION: transfer reverted', { env: this.env, key: spec.key, job_id: job.id, hash: sent.hash })
      state.pay_hash = null
      state.pay_attempt = null
      state.last_error = `transfer ${sent.hash} reverted`
      await this.save(spec.key, state)
      return
    }
    this.spend = null
    this.balances = null
    await this.submitPayment(spec, state, job)
  }

  private async submitPayment(spec: BountySpec, state: BountyState, job: Job): Promise<void> {
    if (!state.pay_hash) return
    try {
      const paid = await this.client.jobs.pay(job.id, state.pay_hash)
      state.pay_attempt = null
      state.last_error = null
      await this.save(spec.key, state)
      this.log('payment verified by the platform', { env: this.env, key: spec.key, job_id: job.id, hash: state.pay_hash, status: paid.status })
    } catch (e) {
      const code = errorCode(e)
      if (code === 'transaction_pending' || code === 'transaction_not_found' || code === 'chain_unavailable') {
        this.log('payment submitted, platform still waiting for confirmations', { env: this.env, job_id: job.id, hash: state.pay_hash, code })
        return
      }
      state.needs_operator = `payment ${state.pay_hash} for job ${job.id} was rejected by the platform: ${String((e as Error).message ?? e)}`.slice(0, 500)
      await this.save(spec.key, state)
      this.log('ATTENTION: payment rejected', { env: this.env, key: spec.key, job_id: job.id, hash: state.pay_hash, error: String((e as Error).message ?? e) })
    }
  }

  private async handleRevealed(spec: BountySpec, state: BountyState, job: Job): Promise<void> {
    if (state.verdict && state.verdict.output_hash === job.output_hash) return
    const checks = await this.runChecks(spec, job)
    const revisionsLeft = job.available_actions.includes('request_revision') ? Math.max(0, job.max_revisions - job.revision_count) : 0
    const v = await this.judge.evaluateDelivery(spec, { output: job.output, message: null, seller_handle: job.seller.handle, checks, revisions_left: revisionsLeft })
    state.verdict = { ...v, output_hash: job.output_hash, at: new Date(this.now()).toISOString() }
    await this.save(spec.key, state)
    this.log('delivery graded', { env: this.env, key: spec.key, job_id: job.id, decision: v.decision, rating: v.rating, failed_checks: checks.filter((c) => !c.ok).map((c) => c.check) })
    if (v.decision === 'revise' && revisionsLeft > 0) await this.client.jobs.requestRevision(job.id, v.message || 'Please address the gaps listed by the desk.')
    else if (v.decision === 'dispute') await this.client.jobs.dispute(job.id, v.message || 'The delivery does not do what the bounty asked.')
    else await this.client.jobs.accept(job.id)
  }

  private async handleCompleted(spec: BountySpec, state: BountyState, job: Job): Promise<void> {
    const rating = state.verdict?.rating ?? 4
    if (!state.reviewed) {
      await this.client.jobs.review(job.id, rating, state.verdict?.message?.slice(0, 1000) || 'Delivered as asked.').catch((e: unknown) => this.log('review failed', { env: this.env, job_id: job.id, error: String((e as Error).message ?? e) }))
      state.reviewed = true
    }
    const paid = state.pay_hash != null || job.payment.status === 'paid'
    if (paid) {
      state.awards_paid += 1
      const distinct = spec.distinct_by ? pathValue(job.output, spec.distinct_by) : undefined
      if (typeof distinct === 'string' && distinct && !state.paid_distinct.includes(distinct)) state.paid_distinct.push(distinct)
    }
    await this.finishJob(spec, state, job, paid ? 'paid' : job.status, rating)
    this.log('award completed', { env: this.env, key: spec.key, job_id: job.id, paid, rating, awards_paid: state.awards_paid })
  }

  private async finishJob(spec: BountySpec, state: BountyState, job: Job | null, outcome: string, rating: number | null = null): Promise<void> {
    if (job) state.history = [...state.history, { job_id: job.id, seller: job.seller.handle, price: job.price ?? 0, hash: state.pay_hash, rating, outcome, at: new Date(this.now()).toISOString() }].slice(-20)
    state.job_id = null
    state.bounty_id = null
    state.pay_hash = null
    state.pay_attempt = null
    state.triage = null
    state.asked_at = null
    state.verdict = null
    state.reviewed = false
    await this.save(spec.key, state)
  }

  private async walkAway(spec: BountySpec, state: BountyState, job: Job, message: string): Promise<void> {
    await this.client.jobs.cancel(job.id, message.slice(0, 500))
    this.log('walked away from a sealed delivery', { env: this.env, key: spec.key, job_id: job.id })
    await this.finishJob(spec, state, job, 'walked_away')
  }

  // --- mechanical checks --------------------------------------------------------------------------------------

  async runChecks(spec: BountySpec, job: Job): Promise<CheckResult[]> {
    const out = job.output as Record<string, unknown> | null
    const results: CheckResult[] = []
    const schema = validateDocuments(spec.output_schema, [out ?? null])
    const errs = schema.results[0]?.errors ?? []
    results.push({ check: 'schema', ok: !schema.schema_error && errs.length === 0, detail: schema.schema_error ?? (errs.length ? errs.slice(0, 8).map((e) => `${e.path} ${e.message}`).join('; ') : 'valid') })
    for (const check of spec.checks) {
      try {
        if (check === 'receipt') results.push(await this.checkReceipt(out?.receipt, job.seller.id))
        else if (check === 'repo_url') results.push(await this.checkRepoUrl(out?.repo_url))
      } catch (e) {
        results.push({ check, ok: false, detail: String((e as Error).message ?? e).slice(0, 300) })
      }
    }
    return results
  }

  private async checkReceipt(receipt: unknown, sellerId: string): Promise<CheckResult> {
    const r = receipt as { receipt?: Record<string, unknown>; signature?: Record<string, unknown> } | undefined
    if (!r || !r.receipt || !r.signature) return { check: 'receipt', ok: false, detail: 'no signed receipt in the delivery' }
    const v = await this.client.receipts.verify({ receipt: r.receipt, signature: r.signature })
    if (!v.valid) return { check: 'receipt', ok: false, detail: `receipt signature invalid: ${v.reason ?? 'unknown'}` }
    const parties = [(r.receipt.buyer as { id?: string } | undefined)?.id, (r.receipt.seller as { id?: string } | undefined)?.id]
    if (!parties.includes(sellerId)) return { check: 'receipt', ok: false, detail: 'the receipt is valid but the delivering agent is not a party of that job' }
    const jobEnv = (r.receipt.job as { env?: string } | undefined)?.env
    return { check: 'receipt', ok: true, detail: `valid platform receipt for job ${(r.receipt.job as { id?: string } | undefined)?.id ?? '?'}${jobEnv ? ` (${jobEnv})` : ''}, agent is a party` }
  }

  private async checkRepoUrl(url: unknown): Promise<CheckResult> {
    if (typeof url !== 'string' || !/^https:\/\//.test(url)) return { check: 'repo_url', ok: false, detail: 'repo_url is not an https URL' }
    const page = await safeFetch(url, { fetchImpl: this.deps.fetchImpl, timeoutMs: 15_000 })
    if (page.status !== 200) return { check: 'repo_url', ok: false, detail: `repository page answered HTTP ${page.status}` }
    if (!/agent\s?souk/i.test(page.body)) return { check: 'repo_url', ok: false, detail: 'the repository page does not mention Agent Souk' }
    return { check: 'repo_url', ok: true, detail: `public page reachable (${page.body.length} bytes), mentions Agent Souk` }
  }

  // --- plumbing -----------------------------------------------------------------------------------------------

  private memKey(key: string) {
    return `operator/${this.env}/bounty/${key}`
  }

  private async load(key: string): Promise<BountyState> {
    const r = await this.client.memory.get<Partial<BountyState>>(this.memKey(key)).catch((e: unknown) => (isStatus(e, 404) ? null : Promise.reject(e)))
    return { ...freshState(), ...(r?.value ?? {}) }
  }

  private async save(key: string, state: BountyState): Promise<void> {
    await this.client.memory.set(this.memKey(key), state)
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

  /** What the seller wrote in the job thread (oldest first), for triage; platform notices and our own messages are skipped. */
  private async sellerNotes(job: Job): Promise<{ count: number; text: string | null }> {
    if (!job.thread_id) return { count: 0, text: null }
    const res = await this.client.threads.messages(job.thread_id, { order: 'asc', limit: 100 }).catch(() => null)
    const theirs = (res?.data ?? []).filter((m) => (m as { sender?: { id?: string } }).sender?.id === job.seller.id && typeof (m as { body?: unknown }).body === 'string') as { body: string; created_at: string }[]
    if (!theirs.length) return { count: 0, text: null }
    return { count: theirs.length, text: theirs.map((m) => `[${m.created_at}] ${m.body}`).join('\n').slice(-6000) }
  }

  private async message(job: Job, body: string): Promise<void> {
    if (!job.thread_id) return
    await this.client.threads.send(job.thread_id, body.slice(0, 4000)).catch((e: unknown) => this.log('message failed', { env: this.env, job_id: job.id, error: String((e as Error).message ?? e) }))
  }

  /** Test/ops helper: the in-memory state of one catalogue entry. */
  stateOf(key: string): BountyState | undefined {
    return this.states.get(key)
  }
}
