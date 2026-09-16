import { describe, it, expect, beforeEach } from 'vitest'
import { baseRates, corpusAvailable, countBy, mechanisms, largestInScope, latestDate, loadCorpus, lossStats, narrow, precedents, resetCorpusCache, score, scopeOf, trend, vocabulary, WEIGHTS, type Corpus, type Incident, type Match } from './corpus.js'

/**
 * Eight incidents whose every figure can be checked by hand, because the whole claim of this service is that the
 * arithmetic is re-checkable. The real corpus is asserted separately at the end: that it is committed, readable
 * and holds what the listing says it holds.
 */
const row = (id: string, date: string, protocol: string, amount: number | null, chains: string[], classification: string | null, technique: string | null, target_type: string, returned: number | null = null): Incident => ({
  id,
  date,
  protocol,
  amount_usd: amount,
  returned_usd: returned,
  chains,
  classification,
  technique,
  target_type,
  bridge: false,
  source_url: null,
})

const INCIDENTS = [
  row('a1', '2026-09-10', 'Alpha', 1_000, ['Base'], 'Oracle Manipulation', 'Spot Price Manipulation', 'DeFi Protocol'),
  row('a2', '2026-06-01', 'Beta', 3_000, ['Ethereum'], 'Oracle Manipulation', 'Spot Price Manipulation', 'DeFi Protocol'),
  row('a3', '2026-01-01', 'Gamma', null, ['Base'], 'Oracle Manipulation', 'Oracle Misconfiguration', 'DeFi Protocol'),
  row('a4', '2025-05-01', 'Delta', 9_000, ['Base'], 'Token & Share Accounting', 'Incorrect Share Accounting', 'DeFi Protocol'),
  row('a5', '2025-01-01', 'Epsilon', 50_000, ['BSC'], 'Key Compromise', 'Private Key Compromised', 'CEX'),
  row('a6', '2025-03-01', 'Zeta', 200, ['Base'], 'Oracle Manipulation', 'Spot Price Manipulation', 'DeFi Protocol'),
  row('a7', '2023-01-01', 'Eta', 700, ['Ethereum'], 'Reentrancy', 'Reentrancy', 'DeFi Protocol'),
  row('a8', '2026-03-01', 'Theta', 400, ['Base'], 'Oracle Manipulation', 'Spot Price Manipulation', 'NFTfi', 100),
]

/** Aggregates built from the rows, exactly as the build script does, so the fixture cannot drift from itself. */
function agg(key: (i: Incident) => string[]) {
  const by = new Map<string, Incident[]>()
  for (const i of INCIDENTS) for (const v of key(i)) if (v) by.set(v, [...(by.get(v) ?? []), i])
  return [...by]
    .map(([value, list]) => ({ value, incidents: list.length, total_usd: list.reduce((s, i) => s + (i.amount_usd ?? 0), 0), median_usd: null, largest: null }))
    .sort((a, b) => b.incidents - a.incidents)
}

export const FIXTURE: Corpus = {
  object: 'incident_corpus',
  built_at: '2026-09-11T00:00:00.000Z',
  source: { name: 'test', url: 'https://example.invalid/hacks', licence: 'test' },
  counts: { incidents: 8, with_amount: 7, with_source_url: 0 },
  classifications: agg((i) => (i.classification ? [i.classification] : [])),
  techniques: agg((i) => (i.technique ? [i.technique] : [])),
  target_types: agg((i) => (i.target_type ? [i.target_type] : [])),
  chains: agg((i) => i.chains),
  years: agg((i) => [i.date.slice(0, 4)]),
  incidents: INCIDENTS,
}

const MATCH: Match = { classifications: ['Oracle Manipulation'], techniques: ['Spot Price Manipulation'], target_type: 'DeFi Protocol', chains: ['Base'] }

beforeEach(() => resetCorpusCache())

