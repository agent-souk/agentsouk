import { and, asc, desc, eq, gte, inArray, lt, lte, notLike, or, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { agents, jobs, messages, operatorAlerts, settlements, type AlertTier, type Env } from '../db/schema.js'
import { config } from '../config.js'
import { newId } from '../lib/ids.js'
import { log } from '../lib/log.js'
import { registerSweep } from '../lib/scheduler.js'
import { onEvent, type EventRecord } from '../events/bus.js'
import { ourFundedWallets } from '../modules/payments/our-money.js'
import { OUTSIDER_PRICE_FLOOR } from '../modules/meta/stats.js'
import { explorerTxUrl, formatUsdc, networkFor } from '../modules/payments/x402.js'
import { channelStatus, requestsFor, type AlertPayload, type ChannelRequest } from './alert-channels.js'

/**
 * ADR-49: the operator's own wire.
 *
 * Everything this platform publishes can be read later, and that is on purpose - the numbers are the product of
 * the argument, not a dashboard. One thing cannot usefully be read later: the moment an outside agent pays real
 * money here. On live that has never happened (GET /v1/stats between_outsiders.orders = 0), and the whole point
 * of the next weeks is to find out whether it ever will. If it does at 03:00 and nobody notices until the next
 * session, the one event the operator was waiting for passes unattended - and if the seller is one of ours and
 * something goes wrong in the delivery, an unattended failure is also the worst possible first impression.
 *
 * The rule that decides what is worth waking someone is NOT a new judgement. It is the same rule the headline
 * figure uses (modules/meta/stats.ts, modules/payments/our-money.ts): a payment counts as outside money only if
 * the job had none of our identities on it when it was created, at least OUTSIDER_PRICE_FLOOR settled on chain,
 * and the paying wallet never held USDC that came from us. Any other definition would eventually drift from the
 * published one, and two definitions drifting apart is exactly how ADR-43 happened.
 *
 * Unset configuration means no alerts and no rows: the platform must run identically with nobody watching.
 */

/**
 * Waits BETWEEN attempts, so there is one more attempt than there are waits. Setting MAX_ATTEMPTS to the length
 * of this table made the last entry unreachable: the row was failed at attempt 4 before the 30-minute wait was
 * ever read, and the retry window was 6m15s while the table said 36 minutes. A channel that is down for a
 * quarter of an hour - a deploy, a webhook rotation - is exactly the case the long tail is for.
 */
export const ALERT_BACKOFF_MS = [15_000, 60_000, 5 * 60_000, 30 * 60_000]
export const ALERT_MAX_ATTEMPTS = ALERT_BACKOFF_MS.length + 1
export const ALERT_TIMEOUT_MS = 10_000

/**
 * The hourly cap DEFERS, it does not discard. Holding an alert back and never looking at it again would mean the
 * first order ever placed between two outsiders - the number this marketplace is measured by, 0 for its whole
 * history - could be dropped because twelve ordinary alerts went out in the hour before it. Held rows are
 * re-offered every ALERT_DEFER_MS until the rolling window frees up, and only given up after ALERT_DEFER_MAX_MS.
 */
export const ALERT_DEFER_MS = 10 * 60_000
export const ALERT_DEFER_MAX_MS = 6 * 3600_000

/**
 * Why a row was not sent, as the one text each ending writes and the summary reads back (ADR-58). Three endings
 * used to be told apart by free-text prefixes sixty lines from where they were written, with "our money" as the
 * catch-all for anything unrecognised - so a delivery failure with a new wording read as an answer.
 */
export const SUPPRESSED = {
  cap: (cap: number) => `held back by the ${cap}/hour cap for ${Math.round(ALERT_DEFER_MAX_MS / 3600_000)} hours and given up on`,
  ourMoney: 'the paying wallet holds money that came from us (modules/payments/our-money.ts)',
  noChannel: 'no channel configured',
} as const

/** The summary that says alerts are being held back must never itself be held back. */
const bypassesCap = (row: { tier: AlertTier; key: string }) => row.tier === 'urgent' || row.key.startsWith('flood:')

/**
 * A quiet row may use only half of the hourly cap (ADR-60). Quiet rows can be produced by anyone for free - an
 * outsider's message to our desk, an order placed with one of our listings - and rows already delivered fill the
 * rolling hour whatever their tier, so without headroom a dozen of them would hold back the next notable alert
 * (the first order between outsiders, an escalated dispute) and, kept up for six hours, give it up.
 */
const capFor = (row: { tier: AlertTier }, cap: number) => (row.tier === 'quiet' ? Math.max(1, Math.floor(cap / 2)) : cap)

const TIER_ORDER: Record<AlertTier, number> = { urgent: 3, notable: 2, quiet: 1 }

export type AlertDraft = {
  env: Env
  tier: AlertTier
  /** `<kind>:<id>`: the same fact never wakes anyone twice, whichever party's event carried it. */
  key: string
  title: string
  body: string
  url?: string | null
  data?: Record<string, unknown>
  /** raise() may replace a row with this key that has not gone out yet (never stored) */
  upgrade?: boolean
  /** a new row waits this long before its first delivery, so later facts can still bring it up to date (never stored) */
  holdMs?: number
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number; text?: () => Promise<string> }>
let alertFetch: FetchLike = fetch as unknown as FetchLike
/** Tests only: replace the outbound send. */
export function _setAlertFetchForTests(f: FetchLike | null) {
  alertFetch = f ?? (fetch as unknown as FetchLike)
}

/** Whether this tier is delivered at all under the current configuration. */
export function tierWanted(tier: AlertTier): boolean {
  return TIER_ORDER[tier] >= TIER_ORDER[config().OPERATOR_ALERT_MIN_TIER]
}

const hourBucket = (now: number) => new Date(now).toISOString().slice(0, 13)

/**
 * Record an alert for delivery. Deduplicated by `key`, so the same fact arriving twice (every job event is
 * emitted once per party) is one alert. Returns the row id, or null when nothing was recorded.
 *
 * The row is written even with no channel configured. It costs one insert and it buys the thing the operator
 * actually needs on the day they wire a channel up: a record of what would have been sent. The delivery worker
 * marks those rows `suppressed`, so nothing retries for ever.
 *
 * `upgrade` lets a caller that knows more about the same fact (the x402 endpoint knows the purchase came in
 * without an account) replace a row the classifier already wrote, as long as it has not gone out yet. Without
 * it the two paths would produce two alerts for one payment.
 */
export async function raise(draft: AlertDraft, now = Date.now(), opts: { upgrade?: boolean } = {}): Promise<string | null> {
  if (!tierWanted(draft.tier)) return null
  const cap = config().OPERATOR_ALERT_MAX_PER_HOUR
  // Counted on what was actually DELIVERED, per environment, and never applied to an urgent alert. Counting
  // created rows instead turns a broken channel into a suppression cascade (twelve stuck rows silence the
  // thirteenth), and counting across environments lets sandbox noise silence live.
  let flooded = false
  if (!bypassesCap(draft)) {
    const delivered = await db()
      .select({ n: sql<number>`count(*)` })
      .from(operatorAlerts)
      .where(and(eq(operatorAlerts.env, draft.env), gte(operatorAlerts.sentAt, now - 3600_000), notLike(operatorAlerts.key, 'flood:%')))
    flooded = (delivered[0]?.n ?? 0) >= capFor(draft, cap)
  }
  // Held back, not dropped: the row stays pending and comes round again when the rolling hour has room.
  const id = await insert(draft, 'pending', now, flooded ? `held back: more than ${cap} alerts delivered in the last hour` : null, flooded ? now + ALERT_DEFER_MS : now + (draft.holdMs ?? 0))
  if (!id && opts.upgrade) return upgradePending(draft, now)
  // Only for a row that was actually written and held back: the second emission of the same fact (every job event
  // is emitted once per party) collides on the key and is not queued, so it must not be named as "held back".
  if (flooded && id) await floodSummary(draft.env, cap, draft, now)
  return id
}

/**
 * The one-an-hour notice that alerts are being held back. It bypasses the cap in both places - a notice that
 * alerts are being held back is worthless if it can be held back - and names the first held-back alert in the
 * BODY, not only in data: e-mail, Discord, Slack, ntfy and Telegram all render title and body and drop data.
 *
 * Keyed by ENVIRONMENT and hour (ADR-57). Keyed by the hour alone, the sandbox flooding first in an hour silently
 * swallowed the live notice for the same hour: the row that says "live alerts are being held back" was itself
 * held back, with nothing to say so. Written from raise() AND from the delivery sweep, because the sweep is where
 * thirty rows raised inside one minute actually meet the cap - raise() sees nothing delivered yet and lets them
 * all through, and until now the sweep then deferred them without a word.
 */
async function floodSummary(env: Env, cap: number, firstHeldBack: { key: string; title: string }, now: number): Promise<void> {
  await insert(
    {
      env,
      tier: 'notable',
      key: `flood:${env}:${hourBucket(now)}`,
      title: `More than ${cap} alerts in one hour on ${env} - the rest are queued`,
      body: [
        `Alerts beyond ${cap} an hour on ${env} wait their turn instead of going out; they are delivered as the hour frees up, and given up on after ${Math.round(ALERT_DEFER_MAX_MS / 3600_000)} hours.`,
        `First one held back: ${firstHeldBack.title}`,
        `Read everything with GET ${config().PUBLIC_BASE_URL.replace(/\/$/, '')}/v1/admin/alerts (header X-Admin-Token), and raise OPERATOR_ALERT_MAX_PER_HOUR if this is normal traffic now.`,
      ].join('\n'),
      data: { cap, env, first_held_back: firstHeldBack.key },
    },
    'pending',
    now,
    null,
  )
}

const dataOf = (draft: AlertDraft) => ({ ...(draft.data ?? {}), ...(draft.url ? { url: draft.url } : {}) })

async function insert(draft: AlertDraft, status: 'pending' | 'suppressed', now: number, lastError: string | null, nextAttemptAt = now): Promise<string | null> {
  const id = newId('alert')
  const r = await db()
    .insert(operatorAlerts)
    .values({ id, env: draft.env, tier: draft.tier, key: draft.key, title: draft.title, body: draft.body, data: dataOf(draft), status, attempt: 0, nextAttemptAt, lastError, createdAt: now, updatedAt: now })
    .onConflictDoNothing({ target: operatorAlerts.key })
  return (r.rowsAffected ?? 0) > 0 ? id : null
}

/** Replace an alert that has not gone out yet with a better-informed version of the same fact. */
async function upgradePending(draft: AlertDraft, now: number): Promise<string | null> {
  const r = await db()
    .update(operatorAlerts)
    .set({ tier: draft.tier, title: draft.title, body: draft.body, data: dataOf(draft), updatedAt: now })
    .where(and(eq(operatorAlerts.key, draft.key), eq(operatorAlerts.status, 'pending')))
  if (!(r.rowsAffected ?? 0)) return null
  return (await db().query.operatorAlerts.findFirst({ where: eq(operatorAlerts.key, draft.key), columns: { id: true } }))?.id ?? null
}

// --- what is worth an alert ---------------------------------------------------------------------

const base = () => config().PUBLIC_BASE_URL.replace(/\/$/, '')

type JobFacts = {
  job: typeof jobs.$inferSelect
  buyer: { handle: string; firstParty: boolean; walletAddress: string | null } | null
  seller: { handle: string; firstParty: boolean; walletAddress: string | null } | null
  paid: number
  payers: string[]
  transaction: string | null
}

/**
 * Everything the classifier needs, and deliberately NOT whether the money came from us.
 *
 * `emit()` awaits its listeners inline (events/bus.ts) and `job.paid` is emitted once per party, so anything
 * this function does happens twice while the buyer is still holding the HTTP connection open on
 * POST /v1/jobs/{id}/pay. `ourFundedWallets()` is a recursive CTE over every settlement; it belongs in the
 * delivery sweep, where it also produces a better record - the operator sees the alerts we chose not to send,
 * and why, instead of a filter that leaves no trace.
 */
async function factsFor(jobId: string, withPayments: boolean): Promise<JobFacts | null> {
  const job = await db().query.jobs.findFirst({ where: eq(jobs.id, jobId) })
  if (!job) return null
  const parties = await db().query.agents.findMany({ where: inArray(agents.id, [job.buyerAgentId, job.sellerAgentId]), columns: { id: true, handle: true, firstParty: true, walletAddress: true } })
  const of = (id: string) => parties.find((a) => a.id === id) ?? null
  // Oldest first: the first payer is the one that opened the payment, the newest transaction is the one to link.
  const pays = withPayments ? await db().query.settlements.findMany({ where: and(eq(settlements.jobId, job.id), eq(settlements.kind, 'payment'), eq(settlements.status, 'settled')), orderBy: [asc(settlements.createdAt), asc(settlements.id)] }) : []
  return {
    job,
    buyer: of(job.buyerAgentId),
    seller: of(job.sellerAgentId),
    paid: pays.reduce((sum, s) => sum + s.amount, 0),
    payers: [...new Set(pays.map((s) => s.payerAddress.toLowerCase()))],
    transaction: pays[pays.length - 1]?.transaction ?? null,
  }
}

const jobLine = (f: JobFacts) => `${f.buyer?.handle ?? f.job.buyerAgentId} → ${f.seller?.handle ?? f.job.sellerAgentId} · ${f.job.title} · ${formatUsdc(f.job.price)}`

/**
 * A settled payment. Urgent only under exactly the rule the published figure uses; a payment to one of our own
 * desks is worth knowing but is not the thing we are waiting for, and it says so in the alert itself.
 */
export function classifyPayment(f: JobFacts): AlertDraft | null {
  if (f.paid < OUTSIDER_PRICE_FLOOR) return null
  const outsiders = f.job.firstPartyInvolved === false
  const payerLine = f.payers.length ? `payer wallet: ${f.payers.join(', ')}` : ''
  const tx = explorerTxUrl(networkFor(f.job.env), f.transaction)
  const common = { env: f.job.env, key: `paid:${f.job.id}`, url: tx ?? `${base()}/v1/jobs/${f.job.id}`, data: { job_id: f.job.id, env: f.job.env, amount: f.paid, buyer: f.buyer?.handle, seller: f.seller?.handle, payers: f.payers, transaction: f.transaction, first_party_involved: f.job.firstPartyInvolved } }
  if (outsiders) {
    return {
      ...common,
      // The sandbox runs on worthless testnet USDC out of our own faucet. Real money is what justifies a phone
      // ringing at night; a sandbox trade is worth reading in the morning.
      tier: f.job.env === 'live' ? 'urgent' : 'notable',
      title: `${formatUsdc(f.paid)} paid between two outsiders (${f.job.env})`,
      body: [
        jobLine(f),
        '',
        'This is the figure the whole thing is measured by: a payment with Agent Souk on neither side, above the price floor. Before believing it, read GET /v1/stats between_outsiders and its `excluded` block - this alert applies the same rule, but the figure is the one that counts.',
        payerLine,
      ]
        .filter(Boolean)
        .join('\n'),
    }
  }
  if (f.seller?.firstParty && !f.buyer?.firstParty) {
    return {
      ...common,
      tier: 'notable',
      title: `${formatUsdc(f.paid)} paid to us by an outside agent (${f.job.env})`,
      body: [jobLine(f), '', 'Someone outside paid one of OUR listings. It cannot move between_outsiders (we are one of the two parties by construction) and it does answer the question behind it: an agent out there pays for something.', payerLine].filter(Boolean).join('\n'),
    }
  }
  return null
}

/** After this many payments to us from one outside buyer in 24 hours, its further payments share one line per six-hour slot (ADR-66). */
export const PAYMENT_ALERTS_PER_BUYER_PER_DAY = 3
/** How long the slot line waits before it goes out: a burst is one message with its count, not a message with the fourth payment's (ADR-66 audit). */
export const REPEAT_PAYMENT_HOLD_MS = 10 * 60_000

/**
 * ADR-66: a buyer that comes back and pays again and again is one fact per slot, not one alert per payment. On
 * 2026-09-15 one wallet paid for fifteen extractions in twelve minutes: fifteen notable alerts, and the hourly cap
 * held six of them - and everything behind them - back. A buyer's first payments of a day still alert one by one,
 * because a new buyer paying is the news; from the fourth on, one line per six-hour slot names how many and how much,
 * waits ten minutes and is brought up to date meanwhile, and carries every payer wallet of the day, so the our-money check
 * at delivery sees all of them. Only payments to US: a payment between two outsiders is the figure and alerts each time.
 */
async function repeatPayment(f: JobFacts, via: 'x402' | null): Promise<AlertDraft | null> {
  if (f.job.firstPartyInvolved === false || !f.job.paidAt || !(f.seller?.firstParty && !f.buyer?.firstParty)) return null
  // Window and slot hang on the payment itself, not on the moment it is classified: job.paid is emitted once per party
  // and the x402 endpoint raises again later, and all of them must arrive at the same count and the same row.
  const at = f.job.paidAt
  const inWindow = and(eq(jobs.env, f.job.env), eq(jobs.buyerAgentId, f.job.buyerAgentId), eq(jobs.firstPartyInvolved, true), gte(jobs.paidAt, at - 24 * 3_600_000), lte(jobs.paidAt, at))
  const [earlier] = await db()
    .select({ n: sql<number>`count(*)` })
    .from(jobs)
    .where(and(inWindow, or(lt(jobs.paidAt, f.job.paidAt), and(eq(jobs.paidAt, f.job.paidAt), lt(jobs.id, f.job.id)))))
  const nth = (earlier?.n ?? 0) + 1
  if (nth <= PAYMENT_ALERTS_PER_BUYER_PER_DAY) return null
  const pays = await db()
    .select({ payer: settlements.payerAddress, amount: settlements.amount })
    .from(settlements)
    .innerJoin(jobs, eq(settlements.jobId, jobs.id))
    .where(and(inWindow, eq(settlements.kind, 'payment'), eq(settlements.status, 'settled')))
  const payers = [...new Set([...pays.map((p) => p.payer.toLowerCase()), ...f.payers])]
  const total = pays.reduce((sum, p) => sum + p.amount, 0)
  const who = f.buyer?.handle ?? f.job.buyerAgentId
  return {
    env: f.job.env,
    tier: 'notable',
    key: `paid-again:${f.job.env}:${f.job.buyerAgentId}:${Math.floor(at / ORDER_ALERT_SLOT_MS)}`,
    title: `${who} keeps paying us: ${nth} payments in 24 h, ${formatUsdc(total)} (${f.job.env})`,
    body: [
      jobLine(f),
      '',
      `After ${PAYMENT_ALERTS_PER_BUYER_PER_DAY} payments from one buyer in a day its further payments share one line per six-hour slot. The line waits ${Math.round(REPEAT_PAYMENT_HOLD_MS / 60_000)} minutes before it goes out and counts what came in meanwhile; payments after that stay on GET ${base()}/v1/admin/overview until the next slot. The first payments of every buyer still alert one by one.${via === 'x402' ? ' Paid through POST /v1/x402 without an account.' : ''}`,
      `payer wallets: ${payers.join(', ')}`,
    ].join('\n'),
    url: explorerTxUrl(networkFor(f.job.env), f.transaction) ?? `${base()}/v1/jobs/${f.job.id}`,
    data: { job_id: f.job.id, env: f.job.env, buyer: f.buyer?.handle, seller: f.seller?.handle, payments_24h: nth, amount_24h: total, payers, transaction: f.transaction, first_party_involved: f.job.firstPartyInvolved, ...(via ? { via } : {}) },
    upgrade: true,
    holdMs: REPEAT_PAYMENT_HOLD_MS,
  }
}

/** After this many orders from one buyer in 24 hours, its further orders share one line per six-hour slot (ADR-63). */
export const ORDER_ALERTS_PER_BUYER_PER_DAY = 3
export const ORDER_ALERT_SLOT_MS = 6 * 3_600_000

/**
 * An order placed with us on neither side: no money yet, and still the widest mouth of the funnel (ADR-46).
 *
 * ADR-63: one buyer ordering all day is one fact, not one alert per order. On 2026-09-13 a single agent placed 27
 * orders on live in one day (31 in all; 18 of them in one morning, at eleven different sellers), cancelled most of
 * them itself, and the hourly cap
 * held back the alerts that mattered behind them - three times that day the operator was told "the rest are queued".
 * The first orders of a buyer in a day alert one by one; from the fourth on, one quiet line per six-hour slot says how
 * many and how many were paid. Ordering is free; a payment still alerts on its own, whatever this says.
 */
export async function classifyOrder(f: JobFacts, now = Date.now()): Promise<AlertDraft | null> {
  if (f.job.firstPartyInvolved !== false && !(f.seller?.firstParty && !f.buyer?.firstParty)) return null
  const outsiders = f.job.firstPartyInvolved === false
  // Only orders of the same kind as this one: three orders at OUR desk must not demote a buyer's first order between
  // outsiders - that one is the figure, and at the default minimum tier a quiet row is not even written. Orders in the
  // same millisecond are ordered by id, so no two of them count each other (both from the audit of this change).
  const [earlier] = await db()
    .select({ n: sql<number>`count(*)`, paid: sql<number>`coalesce(sum(case when ${jobs.paidAt} is not null then 1 else 0 end), 0)` })
    .from(jobs)
    .where(
      and(
        eq(jobs.env, f.job.env),
        eq(jobs.buyerAgentId, f.job.buyerAgentId),
        eq(jobs.firstPartyInvolved, f.job.firstPartyInvolved),
        gte(jobs.createdAt, now - 24 * 3_600_000),
        or(lt(jobs.createdAt, f.job.createdAt), and(eq(jobs.createdAt, f.job.createdAt), lt(jobs.id, f.job.id))),
      ),
    )
  const nth = (earlier?.n ?? 0) + 1
  const paid = earlier?.paid ?? 0
  const common = {
    env: f.job.env,
    url: `${base()}/v1/jobs/${f.job.id}`,
    data: { job_id: f.job.id, env: f.job.env, buyer: f.buyer?.handle, seller: f.seller?.handle, price: f.job.price, first_party_involved: f.job.firstPartyInvolved, orders_24h: nth, paid_24h: paid },
  }
  if (nth > ORDER_ALERTS_PER_BUYER_PER_DAY) {
    return {
      ...common,
      tier: 'quiet',
      key: `ordered-again:${f.job.env}:${f.job.buyerAgentId}:${outsiders ? 'outsiders' : 'desk'}:${Math.floor(now / ORDER_ALERT_SLOT_MS)}`,
      title: `${f.buyer?.handle ?? f.job.buyerAgentId} keeps ordering ${outsiders ? 'between outsiders' : 'from us'}: ${nth} orders in 24 h, ${paid} paid (${f.job.env})`,
      body: [
        jobLine(f),
        '',
        `After ${ORDER_ALERTS_PER_BUYER_PER_DAY} orders from one buyer in a day its further orders share one line per six-hour slot; this is that line, and the orders behind it are not alerted one by one. Ordering is free - the figure is payments, and a payment still alerts on its own. Every order is on GET ${base()}/v1/admin/overview.`,
      ].join('\n'),
    }
  }
  return {
    ...common,
    // An order with us on neither side is `between_outsiders.orders`, which on live has been 0 for the whole
    // history of this marketplace. The first one is news, so it must not sit below the default minimum tier.
    // An order placed with our own desk is ordinary traffic and stays quiet.
    tier: outsiders ? 'notable' : 'quiet',
    key: `ordered:${f.job.id}`,
    title: outsiders ? `An outsider ordered from an outsider (${f.job.env})` : `An outside agent ordered from us (${f.job.env})`,
    body: [jobLine(f), '', outsiders ? 'Nothing has been paid. Ordering is free, so this is an upper bound on independent interest, not demand - GET /v1/commitments says as much next to the figure.' : 'Nothing has been paid yet; the desk delivers first.'].join('\n'),
  }
}

/** One alert per thread per window: a seller asking three questions in a row is one thing to read, not three. */
export const MESSAGE_ALERT_WINDOW_MS = 6 * 3_600_000

/**
 * An outside agent writing to one of OUR identities (ADR-60). The bounty desk told every awarded seller "questions
 * are answered in this thread", and nothing answers a question a seller asks on its own initiative: the desks
 * re-read a seller's messages only where they asked something themselves (a proposal clarification, a preview
 * that misses something). On 2026-09-13 the seller holding the 10 USDC security award asked, before its deadline,
 * whether a report without reproduction steps would qualify, and waited twelve hours, because nothing woke anyone.
 * `message.received` is emitted once per recipient, so the recipient of THIS event has to be ours; the sender must not be.
 */
async function classifyMessage(e: EventRecord): Promise<AlertDraft | null> {
  const d = e.data as { thread_id?: unknown; message_id?: unknown; from?: unknown; job_id?: unknown; preview?: unknown; via?: unknown }
  if (typeof d.thread_id !== 'string' || typeof d.from !== 'string') return null
  // The words an agent attaches to a job action (a delivery note, a decline or cancel reason, a quote) are posted as
  // its message too. They are a status line the desk reads with the action, not a question.
  if (d.via === 'job_action') return null
  const people = await db().query.agents.findMany({ where: inArray(agents.id, [e.agentId, d.from]), columns: { id: true, handle: true, firstParty: true, status: true } })
  const to = people.find((a) => a.id === e.agentId)
  const from = people.find((a) => a.id === d.from) // a system note has no agent behind it and is not a question
  // A recipient that has left (a deactivated smoke helper: still a participant of the thread, still flagged as ours) reads
  // nothing, so nobody is waiting for an answer there. On 2026-09-13 an outsider kept writing to twelve such helpers and
  // each line was an alert (ADR-63).
  if (!to?.firstParty || to.status !== 'active' || !from || from.firstParty) return null
  const job = typeof d.job_id === 'string' ? await db().query.jobs.findFirst({ where: eq(jobs.id, d.job_id) }) : null
  // Set by our own desk when it awards a bounty; no outsider can create a job that carries it on our side.
  const waitsOnOperator = job?.buyerAgentId === to.id && (job.input as { operator_confirmation_before_payment?: unknown } | null)?.operator_confirmation_before_payment === true
  // A follow-up after one of ours has answered is a new question: the window restarts at our newest message here.
  const ours = await db()
    .select({ id: messages.id })
    .from(messages)
    .innerJoin(agents, eq(agents.id, messages.senderAgentId))
    .where(and(eq(messages.threadId, d.thread_id), eq(agents.firstParty, true)))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(1)
  const deadline = job?.deadlineAt ? new Date(job.deadlineAt).toISOString() : null
  return {
    env: e.env,
    // Registering and writing to our desk costs nothing, so an ordinary message must not compete under the hourly cap
    // with the alerts that matter: quiet rows go out after every notable one. Only a job already waiting on the
    // operator is notable on live - and never urgent, a question is worth reading today, not a phone at night.
    tier: waitsOnOperator && e.env === 'live' ? 'notable' : 'quiet',
    key: `message:${d.thread_id}:${ours[0]?.id ?? 'start'}:${Math.floor(e.createdAt / MESSAGE_ALERT_WINDOW_MS)}`,
    title: `${from.handle} wrote to ${to.handle} (${e.env})`,
    body: [
      job ? `${from.handle} on "${job.title}" (${job.status}${deadline ? `, deliver by ${deadline}` : ''})` : `${from.handle} in a direct thread`,
      '',
      // Never the words themselves. This text leaves the platform for a push service, and a seller writing to a desk can be
      // discussing an unfixed security finding in ANY thread - the job thread, the direct thread of a proposal question,
      // A2A - not only in the job that carries the operator flag (second audit round, ADR-60). It is also untrusted text
      // in the one channel the operator trusts.
      'The message text is not copied into alerts. Read it in the thread.',
      '',
      `Nothing answers a question a seller asks on its own initiative; the desks re-read replies only where they asked something themselves, so look at the thread before answering: GET ${base()}/v1/threads/${d.thread_id}/messages with the ${to.handle} key, reply with POST to the same path.${waitsOnOperator ? ' This job pays only after the operator confirms it.' : ''} More messages here do not alert again until one of our identities writes in this thread or the next six-hour UTC slot begins.`,
    ].join('\n'),
    url: `${base()}/v1/threads/${d.thread_id}/messages`,
    data: { thread_id: d.thread_id, message_id: d.message_id, env: e.env, from: from.handle, to: to.handle, job_id: job?.id ?? null },
  }
}

/** Turn one platform event into an alert, or nothing. Everything our own identities did to themselves is nothing. */
export async function classify(e: EventRecord): Promise<AlertDraft | null> {
  const jobId = (e.data as { job_id?: unknown })?.job_id
  if (e.type === 'job.paid' && typeof jobId === 'string') {
    const f = await factsFor(jobId, true)
    const draft = f ? classifyPayment(f) : null
    return draft && f ? ((await repeatPayment(f, null)) ?? draft) : draft
  }
  if (e.type === 'job.created' && typeof jobId === 'string') {
    const f = await factsFor(jobId, false)
    return f ? classifyOrder(f, e.createdAt) : null
  }
  if ((e.type === 'job.disputed' || e.type === 'dispute.escalated') && typeof jobId === 'string') {
    const f = await factsFor(jobId, false)
    if (!f) return null
    const escalated = e.type === 'dispute.escalated'
    return {
      env: f.job.env,
      // A panel of evaluator agents decides an ordinary dispute; the operator has nothing to do until it
      // escalates, and only then is being interrupted the right outcome.
      tier: escalated ? 'notable' : 'quiet',
      key: `${escalated ? 'escalated' : 'disputed'}:${jobId}`,
      title: escalated ? `A dispute needs the operator (${f.job.env})` : `A job was disputed (${f.job.env})`,
      body: [jobLine(f), '', escalated ? `The evaluator panel could not decide it. Resolve with POST ${base()}/v1/admin/jobs/${jobId}/resolve.` : 'A panel of evaluator agents is voting; nothing to do unless it escalates.'].join('\n'),
      url: `${base()}/v1/admin/overview`,
      // no dispute reason: the desk writes it from the delivery, which for a security bounty is the finding (ADR-60)
      data: { job_id: jobId, env: f.job.env },
    }
  }
  if (e.type === 'job.delivered' && typeof jobId === 'string') {
    const f = await factsFor(jobId, false)
    if (!f?.buyer?.firstParty) return null
    // The one step of our own desk's process that needs a human: a bounty that pays only after the operator has
    // reproduced the finding (catalog.ts needs_operator_confirmation, carried on the job as
    // input.operator_confirmation_before_payment). Until 2026-09-12 a delivery here produced a log line in the
    // desk's process and a field on its health page, nothing else - and the desk walks away an hour before pay_by
    // if nobody answers, so a valid finding would have gone unpaid for our silence, on the one job whose public
    // promise is "fixed before it is paid" (ADR-57).
    if ((f.job.input as { operator_confirmation_before_payment?: unknown } | null)?.operator_confirmation_before_payment !== true) return null
    const payBy = f.job.paymentDeadlineAt ? new Date(f.job.paymentDeadlineAt).toISOString() : null
    return {
      env: f.job.env,
      tier: f.job.env === 'live' ? 'urgent' : 'notable',
      key: `confirm:${jobId}`,
      title: `A delivery waits for the operator's confirmation before payment (${f.job.env})`,
      body: [
        jobLine(f),
        '',
        `A sealed delivery on a bounty that pays only after a human reproduces it. Order of events: read the preview (GET ${base()}/v1/jobs/${jobId} as the desk; never on the public desk health page, ADR-60), reproduce it, deploy the fix, then as the desk PUT memory operator/confirm/${jobId} = {"output_hash": "${f.job.outputHash ?? '<output_hash>'}"}.`,
        `Pay by ${payBy ?? 'the deadline on the job'}; the desk walks away one hour before that if nothing is confirmed.`,
      ].join('\n'),
      url: `${base()}/v1/jobs/${jobId}`,
      data: { job_id: jobId, env: f.job.env, seller: f.seller?.handle, output_hash: f.job.outputHash, pay_by: payBy },
    }
  }
  if (e.type === 'message.received') return classifyMessage(e)
  if (e.type === 'webhook.disabled') {
    // The platform stopped calling one of OUR receivers (ADR-61). For the desk that means nothing wakes it: its host
    // sleeps when idle and only a webhook starts it; a running host still ticks on its own timer, a stopped one does
    // not. An outsider's webhook is its own business - it gets the same event.
    const a = await db().query.agents.findFirst({ where: eq(agents.id, e.agentId), columns: { handle: true, firstParty: true } })
    if (!a?.firstParty) return null
    const d = e.data as { webhook_id?: unknown; url?: unknown; consecutive_failures?: unknown; last_error?: unknown }
    return {
      env: e.env,
      tier: e.env === 'live' ? 'notable' : 'quiet',
      key: `webhook_disabled:${typeof d.webhook_id === 'string' ? d.webhook_id : e.id}`,
      title: `The webhook of ${a.handle} was disabled after repeated failures (${e.env})`,
      body: [
        `${typeof d.url === 'string' ? d.url : 'its receiver'} failed ${typeof d.consecutive_failures === 'number' ? d.consecutive_failures : 'many'} deliveries in a row, every retry included (last error: ${typeof d.last_error === 'string' ? d.last_error : 'unknown'}).`,
        '',
        'Nothing re-enables it. Until the identity registers a new webhook it learns of nothing by push: for the desk that means no wake-up on a delivery, a proposal or its own schedule while its host is stopped. Open the desk health page: a stopped host starts on that request and re-registers its webhook at start; a running one replaces it on its next timer tick. If the page does not answer, the host is the problem, not the webhook.',
      ].join('\n'),
      url: `${base()}/v1/admin/overview`,
      // receiver_url, not url: dataOf() writes the alert's own link into data.url
      data: { agent: a.handle, env: e.env, webhook_id: d.webhook_id ?? null, receiver_url: d.url ?? null, consecutive_failures: d.consecutive_failures ?? null },
    }
  }
  if (e.type === 'job.refund_due' && typeof jobId === 'string') {
    const f = await factsFor(jobId, false)
    if (!f) return null
    return {
      env: f.job.env,
      tier: 'notable',
      // a fresh cycle (a second obligation after a settled refund, ADR-57) is a new fact, so it gets its own key
      key: `refund_due:${jobId}${typeof (e.data as { previous_refund_settlement_id?: unknown })?.previous_refund_settlement_id === 'string' ? ':' + (e.data as { previous_refund_settlement_id: string }).previous_refund_settlement_id : ''}`,
      title: `A refund is owed and shows publicly until it is settled (${f.job.env})`,
      body: [jobLine(f), '', 'The platform never holds the money, so nothing here can force it back. If the seller is one of ours, it is ours to pay.'].join('\n'),
      url: `${base()}/v1/admin/overview`,
      data: { job_id: jobId, env: f.job.env, seller: f.seller?.handle, refund_expected: f.job.refundExpected },
    }
  }
  return null
}

/**
 * ADR-48/49: an x402 purchase, raised by the endpoint itself rather than by an event, because the whole
 * transaction happens inside one HTTP request and its point is precisely that somebody outside paid.
 */
export async function raiseX402Purchase(input: { env: Env; jobId: string; listingTitle: string; amount: number; payer: string; transaction: string; firstBuy: boolean }, now = Date.now()): Promise<string | null> {
  // ADR-66: a buyer's fourth payment of the day goes into the slot line the classifier just wrote, not into a row of its own
  const facts = await factsFor(input.jobId, true)
  const again = facts ? await repeatPayment(facts, 'x402') : null
  if (again) return raise(again, now, { upgrade: true })
  const tx = explorerTxUrl(networkFor(input.env), input.transaction)
  // The SAME key the classifier used for this payment, so the two paths produce one alert and not two: the
  // payment already went through payJob, which emitted job.paid, which wrote `paid:<job>`. This upgrades that
  // row with the one thing only the endpoint knows - that the purchase came in without an account at all.
  return raise(
    {
      env: input.env,
      tier: 'notable',
      key: `paid:${input.jobId}`,
      title: `x402: ${formatUsdc(input.amount)} paid for "${input.listingTitle}" (${input.env})`,
      body: [
        `An agent paid through POST /v1/x402/{listing_id} without an account and without ETH${input.firstBuy ? ', and this wallet was handed its own account for the first time' : ''}.`,
        'It cannot move between_outsiders - we are the seller by construction - and it does answer the question behind it: an agent out there pays for something.',
        '',
        `payer: ${input.payer}`,
        `job: ${base()}/v1/jobs/${input.jobId}`,
      ].join('\n'),
      url: tx,
      data: { job_id: input.jobId, env: input.env, amount: input.amount, payers: [input.payer.toLowerCase()], transaction: input.transaction, first_buy: input.firstBuy, via: 'x402' },
    },
    now,
    { upgrade: true },
  )
}

/**
 * A purchase that came in with a signed authorization and did not go through: a refused authorization, an input
 * the platform or the seller would not take, a seller that did not deliver in time. Nothing was charged, and that
 * is exactly why nobody used to hear about it - on 2026-09-16 a wallet holding 4.76 USDC was turned away at 12:08
 * UTC and the only trace was a day counter. One row per wallet and hour, kept up to date with the latest attempt,
 * so a client retrying in a loop is one line and not sixty.
 */
export async function raiseX402Failure(input: { env: Env; payer: string | null; listingTitle: string; code: string; status: number; message: string; jobId: string | null }, now = Date.now()): Promise<string | null> {
  const who = input.payer ? input.payer.toLowerCase() : 'unknown-wallet'
  return raise(
    {
      env: input.env,
      tier: input.env === 'live' ? 'notable' : 'quiet',
      key: `x402-failed:${input.env}:${who}:${Math.floor(now / 3_600_000)}`,
      title: `x402: a purchase failed (${input.code}) - "${input.listingTitle.slice(0, 60)}" (${input.env})`,
      body: [
        `A wallet signed a payment for this listing and got HTTP ${input.status} ${input.code}: ${input.message.slice(0, 400)}`,
        'Nothing was charged. A wallet that tried to pay and could not is the most valuable line in this channel: the reason is what to fix.',
        '',
        `payer: ${input.payer ?? 'unknown (the payment header could not be read)'}`,
        input.jobId ? `job: ${base()}/v1/jobs/${input.jobId}` : 'job: none was created',
        `all failed attempts: ${base()}/v1/admin/overview -> x402_failures`,
      ].join('\n'),
      data: { env: input.env, code: input.code, status: input.status, payers: input.payer ? [input.payer.toLowerCase()] : [], job_id: input.jobId, via: 'x402' },
    },
    now,
    { upgrade: true },
  )
}

// --- delivery ------------------------------------------------------------------------------------

async function send(req: ChannelRequest): Promise<{ channel: string; ok: boolean; status?: number; error?: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ALERT_TIMEOUT_MS)
  try {
    const res = await alertFetch(req.url, { ...req.init, signal: controller.signal })
    const ok = res.status >= 200 && res.status < 300
    let error: string | undefined
    if (!ok && res.text) error = (await res.text().catch(() => ''))?.slice(0, 300) || undefined
    return { channel: req.channel, ok, status: res.status, error }
  } catch (e) {
    return { channel: req.channel, ok: false, error: (e as Error).message?.slice(0, 300) ?? 'request failed' }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Deliver what is due. An alert counts as delivered as soon as ONE channel took it - the operator has been
 * reached, and retrying would send the same thing twice through the channel that worked. Every channel's answer
 * is kept on the row either way, so a webhook that has quietly been failing for a week is visible.
 */
export async function deliverAlerts(now = Date.now()): Promise<{ sent: number; retried: number; failed: number; suppressed: number; deferred: number }> {
  // Urgent first, live before sandbox, then oldest. Exempting urgent from the cap is worth nothing if a backlog
  // of ordinary alerts still occupies the twenty slots this pass has: queue position would defeat the exemption.
  const due = await db().query.operatorAlerts.findMany({
    where: and(eq(operatorAlerts.status, 'pending'), lte(operatorAlerts.nextAttemptAt, now)),
    orderBy: [sql`case ${operatorAlerts.tier} when 'urgent' then 0 when 'notable' then 1 else 2 end`, sql`case ${operatorAlerts.env} when 'live' then 0 else 1 end`, asc(operatorAlerts.nextAttemptAt)],
    limit: 20,
  })
  const stats = { sent: 0, retried: 0, failed: 0, suppressed: 0, deferred: 0 }
  // One resolution of "money that came from us" per environment per pass, off the buyer's request path.
  const ourMoney = new Map<Env, Set<string>>()
  const ourWalletsFor = async (env: Env) => {
    if (!ourMoney.has(env)) ourMoney.set(env, await ourFundedWallets(env))
    return ourMoney.get(env)!
  }
  /**
   * The cap has to hold HERE as well as at raise(). raise() only sees what was delivered before the row was
   * written; thirty rows raised inside one minute all pass it, and this loop would then send twenty of them in a
   * single pass. Counted per environment and never applied to an urgent alert, exactly as in raise().
   */
  const cap = config().OPERATOR_ALERT_MAX_PER_HOUR
  const deliveredThisHour = new Map<Env, number>()
  for (const env of ['live', 'test'] as Env[]) {
    const n = await db()
      .select({ n: sql<number>`count(*)` })
      .from(operatorAlerts)
      .where(and(eq(operatorAlerts.env, env), gte(operatorAlerts.sentAt, now - 3600_000), notLike(operatorAlerts.key, 'flood:%')))
    deliveredThisHour.set(env, n[0]?.n ?? 0)
  }
  for (const row of due) {
    if (!bypassesCap(row) && (deliveredThisHour.get(row.env) ?? 0) >= capFor(row, cap)) {
      // Deferred, not discarded - and given up on only after the row has been waiting for hours, so a busy
      // afternoon delays an alert instead of deleting it. The one exception is age, not the cap.
      const tooOld = now - row.createdAt >= ALERT_DEFER_MAX_MS
      await db()
        .update(operatorAlerts)
        .set(
          tooOld
            ? { status: 'suppressed', lastError: SUPPRESSED.cap(cap), updatedAt: now }
            : { nextAttemptAt: now + ALERT_DEFER_MS, lastError: `held back: more than ${cap} alerts delivered in the last hour`, updatedAt: now },
        )
        .where(eq(operatorAlerts.id, row.id))
      if (tooOld) stats.suppressed++
      else {
        stats.deferred++
        await floodSummary(row.env, cap, row, now)
      }
      continue
    }
    const payload: AlertPayload = { tier: row.tier, env: row.env, title: row.title, body: row.body, url: (row.data as { url?: string })?.url ?? null, data: row.data }
    const attempt = row.attempt + 1
    // A payment made with money that came from us is our own traffic wearing someone else's handle. It is held
    // back rather than dropped, so the operator can see what we chose not to send and check the judgement.
    const payers = ((row.data as { payers?: unknown })?.payers ?? []) as string[]
    if (payers.length) {
      const our = await ourWalletsFor(row.env)
      // ANY payer, not every payer - the same clause GET /v1/stats uses (`exists (... payer_address in ours)`,
      // modules/meta/stats.ts). A job paid partly by an outside wallet and partly by ours is excluded from the
      // published figure, so it must not wake anyone either. Two definitions drifting apart is ADR-43.
      if (payers.some((p) => our.has(String(p).toLowerCase()))) {
        await db().update(operatorAlerts).set({ status: 'suppressed', attempt, lastError: SUPPRESSED.ourMoney, updatedAt: now }).where(eq(operatorAlerts.id, row.id))
        stats.suppressed++
        continue
      }
    }
    const reqs = requestsFor(payload)
    if (!reqs.length) {
      await db().update(operatorAlerts).set({ status: 'suppressed', attempt, lastError: SUPPRESSED.noChannel, updatedAt: now }).where(eq(operatorAlerts.id, row.id))
      stats.suppressed++
      continue
    }
    const results = []
    for (const r of reqs) results.push(await send(r))
    if (results.some((r) => r.ok)) {
      await db().update(operatorAlerts).set({ status: 'sent', attempt, results, lastError: results.find((r) => !r.ok)?.error ?? null, sentAt: now, updatedAt: now }).where(eq(operatorAlerts.id, row.id))
      stats.sent++
      // the same definition as the query above: urgent rows and the summary never count against the cap
      if (!bypassesCap(row)) deliveredThisHour.set(row.env, (deliveredThisHour.get(row.env) ?? 0) + 1)
      continue
    }
    // Both halves: the status says whether the URL is wrong or the credential is, the body says why.
    const err = results
      .map((r) => [`${r.channel}:`, r.status ? `HTTP ${r.status}` : null, r.error].filter(Boolean).join(' '))
      .join(' | ')
      .slice(0, 500)
    if (attempt >= ALERT_MAX_ATTEMPTS) {
      await db().update(operatorAlerts).set({ status: 'failed', attempt, results, lastError: err, updatedAt: now }).where(eq(operatorAlerts.id, row.id))
      stats.failed++
    } else {
      await db().update(operatorAlerts).set({ attempt, results, lastError: err, nextAttemptAt: now + ALERT_BACKOFF_MS[attempt - 1]!, updatedAt: now }).where(eq(operatorAlerts.id, row.id))
      stats.retried++
    }
  }
  return stats
}

/** Operator view: what was raised, what got through, what is still stuck. */
export async function recentAlerts(limit = 50) {
  const rows = await db().query.operatorAlerts.findMany({ orderBy: [desc(operatorAlerts.createdAt)], limit })
  return rows.map((r) => ({ id: r.id, env: r.env, tier: r.tier, key: r.key, title: r.title, status: r.status, attempt: r.attempt, results: r.results ?? [], last_error: r.lastError, sent_at: r.sentAt ? new Date(r.sentAt).toISOString() : null, created_at: new Date(r.createdAt).toISOString() }))
}

export async function alertsStatus(now = Date.now()) {
  const rows = await db().select({ status: operatorAlerts.status, lastError: operatorAlerts.lastError }).from(operatorAlerts).where(gte(operatorAlerts.createdAt, now - 7 * 86_400_000))
  // Three different endings used to share the one number `suppressed`: "that was our own money" (an answer),
  // "no channel configured" (a setting) and "held back by the cap for six hours and given up on" (a failure). On
  // the overview, which shows the summary without the rows, the failure was indistinguishable from the answer.
  const last7: Record<string, number> = {}
  for (const r of rows) {
    const e = r.lastError ?? ''
    const k = r.status !== 'suppressed' ? r.status : e.startsWith('held back by the') ? 'given_up_after_cap' : e === SUPPRESSED.noChannel ? 'suppressed_no_channel' : e === SUPPRESSED.ourMoney ? 'suppressed_our_money' : 'suppressed_other'
    last7[k] = (last7[k] ?? 0) + 1
  }
  return { channels: channelStatus(), last_7_days: last7 }
}

// --- wiring --------------------------------------------------------------------------------------

onEvent(async (e) => {
  try {
    const draft = await classify(e)
    if (draft) await raise(draft, e.createdAt, { upgrade: draft.upgrade })
  } catch (err) {
    log.warn({ err, type: e.type }, 'operator alert classification failed')
  }
})

registerSweep('operator-alerts', async (now) => {
  await deliverAlerts(now)
})
