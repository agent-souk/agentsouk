/**
 * ADR-76 iteration 2: what each incident in the corpus can be BACKED BY.
 *
 *   cd packages/agents && npx tsx scripts/build-incident-references.ts [--out data/references.json] [--report]
 *
 * The corpus from iteration 1 says WHAT happened and how often. It cannot say "and here is a runnable
 * reproduction of exactly this mechanism" - and that is the sentence a reviewer actually acts on. DefiLlama's
 * `source` field is empty for all 1,271 rows (measured), so this cannot be fetched; it has to be assembled.
 *
 * SOURCE: SunWeb3Sec/DeFiHackLabs (Apache-2.0, attributed in the artifact and in the listing). For several hundred
 * incidents it holds a Foundry test that reproduces the exploit against a forked chain, plus a one-line mechanism
 * description written by a security engineer and the amount they reproduced. We take the references - date, name,
 * description, the path of the proof-of-concept and the command that runs it - not the code and not any article.
 *
 * WHY A SEPARATE ARTIFACT from data/incidents.json: the corpus is rebuilt from DefiLlama whenever the source
 * moves, and a merged file would lose this work on every rebuild. Two files, one join on the incident id, and each
 * can be rebuilt without the other.
 *
 * THE MATCH IS THE HARD PART and it is deliberately conservative. Two independent groups name the same incident
 * differently ("Moonwell" vs "Moonwell Lending") and date it differently by up to a day or two (block time vs
 * report time, timezones). A wrong match is worse than a missing one: it would attach a proof-of-concept to the
 * wrong incident, and a buyer who follows it would review the wrong mechanism. So a reference is only attached
 * when the dates are within MAX_DAYS and the names agree after normalisation, and every rejected candidate is
 * counted so the miss rate stays visible instead of looking like an absence of incidents.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { loadCorpus, type Incident } from '../src/corpus.js'

const RAW = 'https://raw.githubusercontent.com/SunWeb3Sec/DeFiHackLabs/main'
const REPO = 'https://github.com/SunWeb3Sec/DeFiHackLabs'
const YEARS = [2021, 2022, 2023, 2024, 2025]
/** How far two records may disagree about the date and still be the same incident. */
const MAX_DAYS = 2

const outArg = process.argv.indexOf('--out')
const out = outArg >= 0 ? process.argv[outArg + 1]! : 'data/references.json'
const report = process.argv.includes('--report')

export type Poc = {
  /** the file in the source repository that reproduces the exploit */
  path: string
  url: string
  /** the command the source gives to run it */
  command: string
  /** what the source reproduced, in their words, e.g. "~10.70728 ETH (reproduced exact to the wei)" */
  reproduced: string | null
}
export type Reference = {
  /** the mechanism in one line, as the source's engineers titled it */
  mechanism: string
  source: 'DeFiHackLabs'
  poc: Poc | null
  /** how this reference was tied to the incident, so a wrong match is traceable rather than invisible */
  matched: { on: 'date+name' | 'date+name-contains'; source_date: string; source_name: string; days_apart: number }
}

type Entry = { date: string; name: string; mechanism: string; lost: string | null; poc: { path: string; command: string } | null }