describe('the corpus engine (ADR-76)', () => {
  it('takes the vocabulary from the corpus itself and drops the long tail of chains', () => {
    const v = vocabulary(FIXTURE)
    expect(v.classifications).toContain('Oracle Manipulation')
    expect(v.techniques).toContain('Spot Price Manipulation')
    expect(v.target_types).toEqual(expect.arrayContaining(['DeFi Protocol', 'CEX', 'NFTfi']))
    // Base carries 5 rows, Ethereum 2 and BSC 1: only chains with some history stay, or a prompt carries 139 names
    expect(v.chains).toEqual(['Base'])
  })

  it('scores a row on why it is relevant, weighing the technique above the drawer it sits in', () => {
    expect(WEIGHTS).toEqual({ technique: 4, classification: 3, target_type: 1, chain: 1 })
    expect(score(INCIDENTS[0], MATCH)).toEqual({ score: 9, matched_on: ['technique:Spot Price Manipulation', 'classification:Oracle Manipulation', 'target_type:DeFi Protocol', 'chain:Base'] })
    // the technique misses, the classification still holds
    expect(score(INCIDENTS[2], MATCH).score).toBe(5)
    // shares only the target type and the chain: relevant to nothing
    expect(score(INCIDENTS[3], MATCH)).toEqual({ score: 2, matched_on: ['target_type:DeFi Protocol', 'chain:Base'] })
    expect(score(INCIDENTS[6], MATCH)).toEqual({ score: 1, matched_on: ['target_type:DeFi Protocol'] })
    expect(score(INCIDENTS[4], MATCH).score).toBe(0)
  })

  it('defines the scope by mechanism and narrows by chain and target type separately, never in one number', () => {
    const scope = scopeOf(FIXTURE, MATCH)
    expect(scope.map((i) => i.id)).toEqual(['a1', 'a2', 'a3', 'a6', 'a8'])
    // the narrowed set is always the smaller, shakier figure, which is why it is reported apart from the scope
    expect(narrow(scope, MATCH).map((i) => i.id)).toEqual(['a1', 'a3', 'a6'])
    expect(scopeOf(FIXTURE, { classifications: [], techniques: [], target_type: 'DeFi Protocol', chains: ['Base'] })).toEqual([])
  })

  it('computes loss statistics by hand-checkable arithmetic, and counts the rows it cannot sum', () => {
    const l = lossStats(scopeOf(FIXTURE, MATCH))
    // amounts in scope: 200, 400, 1000, 3000 - a3 states none
    expect(l).toEqual({ with_amount: 4, total_usd: 4_600, median_usd: 1_000, p90_usd: 3_000, max_usd: 3_000, mean_usd: 1_150 })
    expect(lossStats([])).toEqual({ with_amount: 0, total_usd: 0, median_usd: null, p90_usd: null, max_usd: null, mean_usd: null })
  })

  it('counts the last twelve months against the twelve before AND against the whole corpus', () => {
    expect(latestDate(FIXTURE)).toBe('2026-09-10')
    const t = trend(scopeOf(FIXTURE, MATCH), FIXTURE)
    expect(t.recent).toMatchObject({ from: '2025-09-10', to: '2026-09-10', incidents: 4 })
    expect(t.previous).toMatchObject({ from: '2024-09-10', to: '2025-09-10', incidents: 1 })
    expect(t.change_pct).toBe(300)
    // the corpus itself went from 3 to 4 incidents over the same windows: +33%
    expect(t.corpus_change_pct).toBe(33)
    // so only 267 points of that 300 are about this scope rather than about the dataset growing
    expect(t.excess_pct).toBe(267)
    // a scope with nothing in the earlier window has no comparison, and says so instead of showing infinity
    expect(trend(INCIDENTS.filter((i) => i.id === 'a1'), FIXTURE).change_pct).toBeNull()
  })

  it('ranks precedent by relevance, breaks ties by date, and refuses a row that matched no mechanism', () => {
    const p = precedents(FIXTURE, MATCH, 10)
    expect(p.map((i) => i.id)).toEqual(['a1', 'a6', 'a2', 'a8', 'a3'])
    expect(p.map((i) => i.score)).toEqual([9, 9, 8, 8, 5])
    // a4 scores 2 on target type and chain alone: it is not precedent for this mechanism and must not appear
    expect(p.map((i) => i.id)).not.toContain('a4')
    expect(precedents(FIXTURE, MATCH, 2).map((i) => i.id)).toEqual(['a1', 'a6'])
  })

  it('delivers the tail as well, because relevance ranking hides the biggest losses', () => {
    const big = largestInScope(scopeOf(FIXTURE, MATCH), MATCH, 3)
    expect(big.map((i) => i.id)).toEqual(['a2', 'a1', 'a8'])
    expect(big[0]).toMatchObject({ amount_usd: 3_000, score: 8 })
    // a row without a stated amount cannot be ranked by size and is left out of this band, not guessed at zero
    expect(big.map((i) => i.id)).not.toContain('a3')
  })

  it('puts the whole answer together with its own definition, so a buyer can re-derive every figure', () => {
    const r = baseRates(FIXTURE, MATCH)
    expect(r.scope.incidents).toBe(5)
    expect(r.scope.share_of_corpus_pct).toBe(62.5)
    expect(r.scope.definition).toBe('incidents whose classification is one of [Oracle Manipulation] or whose technique is one of [Spot Price Manipulation]')
    expect(r.narrowed).toMatchObject({ definition: 'the same scope, target type DeFi Protocol and chain in Base', incidents: 3 })
    expect(r.by_technique).toEqual([
      { value: 'Spot Price Manipulation', incidents: 4, total_usd: 4_600 },
      { value: 'Oracle Misconfiguration', incidents: 1, total_usd: 0 },
    ])
    expect(r.by_target_type).toEqual([
      { value: 'DeFi Protocol', incidents: 4, total_usd: 4_200 },
      { value: 'NFTfi', incidents: 1, total_usd: 400 },
    ])
    expect(r.by_year.map((y) => y.value)).toEqual(['2026', '2025'])
    expect(r.returned_usd).toBe(100)
  })

  it('gives one base rate per mechanism, because a union over half the corpus says nothing', () => {
    const ms = mechanisms(FIXTURE, MATCH)
    expect(ms.map((x) => x.value)).toEqual(['Oracle Manipulation', 'Spot Price Manipulation'])
    expect(ms[0]).toMatchObject({ kind: 'classification', incidents: 5, share_of_corpus_pct: 62.5, narrowed_incidents: 3, recent_12m: 4, previous_12m: 1, change_pct: 300, excess_pct: 267 })
    // the technique is the narrower statement and gets its own, different numbers
    expect(ms[1]).toMatchObject({ kind: 'technique', incidents: 4, share_of_corpus_pct: 50, narrowed_incidents: 2, recent_12m: 3, previous_12m: 1, change_pct: 200, excess_pct: 167 })
    expect(ms[1].loss).toEqual({ with_amount: 4, total_usd: 4_600, median_usd: 1_000, p90_usd: 3_000, max_usd: 3_000, mean_usd: 1_150 })
    // nothing narrows it, so there is no narrowed count rather than a count equal to the whole
    expect(mechanisms(FIXTURE, { classifications: ['Reentrancy'], techniques: [], target_type: null, chains: [] })[0]).toMatchObject({ incidents: 1, narrowed_incidents: null })
    // a value the corpus does not carry contributes no row at all
    expect(mechanisms(FIXTURE, { classifications: ['Nothing Like This'], techniques: [], target_type: null, chains: [] })).toEqual([])
  })

  it('says there is no narrowed figure rather than inventing one when the situation named no chain or type', () => {
    const r = baseRates(FIXTURE, { classifications: ['Oracle Manipulation'], techniques: [], target_type: null, chains: [] })
    expect(r.narrowed).toBeNull()
    // every Oracle Manipulation row, with nothing narrowing it: a1, a2, a3, a6, a8
    expect(r.scope.incidents).toBe(5)
  })

  it('groups by any key, largest first', () => {
    expect(countBy(INCIDENTS, (i) => i.chains)).toEqual([
      { value: 'Base', incidents: 5, total_usd: 10_600 },
      { value: 'Ethereum', incidents: 2, total_usd: 3_700 },
      { value: 'BSC', incidents: 1, total_usd: 50_000 },
    ])
    expect(countBy(INCIDENTS, (i) => i.chains, 1).length).toBe(1)
  })
})

