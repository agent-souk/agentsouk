/**
 * ADR-76: one real job through risk-precedent, against the real model and the committed corpus.
 *
 *   cd packages/agents && npx tsx scripts/smoke-risk-precedent.ts [--situation "..."] [--chains Base,Ethereum]
 *
 * Costs real model time (two calls). Prints the delivery, the cost, and the checks that matter: whether every
 * finding cites a row we delivered, and whether the arithmetic in the answer agrees with the corpus.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Llm } from '../src/llm.js'
import { riskPrecedent } from '../src/services/risk-precedent.js'

let apiKey = process.env.ANTHROPIC_API_KEY
if (!apiKey) {
  const envFile = join(homedir(), '.agentsouk-ops', 'agents.env')
  if (existsSync(envFile)) apiKey = readFileSync(envFile, 'utf8').match(/^ANTHROPIC_API_KEY=(.+)$/m)?.[1]?.trim()
}
if (!apiKey) {
  console.error('ANTHROPIC_API_KEY missing (environment or ~/.agentsouk-ops/agents.env)')
  process.exit(1)
}
const arg = (name: string, dflt?: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith('--') ? process.argv[i + 1]! : dflt
}

const situation =
  arg('situation') ??
  'We run a lending market on Base. Users deposit an ERC-20 as collateral and borrow USDC against it. The collateral price comes from a Chainlink feed, but for newly listed long-tail assets with no feed we fall back to the spot price of the deepest Uniswap v3 pool, read at the moment of the borrow. Liquidations are permissionless and pay a 8% bonus. An upgradeable proxy owned by a 2-of-3 multisig can add markets and change the collateral factor.'
const chains = (arg('chains', 'Base') ?? '').split(',').map((s) => s.trim()).filter(Boolean)

const llm = new Llm({ apiKey, dailyBudgetUsd: 5, log: (m, x) => console.log(`  [llm] ${m}`, x ?? '') })
// what each call really costs, per call: the output allowance has to fit the answer INCLUDING the thinking the
// model does by default, and that is a measurement, not a guess (ADR-72, ADR-75 both got it wrong first)
const inner = llm.completeJson.bind(llm)
llm.completeJson = (async (i: Parameters<typeof inner>[0]) => {
  const r = await inner(i)
  console.log(`  [call] in ${r.completion.inputTokens} tok, out ${r.completion.outputTokens} tok of ${i.maxTokens} allowed, ${r.completion.costUsd.toFixed(4)} USD`)
  return r
}) as typeof llm.completeJson
const svc = riskPrecedent(llm)

console.log(`listing title (${svc.listing.title.length} chars): ${svc.listing.title}`)
console.log(`price: ${(svc.listing.price / 1e6).toFixed(2)} USDC, description ${String(svc.listing.description).length} chars`)
const decline = await svc.validate({ situation, chains }, { units: 1 })
if (decline) {
  console.error(`declined before any spend: ${decline}`)
  process.exit(1)
}

const t0 = Date.now()
const r = await svc.run({ situation, chains }, { units: 1 })
const seconds = ((Date.now() - t0) / 1000).toFixed(1)
const o = r.output as Record<string, any>

console.log(`\n=== delivered in ${seconds} s ===`)
console.log(`reading: ${o.reading}`)
console.log(`match:   classifications ${JSON.stringify(o.match.classifications)}`)
console.log(`         techniques      ${JSON.stringify(o.match.techniques)}`)
console.log(`         target ${o.match.target_type}, chains ${JSON.stringify(o.match.chains)}, unmatched ${JSON.stringify(o.match.chains_unmatched)}`)
const s = o.base_rates.scope
const usd = (n: number | null) => (n == null ? 'n/a' : n >= 1e9 ? `${(n / 1e9).toFixed(2)} bn` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} m` : `${Math.round(n / 1000)} k`)
console.log(`\nscope:   ${s.incidents} incidents (${s.share_of_corpus_pct}% of the corpus), ${s.loss.with_amount} with an amount`)
console.log(`         median ${usd(s.loss.median_usd)}, p90 ${usd(s.loss.p90_usd)}, max ${usd(s.loss.max_usd)}, total ${usd(s.loss.total_usd)}, recovered ${usd(o.base_rates.returned_usd)}`)
if (o.base_rates.narrowed) console.log(`narrowed: ${o.base_rates.narrowed.incidents} incidents (${o.base_rates.narrowed.definition}), median ${usd(o.base_rates.narrowed.loss.median_usd)}, max ${usd(o.base_rates.narrowed.loss.max_usd)}`)
console.log('\nper mechanism - the figures the findings are written from:')
for (const x of o.base_rates.by_mechanism) console.log(`  ${x.value.slice(0, 30).padEnd(30)} ${x.kind.padEnd(14)} ${String(x.incidents).padStart(4)} inc (${String(x.share_of_corpus_pct).padStart(4)}%)  median ${usd(x.loss.median_usd).padStart(8)}  max ${usd(x.loss.max_usd).padStart(8)}  yours ${String(x.narrowed_incidents).padStart(3)}  repro ${String(x.with_reproduction).padStart(3)}  ${String(x.recent_12m).padStart(3)}/${String(x.previous_12m).padStart(3)} = ${String(x.change_pct).padStart(5)}%`)
const t = o.base_rates.trend
console.log(`trend:   ${t.recent.incidents} in ${t.recent.from}..${t.recent.to} against ${t.previous.incidents} before = ${t.change_pct}%, corpus ${t.corpus_change_pct}%, excess ${t.excess_pct}%`)
console.log(`\nprecedents, closest ${o.precedents.closest.length}:`)
for (const p of o.precedents.closest) console.log(`  ${String(p.relevance).padStart(2)} ${p.date} ${p.protocol.slice(0, 22).padEnd(22)} ${usd(p.amount_usd).padStart(8)}  ${(p.technique ?? '-').slice(0, 26).padEnd(26)} ${p.reference ? (p.reference.poc ? 'RUNNABLE: ' : 'mech: ') + p.reference.mechanism.slice(0, 64) : ''}`)
console.log(`precedents, largest ${o.precedents.largest.length}:`)
for (const p of o.precedents.largest) console.log(`  ${String(p.relevance).padStart(2)} ${p.date} ${p.protocol.slice(0, 26).padEnd(26)} ${usd(p.amount_usd).padStart(8)}  ${(p.technique ?? '-').slice(0, 30)}`)
console.log(`\nfindings ${o.findings.length}:`)
for (const f of o.findings) {
  console.log(`  [${f.grounded ? 'grounded' : 'NOT GROUNDED'}] ${f.finding}`)
  console.log(`     because: ${f.because}`)
  console.log(`     cites: ${f.precedent_ids.join(', ') || '(none)'}`)
}
console.log(`\nmessage: ${r.message}`)
console.log(`preview: ${JSON.stringify(r.preview)}`)
console.log(`corpus:  ${o.corpus.incidents} incidents, built ${o.corpus.built_at}`)

// the two checks that decide whether this answer is worth its price
const delivered = new Set([...o.precedents.closest, ...o.precedents.largest].map((p: any) => p.id))
const grounded = o.findings.filter((f: any) => f.grounded).length
const bad = o.findings.flatMap((f: any) => f.precedent_ids.filter((id: string) => !delivered.has(id)))
console.log(`\n${grounded}/${o.findings.length} findings grounded, ${bad.length} citations survived that point at nothing (must be 0)`)
console.log(`model cost of this job: ${llm.spentTodayUsd().toFixed(4)} USD against a price of ${(svc.listing.price / 1e6).toFixed(2)} USDC`)
