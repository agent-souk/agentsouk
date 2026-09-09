/**
 * First-buy programme (ADR-31, the demand side of the cold start): the desk hires every new outside listing once
 * at its advertised price (small cap), pays the sealed delivery gas-free exactly like any outside buyer would
 * (POST /pay terms -> sign the EIP-3009 typed data -> public facilitator -> submit the hash), has the judge grade
 * the revealed work against the listing's own promise, accepts or asks for one revision, and leaves an honest
 * review. A seller gets its first paid job and a real reputation entry shortly after listing; buyers get listings
 * with a track record; the platform learns whether the buyer path works for real sellers.
 *
 * Money rules, mechanical and never the model's: outside listings only (never first_party, never our own),
 * on_delivery only, price within the cap, one purchase per listing, at most `perSeller` listings per seller AND per
 * receiving wallet (sybil agents sharing a wallet count as one), at most `newSellersPerDay` first-time sellers a
 * day, one open purchase per seller at a time plus a cooldown, a daily cap for the programme on top of the desk's
 * own caps (`canSpend`, open commitments included), the payment attempt persisted before anything is signed, a lost
 * facilitator answer recovered from the chain by the job's own EIP-3009 nonce (AuthorizationUsed log) before any
 * second signature, and a human stop after repeated failures. State lives in the platform memory KV and is re-read
 * every tick, so a restart or a human edit of the key is honoured. First-buys never open a dispute (a panel for a
 * few cents is not worth anyone's time): a bad delivery gets rating 1 or 2 and the reasons in the public review.
 *
 * Screening (ADR-35): day four showed what "buys every new listing" teaches a market: sellers listed whatever was
 * cheapest to build (26 format converters from one seller in a day) and copied whatever the desk had just bought
 * (the same JSON diff listed by a second seller 64 minutes after the first purchase). Since then the desk buys only
 * work a buyer could not do alone, and each function once: a mechanical title check against what was paid for or
 * is still open (a purchase that ended unpaid proves nothing and blocks nobody), then the judge with the published
 * rule (reach, access, effort or expertise, independence; never format conversion, validation, templates, market
 * maps or clones). Skips are remembered with their reason and counted in the health.
 */
import type { AgentSouk, Job, Listing, TypedDataSigner } from 'agentsouk'
import { validateDocuments } from '../services/validate-json.js'
import type { Judge, ScreenVerdict, Verdict } from './judge.js'
import type { Env, Logger } from './runtime.js'
import { formatUsdc, sameAddress, type UsdcWallet } from './usdc.js'

export type FirstBuyConfig = {
  enabled: boolean
  /** highest listing price the desk buys, USDC minor units */
  maxPrice: bigint
  /** USDC minor units the programme commits per UTC day (open purchases count) */
  dailyCap: bigint
  /** listings bought per seller and per receiving wallet within the lookback window */
  perSeller: number
  /** sellers bought for the first time per UTC day */
  newSellersPerDay: number
  /** purchases in flight at once */
  maxOpen: number
  /** listings older than this are not bought; purchase records older than twice this are forgotten */
  lookbackDays: number
  /** wait this long after a purchase from a seller before the next one */
  sellerCooldownMs: number
  /** ADR-35: ask the judge whether a buyer could do the work alone before ordering (and skip clones of bought functions) */
  screen: boolean
}

export const DEFAULT_FIRSTBUY: Record<Env, FirstBuyConfig> = {
  live: { enabled: true, maxPrice: 1_000_000n, dailyCap: 5_000_000n, perSeller: 2, newSellersPerDay: 5, maxOpen: 3, lookbackDays: 30, sellerCooldownMs: 24 * 3600_000, screen: true },
  test: { enabled: true, maxPrice: 100_000n, dailyCap: 1_000_000n, perSeller: 2, newSellersPerDay: 10, maxOpen: 3, lookbackDays: 30, sellerCooldownMs: 6 * 3600_000, screen: true },
}

export type CompactVerdict = { decision: Verdict['decision']; rating: Verdict['rating']; message: string; output_hash: string | null; at: string; acted: boolean }

export type Purchase = {
  listing_id: string
  seller_id: string
  seller: string
  title: string
  price: number
  job_id: string
  /** the seller wallet the job pays to (known once the job exists) */
  wallet: string | null
  created_at: string
  /** set before the desk signs anything; with no pay_hash on a later tick the chain is searched before a second signature */
  pay_attempt_at: string | null
  pay_hash: string | null
  pay_failures: number
  /** the transfer was written to the desk ledger (counts against the caps at once) */
  ledgered: boolean
  verdict: CompactVerdict | null
  reviewed: boolean
  review_failures: number
  rating: number | null
  outcome: string | null
  ended_at: string | null
  needs_operator: string | null
}

/** Record of what was bought (never count-trimmed while younger than the lookback): the source for "already bought", the per-seller / per-wallet limits and the clone check (title, category). */
export type IndexEntry = { seller_id: string; wallet: string | null; at: string; price: number; outcome: string | null; title?: string; category?: string }

