/**
 * ADR-76, iteration 1: builds the incident corpus this platform sells answers from.
 *
 *   cd packages/agents && npx tsx scripts/build-incident-corpus.ts [--out data/incidents.json]
 *
 * WHY A FILE IN THE REPO, not platform memory: a value there is capped at 64 KB and an identity may hold 1,000
 * keys, while this corpus is ~350 KB today and meant to grow for months. As a build artifact it is versioned,
 * reviewable in a diff, identical on every machine, and it costs nothing to read. The price of that choice is
 * honest: the corpus is only as fresh as the last commit, so the service says when it was built.
 *
 * WHERE THE FACTS COME FROM: DefiLlama's public hacks dataset (https://api.llama.fi/hacks), CC-BY-4.0-style open
 * data, 1,271 incidents from 2015 to today with date, protocol, amount in USD, chains, their own classification
 * and technique, and the target type. We do not claim this data as ours and the listing names the source. What is
 * ours is the normalisation, the aggregation and - from iteration 2 - the attack chains we derive from public
 * write-ups with exploit-chain.
 *
 * WHAT IS DELIBERATELY NOT COPIED: no article text. The corpus holds facts and figures, plus a link where one
 * exists. Anything narrative that later joins it comes from our own analysis, with short quoted evidence only.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Corpus, Incident, Aggregate } from '../src/corpus.js'

const SOURCE = 'https://api.llama.fi/hacks'
const outArg = process.argv.indexOf('--out')
const out = outArg >= 0 ? process.argv[outArg + 1]! : 'data/incidents.json'

type Raw = {
  date: number
  name: string
  classification: string | null
  technique: string | null
  amount: number | null
  chain: string[] | null
  bridgeHack: boolean | null
  targetType: string | null
  source: string | null
  returnedFunds: number | null
  defillamaId: string | null
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 48)

function aggregate(rows: Incident[], key: (i: Incident) => string[]): Aggregate[] {
  const byValue = new Map<string, Incident[]>()
  for (const i of rows) for (const v of key(i)) if (v) byValue.set(v, [...(byValue.get(v) ?? []), i])
  const out: Aggregate[] = []
  for (const [value, list] of byValue) {
    const amounts = list.map((i) => i.amount_usd).filter((a): a is number => typeof a === 'number' && a > 0)
    amounts.sort((a, b) => a - b)
    const largest = list.filter((i) => typeof i.amount_usd === 'number').sort((a, b) => (b.amount_usd ?? 0) - (a.amount_usd ?? 0))[0]
    out.push({
      value,
      incidents: list.length,
      total_usd: Math.round(amounts.reduce((s, a) => s + a, 0)),
      median_usd: amounts.length ? Math.round(amounts[Math.floor(amounts.length / 2)]!) : null,
      largest: largest ? { protocol: largest.protocol, date: largest.date, amount_usd: largest.amount_usd } : null,
    })
  }
  return out.sort((a, b) => b.incidents - a.incidents)
}

const res = await fetch(SOURCE, { headers: { accept: 'application/json', 'user-agent': 'agentsouk-incident-corpus/1.0 (+https://api.agentsouk.dev)' } })
if (!res.ok) throw new Error(`${SOURCE} answered HTTP ${res.status}`)
const raw = (await res.json()) as Raw[]
if (!Array.isArray(raw) || raw.length < 500) throw new Error(`the source returned ${Array.isArray(raw) ? raw.length : 'no'} rows; refusing to overwrite the corpus with that`)

const seen = new Set<string>()
const incidents: Incident[] = []
for (const r of raw) {
  const date = new Date(r.date * 1000).toISOString().slice(0, 10)
  let id = `${date}-${slug(r.name ?? 'unknown')}`
  for (let n = 2; seen.has(id); n++) id = `${date}-${slug(r.name ?? 'unknown')}-${n}`
  seen.add(id)
  incidents.push({
    id,
    date,
    protocol: r.name ?? 'unknown',
    amount_usd: typeof r.amount === 'number' && r.amount > 0 ? Math.round(r.amount) : null,
    returned_usd: typeof r.returnedFunds === 'number' && r.returnedFunds > 0 ? Math.round(r.returnedFunds) : null,
    chains: (r.chain ?? []).filter(Boolean),
    classification: r.classification || null,
    technique: r.technique || null,
    target_type: r.targetType || null,
    bridge: r.bridgeHack === true,
    source_url: r.source?.trim() ? r.source.trim() : null,
  })
}
incidents.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))

const corpus: Corpus = {
  object: 'incident_corpus',
  built_at: new Date().toISOString(),
  source: { name: 'DefiLlama hacks', url: SOURCE, licence: 'open data, attributed; facts and figures only, no article text' },
  counts: {
    incidents: incidents.length,
    with_amount: incidents.filter((i) => i.amount_usd != null).length,
    with_source_url: incidents.filter((i) => i.source_url != null).length,
  },
  classifications: aggregate(incidents, (i) => (i.classification ? [i.classification] : [])),
  techniques: aggregate(incidents, (i) => (i.technique ? [i.technique] : [])),
  target_types: aggregate(incidents, (i) => (i.target_type ? [i.target_type] : [])),
  chains: aggregate(incidents, (i) => i.chains),
  years: aggregate(incidents, (i) => [i.date.slice(0, 4)]),
  incidents,
}

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify(corpus, null, 1) + '\n', 'utf8')
const usd = (n: number) => `${(n / 1e9).toFixed(1)} bn USD`
console.log(`${out}: ${corpus.counts.incidents} incidents, ${corpus.counts.with_amount} with an amount, built ${corpus.built_at}`)
console.log(`  ${corpus.classifications.length} classifications, ${corpus.techniques.length} techniques, ${corpus.chains.length} chains, ${corpus.years.length} years`)
console.log(`  total loss in the corpus: ${usd(corpus.classifications.reduce((s, c) => s + c.total_usd, 0))}`)
console.log(`  top classifications: ${corpus.classifications.slice(0, 3).map((c) => `${c.value} (${c.incidents})`).join(', ')}`)
