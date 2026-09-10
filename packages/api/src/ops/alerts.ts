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

/**
 * Waits BETWEEN attempts, so there is one more attempt than there are waits. Setting MAX_ATTEMPTS to the length
 * of this table made the last entry unreachable: the row was failed at attempt 4 before the 30-minute wait was
 * ever read, and the retry window was 6m15s while the table said 36 minutes. A channel that is down for a
 * quarter of an hour - a deploy, a webhook rotation - is exactly the case the long tail is for.
 */
export const ALERT_BACKOFF_MS = [15_000, 60_000, 5 * 60_000, 30 * 60_000]
export const ALERT_MAX_ATTEMPTS = ALERT_BACKOFF_MS.length + 1
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
  if (draft.tier !== 'urgent') {
    const delivered = await db()
      .select({ n: sql<number>`count(*)` })
      .from(operatorAlerts)
      .where(and(eq(operatorAlerts.env, draft.env), gte(operatorAlerts.sentAt, now - 3600_000)))
    flooded = (delivered[0]?.n ?? 0) >= cap
  }
  const id = await insert(draft, flooded ? 'suppressed' : 'pending', now, flooded ? `more than ${cap} alerts delivered in the last hour` : null)
  if (!id && opts.upgrade) return upgradePending(draft, now)
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

const dataOf = (draft: AlertDraft) => ({ ...(draft.data ?? {}), ...(draft.url ? { url: draft.url } : {}) })

async function insert(draft: AlertDraft, status: 'pending' | 'suppressed', now: number, lastError: string | null): Promise<string | null> {
  const id = newId('alert')
  const r = await db()
    .insert(operatorAlerts)
    .values({ id, env: draft.env, tier: draft.tier, key: draft.key, title: draft.title, body: draft.body, data: dataOf(draft), status, attempt: 0, nextAttemptAt: now, lastError, createdAt: now, updatedAt: now })
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

/** An order placed with us on neither side: no money yet, and still the widest mouth of the funnel (ADR-46). */
export function classifyOrder(f: JobFacts): AlertDraft | null {
  if (f.job.firstPartyInvolved !== false && !(f.seller?.firstParty && !f.buyer?.firstParty)) return null
  const outsiders = f.job.firstPartyInvolved === false
  return {
    env: f.job.env,
    // An order with us on neither side is `between_outsiders.orders`, which on live has been 0 for the whole
    // history of this marketplace. The first one is news, so it must not sit below the default minimum tier.
    // An order placed with our own desk is ordinary traffic and stays quiet.
    tier: outsiders ? 'notable' : 'quiet',
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
    const f = await factsFor(jobId, true)
    return f ? classifyPayment(f) : null
  }
  if (e.type === 'job.created' && typeof jobId === 'string') {
    const f = await factsFor(jobId, false)
    return f ? classifyOrder(f) : null
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
      data: { job_id: jobId, env: f.job.env, reason: f.job.disputeReason },
    }
  }
  if (e.type === 'job.refund_due' && typeof jobId === 'string') {
    const f = await factsFor(jobId, false)
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
export async function deliverAlerts(now = Date.now()): Promise<{ sent: number; retried: number; failed: number; suppressed: number }> {
  const due = await db().query.operatorAlerts.findMany({ where: and(eq(operatorAlerts.status, 'pending'), lte(operatorAlerts.nextAttemptAt, now)), orderBy: [asc(operatorAlerts.nextAttemptAt)], limit: 20 })
  const stats = { sent: 0, retried: 0, failed: 0, suppressed: 0 }
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
      .where(and(eq(operatorAlerts.env, env), gte(operatorAlerts.sentAt, now - 3600_000)))
    deliveredThisHour.set(env, n[0]?.n ?? 0)
  }
  for (const row of due) {
    if (row.tier !== 'urgent' && (deliveredThisHour.get(row.env) ?? 0) >= cap) {
      await db().update(operatorAlerts).set({ status: 'suppressed', attempt: row.attempt + 1, lastError: `more than ${cap} alerts delivered in the last hour`, updatedAt: now }).where(eq(operatorAlerts.id, row.id))
      stats.suppressed++
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
        await db().update(operatorAlerts).set({ status: 'suppressed', attempt, lastError: 'the paying wallet holds money that came from us (modules/payments/our-money.ts)', updatedAt: now }).where(eq(operatorAlerts.id, row.id))
        stats.suppressed++
        continue
      }
    }
    const reqs = requestsFor(payload)
    if (!reqs.length) {
      await db().update(operatorAlerts).set({ status: 'suppressed', attempt, lastError: 'no channel configured', updatedAt: now }).where(eq(operatorAlerts.id, row.id))
      stats.suppressed++
      continue
    }
    const results = []
    for (const r of reqs) results.push(await send(r))
    if (results.some((r) => r.ok)) {
      await db().update(operatorAlerts).set({ status: 'sent', attempt, results, lastError: results.find((r) => !r.ok)?.error ?? null, sentAt: now, updatedAt: now }).where(eq(operatorAlerts.id, row.id))
      stats.sent++
      deliveredThisHour.set(row.env, (deliveredThisHour.get(row.env) ?? 0) + 1)
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
  try {
    const draft = await classify(e)
    if (draft) await raise(draft, e.createdAt)
  } catch (err) {
    log.warn({ err, type: e.type }, 'operator alert classification failed')
  }
})

registerSweep('operator-alerts', async (now) => {
  await deliverAlerts(now)
})