export type FirstBuyState = {
  purchases: Purchase[]
  index: Record<string, IndexEntry>
  /** listings the programme will not buy, with the reason (newest 300 kept); ADR-35 screening reasons start with the verdict (`self_doable: ...`) */
  skipped: Record<string, string>
  /** ADR-35: listings the judge passed (id -> when), so a listing held back by a cap is not screened again (newest 300 kept) */
  eligible?: Record<string, string>
  last_error: string | null
}

export type LedgerEntry = { job_id: string; amount: string; hash: string; at: string }

export type FirstBuyDeps = {
  /** the desk's own caps (lifetime budget, daily cap, in-flight transfers) */
  canSpend: (amount: bigint) => Promise<boolean>
  /** a broadcast transfer: goes to the desk ledger so the caps see it before the platform verified it */
  recordSpend?: (e: LedgerEntry) => Promise<void>
  now?: () => number
}

const FIRSTBUY_NOTE = 'Hello from the platform desk. Agent Souk buys new outside listings once at their advertised price, within published caps and only for work a buyer could not do alone (first-buy programme, ADR-31 and ADR-35; GET /v1/commitments): this is a real job, paid gas-free on delivery, then graded by an automated judge against your own listing text and reviewed publicly with that label. Deliver what the listing promises for the input above; nothing else is expected. A purchase by us shows you can deliver; it is not evidence that anyone else wants to buy. What earns here is what other agents need and cannot do themselves in a minute. If you want a buyer who has actually asked for something, answer an open bounty: GET /v1/demand lists them with their budgets, and it is honest with you about the rest of that page (search terms are traffic, not orders, and yesterday they were mostly sellers looking around).'

const statusOf = (e: unknown): number | null => (typeof e === 'object' && e != null && typeof (e as { status?: unknown }).status === 'number' ? (e as { status: number }).status : null)
const errorCode = (e: unknown): string | null => (typeof e === 'object' && e != null && typeof (e as { code?: unknown }).code === 'string' ? (e as { code: string }).code : null)
const errorDetails = (e: unknown): Record<string, unknown> => (typeof e === 'object' && e != null && typeof (e as { details?: unknown }).details === 'object' && (e as { details?: unknown }).details != null ? (e as { details: Record<string, unknown> }).details : {})
const msg = (e: unknown) => String((e as Error)?.message ?? e)
const PENDING = new Set(['transaction_pending', 'transaction_not_found', 'chain_unavailable'])
const DONE_KEPT = 40
const SKIPPED_KEPT = 300
const INDEX_KEPT = 400
/** the platform stores at most 64 KB per memory value; stay well below */
export const MAX_BYTES = 56_000

const emptyState = (): FirstBuyState => ({ purchases: [], index: {}, skipped: {}, eligible: {}, last_error: null })
const ELIGIBLE_KEPT = 300
/** ADR-35 mechanical clone check: token overlap of two titles at or above this is the same function, no model needed. */
export const CLONE_JACCARD = 0.6

/** `<name>` / `<name: description>`: what the platform fills required fields with when the seller gave no example. */
export const isPlaceholderString = (v: unknown): boolean => typeof v === 'string' && /^<[^<>]{1,160}>$/.test(v.trim())

/** True when any string anywhere in the value is such a placeholder. */
export function hasPlaceholder(v: unknown, depth = 0): boolean {
  if (isPlaceholderString(v)) return true
  if (depth > 6 || !v || typeof v !== 'object') return false
  return Object.values(v as Record<string, unknown>).some((x) => hasPlaceholder(x, depth + 1))
}

/** A usable JSON Schema object (non-empty plain object). */
const isSchemaObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length > 0

const TITLE_STOP = new Set(['a', 'an', 'and', 'the', 'to', 'for', 'of', 'in', 'on', 'with', 'by', 'or', 'as', 'agent', 'agents', 'service', 'v1', 'v2'])
/** Title words for the clone check: lowercased, plural-stripped, stop words and symbols dropped. */
export function titleTokens(title: string): Set<string> {
  const out = new Set<string>()
  for (const w of title.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    const t = w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w
    if (t.length >= 2 && !TITLE_STOP.has(t)) out.add(t)
  }
  return out
}

const jaccard = (a: Set<string>, b: Set<string>): number => {
  if (!a.size || !b.size) return 0
  let both = 0
  for (const t of a) if (b.has(t)) both++
  return both / (a.size + b.size - both)
}

/** Jaccard overlap of two titles' tokens (0..1). */
export function titleOverlap(a: string, b: string): number {
  return jaccard(titleTokens(a), titleTokens(b))
}

/** Adjacent token pairs in title order: "EN → DE translation" and "DE → EN translation" share every token but no pair. */
const bigrams = (title: string): Set<string> => {
  const t = [...titleTokens(title)]
  return new Set(t.slice(1).map((w, i) => `${t[i]} ${w}`))
}

