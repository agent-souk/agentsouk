/**
 * Smoke test of the bounty desk's judge against the REAL model (checkpoint 51 lesson: the judge tests run with a
 * fake client, so a JSON schema the constrained decoder rejects only fails in production). Runs the three judge
 * calls (proposal score, preview triage, delivery verdict) with fixtures for one catalogue entry and checks the
 * shapes. Costs a few cents. Run before every deploy of packages/agents:
 *
 *   npx tsx scripts/smoke-judge.ts [--key sandbox-walkthrough] [--all]
 *
 * ANTHROPIC_API_KEY from the environment or ~/.agentsouk-ops/agents.env. Exit code 1 on any failure.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Llm } from '../src/llm.js'
import { CATALOG, type BountySpec } from '../src/operator/catalog.js'
import { Judge, type ProposalFacts, type PreviewFacts, type DeliveryFacts } from '../src/operator/judge.js'

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith('--') ? process.argv[i + 1]! : fallback
}
const flag = (name: string) => process.argv.includes(`--${name}`)

let apiKey = process.env.ANTHROPIC_API_KEY
if (!apiKey) {
  const envFile = join(homedir(), '.agentsouk-ops', 'agents.env')
  if (existsSync(envFile)) apiKey = readFileSync(envFile, 'utf8').match(/^ANTHROPIC_API_KEY=(.+)$/m)?.[1]?.trim()
}
if (!apiKey) {
  console.error('ANTHROPIC_API_KEY missing (environment or ~/.agentsouk-ops/agents.env)')
  process.exit(1)
}

const wantedKey = arg('key', 'sandbox-walkthrough')!
const wanted = CATALOG.find((s) => s.key === wantedKey)
if (!flag('all') && !wanted) {
  console.error(`unknown --key ${wantedKey}; known: ${CATALOG.map((s) => s.key).join(', ')}`)
  process.exit(1)
}
const specs = flag('all') ? CATALOG : [wanted!]
const llm = new Llm({ apiKey, dailyBudgetUsd: 2 })
const judge = new Judge(llm)

/** Fixtures that look like a plausible, mediocre seller so every branch of each schema is exercised. */
function fixtures(spec: BountySpec): { proposal: ProposalFacts; preview: PreviewFacts; delivery: DeliveryFacts } {
  const receipt = { receipt: { object: 'receipt', job_id: 'job_01SMOKE', env: 'test', price: 10000 }, signature: { alg: 'EdDSA', kid: 'smoke', sig: 'AA' } }
  const preview = spec.key === 'sandbox-walkthrough' ? { client_kind: 'http', steps: 9, friction: 3, top_friction: 'The 402 payment terms do not say which network the test key uses until you read /v1/payments.', receipt } : spec.key === 'framework-integration' ? { framework: 'langgraph', repo_url: 'https://github.com/example/agentsouk-langgraph', receipt } : { title: 'Idempotency key replay across environments', severity: 'medium', endpoint: 'POST /v1/jobs', summary: 'A test-key idempotency key is accepted again with a live key and returns the cached test response.', reproduction: '1. POST /v1/jobs with Idempotency-Key K using as_test_ 2. same with as_live_ -> 200 with the test body' }
  return {
    proposal: { price: Math.round(spec.budget_max * 0.8), payment: 'on_delivery', message: `I will run the ${spec.title.toLowerCase()} using plain HTTP with python-requests, covering registration, wallet binding, one listing, one job as seller, one as buyer, a bounty proposal, inbox and events, and the 402 terms. Delivery in 2 days.`, seller: { handle: 'smoke-seller-3f2a', trust_tier: 0, reputation: { score: null, completed_jobs: 0 } } },
    preview: { preview, message: 'Delivered. Preview carries the counts and the signed receipt of job job_01SMOKE.', seller_handle: 'smoke-seller-3f2a', paid_distinct: [], paid_summaries: [], previous: [] },
    delivery: { output: { ...preview, steps: [{ action: 'register', endpoint_or_tool: 'POST /v1/agents', ok: true, note: '201' }], friction: [{ where: 'GET /v1/payments', what: 'network not named in the 402 body', severity: 'medium', suggestion: 'add network to the 402 terms' }], bugs: [], docs_rating: 4, minutes: 55 }, message: null, seller_handle: 'smoke-seller-3f2a', checks: [{ check: 'schema', ok: true, detail: 'output matches deliverable_schema' }], revisions_left: 1 },
  }
}

let failed = false
const check = (what: string, ok: boolean, detail: unknown) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}: ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 300)}`)
  if (!ok) failed = true
}

for (const spec of specs) {
  console.log(`\n== ${spec.key} ==`)
  const f = fixtures(spec)
  try {
    const s = await judge.scoreProposal(spec, f.proposal)
    check('scoreProposal', Number.isInteger(s.score) && s.score >= 0 && s.score <= 100 && typeof s.reasons === 'string' && Array.isArray(s.red_flags) && typeof s.question === 'string', { score: s.score, question: s.question.slice(0, 120), red_flags: s.red_flags })
  } catch (e) {
    check('scoreProposal', false, String((e as Error).message ?? e))
  }
  try {
    const t = await judge.triagePreview(spec, f.preview)
    check('triagePreview', ['pay', 'ask', 'walk_away'].includes(t.decision) && typeof t.message === 'string', { decision: t.decision, message: t.message.slice(0, 160) })
  } catch (e) {
    check('triagePreview', false, String((e as Error).message ?? e))
  }
  try {
    const v = await judge.evaluateDelivery(spec, f.delivery)
    check('evaluateDelivery', ['accept', 'revise', 'dispute'].includes(v.decision) && v.rating >= 1 && v.rating <= 5 && Array.isArray(v.rubric_scores), { decision: v.decision, rating: v.rating, rubric: v.rubric_scores.length })
  } catch (e) {
    check('evaluateDelivery', false, String((e as Error).message ?? e))
  }
}
console.log(`\nmodel spend: $${llm.spentTodayUsd().toFixed(4)} · ${failed ? 'FAILED' : 'PASSED'}`)
process.exit(failed ? 1 : 0)
