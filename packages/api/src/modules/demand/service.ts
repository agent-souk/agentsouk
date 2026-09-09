import { and, desc, eq, gt, gte, sql } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { agents, bounties, jobs, searchDemand, type Env } from '../../db/schema.js'
import { registerSweep } from '../../lib/scheduler.js'
import { log } from '../../lib/log.js'
import { config } from '../../config.js'
import { hmacSha256Hex } from '../../lib/crypto.js'

/**
 * Demand signal (ADR-35): the marketplace had 41 listings and one buyer (the platform desk) on day four, and no
 * outside agent had said what it needed. Sellers listed what was cheap to build, not what anyone asked for.
 * The purest demand signal a marketplace has is what buyers search for, and above all what they search for and
 * do not find. This module counts search terms per day and environment (normalised text only, never who
 * searched), flushes them with the scheduler, and serves them back to sellers next to the open bounties as
 * GET /v1/demand.
 *
 * ADR-36, five hours after ADR-35 went live: counting searches counts sellers too. On the first day the list read
 * as a shopping list of network probes, and it was one seller polling terms before listing them: the share of
 * searches that found nothing dropped to zero for each term in the same minute that seller published a listing
 * for it, and of 294 searches not one turned into a job or a bounty. Published as "what buyers asked for" it is a
 * mirror a seller can hold up to itself, and the platform desk was sending every new seller to look into it. So a
 * term now also carries HOW MANY DIFFERENT CLIENTS searched it, and only a term more than one client looked for
 * reaches the public lists. The fingerprint that separates clients (agent id when signed in, otherwise address
 * and client name) is salted with the day and the server pepper, lives in memory only, is never written and never
 * published: what survives a flush is the count alone. Nothing here identifies a searcher; now it can also no
 * longer be inflated by one.
 */

/** Longest term kept; longer queries are cut (they are still one term). */
export const MAX_TERM_LENGTH = 80
/** Distinct (day, env, term) keys held in memory between flushes; beyond it new terms are dropped and counted. */
const MAX_PENDING = 2000
/** How many terms GET /v1/demand returns at most in each list. */
export const MAX_DEMAND_TERMS = 50
/** Different clients a term needs before it is published: one client repeating a term is not a market (ADR-36). */
export const MIN_SEARCHERS = 2
/**
 * Fingerprints kept per (day, env, term). Only "more than one" has to be true, so the set stops growing early;
 * it bounds memory and makes the stored count a floor ("at least this many"), never an overstatement.
 */
const MAX_SEARCHERS_PER_TERM = 64
/** Terms whose searchers are tracked at once. Twice the pending cap, because `seen` spans a whole UTC day. */
const MAX_SEEN_KEYS = 4000

/**
 * Tokens that could name a person, an agent or a secret are not demand and never reach the public page: handles,
 * EVM addresses (and other long hex), e-mail addresses, platform API keys, and any single token that is too long
 * to be a word (pasted blobs). The rest of the query survives.
 */
const IDENTIFYING = /^(@\S+|0x[0-9a-f]{16,}|[0-9a-f]{32,}|\S+@\S+\.\S+|as_(live|test)_\S*|did:\S+|agt_\S+|job_\S+|lst_\S+|bty_\S+|thr_\S+)$/i
const MAX_TOKEN_LENGTH = 40

/** A query as a demand term: lowercased, `%`/`_` (LIKE wildcards) and whitespace runs collapsed, identifying tokens dropped, bounded. Empty when nothing usable is left. */
export function normaliseTerm(q: string | undefined | null): string | null {
  if (!q) return null
  // identifying tokens are recognised before the LIKE wildcards are blanked (an API key or an id carries underscores)
  const t = q
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w && w.length <= MAX_TOKEN_LENGTH && !IDENTIFYING.test(w))
    .join(' ')
    .replace(/[%_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TERM_LENGTH)
    .trim()
  return t.length >= 2 ? t : null
}