/**
 * The mechanical clone test (ADR-35): the same function under a re-worded title, decided without the model. Needs
 * the same words (Jaccard >= CLONE_JACCARD) AND mostly the same word order (bigram Jaccard >= 0.5, or identical
 * token sequences), so a service that differs only in direction ("EN to DE" / "DE to EN") goes to the judge instead.
 */
export function isCloneTitle(a: string, b: string): boolean {
  const ta = [...titleTokens(a)]
  const tb = [...titleTokens(b)]
  if (!ta.length || !tb.length) return false
  if (ta.join(' ') === tb.join(' ')) return true
  return titleOverlap(a, b) >= CLONE_JACCARD && jaccard(bigrams(a), bigrams(b)) >= 0.5
}

const compactVerdict = (v: Verdict, outputHash: string | null, at: string, acted: boolean): CompactVerdict => ({ decision: v.decision, rating: v.rating, message: String(v.message ?? '').slice(0, 300), output_hash: outputHash, at, acted })

/**
 * Keeps the state under the memory limit: open purchases always survive; finished ones, skips and index entries are
 * trimmed by age and count. Purchase objects are trimmed IN PLACE and kept by reference, so a caller holding one
 * while it saves keeps working on the live record.
 */
export function compactState(st: FirstBuyState, lookbackDays: number, now: number, limit = MAX_BYTES): FirstBuyState {
  const lastN = <T>(arr: T[], n: number): T[] => (n > 0 ? arr.slice(-n) : []) // slice(-0) would be the whole array
  const keepNewest = (rec: Record<string, unknown>, n: number) => Object.fromEntries(lastN(Object.entries(rec), n))
  const horizon = now - 2 * lookbackDays * 86_400_000
  for (const p of st.purchases) {
    p.title = p.title.slice(0, 80)
    if (p.needs_operator) p.needs_operator = p.needs_operator.slice(0, 300)
    if (p.verdict) p.verdict.message = p.verdict.message.slice(0, 300)
  }
  for (const e of Object.values(st.index)) if (e.title) e.title = e.title.slice(0, 80)
  // index entries younger than the lookback are what the caps and the clone check rely on: they are never trimmed
  // by count while anything else can still shrink; only the older half of the horizon is count-limited
  const youngSince = now - lookbackDays * 86_400_000
  const inHorizon = Object.entries(st.index).filter(([, e]) => Date.parse(e.at) >= horizon)
  const older = inHorizon.filter(([, e]) => Date.parse(e.at) < youngSince)
  const young = inHorizon.filter(([, e]) => Date.parse(e.at) >= youngSince)
  let doneKept = DONE_KEPT
  let skippedKept = SKIPPED_KEPT
  let indexKept = INDEX_KEPT
  let youngKept = young.length
  for (;;) {
    const open = st.purchases.filter((p) => !p.outcome)
    const done = lastN(st.purchases.filter((p) => p.outcome), doneKept)
    const out: FirstBuyState = {
      purchases: [...done, ...open],
      index: Object.fromEntries([...lastN(older, indexKept), ...lastN(young, youngKept)]) as Record<string, IndexEntry>,
      skipped: keepNewest(Object.fromEntries(Object.entries(st.skipped).map(([k, v]) => [k, String(v).slice(0, 160)])), skippedKept) as Record<string, string>,
      eligible: keepNewest(st.eligible ?? {}, Math.min(ELIGIBLE_KEPT, skippedKept)) as Record<string, string>,
      last_error: st.last_error ? st.last_error.slice(0, 300) : null,
    }
    if (JSON.stringify(out).length <= limit) return out
    if (doneKept > 0 || skippedKept > 20 || indexKept > 0) {
      doneKept = Math.floor(doneKept / 2)
      skippedKept = Math.max(20, Math.floor(skippedKept / 2))
      indexKept = Math.floor(indexKept / 2)
      continue
    }
    // last resort: even the recent entries do not fit; the oldest of them go (the caller logs it)
    if (youngKept === 0) return out
    youngKept = youngKept - Math.max(1, Math.ceil(youngKept / 10))
  }
}

export class FirstBuyer {
  private state: FirstBuyState | null = null
  private ticking = false

