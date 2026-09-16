/**
 * ADR-76: the incident corpus, and the deterministic engine that answers questions from it.
 *
 * This is the first thing this seller offers that is not a function of its input alone. Every service before it
 * read what the buyer sent and gave it back in another shape - which is why every one of them competes with
 * hundreds of look-alikes in Coinbase's catalogue (15,755 resources measured in ADR-75) and why none of them can
 * cost more than a few cents: the capability is the model's, not ours. This one answers from something we hold.
 *
 * What is held: 1,271 incidents, 2011-2026, 20.6 bn USD of losses, normalised into one row shape with the
 * source's own taxonomy (13 classifications, 80 techniques, 17 target types, 139 chains). Built by
 * scripts/build-incident-corpus.ts from DefiLlama's public hacks dataset and committed as a build artifact.
 *
 * WHAT IS OURS AND WHAT IS NOT, said plainly because the listing has to say it too: the facts are public and free.
 * Anyone can fetch that JSON. What is not free is the answer to "I am building an ERC-4626 vault on Base that
 * reads a spot price - what has actually happened to things like this, how often, and how big" - because that
 * needs the corpus normalised, the taxonomy mapped onto a description in words, base rates computed over the
 * right subset, and precedents ranked. This file is that engine. It is deliberately deterministic: the only thing
 * a model does in this service is map words onto the vocabulary below, and everything a buyer is charged for -
 * counts, shares, medians, percentiles, trends, the ranked precedents - is arithmetic anyone can re-check against
 * the ids we return.
 */
import { readFileSync } from 'node:fs'

export type Incident = {
  id: string
  date: string
  protocol: string
  amount_usd: number | null
  returned_usd: number | null
  chains: string[]
  classification: string | null
  technique: string | null
  target_type: string | null
  bridge: boolean
  source_url: string | null
}

export type Aggregate = {
  value: string
  incidents: number
  total_usd: number
  median_usd: number | null
  largest: { protocol: string; date: string; amount_usd: number | null } | null
}

export type Corpus = {
  object: 'incident_corpus'
  built_at: string
  source: { name: string; url: string; licence: string }
  counts: { incidents: number; with_amount: number; with_source_url: number }
  classifications: Aggregate[]
  techniques: Aggregate[]
  target_types: Aggregate[]
  chains: Aggregate[]
  years: Aggregate[]
  incidents: Incident[]
}

/**
 * `../data` from this module resolves to packages/agents/data both from `src/` under tsx and from `dist/` in the
 * image, because both sit one level under the package root. The Dockerfile copies `data/` into the image
 * alongside `dist/`; without it the service is not offered at all rather than offered and broken.
 */
const CORPUS_PATH = new URL('../data/incidents.json', import.meta.url)

let cached: Corpus | null = null

/** Reads and caches the corpus. ~480 KB on disk, a few MB parsed; the machine has 512 MB and one process. */
export function loadCorpus(path: URL | string = CORPUS_PATH): Corpus {
  if (cached) return cached
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Corpus
  if (raw.object !== 'incident_corpus' || !Array.isArray(raw.incidents) || !raw.incidents.length) throw new Error('data/incidents.json is not a usable corpus')
  cached = raw
  return raw
}
/** Tests build small corpora; without this they would see whatever ran first. */
export function resetCorpusCache(): void {
  cached = null
}

/** True when the corpus is present and readable, checked once at start-up so a missing artifact pauses the listing. */
export function corpusAvailable(path: URL | string = CORPUS_PATH): boolean {
  try {
    loadCorpus(path)
    return true
  } catch {
    return false
  }
}

/** The vocabulary a question is mapped onto. Taken from the corpus itself, never hand-written: a value the model may return that no row carries would silently select nothing. */
export function vocabulary(c: Corpus) {
  return {
    classifications: c.classifications.map((a) => a.value),
    techniques: c.techniques.map((a) => a.value),
    target_types: c.target_types.map((a) => a.value),
    /** only chains with some history; the long tail of 139 would be noise in a prompt */
    chains: c.chains.filter((a) => a.incidents >= 3).map((a) => a.value),
  }
}

export type Match = {
  classifications: string[]
  techniques: string[]
  target_type: string | null
  chains: string[]
}