describe('the committed corpus', () => {
  it('is present, readable and holds what the listing claims', () => {
    expect(corpusAvailable()).toBe(true)
    const c = loadCorpus()
    expect(c.object).toBe('incident_corpus')
    // the listing quotes these counts, so a rebuild that halves the corpus should fail here first
    expect(c.counts.incidents).toBeGreaterThan(1_000)
    expect(c.counts.incidents).toBe(c.incidents.length)
    expect(c.classifications.length).toBeGreaterThanOrEqual(10)
    expect(c.techniques.length).toBeGreaterThanOrEqual(50)
    expect(c.source.url).toBe('https://api.llama.fi/hacks')
    // every row has a usable handle and a date, because both are cited back in an answer
    expect(new Set(c.incidents.map((i) => i.id)).size).toBe(c.incidents.length)
    expect(c.incidents.every((i) => /^\d{4}-\d{2}-\d{2}$/.test(i.date))).toBe(true)
    expect(c.incidents.every((i) => i.amount_usd === null || i.amount_usd > 0)).toBe(true)
  })

  it('answers a real question over the real corpus without a model anywhere in the path', () => {
    const c = loadCorpus()
    const m: Match = { classifications: ['Oracle Manipulation'], techniques: ['Spot Price Manipulation'], target_type: 'DeFi Protocol', chains: ['Base'] }
    const r = baseRates(c, m)
    expect(r.scope.incidents).toBeGreaterThan(100)
    expect(r.scope.loss.median_usd).toBeGreaterThan(0)
    expect(r.scope.loss.p90_usd!).toBeGreaterThan(r.scope.loss.median_usd!)
    expect(precedents(c, m, 12).length).toBe(12)
    expect(precedents(c, m, 12).every((p) => p.matched_on.length > 0)).toBe(true)
  })
})