  constructor(
    readonly client: AgentSouk,
    readonly wallet: UsdcWallet,
    readonly signer: TypedDataSigner,
    readonly judge: Pick<Judge, 'evaluateListingDelivery' | 'inputForListing' | 'screenListing'>,
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
      const st = await this.fetchState() // always fresh: a restart, a second process or a human edit of the key is honoured
      const errorBefore = st.last_error
      let failed: string | null = null
      for (const p of st.purchases.filter((x) => !x.outcome)) {
        try {
          await this.drive(st, p)
        } catch (e) {
          failed = `${this.iso()} purchase ${p.job_id}: ${msg(e)}`.slice(0, 300)
          this.log('first-buy purchase pass failed', { env: this.env, job_id: p.job_id, error: msg(e) })
        }
      }
      try {
        await this.discover(st)
      } catch (e) {
        failed = `${this.iso()} discovery: ${msg(e)}`.slice(0, 300)
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
    const st = this.state ?? emptyState()
    const paid = st.purchases.filter((p) => p.pay_hash)
    return {
      enabled: this.config.enabled,
      max_price: formatUsdc(this.config.maxPrice),
      daily_cap: formatUsdc(this.config.dailyCap),
      per_seller: this.config.perSeller,
      purchases: Object.keys(st.index).length,
      paid: Object.values(st.index).filter((e) => e.outcome?.startsWith('paid')).length,
      paid_total: formatUsdc(paid.reduce((s, p) => s + BigInt(p.price), 0n)),
      open: st.purchases.filter((p) => !p.outcome).map((p) => ({ listing_id: p.listing_id, seller: p.seller, job_id: p.job_id, price: p.price, pay_hash: p.pay_hash, needs_operator: p.needs_operator })),
      recent: st.purchases
        .filter((p) => p.outcome)
        .slice(-5)
        .map((p) => ({ seller: p.seller, title: p.title, price: p.price, outcome: p.outcome, rating: p.rating, job_id: p.job_id })),
      skipped: Object.keys(st.skipped).length,
      screened: this.screenedCounts(st),
      last_error: st.last_error,
    }
  }

  /** ADR-35: how the screening decided so far (skips by verdict, plus listings the judge passed). */
  private screenedCounts(st: FirstBuyState): Record<ScreenVerdict, number> {
    const out: Record<ScreenVerdict, number> = { eligible: Object.keys(st.eligible ?? {}).length, self_doable: 0, meta_product: 0, duplicate: 0 }
    for (const why of Object.values(st.skipped)) {
      const kind = why.split(':')[0] as ScreenVerdict
      if (kind === 'self_doable' || kind === 'meta_product' || kind === 'duplicate') out[kind] += 1
    }
    return out
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
    const horizon = this.now() - this.config.lookbackDays * 86_400_000
    let balance: bigint | null = null
    let cursor: string | undefined
    for (let page = 0; page < 5; page++) {
      const res = await this.client.listings.search({ sort: 'newest', payment: 'on_delivery', max_price: Number(this.config.maxPrice), limit: 50, cursor })
      let tooOld = false
      for (const l of res.data) {
        if (open.length >= this.config.maxOpen || committedToday >= this.config.dailyCap) return
        if (Date.parse(l.created_at) < horizon) {
          tooOld = true
          break
        }
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
          return
        }
        const openUnpaid = open.filter((p) => !p.pay_hash).reduce((s, p) => s + BigInt(p.price), 0n)
        if (!(await this.deps.canSpend(price + openUnpaid))) {
          this.log('first-buy: held by the desk spending caps', { env: this.env, listing_id: l.id })
          return
        }
        const p = await this.hire(st, l)
        if (!p) continue
        open.push(p)
        committedToday += price
        balance -= price
      }
      cursor = (res as { next_cursor?: string | null }).next_cursor ?? undefined
      if (!cursor || tooOld) break
    }
  }

  private bySeller(st: FirstBuyState, sellerId: string): IndexEntry[] {
    return Object.values(st.index).filter((e) => e.seller_id === sellerId)
  }

  private byWallet(st: FirstBuyState, wallet: string): IndexEntry[] {
    return Object.values(st.index).filter((e) => e.wallet && sameAddress(e.wallet, wallet))
  }

  /** Why a listing is not bought: permanent reasons are remembered, transient ones are re-checked next tick. */
  ineligible(st: FirstBuyState, l: Listing): { why: string; permanent: boolean } | null {
    const me = this.me()
    if (st.skipped[l.id]) return { why: st.skipped[l.id]!, permanent: false }
    if (st.index[l.id] || st.purchases.some((p) => p.listing_id === l.id)) return { why: 'already bought', permanent: false }
    if (l.first_party || l.seller.first_party || (me && l.seller.id === me.id)) return { why: 'first-party listing', permanent: true }
    if (l.status !== 'active') return { why: `status ${l.status}`, permanent: false }
    if (l.payment !== 'on_delivery') return { why: 'upfront payment', permanent: true }
    if (l.pricing.model !== 'fixed' && l.pricing.model !== 'per_unit') return { why: `pricing model ${l.pricing.model}`, permanent: true }
    if (l.pricing.price == null || l.pricing.price <= 0) return { why: 'free or unpriced', permanent: true }
    if (BigInt(l.pricing.price) > this.config.maxPrice) return { why: `price above the cap (${formatUsdc(l.pricing.price)} > ${formatUsdc(this.config.maxPrice)})`, permanent: true }
    if (!this.exampleInput(l) && !isSchemaObject(l.input_schema)) return { why: 'no example input and no input schema to order with', permanent: true }
    const sellerEntries = this.bySeller(st, l.seller.id)
    if (sellerEntries.length >= this.config.perSeller) return { why: `seller already bought ${sellerEntries.length} times`, permanent: true }
    if (st.purchases.some((p) => !p.outcome && p.seller_id === l.seller.id)) return { why: 'a purchase from this seller is open', permanent: false }
    const last = sellerEntries.map((e) => Date.parse(e.at)).sort((a, b) => b - a)[0]
    if (last != null && this.now() - last < this.config.sellerCooldownMs) return { why: 'seller cooldown', permanent: false }
    if (!sellerEntries.length) {
      const today = this.iso().slice(0, 10)
      const firstTimersToday = new Set(Object.values(st.index).filter((e) => e.at.slice(0, 10) === today && this.bySeller(st, e.seller_id).every((x) => x.at.slice(0, 10) === today)).map((e) => e.seller_id))
      if (firstTimersToday.size >= this.config.newSellersPerDay) return { why: 'new-seller cap for today reached', permanent: false }
    }
    return null
  }

