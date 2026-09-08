/**
 * First-buy programme (ADR-31, the demand side of the cold start): the desk hires every new outside listing once
 * at its advertised price (small cap), pays the sealed delivery gas-free exactly like any outside buyer would
 * (POST /pay terms -> sign the EIP-3009 typed data -> public facilitator -> submit the hash), has the judge grade
 * the revealed work against the listing's own promise, accepts or asks for one revision, and leaves an honest
 * review. A seller gets its first paid job and a real reputation entry shortly after listing; buyers get listings
 * with a track record; the platform learns whether the buyer path works for real sellers.
 *
 * Money rules, mechanical and never the model's: outside listings only (never first_party, never our own),
 * on_delivery only, price within the cap, one purchase per listing ever, at most `perSeller` listings per seller,
 * one open purchase per seller at a time plus a cooldown, a daily cap for the programme on top of the desk's own
 * caps (`canSpend`), the payment attempt persisted before anything is signed, a lost facilitator answer recovered
 * from the chain (Transfer logs) before any second signature, and a human stop after repeated failures.
 * First-buys never open a dispute (a panel for a few cents is not worth anyone's time): a bad delivery gets
 * rating 1 or 2 and the reasons in the public review, which is the signal buyers read.
 */
import type { AgentSouk, Job, Listing, TypedDataSigner } from 'agentsouk'
import type { Judge, Verdict } from './judge.js'
import type { Env, Logger } from './runtime.js'
import { formatUsdc, type UsdcWallet } from './usdc.js'

export type FirstBuyConfig = {
  enabled: boolean
  /** highest listing price the desk buys, USDC minor units */
  maxPrice: bigint
  /** USDC minor units the programme commits per UTC day (open purchases count) */
  dailyCap: bigint
  /** listings bought per seller, lifetime */
  perSeller: number
  /** purchases in flight at once */
  maxOpen: number
  /** listings older than this are not bought */
  lookbackDays: number
  /** wait this long after a purchase from a seller before the next one */
  sellerCooldownMs: number
}

export const DEFAULT_FIRSTBUY: Record<Env, FirstBuyConfig> = {
  live: { enabled: true, maxPrice: 1_000_000n, dailyCap: 5_000_000n, perSeller: 2, maxOpen: 3, lookbackDays: 30, sellerCooldownMs: 24 * 3600_000 },
  test: { enabled: true, maxPrice: 100_000n, dailyCap: 1_000_000n, perSeller: 2, maxOpen: 3, lookbackDays: 30, sellerCooldownMs: 6 * 3600_000 },
}

export type Purchase = {
  listing_id: string
  seller_id: string
  seller: string
  title: string
  price: number
  job_id: string
  created_at: string
  /** set before the desk signs anything; with no pay_hash on a later tick the chain is searched before a second signature */
  pay_attempt_at: string | null
  pay_hash: string | null
  pay_failures: number
  verdict: (Verdict & { output_hash: string | null; at: string; acted: boolean }) | null
  reviewed: boolean
  rating: number | null
  outcome: string | null
  ended_at: string | null
  needs_operator: string | null
}

export type FirstBuyState = {
  purchases: Purchase[]
  /** listings the programme will never buy, with the reason */
  skipped: Record<string, string>
  last_error: string | null
}

export type FirstBuyDeps = {
  /** the desk's own caps (lifetime budget, daily cap, in-flight transfers) */
  canSpend: (amount: bigint) => Promise<boolean>
  now?: () => number
}

const FIRSTBUY_NOTE = 'Hello from the platform desk. Agent Souk hires every new listing once at its advertised price (first-buy programme, ADR-31): this is a real job, paid gas-free on delivery, then graded against your own listing text and reviewed honestly. Deliver what the listing promises for the input above; nothing else is expected.'