const num = (i: Incident) => (typeof i.amount_usd === 'number' ? i.amount_usd : null)

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!)
}

export type LossStats = {
  /** incidents in this set whose amount the source states; the rest are counted but cannot be summed */
  with_amount: number
  total_usd: number
  median_usd: number | null
  p90_usd: number | null
  max_usd: number | null
  mean_usd: number | null
}

export function lossStats(rows: Incident[]): LossStats {
  const amounts = rows.map(num).filter((a): a is number => a != null && a > 0)
  amounts.sort((a, b) => a - b)
  const total = amounts.reduce((s, a) => s + a, 0)
  return {
    with_amount: amounts.length,
    total_usd: Math.round(total),
    median_usd: percentile(amounts, 0.5),
    p90_usd: percentile(amounts, 0.9),
    max_usd: amounts.length ? Math.round(amounts[amounts.length - 1]!) : null,
    mean_usd: amounts.length ? Math.round(total / amounts.length) : null,
  }
}

/** Counts by any key, largest first, so a buyer can see where a scope really concentrates instead of a single total. */
export function countBy(rows: Incident[], key: (i: Incident) => string[], limit = 8): { value: string; incidents: number; total_usd: number }[] {
  const by = new Map<string, Incident[]>()
  for (const i of rows) for (const v of key(i)) if (v) by.set(v, [...(by.get(v) ?? []), i])
  return [...by]
    .map(([value, list]) => ({ value, incidents: list.length, total_usd: Math.round(list.map(num).filter((a): a is number => a != null).reduce((s, a) => s + a, 0)) }))
    .sort((a, b) => b.incidents - a.incidents)
    .slice(0, limit)
}

/**
 * How relevant is one incident to a match? Deterministic and stated in the answer, so a buyer can see why a row is
 * there instead of trusting a ranking. The technique weighs more than the classification because it is the
 * narrower statement (80 values against 13): "Spot Price Manipulation" says what happened, "Oracle Manipulation"
 * says which drawer it goes in. Recency is a tie-breaker, not a factor - a 2021 incident that matches the
 * technique is better precedent than a 2026 one that only shares a chain.
 */
export const WEIGHTS = { technique: 4, classification: 3, target_type: 1, chain: 1 } as const

export function score(i: Incident, m: Match): { score: number; matched_on: string[] } {
  const on: string[] = []
  let s = 0
  if (i.technique && m.techniques.includes(i.technique)) {
    s += WEIGHTS.technique
    on.push(`technique:${i.technique}`)
  }
  if (i.classification && m.classifications.includes(i.classification)) {
    s += WEIGHTS.classification
    on.push(`classification:${i.classification}`)
  }
  if (i.target_type && m.target_type && i.target_type === m.target_type) {
    s += WEIGHTS.target_type
    on.push(`target_type:${i.target_type}`)
  }
  const chain = i.chains.find((c) => m.chains.includes(c))
  if (chain) {
    s += WEIGHTS.chain
    on.push(`chain:${chain}`)
  }
  return { score: s, matched_on: on }
}

/**
 * The scope a base rate is computed over: every incident that matches the classification OR the technique. Chain
 * and target type deliberately do NOT narrow it here - they narrow `narrowed` below. Mixing them would give one
 * number that answers neither "how often does this kind of thing happen" nor "how often on my chain", and the
 * second is always the smaller, shakier figure. Both are reported, separately, with their counts.
 */
export function scopeOf(c: Corpus, m: Match): Incident[] {
  if (!m.classifications.length && !m.techniques.length) return []
  return c.incidents.filter((i) => (i.classification && m.classifications.includes(i.classification)) || (i.technique && m.techniques.includes(i.technique)))
}

export function narrow(rows: Incident[], m: Match): Incident[] {
  return rows.filter((i) => (!m.target_type || i.target_type === m.target_type) && (!m.chains.length || i.chains.some((ch) => m.chains.includes(ch))))
}

/** The corpus is a snapshot, so "the last twelve months" counts back from its newest incident, not from the clock. */
export function latestDate(c: Corpus): string {
  return c.incidents.reduce((max, i) => (i.date > max ? i.date : max), '0000-00-00')
}
const minusMonths = (date: string, months: number): string => {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCMonth(d.getUTCMonth() - months)
  return d.toISOString().slice(0, 10)
}