  /**
   * The seller's own example, if it is real content. The platform fills missing required fields of
   * `how_to_order.body_example` with `<name: description>` placeholders (API 0.3.6); ordering with those wastes the
   * money and earns the seller an unfair rating, so anything containing one is not an example (learned the hard way
   * on the first live first-buy, 2026-09-08: we sent `<html: HTML document to parse>` and paid for an empty result).
   */
  exampleInput(l: Listing): Record<string, unknown> | null {
    for (const candidate of [l.example_input, (l.how_to_order?.body_example as { input?: unknown } | undefined)?.input]) {
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate) && Object.keys(candidate as object).length && !hasPlaceholder(candidate)) return candidate as Record<string, unknown>
    }
    return null
  }

  /** What to order with: the seller's real example, else one the judge writes from the listing and its schema. */
  async inputFor(l: Listing): Promise<Record<string, unknown> | null> {
    const example = this.exampleInput(l)
    if (example) return example
    if (!isSchemaObject(l.input_schema)) return null
    const raw = await this.judge.inputForListing({ title: l.title, description: l.description, category: l.category, input_schema: l.input_schema, example_input: l.example_input, output_schema: l.output_schema }).catch((e: unknown) => {
      this.log('first-buy: input generation failed', { env: this.env, listing_id: l.id, error: msg(e) })
      return null
    })
    if (!raw) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      this.log('first-buy: generated input is not JSON', { env: this.env, listing_id: l.id })
      return null
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Object.keys(parsed).length || hasPlaceholder(parsed)) return null
    if (JSON.stringify(parsed).length > 8000) return null
    const check = validateDocuments(l.input_schema as Record<string, unknown>, [parsed])
    if (check.schema_error) this.log('first-buy: the listing input_schema could not be compiled; ordering with the generated input anyway', { env: this.env, listing_id: l.id, schema_error: check.schema_error })
    else if (!check.results[0]?.valid) {
      this.log('first-buy: generated input does not satisfy the listing schema', { env: this.env, listing_id: l.id, errors: check.results[0]?.errors?.slice(0, 3) })
      return null
    }
    this.log('first-buy: ordering with a generated input', { env: this.env, listing_id: l.id, input: JSON.stringify(parsed).slice(0, 200) })
    return parsed as Record<string, unknown>
  }

  /**
   * ADR-35: null when the desk may order; otherwise why not. Permanent reasons are remembered in `skipped` (with the
   * verdict as prefix) and counted; a transient one (judge unavailable) is retried next tick.
   */
  async screen(st: FirstBuyState, l: Listing): Promise<{ why: string; permanent: boolean } | null> {
    if (!this.config.screen) return null
    // "bought" = paid for, or still in flight; a purchase that ended unpaid (expired, declined, cancelled) proves nothing
    const bought = Object.values(st.index).filter((e): e is IndexEntry & { title: string } => !!e.title && (!e.outcome || e.outcome.startsWith('paid')))
    // the free check runs every time, before the cached verdict: another copy may have been bought since the judge said yes
    const clone = bought.find((e) => isCloneTitle(e.title, l.title))
    if (clone) return { why: `duplicate: the desk already bought this function ("${clone.title.slice(0, 60)}"); it buys each function once, not each copy`, permanent: true }
    if (st.eligible?.[l.id]) return null
    let verdict: Awaited<ReturnType<Judge['screenListing']>>
    try {
      verdict = await this.judge.screenListing({ title: l.title, description: l.description, category: l.category, price: l.pricing.price ?? 0, input_schema: l.input_schema, output_schema: l.output_schema, example_input: l.example_input, example_output: l.example_output, already_bought: bought.map((e) => ({ title: e.title, category: e.category ?? '' })) })
    } catch (e) {
      this.log('first-buy: screening unavailable, will retry', { env: this.env, listing_id: l.id, error: msg(e) })
      return { why: 'screening unavailable', permanent: false }
    }
    if (verdict.verdict === 'eligible') {
      st.eligible = { ...(st.eligible ?? {}), [l.id]: this.iso() }
      return null
    }
    return { why: `${verdict.verdict}: ${verdict.reason || 'not work a buyer needs another agent for'}`, permanent: true }
  }

  private async hire(st: FirstBuyState, l: Listing): Promise<Purchase | null> {
    const screened = await this.screen(st, l)
    if (screened) {
      if (screened.permanent) {
        st.skipped[l.id] = screened.why
        await this.save(st)
      }
      this.log('first-buy: listing skipped', { env: this.env, listing_id: l.id, seller: l.seller.handle, why: screened.why })
      return null
    }
    const input = await this.inputFor(l)
    if (!input) {
      st.skipped[l.id] = 'no realistic input could be derived for this listing'
      this.log('first-buy: listing skipped', { env: this.env, listing_id: l.id, seller: l.seller.handle, why: st.skipped[l.id] })
      return null
    }
    // idempotent per listing: a crash between create and save replays into the same job instead of a second one
    const job = await this.client.jobs.create({ listing_id: l.id, input, units: l.pricing.model === 'per_unit' ? 1 : undefined, title: `First buy by the platform desk: ${l.title.slice(0, 80)}`, max_revisions: 1 }, `firstbuy:${this.env}:${l.id}`)
    const wallet = job.payment.pay_to ?? null
    const refuse = async (why: string) => {
      await this.client.jobs.cancel(job.id, `buyer: ${why}`).catch(() => undefined)
      st.skipped[l.id] = why
      this.log('first-buy: hired then refused', { env: this.env, listing_id: l.id, job_id: job.id, why })
      return null
    }
    if (job.price == null || BigInt(job.price) > this.config.maxPrice) return refuse(`job price ${job.price == null ? 'unknown' : formatUsdc(job.price)} above the first-buy cap`)
    if (job.payment.timing !== 'on_delivery') return refuse('the first-buy programme pays on delivery only')
    if (wallet && sameAddress(wallet, this.wallet.address)) return refuse('the seller wallet is the desk wallet')
    if (wallet && this.byWallet(st, wallet).length >= this.config.perSeller) return refuse(`this wallet already received ${this.byWallet(st, wallet).length} first-buys`)
    const at = this.iso()
    const p: Purchase = { listing_id: l.id, seller_id: l.seller.id, seller: l.seller.handle, title: l.title.slice(0, 80), price: job.price, job_id: job.id, wallet, created_at: at, pay_attempt_at: null, pay_hash: null, pay_failures: 0, ledgered: false, verdict: null, reviewed: false, review_failures: 0, rating: null, outcome: null, ended_at: null, needs_operator: null }
    st.purchases.push(p)
    st.index[l.id] = { seller_id: l.seller.id, wallet, at, price: job.price, outcome: null, title: l.title.slice(0, 80), category: l.category }
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
    if (!p.wallet && job.payment.pay_to) p.wallet = job.payment.pay_to
    switch (job.status) {
      case 'quoted':
        if (job.quoted_price != null && BigInt(job.quoted_price) <= this.config.maxPrice && job.available_actions.includes('accept_quote') && (await this.deps.canSpend(BigInt(job.quoted_price)))) {
          await this.client.jobs.acceptQuote(job.id)
          p.price = job.quoted_price
          if (st.index[p.listing_id]) st.index[p.listing_id]!.price = job.quoted_price
        } else if (job.available_actions.includes('cancel')) {
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
      case 'expired':
        // a broadcast payment inside the platform's grace window still pays the job
        if (p.pay_hash && job.available_actions.includes('pay')) {
          await this.submitHash(st, p, job)
          return
        }
        await this.end(st, p, job, p.pay_hash ? 'paid_then_expired' : 'expired')
        return
      case 'declined':
      case 'cancelled':
        await this.end(st, p, job, p.pay_hash ? `paid_then_${job.status}` : job.status)
        return
      case 'in_progress':
        // the platform lets the buyer cancel once the delivery deadline plus its grace passed; a paid job gets refund_due that way
        if (job.available_actions.includes('cancel')) {
          await this.client.jobs.cancel(job.id, p.pay_hash ? 'buyer: paid, revision not delivered by the deadline' : 'buyer: no delivery by the deadline')
          await this.end(st, p, job, p.pay_hash ? 'paid_no_redelivery' : 'no_delivery')
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
    if (p.pay_hash) return this.submitHash(st, p, job)
    if (p.pay_attempt_at) {
      // an earlier attempt left no hash: the transfer may have happened. The job's derived EIP-3009 nonce identifies it exactly.
      const nonce = await this.jobNonce(job.id)
      const hash = nonce ? await this.wallet.findAuthorizationUse(nonce) : null
      if (hash) {
        p.pay_hash = hash
        await this.save(st)
        this.log('first-buy: recovered the transfer from the chain by its nonce', { env: this.env, job_id: job.id, hash })
        await this.ledger(p)
        return this.submitHash(st, p, job)
      }
      if (p.pay_failures >= 3) {
        p.needs_operator = `first-buy payment for job ${job.id} (${formatUsdc(job.price ?? 0)} to ${job.payment.pay_to}) failed ${p.pay_failures} times and no transfer with its nonce is on the chain; check the wallet, then clear pay_attempt_at, pay_failures and needs_operator for this job in memory ${this.key} (re-read every tick)`
        await this.save(st)
        this.log('ATTENTION: first-buy payment needs a human', { env: this.env, job_id: job.id })
        return false
      }
    }
    if (!(await this.deps.canSpend(BigInt(job.price ?? 0)))) {
      this.log('first-buy: payment held by the desk spending caps', { env: this.env, job_id: job.id })
      if (job.deadlines.pay_by && Date.parse(job.deadlines.pay_by) - this.now() < 2 * 3600_000 && job.available_actions.includes('cancel')) {
        // better an honest walk-away than a sealed delivery that expires unpaid
        await this.client.jobs.cancel(job.id, 'buyer: the desk hit its spending cap and cannot pay before the deadline; sorry, nothing is held against you')
        await this.end(st, p, job, 'unpaid_caps')
      }
      return false
    }
    // guard against a second process working on the same key: sign only if the fresh record still shows no attempt
    const fresh = (await this.fetchState()).purchases.find((x) => x.job_id === p.job_id)
    if (fresh?.pay_hash) {
      p.pay_hash = fresh.pay_hash
      await this.save(st)
      return this.submitHash(st, p, job)
    }
    if (fresh && fresh.pay_attempt_at && fresh.pay_attempt_at !== p.pay_attempt_at) {
      this.log('first-buy: another process is paying this job; waiting', { env: this.env, job_id: job.id })
      return false
    }
    p.pay_attempt_at = this.iso()
    await this.save(st)
    try {
      const paid = await this.client.jobs.payGasless(job.id, this.signer, { retries: 20, intervalMs: 3000 })
      p.pay_hash = paid.payment.settlement?.transaction ?? p.pay_hash
      await this.save(st)
      await this.ledger(p)
      this.log('first-buy: paid gas-free', { env: this.env, job_id: job.id, seller: p.seller, price: job.price, hash: p.pay_hash })
      return paid.payment.status === 'paid'
    } catch (e) {
      const hash = errorDetails(e).transaction
      if (typeof hash === 'string' && /^0x[0-9a-f]{64}$/i.test(hash)) {
        // the facilitator broadcast it; the platform has not verified it yet: keep the hash, resubmit next tick
        p.pay_hash = hash.toLowerCase()
        await this.save(st)
        await this.ledger(p)
        this.log('first-buy: transfer broadcast, verification pending', { env: this.env, job_id: job.id, hash: p.pay_hash })
        return false
      }
      p.pay_failures += 1
      await this.save(st)
      this.log('first-buy: gas-free payment failed', { env: this.env, job_id: job.id, code: errorCode(e), error: msg(e), failures: p.pay_failures })
      throw e
    }
  }

  /** Submits a known hash; pending answers wait, anything else counts as a failure and stops for a human after three. */
  private async submitHash(st: FirstBuyState, p: Purchase, job: Job): Promise<boolean> {
    try {
      const r = await this.client.jobs.pay(job.id, p.pay_hash!, { retries: 3, intervalMs: 2000 })
      return r.payment.status === 'paid'
    } catch (e) {
      const code = errorCode(e)
      if (code && PENDING.has(code)) {
        this.log('first-buy: payment not verified yet, will retry', { env: this.env, job_id: job.id, code })
        return false
      }
      p.pay_failures += 1
      if (p.pay_failures >= 3) p.needs_operator = `first-buy hash ${p.pay_hash} for job ${job.id} was rejected (${code ?? msg(e)}); check the transfer on the explorer, then fix pay_hash or clear it (and pay_failures, needs_operator) in memory ${this.key}`
      await this.save(st)
      this.log('first-buy: submitting the hash failed', { env: this.env, job_id: job.id, code, error: msg(e), failures: p.pay_failures })
      return false
    }
  }

  /** The job's EIP-3009 nonce as the platform derives it (stable while nothing was paid partially). */
  private async jobNonce(jobId: string): Promise<string | null> {
    const terms = await this.client.jobs.paymentRequired(jobId).catch(() => null)
    const nonce = terms?.gasless?.typed_data.message.nonce
    return typeof nonce === 'string' && /^0x[0-9a-f]{64}$/i.test(nonce) ? nonce.toLowerCase() : null
  }

  private async ledger(p: Purchase): Promise<void> {
    if (p.ledgered || !p.pay_hash || !this.deps.recordSpend) return
    await this.deps.recordSpend({ job_id: p.job_id, amount: String(p.price), hash: p.pay_hash, at: this.iso() }).catch((e: unknown) => this.log('first-buy: ledger write failed', { env: this.env, job_id: p.job_id, error: msg(e) }))
    p.ledgered = true
  }

  /** The judge grades the revealed delivery against the listing's own promise; the desk accepts or asks for one revision, never disputes. */
  private async grade(st: FirstBuyState, p: Purchase, job: Job): Promise<void> {
    if (p.verdict && p.verdict.output_hash === job.output_hash) {
      if (!p.verdict.acted) await this.act(st, p, job)
      return
    }
    const v = await this.verdictFor(p, job)
    p.verdict = compactVerdict(v, job.output_hash, this.iso(), false)
    await this.save(st)
    this.log('first-buy: delivery graded', { env: this.env, job_id: job.id, seller: p.seller, decision: v.decision, rating: v.rating })
    await this.act(st, p, job)
  }

  private async verdictFor(p: Purchase, job: Job): Promise<Verdict> {
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
    return v.decision === 'dispute' ? { ...v, decision: 'accept', rating: Math.min(v.rating, 2) as Verdict['rating'] } : v
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
    if (!p.verdict && upheld && job.output != null) {
      // the platform auto-completed a revealed delivery before the desk graded it: grade now, then review
      const v = await this.verdictFor(p, job)
      p.verdict = compactVerdict(v, job.output_hash, this.iso(), true)
      await this.save(st)
    }
    const rating = upheld ? (p.verdict?.rating ?? 3) : 1
    if (!p.reviewed) {
      // ADR-32 / AI Act Art. 50: the rating and the text come from the automated judge; say so in the text and in the public flag
      const text = upheld ? `First buy by the platform desk (ADR-31), graded by an automated judge against the listing text: ${p.verdict?.message || 'delivered as the listing promised.'}` : 'First buy by the platform desk (automated judge): the dispute panel found the delivery did not do what the listing promised.'
      try {
        await this.client.jobs.review(job.id, rating, text, { machine_generated: true })
        p.reviewed = true
        p.rating = rating
      } catch (e) {
        p.review_failures += 1
        this.log('first-buy: review failed', { env: this.env, job_id: job.id, error: msg(e), failures: p.review_failures })
        if (p.review_failures < 3) {
          await this.save(st)
          return // the public review is the point: try again next tick
        }
      }
    }
    await this.end(st, p, job, p.pay_hash ? 'paid' : job.status)
    this.log('first-buy: completed', { env: this.env, job_id: job.id, seller: p.seller, rating, hash: p.pay_hash })
  }

  private async end(st: FirstBuyState, p: Purchase, job: Job | null, outcome: string): Promise<void> {
    p.outcome = outcome
    p.ended_at = this.iso()
    if (st.index[p.listing_id]) st.index[p.listing_id]!.outcome = outcome
    if (job && p.pay_hash && !outcome.startsWith('paid')) this.log('ATTENTION: first-buy job ended after payment', { env: this.env, job_id: job.id, status: job.status, hash: p.pay_hash })
    await this.save(st)
  }

  private async sellerNotes(threadId: string, sellerId: string): Promise<string | null> {
    const res = await this.client.threads.messages(threadId, { order: 'asc', limit: 50 }).catch(() => null)
    if (!res) return null
    const texts = res.data.filter((m) => (m as { sender?: { id?: string } }).sender?.id === sellerId).map((m) => String((m as { body?: unknown }).body ?? '')).filter(Boolean)
    return texts.length ? texts.join('\n---\n').slice(0, 8000) : null
  }

  // --- persistence (platform memory, so a restart continues where it stopped) ----------------------------------

  private async fetchState(): Promise<FirstBuyState> {
    const r = await this.client.memory.get<Partial<FirstBuyState>>(this.key).catch((e: unknown) => (statusOf(e) === 404 ? null : Promise.reject(e)))
    const v = r?.value
    const st: FirstBuyState = v && Array.isArray(v.purchases) ? { purchases: v.purchases, index: v.index ?? {}, skipped: v.skipped ?? {}, eligible: v.eligible ?? {}, last_error: v.last_error ?? null } : emptyState()
    for (const p of st.purchases) {
      const e = st.index[p.listing_id]
      if (!e) st.index[p.listing_id] = { seller_id: p.seller_id, wallet: p.wallet ?? null, at: p.created_at, price: p.price, outcome: p.outcome, title: p.title }
      else if (!e.title) e.title = p.title // entries written before ADR-35 carried no title; the clone check needs it
    }
    this.state = st
    return st
  }

  private async save(st: FirstBuyState): Promise<void> {
    const youngSince = this.now() - this.config.lookbackDays * 86_400_000
    const youngBefore = Object.values(st.index).filter((e) => Date.parse(e.at) >= youngSince).length
    const compact = compactState(st, this.config.lookbackDays, this.now())
    const youngAfter = Object.values(compact.index).filter((e) => Date.parse(e.at) >= youngSince).length
    if (youngAfter < youngBefore) this.log('ATTENTION: first-buy state exceeds the memory limit; dropped recent index entries (caps and clone check lose them)', { env: this.env, dropped: youngBefore - youngAfter, kept: youngAfter })
    st.purchases = compact.purchases
    st.index = compact.index
    st.skipped = compact.skipped
    st.eligible = compact.eligible
    this.state = st
    await this.client.memory.set(this.key, compact)
  }
}
