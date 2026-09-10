import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { agents, jobs, operatorAlerts, settlements, type AlertTier, type Env } from '../db/schema.js'
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

export const ALERT_BACKOFF_MS = [15_000, 60_000, 5 * 60_000, 30 * 60_000]
export const ALERT_MAX_ATTEMPTS = ALERT_BACKOFF_MS.length
export const ALERT_TIMEOUT_MS = 10_000

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
 */
export async function raise(draft: AlertDraft, now = Date.now()): Promise<string | null> {
  if (!channelStatus().configured || !tierWanted(draft.tier)) return null
  const cap = config().OPERATOR_ALERT_MAX_PER_HOUR
  const recent = await db()
    .select({ n: sql<number>`count(*)` })
    .from(operatorAlerts)
    .where(and(gte(operatorAlerts.createdAt, now - 3600_000), inArray(operatorAlerts.status, ['pending', 'sent'])))
  const flooded = (recent[0]?.n ?? 0) >= cap
  const id = await insert(draft, flooded ? 'suppressed' : 'pending', now, flooded ? `more than ${cap} alerts in the last hour` : null)
  if (flooded) {
    // One summary an hour, never more: the operator learns that alerts are being held back rather than reading
    // silence as calm. It bypasses the cap by construction, because its key is the hour itself.
    await insert(
      {
        env: draft.env,
        tier: 'notable',
        key: `flood:${hourBucket(now)}`,
        title: `More than ${cap} alerts in one hour - the rest are being held back`,
        body: `Alerts beyond ${cap} an hour are recorded but not delivered. Read them with GET ${config().PUBLIC_BASE_URL.replace(/\/$/, '')}/v1/admin/alerts (header X-Admin-Token), and raise OPERATOR_ALERT_MAX_PER_HOUR if this is normal traffic now.`,
        data: { cap, first_suppressed: draft.key },
      },
      'pending',
      now,
      null,
    )
  }
  return id
}

async function insert(draft: AlertDraft, status: 'pending' | 'suppressed', now: number, lastError: string | null): Promise<string | null> {
  const id = newId('alert')
  const r = await db()
    .insert(operatorAlerts)
    .values({ id, env: draft.env, tier: draft.tier, key: draft.key, title: draft.title, body: draft.body, data: { ...(draft.data ?? {}), ...(draft.url ? { url: draft.url } : {}) }, status, attempt: 0, nextAttemptAt: now, lastError, createdAt: now, updatedAt: now })
    .onConflictDoNothing({ target: operatorAlerts.key })
  return (r.rowsAffected ?? 0) > 0 ? id : null
}

// --- what is worth an alert ---------------------------------------------------------------------

const base = () => config().PUBLIC_BASE_URL.replace(/\/$/, '')

type JobFacts = {
  job: typeof jobs.$inferSelect
  buyer: { handle: string; firstParty: boolean; walletAddress: string | null } | null
  seller: { handle: string; firstParty: boolean; walletAddress: string | null } | null
  paid: number
  payer: string | null
  transaction: string | null
  ourMoney: boolean
}

async function factsFor(jobId: string): Promise<JobFacts | null> {
  const job = await db().query.jobs.findFirst({ where: eq(jobs.id, jobId) })
  if (!job) return null
  const parties = await db().query.agents.findMany({ where: inArray(agents.id, [job.buyerAgentId, job.sellerAgentId]), columns: { id: true, handle: true, firstParty: true, walletAddress: true } })
  const of = (id: string) => parties.find((a) => a.id === id) ?? null
  const pays = await db().query.settlements.findMany({ where: and(eq(settlements.jobId, job.id), eq(settlements.kind, 'payment'), eq(settlements.status, 'settled')) })
  const paid = pays.reduce((sum, s) => sum + s.amount, 0)
  const our = pays.length ? await ourFundedWallets(job.env) : new Set<string>()
  return {
    job,
    buyer: of(job.buyerAgentId),
    seller: of(job.sellerAgentId),
    paid,
    payer: pays[0]?.payerAddress ?? null,
    transaction: pays[pays.length - 1]?.transaction ?? null,
    ourMoney: pays.some((s) => our.has(s.payerAddress.toLowerCase())),
  }
}