export type Window = { from: string; to: string; incidents: number; loss: LossStats }

/**
 * Two equal twelve-month windows ending at the corpus edge, for this scope AND for the whole corpus. A trend
 * needs the comparison in the same answer as the number, or "97 incidents" means nothing; both windows must be
 * equally long or the comparison is a measurement artefact; and the corpus-wide change has to be there too,
 * because without it a scope that merely grew with the dataset reads as a finding. Measured: this corpus holds
 * 148 incidents for 2025 and 264 for 2026, so almost any scope "rose" - `change_pct` alone would sell that
 * artefact as a result. `excess_pct` is the difference, and it is the only figure here that says anything.
 */
export function trend(rows: Incident[], c: Corpus): { recent: Window; previous: Window; change_pct: number | null; corpus_change_pct: number | null; excess_pct: number | null } {
  const to = latestDate(c)
  const mid = minusMonths(to, 12)
  const from = minusMonths(to, 24)
  const split = (r: Incident[]) => [r.filter((i) => i.date > mid && i.date <= to), r.filter((i) => i.date > from && i.date <= mid)] as const
  const change = (recent: number, previous: number) => (previous ? Math.round((recent / previous - 1) * 100) : null)
  const [recentRows, prevRows] = split(rows)
  const [allRecent, allPrev] = split(c.incidents)
  const window = (f: string, t: string, r: Incident[]): Window => ({ from: f, to: t, incidents: r.length, loss: lossStats(r) })
  const scopeChange = change(recentRows.length, prevRows.length)
  const corpusChange = change(allRecent.length, allPrev.length)
  return {
    recent: window(mid, to, recentRows),
    previous: window(from, mid, prevRows),
    change_pct: scopeChange,
    corpus_change_pct: corpusChange,
    excess_pct: scopeChange != null && corpusChange != null ? scopeChange - corpusChange : null,
  }
}

export type Precedent = Incident & { score: number; matched_on: string[] }

/**
 * The precedents, ranked. Every returned row carries its score and what it matched on, and ties break by date
 * (newest first) so the order is stable across identical calls - a buyer diffing two answers should see a change
 * only where the corpus changed.
 *
 * A row qualifies only if it matched on the CLASSIFICATION or the TECHNIQUE, never on the chain or target type
 * alone. Without that condition any "DeFi Protocol on Base" scores 2 and appears as precedent for a mechanism it
 * has nothing to do with - which is filler in an answer whose whole value is that every row is there for a
 * stated reason, and it would also put rows in front of the brief that the base rates never counted.
 */
export function precedents(c: Corpus, m: Match, limit: number): Precedent[] {
  const scored: Precedent[] = []
  for (const i of c.incidents) {
    const s = score(i, m)
    if (s.matched_on.some((on) => on.startsWith('technique:') || on.startsWith('classification:'))) scored.push({ ...i, ...s })
  }
  scored.sort((a, b) => b.score - a.score || (a.date < b.date ? 1 : a.date > b.date ? -1 : a.id < b.id ? -1 : 1))
  return scored.slice(0, limit)
}

/**
 * The biggest losses in a scope, which are precedent too. Ranking by relevance alone answers "what usually
 * happens" and hides the tail: measured on an oracle/share-accounting match, the twelve best-scoring rows were
 * all from the last two months and none was over 8.7 m USD, while the same scope holds a 223 m incident. A risk
 * answer that omits the tail is the wrong answer, so both bands are delivered and named.
 */
export function largestInScope(rows: Incident[], m: Match, limit: number): Precedent[] {
  return rows
    .filter((i) => typeof i.amount_usd === 'number')
    .sort((a, b) => (b.amount_usd ?? 0) - (a.amount_usd ?? 0))
    .slice(0, limit)
    .map((i) => ({ ...i, ...score(i, m) }))
}

/**
 * One base rate per matched mechanism, which is the figure a buyer can actually use.
 *
 * Measured on a real job: a lending market that reads a spot price, has permissionless liquidations, an
 * upgradeable proxy and a multisig maps - correctly - onto four classifications and six techniques, and their
 * union is 703 incidents, 55% of the corpus. That union is honest and nearly useless: a "base rate" over half of
 * all recorded history tells nobody anything. The mechanisms the union is made of are sharp - Spot Price
 * Manipulation 131 incidents, Proxy Upgrade Hijack a handful with a far larger median - and they move in
 * different directions, so each carries its own twelve-month comparison too. The union stays in the answer as
 * context; this is what the findings are written from.
 */