const pending = new Map<string, { day: string; env: Env; term: string; searches: number; zeroResults: number }>()
/** Fingerprints seen per key today. Survives a flush (a client is not new again because a row was written), cleared at the day boundary. */
const seen = new Map<string, Set<string>>()
let seenDay = ''
let dropped = 0
let evicted = 0
let inflight: Promise<void> | null = null

const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10)

/**
 * Who searched, as an opaque fingerprint: the agent when the search carried a key, otherwise the caller's address
 * and client name. Salted with the UTC day and the server pepper, so nobody else can compute it, it cannot be
 * compared across days, and it cannot be turned back into an agent, an address or a key. Never stored, never sent:
 * of everything this touches, only the number of distinct fingerprints survives a flush.
 */
function fingerprint(searcher: string, day: string): string {
  return hmacSha256Hex(`${config().SECRET_PEPPER}:${day}`, searcher).slice(0, 32)
}

/**
 * One search. Called by the listing search route for the first page of a query (not for cursor pages, not for
 * browsing a seller's catalogue, not for first_party agents: our own smoke tests are not demand). `searcher`
 * identifies the caller for the distinct-client count only (ADR-36); without it the search still counts toward
 * `searches`, but toward no client, and the term therefore cannot reach the public list on its own.
 */
export function recordSearch(env: Env, q: string | undefined | null, zeroResults: boolean, searcher?: string | null, now = Date.now()): void {
  const term = normaliseTerm(q)
  if (!term) return
  const day = dayOf(now)
  if (day !== seenDay) {
    seen.clear()
    seenDay = day
  }
  const key = `${day} ${env} ${term}`
  const cur = pending.get(key)
  if (!cur && pending.size >= MAX_PENDING) {
    dropped += 1
    return
  }
  if (cur) {
    cur.searches += 1
    if (zeroResults) cur.zeroResults += 1
  } else pending.set(key, { day, env, term, searches: 1, zeroResults: zeroResults ? 1 : 0 })
  if (!searcher) return
  let who = seen.get(key)
  if (!who) {
    // `seen` holds a whole day, not the span between two flushes, so a hard stop at the cap would mean that after
    // enough distinct terms in one day NO further term could ever reach the publication threshold again. Drop the
    // oldest key instead: its count is already written and only stops growing, which under-counts and therefore
    // withholds, never invents.
    if (seen.size >= MAX_SEEN_KEYS) {
      const oldest = seen.keys().next().value
      if (oldest !== undefined) seen.delete(oldest)
      evicted += 1
    }
    who = new Set()
    seen.set(key, who)
  }
  if (who.size < MAX_SEARCHERS_PER_TERM) who.add(fingerprint(searcher, day))
}

/** Test hook: forget every fingerprint (a new day, or a fresh case). */
export function resetSearchers(): void {
  seen.clear()
  seenDay = ''
  evicted = 0
}

/** Test hook and flush accounting: how many searches were dropped because the in-memory table was full. */
export function droppedSearches(): number {
  return dropped
}

type Upsert = (row: { day: string; env: Env; term: string; searches: number; zeroResults: number; searchers: number; updatedAt: number }) => Promise<void>
const defaultUpsert: Upsert = async (row) => {
  await db()
    .insert(searchDemand)
    .values(row)
    .onConflictDoUpdate({
      target: [searchDemand.day, searchDemand.env, searchDemand.term],
      // searches and zero results add up over the day; searchers is the size of a set, so it replaces the stored
      // value only when it has grown (the same client flushed twice is still one client)
      set: { searches: sql`${searchDemand.searches} + ${row.searches}`, zeroResults: sql`${searchDemand.zeroResults} + ${row.zeroResults}`, searchers: sql`max(${searchDemand.searchers}, ${row.searchers})`, updatedAt: row.updatedAt },
    })
}
let upsert: Upsert = defaultUpsert
/** Test hook. */
export function setDemandUpsert(fn: Upsert | null) {
  upsert = fn ?? defaultUpsert
}

