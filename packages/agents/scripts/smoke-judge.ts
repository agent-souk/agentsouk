/**
 * Smoke test of the bounty desk's judge against the REAL model (checkpoint 51 lesson: the judge tests run with a
 * fake client, so a JSON schema the constrained decoder rejects only fails in production). Runs the three judge
 * calls (proposal score, preview triage, delivery verdict) with fixtures for one catalogue entry, the first-buy
 * calls (listing verdict, derived input, ADR-35 screening on both sides of the rule) and checks the shapes. Costs a few cents. Run before every deploy of packages/agents:
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
    // sized like the first real report (22 steps, 3 frictions with request ids): the verdict must fit the token allowance
    delivery: {
      output: {
        ...preview,
        steps: Array.from({ length: 22 }, (_, i) => ({ action: `step ${i + 1}: ${['register', 'read profile', 'bind wallet', 'list listings', 'create listing', 'create job', 'accept', 'deliver', 'receipt', 'pay terms', 'inbox', 'events', 'cancel', 'patch listing', 'search bounties', 'propose', 'read thread', 'message', 'feed', 'leaderboard', 'memory', 'schedule'][i]}`, endpoint_or_tool: ['POST /v1/agents', 'GET /v1/agents/me', 'POST /v1/agents/me/wallet-address', 'GET /v1/listings', 'POST /v1/listings', 'POST /v1/jobs', 'POST /v1/jobs/{id}/accept', 'POST /v1/jobs/{id}/deliver', 'GET /v1/jobs/{id}/receipt', 'POST /v1/jobs/{id}/pay', 'GET /v1/inbox', 'GET /v1/events', 'POST /v1/jobs/{id}/cancel', 'PATCH /v1/listings/{id}', 'GET /v1/bounties', 'POST /v1/bounties/{id}/proposals', 'GET /v1/threads/{id}/messages', 'POST /v1/threads/{id}/messages', 'GET /v1/feed', 'GET /v1/leaderboard', 'PUT /v1/memory/{key}', 'POST /v1/schedules'][i], ok: i !== 9, note: i === 9 ? 'HTTP 402 with terms: amount 10000, pay_to 0xc059..., network eip155:84532, asset 0x036C...; no Sepolia USDC available so the job was cancelled afterwards (request_id req_01SMOKE9)' : `HTTP ${i === 0 || i === 4 || i === 5 ? 201 : 200} in ${120 + i * 7} ms, response shape as documented (request_id req_01SMOKE${i})` })),
        friction: [
          { where: 'POST /v1/listings response how_to_order.body_example', what: 'For a listing with input_schema.required=[text] and no example_input the ready-to-send body contained input:{}; following it produced 400 invalid_request missing=[text] (request_id req_01SMOKEA).', severity: 'medium', suggestion: 'Only label an order example ready-to-send if it validates against input_schema, or generate typed placeholders for required fields.' },
          { where: 'POST /v1/jobs next_steps for a zero-price on_delivery listing', what: 'Creation of a free job returned payment.status=none but next_steps still said "After delivery: pay to reveal it" and instructed a USDC transfer; the actual delivery was unsealed and completed without payment.', severity: 'medium', suggestion: 'Gate the pay-to-reveal entry on price>0 and tell the buyer to review the unsealed delivery instead.' },
          { where: 'GET /v1/bounties/{id}/proposals', what: 'A pending proposal carries created_at and price but no earliest review time or waiting reason; the 12-hour consideration window is only discoverable from the operator source code.', severity: 'low', suggestion: 'Return earliest_review_at and waiting_reason alongside pending proposals.' },
        ],
        bugs: [{ where: 'POST /v1/listings response how_to_order.body_example', what: 'ready-to-send body omits required input fields', severity: 'medium', suggestion: 'validate the example against input_schema' }],
        docs_rating: 4,
        minutes: 6.4,
      },
      message: 'Delivered. The receipt is from a disclosed same-owner zero-price sandbox fixture job; no on-chain transaction is claimed.',
      seller_handle: 'smoke-seller-3f2a',
      checks: [{ check: 'schema', ok: true, detail: 'output matches deliverable_schema' }, { check: 'receipt', ok: true, detail: 'valid platform receipt for job job_01SMOKE (test, completed), agent is a party' }],
      revisions_left: 1,
    },
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
// first-buy programme (ADR-31): the listing verdict has its own prompt and must also survive the real constrained decoder
console.log('\n== first-buy listing verdict ==')
try {
  const v = await judge.evaluateListingDelivery({
    listing: { title: 'HTML to structured JSON', description: 'Send {html}; get {title, headings[], links[]} extracted from the page.', category: 'data', price: 20_000, input_schema: { type: 'object', required: ['html'] }, output_schema: { type: 'object', required: ['title', 'headings', 'links'] }, example_input: { html: '<h1>Hi</h1><a href="/x">x</a>' }, example_output: { title: 'Hi', headings: ['Hi'], links: ['/x'] } },
    input: { html: '<html><head><title>Smoke</title></head><body><h1>Welcome</h1><h2>Docs</h2><a href="https://example.com/a">A</a></body></html>' },
    output: { title: 'Smoke', headings: ['Welcome', 'Docs'], links: ['https://example.com/a'] },
    message: null,
    seller_handle: 'smoke-seller-9c1d',
    revisions_left: 1,
  })
  check('evaluateListingDelivery', ['accept', 'revise', 'dispute'].includes(v.decision) && v.rating >= 1 && v.rating <= 5, { decision: v.decision, rating: v.rating, message: v.message.slice(0, 120) })
} catch (e) {
  check('evaluateListingDelivery', false, String((e as Error).message ?? e))
}
// first-buy programme: the order input the desk derives when a seller gave no usable example
try {
  const raw = await judge.inputForListing({
    title: 'HTML to structured JSON',
    description: 'Send {html}; get {title, headings[], links[]} extracted from the page. Deterministic parser, no LLM.',
    category: 'data',
    input_schema: { type: 'object', required: ['html'], properties: { html: { type: 'string', description: 'HTML document to parse' } } },
    example_input: null,
    output_schema: { type: 'object', required: ['title', 'headings', 'links'] },
  })
  const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : null
  const html = typeof parsed?.html === 'string' ? parsed.html : ''
  check('inputForListing', !!parsed && html.length > 20 && !/^<[^<>]{1,160}>$/.test(html.trim()) && Object.keys(parsed).length === 1, { keys: parsed ? Object.keys(parsed) : null, html: html.slice(0, 90) })
} catch (e) {
  check('inputForListing', false, String((e as Error).message ?? e))
}
// first-buy screening (ADR-35): the published rule against the real model, one listing on each side of it
console.log('\n== first-buy screening ==')
try {
  const trivial = await judge.screenListing({
    title: 'YAML → JSON (safe agent parse)',
    description: 'Send {yamlText}. Returns {data, type, method=yaml_safe_v1, bytesIn, notes}. Safe load only (no custom tags/exec). Max 200000 chars. Not LLM.',
    category: 'data',
    price: 20_000,
    input_schema: { type: 'object', required: ['yamlText'] },
    output_schema: { type: 'object', required: ['data'] },
    example_input: { yamlText: 'a: 1' },
    example_output: { data: { a: 1 } },
    already_bought: [{ title: 'TOML → JSON (safe agent parse)', category: 'data' }],
  })
  check('screenListing trivial', trivial.verdict !== 'eligible' && trivial.reason.length > 10, trivial)
  const real = await judge.screenListing({
    title: 'x402 endpoint probe (Base / multi-rail)',
    description: 'Send {url}. Returns whether the endpoint speaks HTTP 402 / x402: status codes, Payment-Required header (base64-decoded accepts), parsed payTo/network/asset/amount, facilitator hints. Live network probe from our runner.',
    category: 'data',
    price: 100_000,
    input_schema: { type: 'object', required: ['url'] },
    output_schema: { type: 'object', required: ['speaks_x402'] },
    example_input: { url: 'https://example.com/api' },
    example_output: { speaks_x402: false },
    already_bought: [{ title: 'TOML → JSON (safe agent parse)', category: 'data' }],
  })
  check('screenListing real', real.verdict === 'eligible', real)
} catch (e) {
  check('screenListing', false, String((e as Error).message ?? e))
}
console.log(`\nmodel spend: $${llm.spentTodayUsd().toFixed(4)} · ${failed ? 'FAILED' : 'PASSED'}`)
process.exit(failed ? 1 : 0)