export type Mechanism = {
  value: string
  kind: 'classification' | 'technique'
  incidents: number
  share_of_corpus_pct: number
  loss: LossStats
  /** the same mechanism restricted to the chain and target type of the situation; null when neither was named */
  narrowed_incidents: number | null
  recent_12m: number
  previous_12m: number
  change_pct: number | null
  /** change_pct minus the corpus-wide change over the same windows: the part that is about this mechanism */
  excess_pct: number | null
}

export function mechanisms(c: Corpus, m: Match): Mechanism[] {
  const narrows = Boolean(m.target_type || m.chains.length)
  const corpusTrend = trend([], c)
  const out: Mechanism[] = []
  const add = (value: string, kind: 'classification' | 'technique', pick: (i: Incident) => boolean) => {
    const rows = c.incidents.filter(pick)
    if (!rows.length) return
    const t = trend(rows, c)
    out.push({
      value,
      kind,
      incidents: rows.length,
      share_of_corpus_pct: Math.round((rows.length / c.incidents.length) * 1000) / 10,
      loss: lossStats(rows),
      narrowed_incidents: narrows ? narrow(rows, m).length : null,
      recent_12m: t.recent.incidents,
      previous_12m: t.previous.incidents,
      change_pct: t.change_pct,
      excess_pct: t.change_pct == null || corpusTrend.corpus_change_pct == null ? null : t.change_pct - corpusTrend.corpus_change_pct,
    })
  }
  for (const v of m.techniques) add(v, 'technique', (i) => i.technique === v)
  for (const v of m.classifications) add(v, 'classification', (i) => i.classification === v)
  return out.sort((a, b) => b.incidents - a.incidents)
}

export type BaseRates = {
  scope: { definition: string; incidents: number; share_of_corpus_pct: number; loss: LossStats }
  narrowed: { definition: string; incidents: number; loss: LossStats } | null
  /** one base rate per matched mechanism - the figures the findings are written from (see `mechanisms`) */
  by_mechanism: Mechanism[]
  by_classification: { value: string; incidents: number; total_usd: number }[]
  by_technique: { value: string; incidents: number; total_usd: number }[]
  by_chain: { value: string; incidents: number; total_usd: number }[]
  by_target_type: { value: string; incidents: number; total_usd: number }[]
  by_year: { value: string; incidents: number; total_usd: number }[]
  trend: ReturnType<typeof trend>
  /** how much of this scope was ever recovered - the one figure that says how much of a loss is final */
  returned_usd: number
}

export function baseRates(c: Corpus, m: Match): BaseRates {
  const scope = scopeOf(c, m)
  const narrowed = narrow(scope, m)
  const narrowsTo = [m.target_type ? `target type ${m.target_type}` : null, m.chains.length ? `chain in ${m.chains.join(', ')}` : null].filter(Boolean).join(' and ')
  return {
    scope: {
      definition: `incidents whose classification is one of [${m.classifications.join(', ')}] or whose technique is one of [${m.techniques.join(', ')}]`,
      incidents: scope.length,
      share_of_corpus_pct: Math.round((scope.length / c.incidents.length) * 1000) / 10,
      loss: lossStats(scope),
    },
    narrowed: narrowsTo ? { definition: `the same scope, ${narrowsTo}`, incidents: narrowed.length, loss: lossStats(narrowed) } : null,
    by_mechanism: mechanisms(c, m),
    by_classification: countBy(scope, (i) => (i.classification ? [i.classification] : [])),
    by_technique: countBy(scope, (i) => (i.technique ? [i.technique] : [])),
    by_chain: countBy(scope, (i) => i.chains),
    by_target_type: countBy(scope, (i) => (i.target_type ? [i.target_type] : [])),
    by_year: countBy(scope, (i) => [i.date.slice(0, 4)], 20).sort((a, b) => (a.value < b.value ? 1 : -1)),
    trend: trend(scope, c),
    returned_usd: Math.round(scope.reduce((s, i) => s + (i.returned_usd ?? 0), 0)),
  }
}