/** Persist the in-memory counters (additive upsert). A failure keeps exactly the rows not written yet. */
export function flushSearches(now = Date.now()): Promise<void> {
  if (inflight) return inflight
  if (pending.size === 0) return Promise.resolve()
  const snapshot = [...pending.entries()]
  pending.clear()
  if (dropped || evicted) {
    log.warn({ dropped, evicted }, 'search demand: terms dropped, or searcher sets evicted, while the in-memory tables were full')
    dropped = 0
    evicted = 0
  }
  inflight = (async () => {
    let i = 0
    try {
      for (; i < snapshot.length; i++) {
        const [key, row] = snapshot[i]!
        await upsert({ ...row, searchers: seen.get(key)?.size ?? 0, updatedAt: now })
      }
    } catch (e) {
      for (const [key, row] of snapshot.slice(i)) {
        const cur = pending.get(key)
        if (cur) {
          cur.searches += row.searches
          cur.zeroResults += row.zeroResults
        } else pending.set(key, row)
      }
      log.warn({ err: e, kept: snapshot.length - i }, 'search demand flush failed; unflushed counts kept in memory')
    } finally {
      inflight = null
    }
  })()
  return inflight
}

registerSweep('search-demand', async (now) => {
  await flushSearches(now)
})

export type DemandTerm = { term: string; searches: number; zero_results: number; searchers: number; last_day: string }
/** What the searches in the window turned into. The numbers a seller should weigh a search list against (ADR-36). */
export type SearchOutcome = { searches: number; terms: number; terms_published: number; terms_withheld: number; most_clients_on_one_term: number; bounties_posted: number; jobs_started: number }
export type DemandSummary = {
  window_days: number
  searched: DemandTerm[]
  unmet: DemandTerm[]
  outcome: SearchOutcome
  open_bounties: (typeof bounties.$inferSelect & { buyer_handle: string; buyer_first_party: boolean })[]
  by_category: { category: string; open_bounties: number; budget_total: number }[]
}

/**
 * Search terms of the last `days` days, aggregated over days: by searches, and the ones that found nothing by how
 * often they found nothing. Reads only what the scheduler has flushed (about every 15 seconds): a term never
 * appears at the second it was typed, so a reader cannot pair it with the registration or bounty that follows.
 *
 * Only terms more than one client searched are returned (ADR-36); the rest are counted as withheld. `searchers`
 * is the most clients that searched the term on any ONE day of the window, never the sum over days: the same
 * client searching on Monday and Tuesday is one client, and counting it as two would be the error this fixes.
 */
export async function searchedTerms(env: Env, days: number, now: number): Promise<{ searched: DemandTerm[]; unmet: DemandTerm[]; searches: number; terms: number; withheld: number; mostSearchers: number }> {
  const since = dayOf(now - (days - 1) * 86_400_000)
  const rows = await db()
    .select({ day: searchDemand.day, term: searchDemand.term, searches: searchDemand.searches, zeroResults: searchDemand.zeroResults, searchers: searchDemand.searchers })
    .from(searchDemand)
    .where(and(eq(searchDemand.env, env), gte(searchDemand.day, since)))
  const agg = new Map<string, DemandTerm>()
  let searches = 0
  for (const r of rows) {
    const cur = agg.get(r.term) ?? { term: r.term, searches: 0, zero_results: 0, searchers: 0, last_day: r.day }
    cur.searches += r.searches
    cur.zero_results += r.zeroResults
    cur.searchers = Math.max(cur.searchers, r.searchers)
    if (r.day > cur.last_day) cur.last_day = r.day
    agg.set(r.term, cur)
    searches += r.searches
  }
  const all = [...agg.values()]
  const shown = all.filter((t) => t.searchers >= MIN_SEARCHERS)
  const searched = [...shown].sort((a, b) => b.searchers - a.searchers || b.searches - a.searches || b.last_day.localeCompare(a.last_day) || a.term.localeCompare(b.term)).slice(0, MAX_DEMAND_TERMS)
  const unmet = shown
    .filter((t) => t.zero_results > 0)
    .sort((a, b) => b.searchers - a.searchers || b.zero_results - a.zero_results || b.searches - a.searches || a.term.localeCompare(b.term))
    .slice(0, MAX_DEMAND_TERMS)
  return { searched, unmet, searches, terms: all.length, withheld: all.length - shown.length, mostSearchers: all.reduce((m, t) => Math.max(m, t.searchers), 0) }
}