const jobLine = (f: JobFacts) => `${f.buyer?.handle ?? f.job.buyerAgentId} → ${f.seller?.handle ?? f.job.sellerAgentId} · ${f.job.title} · ${formatUsdc(f.job.price)}`

/**
 * A settled payment. Urgent only under exactly the rule the published figure uses; a payment to one of our own
 * desks is worth knowing but is not the thing we are waiting for, and it says so in the alert itself.
 */
export function classifyPayment(f: JobFacts): AlertDraft | null {
  const outsiders = f.job.firstPartyInvolved === false && f.paid >= OUTSIDER_PRICE_FLOOR && !f.ourMoney
  const tx = explorerTxUrl(networkFor(f.job.env), f.transaction)
  const common = { env: f.job.env, key: `paid:${f.job.id}`, url: tx ?? `${base()}/v1/jobs/${f.job.id}`, data: { job_id: f.job.id, env: f.job.env, amount: f.paid, buyer: f.buyer?.handle, seller: f.seller?.handle, payer: f.payer, transaction: f.transaction, first_party_involved: f.job.firstPartyInvolved, our_money: f.ourMoney } }
  if (outsiders) {
    return {
      ...common,
      tier: 'urgent',
      title: `${formatUsdc(f.paid)} paid between two outsiders (${f.job.env})`,
      body: [
        jobLine(f),
        '',
        'This is the figure the whole thing is measured by: a payment with Agent Souk on neither side, above the price floor, from a wallet that never held our money. Before believing it, read GET /v1/stats between_outsiders and its `excluded` block - the alert applies the same rule, but the figure is the one that counts.',
        f.payer ? `payer wallet: ${f.payer}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    }
  }
  if (f.seller?.firstParty && !f.buyer?.firstParty && !f.ourMoney && f.paid >= OUTSIDER_PRICE_FLOOR) {
    return {
      ...common,
      tier: 'notable',
      title: `${formatUsdc(f.paid)} paid to us by an outside agent (${f.job.env})`,
      body: [jobLine(f), '', 'Someone outside paid one of OUR listings with their own money. It cannot move between_outsiders (we are one of the two parties by construction) and it does answer the question behind it: an agent out there pays for something.', f.payer ? `payer wallet: ${f.payer}` : ''].filter(Boolean).join('\n'),
    }
  }
  return null
}

/** An order placed with us on neither side: no money yet, and still the widest mouth of the funnel (ADR-46). */
export function classifyOrder(f: JobFacts): AlertDraft | null {
  if (f.job.firstPartyInvolved !== false && !(f.seller?.firstParty && !f.buyer?.firstParty)) return null
  const outsiders = f.job.firstPartyInvolved === false
  return {
    env: f.job.env,
    tier: 'quiet',
    key: `ordered:${f.job.id}`,
    title: outsiders ? `An outsider ordered from an outsider (${f.job.env})` : `An outside agent ordered from us (${f.job.env})`,
    body: [jobLine(f), '', outsiders ? 'Nothing has been paid. Ordering is free, so this is an upper bound on independent interest, not demand - GET /v1/commitments says as much next to the figure.' : 'Nothing has been paid yet; the desk delivers first.'].join('\n'),
    url: `${base()}/v1/jobs/${f.job.id}`,
    data: { job_id: f.job.id, env: f.job.env, buyer: f.buyer?.handle, seller: f.seller?.handle, price: f.job.price, first_party_involved: f.job.firstPartyInvolved },
  }
}

/** Turn one platform event into an alert, or nothing. Everything our own identities did to themselves is nothing. */
export async function classify(e: EventRecord): Promise<AlertDraft | null> {
  const jobId = (e.data as { job_id?: unknown })?.job_id
  if (e.type === 'job.paid' && typeof jobId === 'string') {
    const f = await factsFor(jobId)
    return f ? classifyPayment(f) : null
  }
  if (e.type === 'job.created' && typeof jobId === 'string') {
    const f = await factsFor(jobId)
    return f ? classifyOrder(f) : null
  }
  if ((e.type === 'job.disputed' || e.type === 'dispute.escalated') && typeof jobId === 'string') {
    const f = await factsFor(jobId)
    if (!f) return null
    const escalated = e.type === 'dispute.escalated'
    return {
      env: f.job.env,
      tier: 'notable',
      key: `${escalated ? 'escalated' : 'disputed'}:${jobId}`,
      title: escalated ? `A dispute needs the operator (${f.job.env})` : `A job was disputed (${f.job.env})`,
      body: [jobLine(f), '', escalated ? `The evaluator panel could not decide it. Resolve with POST ${base()}/v1/admin/jobs/${jobId}/resolve.` : 'A panel of evaluator agents is voting; nothing to do unless it escalates.'].join('\n'),
      url: `${base()}/v1/admin/overview`,
      data: { job_id: jobId, env: f.job.env, reason: f.job.disputeReason },
    }
  }
  if (e.type === 'job.refund_due' && typeof jobId === 'string') {
    const f = await factsFor(jobId)
    if (!f) return null
    return {
      env: f.job.env,
      tier: 'notable',
      key: `refund_due:${jobId}`,
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
  const our = await ourFundedWallets(input.env)
  const ours = our.has(input.payer.toLowerCase())
  const tx = explorerTxUrl(networkFor(input.env), input.transaction)
  return raise(
    {
      env: input.env,
      tier: input.env === 'live' && !ours ? 'urgent' : 'notable',
      key: `x402:${input.jobId}`,
      title: `x402: ${formatUsdc(input.amount)} paid for "${input.listingTitle}" (${input.env})`,
      body: [
        `An agent paid through POST /v1/x402/{listing_id} without an account and without ETH${input.firstBuy ? ', and this wallet was handed its own account for the first time' : ''}.`,
        ours ? 'The paying wallet held money that came from us, so this is our own traffic and proves nothing about outside demand.' : 'The paying wallet never held our money. It cannot move between_outsiders (we are the seller by construction), and it does answer the question behind it.',
        '',
        `payer: ${input.payer}`,
        `job: ${base()}/v1/jobs/${input.jobId}`,
      ].join('\n'),
      url: tx,
      data: { job_id: input.jobId, env: input.env, amount: input.amount, payer: input.payer, transaction: input.transaction, our_money: ours, first_buy: input.firstBuy },
    },
    now,
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
export async function deliverPending(now = Date.now()): Promise<{ sent: number; retried: number; failed: number }> {
  const due = await db().query.operatorAlerts.findMany({ where: and(eq(operatorAlerts.status, 'pending'), lte(operatorAlerts.nextAttemptAt, now)), orderBy: [asc(operatorAlerts.nextAttemptAt)], limit: 20 })
  const stats = { sent: 0, retried: 0, failed: 0 }
  for (const row of due) {
    const payload: AlertPayload = { tier: row.tier, env: row.env, title: row.title, body: row.body, url: (row.data as { url?: string })?.url ?? null, data: row.data }
    const reqs = requestsFor(payload)
    const attempt = row.attempt + 1
    if (!reqs.length) {
      await db().update(operatorAlerts).set({ status: 'suppressed', attempt, lastError: 'no channel configured', updatedAt: now }).where(eq(operatorAlerts.id, row.id))
      stats.failed++
      continue
    }
    const results = []
    for (const r of reqs) results.push(await send(r))
    if (results.some((r) => r.ok)) {
      await db().update(operatorAlerts).set({ status: 'sent', attempt, results, lastError: results.find((r) => !r.ok)?.error ?? null, sentAt: now, updatedAt: now }).where(eq(operatorAlerts.id, row.id))
      stats.sent++
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
  const rows = await db().select({ status: operatorAlerts.status, n: sql<number>`count(*)` }).from(operatorAlerts).where(gte(operatorAlerts.createdAt, now - 7 * 86_400_000)).groupBy(operatorAlerts.status)
  return { channels: channelStatus(), last_7_days: Object.fromEntries(rows.map((r) => [r.status, r.n])) as Record<string, number> }
}

// --- wiring --------------------------------------------------------------------------------------

onEvent(async (e) => {
  if (!channelStatus().configured) return
  try {
    const draft = await classify(e)
    if (draft) await raise(draft, e.createdAt)
  } catch (err) {
    log.warn({ err, type: e.type }, 'operator alert classification failed')
  }
})

registerSweep('operator-alerts', async (now) => {
  if (!channelStatus().configured) return
  await deliverPending(now)
})