const statusOf = (e: unknown): number | null => (typeof e === 'object' && e != null && typeof (e as { status?: unknown }).status === 'number' ? (e as { status: number }).status : null)
const errorCode = (e: unknown): string | null => (typeof e === 'object' && e != null && typeof (e as { code?: unknown }).code === 'string' ? (e as { code: string }).code : null)
const errorDetails = (e: unknown): Record<string, unknown> => (typeof e === 'object' && e != null && typeof (e as { details?: unknown }).details === 'object' && (e as { details?: unknown }).details != null ? ((e as { details: Record<string, unknown> }).details) : {})
const msg = (e: unknown) => String((e as Error)?.message ?? e)
const MAX_HISTORY = 200

export class FirstBuyer {
  private state: FirstBuyState | null = null
  private ticking = false

  constructor(
    readonly client: AgentSouk,
    readonly wallet: UsdcWallet,
    readonly signer: TypedDataSigner,
    readonly judge: Pick<Judge, 'evaluateListingDelivery'>,
    readonly env: Env,
    readonly log: Logger,
    readonly config: FirstBuyConfig,
    readonly me: () => { id: string } | null,
    private readonly deps: FirstBuyDeps,
  ) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }
  private iso(): string {
    return new Date(this.now()).toISOString()
  }
  private get key(): string {
    return `operator/${this.env}/firstbuy`
  }

  // --- lifecycle --------------------------------------------------------------------------------------------

  /** One pass: drive open purchases, then look for new listings. Errors are recorded, never thrown to the caller. */
  async tick(): Promise<void> {
    if (!this.config.enabled || this.ticking) return
    this.ticking = true
    try {
      const st = await this.load()
      const errorBefore = st.last_error
      let failed: string | null = null
      for (const p of st.purchases.filter((x) => !x.outcome)) {
        try {
          await this.drive(st, p)
        } catch (e) {
          failed = `${this.iso()} purchase ${p.job_id}: ${msg(e)}`.slice(0, 500)
          this.log('first-buy purchase pass failed', { env: this.env, job_id: p.job_id, error: msg(e) })
        }
      }
      try {
        await this.discover(st)
      } catch (e) {
        failed = `${this.iso()} discovery: ${msg(e)}`.slice(0, 500)
        this.log('first-buy discovery failed', { env: this.env, error: msg(e) })
      }
      if (failed) st.last_error = failed
      else if (st.last_error === errorBefore) st.last_error = null
      await this.save(st)
    } finally {
      this.ticking = false
    }
  }

  status() {
    const st = this.state ?? { purchases: [], skipped: {}, last_error: null }
    const paid = st.purchases.filter((p) => p.pay_hash)
    return {
      enabled: this.config.enabled,
      max_price: formatUsdc(this.config.maxPrice),
      daily_cap: formatUsdc(this.config.dailyCap),
      per_seller: this.config.perSeller,
      purchases: st.purchases.length,
      paid: paid.length,
      paid_total: formatUsdc(paid.reduce((s, p) => s + BigInt(p.price), 0n)),
      open: st.purchases.filter((p) => !p.outcome).map((p) => ({ listing_id: p.listing_id, seller: p.seller, job_id: p.job_id, price: p.price, pay_hash: p.pay_hash, needs_operator: p.needs_operator })),
      recent: st.purchases
        .filter((p) => p.outcome)
        .slice(-5)
        .map((p) => ({ seller: p.seller, title: p.title, price: p.price, outcome: p.outcome, rating: p.rating, job_id: p.job_id })),
      skipped: Object.keys(st.skipped).length,
      last_error: st.last_error,
    }
  }

  stateOf(): FirstBuyState | null {
    return this.state
  }

  // --- discovery --------------------------------------------------------------------------------------------

  private async discover(st: FirstBuyState): Promise<void> {
    const open = st.purchases.filter((p) => !p.outcome)
    if (open.length >= this.config.maxOpen) return
    const today = this.iso().slice(0, 10)
    let committedToday = st.purchases.filter((p) => p.created_at.slice(0, 10) === today && (!p.outcome || p.pay_hash)).reduce((s, p) => s + BigInt(p.price), 0n)
    if (committedToday >= this.config.dailyCap) return
    const res = await this.client.listings.search({ sort: 'newest', limit: 50 })
    let balance: bigint | null = null
    for (const l of res.data) {
      if (open.length >= this.config.maxOpen || committedToday >= this.config.dailyCap) break
      const reason = this.ineligible(st, l)
      if (reason) {
        if (reason.permanent && !st.skipped[l.id]) {
          st.skipped[l.id] = reason.why
          this.log('first-buy: listing skipped', { env: this.env, listing_id: l.id, seller: l.seller.handle, why: reason.why })
        }
        continue
      }
      const price = BigInt(l.pricing.price!)
      if (committedToday + price > this.config.dailyCap) continue
      balance ??= await this.wallet.usdcBalance()
      if (balance < price) {
        this.log('first-buy: wallet cannot cover the listing price', { env: this.env, listing_id: l.id, price: price.toString(), balance: balance.toString() })
        break
      }
      if (!(await this.deps.canSpend(price))) {
        this.log('first-buy: held by the desk spending caps', { env: this.env, listing_id: l.id })
        break
      }
      const p = await this.hire(st, l)
      if (!p) continue
      open.push(p)
      committedToday += price
      balance -= price
    }
  }

  /** Why a listing is not bought: permanent reasons are remembered, transient ones are re-checked next tick. */
  ineligible(st: FirstBuyState, l: Listing): { why: string; permanent: boolean } | null {
    const me = this.me()
    if (st.skipped[l.id]) return { why: st.skipped[l.id]!, permanent: false }
    if (st.purchases.some((p) => p.listing_id === l.id)) return { why: 'already bought', permanent: false }
    if (l.first_party || l.seller.first_party || (me && l.seller.id === me.id)) return { why: 'first-party listing', permanent: true }
    if (l.status !== 'active') return { why: `status ${l.status}`, permanent: false }
    if (l.payment !== 'on_delivery') return { why: 'upfront payment', permanent: true }
    if (l.pricing.model !== 'fixed' && l.pricing.model !== 'per_unit') return { why: `pricing model ${l.pricing.model}`, permanent: true }
    if (l.pricing.price == null || l.pricing.price <= 0) return { why: 'free or unpriced', permanent: true }
    if (BigInt(l.pricing.price) > this.config.maxPrice) return { why: `price above the cap (${formatUsdc(l.pricing.price)} > ${formatUsdc(this.config.maxPrice)})`, permanent: true }
    if (this.now() - Date.parse(l.created_at) > this.config.lookbackDays * 86_400_000) return { why: 'older than the lookback window', permanent: true }
    if (!this.inputFor(l)) return { why: 'no example input to order with', permanent: true }
    const bySeller = st.purchases.filter((p) => p.seller_id === l.seller.id)
    if (bySeller.length >= this.config.perSeller) return { why: `seller already bought ${bySeller.length} times`, permanent: true }
    if (bySeller.some((p) => !p.outcome)) return { why: 'a purchase from this seller is open', permanent: false }
    const last = bySeller.map((p) => Date.parse(p.ended_at ?? p.created_at)).sort((a, b) => b - a)[0]
    if (last != null && this.now() - last < this.config.sellerCooldownMs) return { why: 'seller cooldown', permanent: false }
    return null
  }

  /** The input the desk orders with: the seller's example first, else the ready-to-send body the platform derives from the schema. */
  inputFor(l: Listing): Record<string, unknown> | null {
    const ex = l.example_input
    if (ex && typeof ex === 'object' && !Array.isArray(ex) && Object.keys(ex as object).length) return ex as Record<string, unknown>
    const body = (l.how_to_order?.body_example ?? {}) as { input?: unknown }
    if (body.input && typeof body.input === 'object' && !Array.isArray(body.input) && Object.keys(body.input as object).length) return body.input as Record<string, unknown>
    return null
  }

  private async hire(st: FirstBuyState, l: Listing): Promise<Purchase | null> {
    const input = this.inputFor(l)!
    const job = await this.client.jobs.create({ listing_id: l.id, input, units: l.pricing.model === 'per_unit' ? 1 : undefined, title: `First buy by the platform desk: ${l.title.slice(0, 80)}`, max_revisions: 1 }, `firstbuy:${this.env}:${l.id}`)
    if (job.price == null || BigInt(job.price) > this.config.maxPrice) {
      // the platform priced it differently from the listing card (units, quote); never buy above the cap
      await this.client.jobs.cancel(job.id, 'buyer: the job price is above the first-buy cap').catch(() => undefined)
      st.skipped[l.id] = `job price ${job.price == null ? 'unknown' : formatUsdc(job.price)} above the cap`
      return null
    }
    const p: Purchase = { listing_id: l.id, seller_id: l.seller.id, seller: l.seller.handle, title: l.title.slice(0, 120), price: job.price, job_id: job.id, created_at: this.iso(), pay_attempt_at: null, pay_hash: null, pay_failures: 0, verdict: null, reviewed: false, rating: null, outcome: null, ended_at: null, needs_operator: null }
    st.purchases.push(p)
    await this.save(st)
    if (job.thread_id) await this.client.threads.send(job.thread_id, FIRSTBUY_NOTE).catch(() => undefined)
    this.log('first-buy: hired', { env: this.env, listing_id: l.id, seller: l.seller.handle, job_id: job.id, price: job.price })
    return p
  }

  // --- one purchase through its life ---------------------------------------------------------------------------

  private async drive(st: FirstBuyState, p: Purchase): Promise<void> {
    const job = await this.client.jobs.get(p.job_id).catch((e: unknown) => (statusOf(e) === 404 ? null : Promise.reject(e)))
    if (!job) {
      await this.end(st, p, null, 'vanished')
      return
    }
    switch (job.status) {
      case 'quoted':
        if (job.quoted_price != null && BigInt(job.quoted_price) <= this.config.maxPrice && job.available_actions.includes('accept_quote')) await this.client.jobs.acceptQuote(job.id)
        else if (job.available_actions.includes('cancel')) {
          await this.client.jobs.cancel(job.id, 'buyer: the quote is above the first-buy cap')
          await this.end(st, p, job, 'quote_above_cap')
        }
        return
      case 'awaiting_payment':
        // an upfront job: the programme never pays before delivery
        if (job.available_actions.includes('cancel')) await this.client.jobs.cancel(job.id, 'buyer: the first-buy programme pays on delivery only')
        await this.end(st, p, job, 'upfront_refused')
        return
      case 'delivered':
        if (job.output_sealed) {
          if (await this.pay(st, p, job)) {
            // paid and verified in this pass: grade right away instead of waiting a tick
            const revealed = await this.client.jobs.get(job.id).catch(() => null)
            if (revealed && revealed.status === 'delivered' && !revealed.output_sealed) await this.grade(st, p, revealed)
          }
        } else await this.grade(st, p, job)
        return
      case 'completed':
      case 'resolved':
        await this.complete(st, p, job)
        return
      case 'declined':
      case 'cancelled':
      case 'expired':
        await this.end(st, p, job, p.pay_hash ? `paid_then_${job.status}` : job.status)
        return
      case 'in_progress':
        if (p.pay_hash && job.deadlines.deliver_by && this.now() > Date.parse(job.deadlines.deliver_by) + 86_400_000) {
          // paid, revision requested, seller silent for a day past the deadline: the platform's refund rules apply; close the book
          await this.end(st, p, job, 'paid_no_redelivery')
        }
        return
      default:
        return
    }
  }

  /** Pays a sealed delivery gas-free, exactly like an outside buyer; never signs twice without looking at the chain first. Returns true once the platform verified the payment. */
  private async pay(st: FirstBuyState, p: Purchase, job: Job): Promise<boolean> {
    if (p.needs_operator) return false
    if (job.payment.status !== 'due') return false
    if (p.pay_hash) {
      // broadcast earlier, verification still pending on the platform side
      const r = await this.client.jobs.pay(job.id, p.pay_hash, { retries: 3, intervalMs: 2000 }).catch((e: unknown) => (this.log('first-buy: resubmitting the hash failed, will retry', { env: this.env, job_id: job.id, error: msg(e) }), null))
      return r?.payment.status === 'paid'
    }
    if (p.pay_attempt_at) {
      // an earlier attempt left no hash: the transfer may have happened. Look before signing anything.
      const found = (await this.wallet.findTransfers(job.payment.pay_to!)).find((t) => t.value === BigInt(job.price ?? -1))
      if (found) {
        p.pay_hash = found.hash
        await this.save(st)
        this.log('first-buy: recovered the transfer from the chain', { env: this.env, job_id: job.id, hash: found.hash })
        const r = await this.client.jobs.pay(job.id, found.hash, { retries: 3, intervalMs: 2000 }).catch((e: unknown) => (this.log('first-buy: submitting the recovered hash failed, will retry', { env: this.env, job_id: job.id, error: msg(e) }), null))
        return r?.payment.status === 'paid'
      }
      if (p.pay_failures >= 3) {
        p.needs_operator = `first-buy payment for job ${job.id} (${formatUsdc(job.price ?? 0)} to ${job.payment.pay_to}) failed ${p.pay_failures} times and no transfer is on the chain; check the wallet, then clear pay_attempt_at/pay_failures in memory ${this.key}`
        await this.save(st)
        this.log('ATTENTION: first-buy payment needs a human', { env: this.env, job_id: job.id })
        return false
      }
    }
    if (!(await this.deps.canSpend(BigInt(job.price ?? 0)))) {
      this.log('first-buy: payment held by the desk spending caps', { env: this.env, job_id: job.id })
      return false
    }
    p.pay_attempt_at = this.iso()
    await this.save(st)
    try {
      const paid = await this.client.jobs.payGasless(job.id, this.signer, { retries: 20, intervalMs: 3000 })
      p.pay_hash = paid.payment.settlement?.transaction ?? p.pay_hash
      await this.save(st)
      this.log('first-buy: paid gas-free', { env: this.env, job_id: job.id, seller: p.seller, price: job.price, hash: p.pay_hash })
      return paid.payment.status === 'paid'
    } catch (e) {
      const hash = errorDetails(e).transaction
      if (typeof hash === 'string' && /^0x[0-9a-f]{64}$/i.test(hash)) {
        // the facilitator broadcast it; the platform has not verified it yet: keep the hash, resubmit next tick
        p.pay_hash = hash.toLowerCase()
        await this.save(st)
        this.log('first-buy: transfer broadcast, verification pending', { env: this.env, job_id: job.id, hash: p.pay_hash })
        return false
      }
      p.pay_failures += 1
      await this.save(st)
      this.log('first-buy: gas-free payment failed', { env: this.env, job_id: job.id, code: errorCode(e), error: msg(e), failures: p.pay_failures })
      throw e
    }
  }

  /** The judge grades the revealed delivery against the listing's own promise; the desk accepts or asks for one revision, never disputes. */
  private async grade(st: FirstBuyState, p: Purchase, job: Job): Promise<void> {
    if (p.verdict && p.verdict.output_hash === job.output_hash) {
      if (!p.verdict.acted) await this.act(st, p, job)
      return
    }
    const l = await this.client.listings.get(p.listing_id)
    const revisionsLeft = job.available_actions.includes('request_revision') ? Math.max(0, job.max_revisions - job.revision_count) : 0
    const notes = job.thread_id ? await this.sellerNotes(job.thread_id, job.seller.id) : null
    const v = await this.judge.evaluateListingDelivery({
      listing: { title: l.title, description: l.description, category: l.category, price: l.pricing.price ?? 0, input_schema: l.input_schema, output_schema: l.output_schema, example_input: l.example_input, example_output: l.example_output },
      input: job.input,
      output: job.output,
      message: notes,
      seller_handle: job.seller.handle,
      revisions_left: revisionsLeft,
    })
    // no panels for a few cents: a delivery the judge would dispute is accepted with the lowest rating and the reasons in the review
    const verdict: Verdict = v.decision === 'dispute' ? { ...v, decision: 'accept', rating: Math.min(v.rating, 2) as Verdict['rating'] } : v
    p.verdict = { ...verdict, output_hash: job.output_hash, at: this.iso(), acted: false }
    await this.save(st)
    this.log('first-buy: delivery graded', { env: this.env, job_id: job.id, seller: p.seller, decision: verdict.decision, rating: verdict.rating })
    await this.act(st, p, job)
  }

  private async act(st: FirstBuyState, p: Purchase, job: Job): Promise<void> {
    const v = p.verdict!
    if (v.decision === 'revise' && job.available_actions.includes('request_revision')) await this.client.jobs.requestRevision(job.id, v.message || 'Please address the gaps the desk listed and deliver again.')
    else if (job.available_actions.includes('accept')) await this.client.jobs.accept(job.id)
    else {
      this.log('first-buy: verdict cannot be acted on yet, will retry', { env: this.env, job_id: job.id, status: job.status, actions: job.available_actions })
      return
    }
    p.verdict = { ...v, acted: true }
    await this.save(st)
  }

  private async complete(st: FirstBuyState, p: Purchase, job: Job): Promise<void> {
    const upheld = job.status === 'completed' || job.resolution?.outcome !== 'buyer'
    const rating = upheld ? (p.verdict?.rating ?? 3) : 1
    if (!p.reviewed) {
      const text = upheld ? `First buy by the platform desk (ADR-31): ${p.verdict?.message?.slice(0, 900) || 'delivered as the listing promised.'}` : 'First buy by the platform desk: the dispute panel found the delivery did not do what the listing promised.'
      await this.client.jobs.review(job.id, rating, text).catch((e: unknown) => this.log('first-buy: review failed', { env: this.env, job_id: job.id, error: msg(e) }))
      p.reviewed = true
      p.rating = rating
    }
    await this.end(st, p, job, p.pay_hash ? 'paid' : job.status)
    this.log('first-buy: completed', { env: this.env, job_id: job.id, seller: p.seller, rating, hash: p.pay_hash })
  }

  private async end(st: FirstBuyState, p: Purchase, job: Job | null, outcome: string): Promise<void> {
    p.outcome = outcome
    p.ended_at = this.iso()
    if (job && p.pay_hash && !['paid', 'completed', 'resolved'].includes(job.status) && !outcome.startsWith('paid')) this.log('ATTENTION: first-buy job ended after payment', { env: this.env, job_id: job.id, status: job.status, hash: p.pay_hash })
    await this.save(st)
  }

  private async sellerNotes(threadId: string, sellerId: string): Promise<string | null> {
    const res = await this.client.threads.messages(threadId, { order: 'asc', limit: 50 }).catch(() => null)
    if (!res) return null
    const texts = res.data.filter((m) => (m as { sender?: { id?: string } }).sender?.id === sellerId).map((m) => String((m as { body?: unknown }).body ?? '')).filter(Boolean)
    return texts.length ? texts.join('\n---\n').slice(0, 8000) : null
  }

  // --- persistence (platform memory, so a restart continues where it stopped) ----------------------------------

  private async load(): Promise<FirstBuyState> {
    if (this.state) return this.state
    const r = await this.client.memory.get<FirstBuyState>(this.key).catch((e: unknown) => (statusOf(e) === 404 ? null : Promise.reject(e)))
    const v = r?.value
    this.state = v && Array.isArray(v.purchases) ? { purchases: v.purchases, skipped: v.skipped ?? {}, last_error: v.last_error ?? null } : { purchases: [], skipped: {}, last_error: null }
    return this.state
  }

  private async save(st: FirstBuyState): Promise<void> {
    if (st.purchases.length > MAX_HISTORY) {
      const open = st.purchases.filter((p) => !p.outcome)
      const done = st.purchases.filter((p) => p.outcome).slice(-(MAX_HISTORY - open.length))
      st.purchases = [...done, ...open]
    }
    this.state = st
    await this.client.memory.set(this.key, st)
  }
}
