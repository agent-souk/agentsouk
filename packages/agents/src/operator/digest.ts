/**
 * ADR-71: one line a day about the only question that decides whether this platform is worth running - does money
 * come in, and how much goes out. It exists because that question was answered by hand, per session, by reading
 * four different places (the chain, `/v1/stats`, the desk ledger, `/health`), and a figure nobody sees is a figure
 * nobody acts on: the desk paid out ~43 USDC while strangers paid in ~1, and that ratio was clear only after
 * someone went looking.
 *
 * It rides on the operator tick (no new schedule), sends through the operator alert webhook that already exists,
 * and keeps its last snapshot in platform memory so a restart cannot make it send twice or skip a day.
 */
import { formatUsdc } from './usdc.js'

/** What the last report saw, so the next one can report movement rather than levels. */
export type DigestSnapshot = {
  /** UTC date (YYYY-MM-DD) this snapshot was sent on */
  day: string
  earned_usdc: string
  spent_usdc: string
  jobs_completed: number
  outsider_orders: number
}

/** Everything the line is made of, gathered by the caller so this stays testable without a chain or an API. */
export type DigestFacts = {
  /** cumulative USDC ever received by the seller wallet: every x402 purchase, ours and theirs */
  sellerUsdc: bigint
  /** the part of that we paid ourselves - the one CDP settlement per listing that makes Coinbase's Bazaar list it (ADR-65/69) */
  selfPaidUsdc: bigint
  /** what the desk has paid out over its lifetime, and what it is still allowed to */
  deskSpentTotal: bigint
  deskBudget: bigint
  deskUsdc: bigint
  jobsCompleted: number
  outsiderOrders: number
  outsiderJobsCompleted: number
  llmLiveUsd: number
  llmTestUsd: number
}

const delta = (now: bigint, then: bigint | undefined): string => {
  if (then === undefined) return ''
  const d = now - then
  return ` (${d >= 0n ? '+' : '-'}${formatUsdc(d < 0n ? -d : d).replace(' USDC', '')})`
}
const deltaN = (now: number, then: number | undefined): string => (then === undefined ? '' : ` (${now - then >= 0 ? '+' : ''}${now - then})`)

/**
 * The report. Deliberately one block of plain text: it goes to a phone, and the numbers that matter are the two
 * money lines. `from others` is cumulative on purpose - the seller wallet is never emptied, so its balance minus
 * what we paid into it ourselves IS the lifetime income, and the delta against yesterday is the day's takings.
 * Still inside that figure: payments from wallets the desk had funded (veriton, ADR-56/63: 0.012 USDC so far);
 * the platform applies that rule in /v1/stats, the wallet cannot.
 */
export function digestText(f: DigestFacts, prev: DigestSnapshot | null): string {
  const prevEarned = prev ? BigInt(prev.earned_usdc) : undefined
  const prevSpent = prev ? BigInt(prev.spent_usdc) : undefined
  const lines = [
    `Agent Souk, ${new Date().toISOString().slice(0, 10)}`,
    `in:    ${formatUsdc(f.sellerUsdc - f.selfPaidUsdc)} from others ever${delta(f.sellerUsdc - f.selfPaidUsdc, prevEarned)} (wallet ${formatUsdc(f.sellerUsdc)}, ${formatUsdc(f.selfPaidUsdc)} of it our own catalogue payments)`,
    `out:   ${formatUsdc(f.deskSpentTotal)} desk spend ever${delta(f.deskSpentTotal, prevSpent)} of ${formatUsdc(f.deskBudget)} budget`,
    `model: ${f.llmLiveUsd.toFixed(4)} USD live today, ${f.llmTestUsd.toFixed(4)} sandbox`,
    `jobs:  ${f.jobsCompleted} delivered${deltaN(f.jobsCompleted, prev?.jobs_completed)}`,
    `other: ${f.outsiderOrders} orders between outsiders${deltaN(f.outsiderOrders, prev?.outsider_orders)}, ${f.outsiderJobsCompleted} completed`,
    `left:  ${formatUsdc(f.deskUsdc)} in the desk wallet`,
  ]
  if (!prev) lines.push('(first report: no movement to compare yet)')
  return lines.join('\n')
}

export function snapshotOf(f: DigestFacts, day: string): DigestSnapshot {
  return { day, earned_usdc: (f.sellerUsdc - f.selfPaidUsdc).toString(), spent_usdc: f.deskSpentTotal.toString(), jobs_completed: f.jobsCompleted, outsider_orders: f.outsiderOrders }
}

export type DigestDeps = {
  store: { load(): Promise<DigestSnapshot | null>; save(v: DigestSnapshot): Promise<void> }
  facts: () => Promise<DigestFacts>
  send: (text: string) => Promise<void>
  now?: () => number
  log?: (msg: string, extra?: Record<string, unknown>) => void
}

/**
 * Sends today's report unless it has already gone out. The snapshot is written only after a successful send, so a
 * failed webhook is retried on the next tick instead of being silently skipped for the day - and the day is the
 * UTC date, because every other counter in this codebase rolls at 00:00 UTC.
 */
export async function runDailyDigest(deps: DigestDeps): Promise<'sent' | 'already-sent' | 'failed'> {
  const day = new Date(deps.now?.() ?? Date.now()).toISOString().slice(0, 10)
  const prev = await deps.store.load()
  if (prev?.day === day) return 'already-sent'
  const facts = await deps.facts()
  try {
    await deps.send(digestText(facts, prev))
  } catch (e) {
    deps.log?.('daily digest not sent', { error: String(e) })
    return 'failed'
  }
  await deps.store.save(snapshotOf(facts, day))
  deps.log?.('daily digest sent', { day, earned_usdc: (facts.sellerUsdc - facts.selfPaidUsdc).toString(), desk_spent_usdc: facts.deskSpentTotal.toString() })
  return 'sent'
}