/** `### 20260912 SpiralHookV2 - Uniswap V4 spot-price borrow plus ...` */
const HEAD = /^### (\d{8}) ([^\n-]+?)\s*[-–—]\s*(.+)$/
const LOST = /^### Lost:\s*(.+)$/
const FORGE = /forge test --contracts (\S+)/
/** the source writes some paths as `./src/test/...`; GitHub resolves that, but a link we hand a buyer should be clean */
const cleanPath = (p: string) => p.replace(/^\.\//, '')

function parse(md: string): Entry[] {
  const lines = md.split(/\r?\n/)
  const out: Entry[] = []
  for (let i = 0; i < lines.length; i++) {
    const h = HEAD.exec(lines[i]!)
    if (!h) continue
    const [, ymd, name, mechanism] = h as unknown as [string, string, string, string]
    // "Lost:" is itself an h3, so it would match HEAD without the dash requirement; guard anyway
    if (/^lost:/i.test(name)) continue
    let lost: string | null = null
    let poc: { path: string; command: string } | null = null
    // the block of a single entry runs until the next entry heading
    for (let j = i + 1; j < lines.length && !(HEAD.test(lines[j]!) && !/^### Lost:/i.test(lines[j]!)); j++) {
      const l = LOST.exec(lines[j]!)
      if (l) lost = l[1]!.trim()
      const f = FORGE.exec(lines[j]!)
      if (f && !poc) poc = { path: cleanPath(f[1]!), command: lines[j]!.trim() }
    }
    out.push({ date: `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`, name: name.trim(), mechanism: mechanism.trim(), lost, poc })
  }
  return out
}

/**
 * Names, reduced to what two groups are likely to agree on. The words dropped are the ones that carry no identity
 * ("Finance", "Protocol", "V2"); the rest is kept, because dropping more turns "Token Holder" and "Tokens" into
 * the same protocol.
 */
const NOISE = /\b(finance|protocol|dao|network|labs?|foundation|token|coin|swap|lending|vault|bridge|v[0-9]+|inc|io|exchange)\b/g
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[._-]/g, ' ')
    .replace(NOISE, ' ')
    .replace(/[^a-z0-9]/g, '')
const days = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000

function match(entry: Entry, incidents: Incident[]): { incident: Incident; on: Reference['matched']['on']; daysApart: number } | null {
  const en = norm(entry.name)
  if (en.length < 3) return null
  const near = incidents.filter((i) => days(i.date, entry.date) <= MAX_DAYS)
  const exact = near.filter((i) => norm(i.protocol) === en)
  if (exact.length === 1) return { incident: exact[0]!, on: 'date+name', daysApart: days(exact[0]!.date, entry.date) }
  // one name contained in the other, e.g. "Moonwell" against "Moonwell Lending". Only when it is unambiguous:
  // two candidates mean we do not know which, and guessing would attach a proof-of-concept to the wrong row.
  const contains = near.filter((i) => {
    const cn = norm(i.protocol)
    return cn.length >= 4 && en.length >= 4 && (cn.includes(en) || en.includes(cn))
  })
  if (exact.length > 1 || contains.length !== 1) return null
  return { incident: contains[0]!, on: 'date+name-contains', daysApart: days(contains[0]!.date, entry.date) }
}

const corpus = loadCorpus()
const entries: Entry[] = []
for (const url of [`${RAW}/README.md`, ...YEARS.map((y) => `${RAW}/past/${y}/README.md`)]) {
  const res = await fetch(url, { headers: { accept: 'text/plain', 'user-agent': 'agentsouk-incident-corpus/1.0 (+https://api.agentsouk.dev)' } })
  if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`)
  const found = parse(await res.text())
  entries.push(...found)
  if (report) console.log(`  ${url.replace(RAW, '')}: ${found.length} entries`)
}
if (entries.length < 200) throw new Error(`only ${entries.length} source entries parsed; the index format probably changed, refusing to write a thin artifact`)

const byIncident: Record<string, Reference> = {}
const unmatched: Entry[] = []
let ambiguous = 0
for (const e of entries) {
  const m = match(e, corpus.incidents)
  if (!m) {
    unmatched.push(e)
    continue
  }
  // an incident already referenced keeps the entry that agrees best on the date
  const existing = byIncident[m.incident.id]
  if (existing && existing.matched.days_apart <= m.daysApart) {
    ambiguous++
    continue
  }
  byIncident[m.incident.id] = {
    mechanism: e.mechanism,
    source: 'DeFiHackLabs',
    poc: e.poc ? { path: e.poc.path, url: `${REPO}/blob/main/${e.poc.path}`, command: e.poc.command, reproduced: e.lost } : null,
    matched: { on: m.on, source_date: e.date, source_name: e.name, days_apart: m.daysApart },
  }
}

const withPoc = Object.values(byIncident).filter((r) => r.poc).length
const artifact = {
  object: 'incident_references' as const,
  built_at: new Date().toISOString(),
  sources: [
    {
      name: 'DeFiHackLabs',
      url: REPO,
      licence: 'Apache-2.0',
      attribution: 'Proof-of-concept reproductions and mechanism descriptions from SunWeb3Sec/DeFiHackLabs, Apache-2.0. Referenced, not copied: this artifact holds the date, the name, the one-line mechanism description, the path of the reproduction and the command that runs it.',
    },
  ],
  counts: {
    source_entries: entries.length,
    incidents_referenced: Object.keys(byIncident).length,
    with_reproduction: withPoc,
    source_entries_unmatched: unmatched.length,
    duplicate_candidates_skipped: ambiguous,
    corpus_incidents: corpus.counts.incidents,
  },
  by_incident: byIncident,
}

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify(artifact, null, 1) + '\n', 'utf8')
const c = artifact.counts
console.log(`${out}: ${c.incidents_referenced} of ${c.corpus_incidents} corpus incidents referenced (${Math.round((c.incidents_referenced / c.corpus_incidents) * 100)}%), ${c.with_reproduction} with a runnable reproduction`)
console.log(`  parsed ${c.source_entries} source entries; ${c.source_entries_unmatched} could not be tied to a corpus incident, ${c.duplicate_candidates_skipped} were a second candidate for an incident already referenced`)
if (report) {
  console.log('\nunmatched source entries (first 30) - each is an incident the corpus does not hold, or a name/date the match would not risk:')
  for (const e of unmatched.slice(0, 30)) console.log(`  ${e.date} ${e.name.padEnd(28)} ${e.mechanism.slice(0, 70)}`)
  console.log('\nsample matches:')
  for (const [id, r] of Object.entries(byIncident).slice(0, 12)) console.log(`  ${id.padEnd(40)} <- ${r.matched.source_name.padEnd(24)} (${r.matched.on}, ${r.matched.days_apart}d) ${r.poc ? 'PoC' : 'no PoC'}`)
}