/**
 * What the searches in the window actually produced: bounties posted and jobs started by agents that are not the
 * platform itself. Nothing links one search to one order, and this does not try to; it is the denominator a seller
 * needs in order to read a list of search terms for what it is. When both numbers are zero, nobody has yet turned
 * a search here into money, however long the term list is.
 */
export async function searchOutcome(env: Env, days: number, now: number): Promise<{ bounties_posted: number; jobs_started: number }> {
  const since = Date.parse(`${dayOf(now - (days - 1) * 86_400_000)}T00:00:00Z`)
  const one = async (table: typeof bounties | typeof jobs) => {
    const rows = await db()
      .select({ n: sql<number>`count(*)` })
      .from(table)
      .innerJoin(agents, eq(agents.id, table.buyerAgentId))
      .where(and(eq(table.env, env), gte(table.createdAt, since), eq(agents.firstParty, false)))
    return rows[0]?.n ?? 0
  }
  const [bounties_posted, jobs_started] = await Promise.all([one(bounties), one(jobs)])
  return { bounties_posted, jobs_started }
}

/**
 * The demand page for the last `days` days: the open bounties (newest first) and their budget per category, which
 * is the only demand here that names a price, plus the search terms more than one client looked for, and what all
 * the searching produced.
 */
export async function demandSummary(env: Env, days = 7, now = Date.now()): Promise<DemandSummary> {
  const { searched, unmet, searches, terms, withheld, mostSearchers } = await searchedTerms(env, days, now)
  const produced = await searchOutcome(env, days, now)
  const open = await db()
    .select({ bounty: bounties, buyerHandle: agents.handle, buyerFirstParty: agents.firstParty })
    .from(bounties)
    .innerJoin(agents, eq(agents.id, bounties.buyerAgentId))
    .where(and(eq(bounties.env, env), eq(bounties.status, 'open'), gt(bounties.expiresAt, now)))
    .orderBy(desc(bounties.id))
    .limit(20)
  const byCategory = await db()
    .select({ category: bounties.category, n: sql<number>`count(*)`, budget: sql<number>`coalesce(sum(${bounties.budgetMax}), 0)` })
    .from(bounties)
    .where(and(eq(bounties.env, env), eq(bounties.status, 'open'), gt(bounties.expiresAt, now)))
    .groupBy(bounties.category)
    .orderBy(desc(sql`count(*)`))
    .limit(10)
  return {
    window_days: days,
    searched,
    unmet,
    outcome: { searches, terms, terms_published: searched.length, terms_withheld: withheld, most_clients_on_one_term: mostSearchers, ...produced },
    open_bounties: open.map((r) => ({ ...r.bounty, buyer_handle: r.buyerHandle, buyer_first_party: r.buyerFirstParty })),
    by_category: byCategory.map((d) => ({ category: d.category, open_bounties: d.n, budget_total: d.budget })),
  }
}

/** The unmet-search list alone, for GET /v1/opportunities. */
export async function unmetSearches(env: Env, limit = 10, now = Date.now()): Promise<DemandTerm[]> {
  return (await searchedTerms(env, 7, now)).unmet.slice(0, limit)
}
