/**
 * Live smoke test of the LLM services on the sandbox: a throwaway buyer orders one job per service from
 * souk-services and prints the preview. Costs a few cents of model usage. Usage: npx tsx scripts/smoke-llm.ts [base]
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AgentSouk } from 'agentsouk'
const base = process.argv[2] ?? 'https://api.agentsouk.dev'

// ADR-44: this throwaway buyer is ours. Registered through the public API it carries first_party = false, so its
// searches and the jobs it starts land in the demand signal and the outsider counts as if a stranger had done
// them. A test harness must not be able to move a number we publish as evidence. No admin token, no run.
const adminFile = join(homedir(), '.agentsouk-ops', 'agentsouk-api.env')
if (!existsSync(adminFile)) { console.error(`FAIL ${adminFile} missing: this script marks its throwaway buyer as platform-operated (ADR-44) and will not register one without the admin token`); process.exit(1) }
const admin = readFileSync(adminFile, 'utf8').match(/^ADMIN_TOKEN=(.+)$/m)?.[1]?.trim()
if (!admin) { console.error(`FAIL ADMIN_TOKEN missing in ${adminFile}: refusing to register a buyer that would be counted as an outsider (ADR-44)`); process.exit(1) }

const reg = await (await fetch(`${base}/v1/agents`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'LLM Smoke Buyer', description: 'throwaway buyer for the first-party LLM smoke test (operated by Agent Souk)' }) })).json() as any
const adminPost = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': admin! }, body: JSON.stringify(body) })
const flagged = await adminPost(`/v1/admin/agents/${reg.agent.id}/first-party`, { first_party: true })
if (!flagged.ok) { console.error('FAIL could not mark the throwaway buyer as platform-operated (ADR-44):', await flagged.text()); process.exit(1) }
const c = new AgentSouk({ baseUrl: base, apiKey: reg.api_keys.test })
const orders: Record<string, { input: Record<string, unknown>; units?: number }> = {
  'souk:translate': { input: { text: 'Your order {order_id} has shipped and should arrive within **3 business days**.', target_language: 'de', tone: 'formal' } },
  'souk:summarize': { input: { url: 'https://example.com/', max_words: 40, style: 'bullets' } },
  'souk:extract-structured': { input: { text: 'Invoice #4711 from Acme GmbH, dated 2026-09-01, total 1,250.00 EUR, due in 30 days. Contact: billing@acme.example.', schema: { type: 'object', required: ['invoice_number', 'vendor', 'total'], properties: { invoice_number: { type: 'string' }, vendor: { type: 'string' }, date: { type: 'string' }, total: { type: 'number' }, currency: { type: 'string' } } } } },
  'souk:classify': { input: { items: ['My invoice shows a double charge for August.', 'Do you offer a student discount?'], labels: ['billing', 'sales', 'support', 'other'] } },
}
try {
  const listings = await c.listings.search({ q: 'Agent Souk', limit: 50 })
  const jobs: { tag: string; id: string }[] = []
  for (const [tag, o] of Object.entries(orders)) {
    const l = listings.data.find((x) => x.tags.includes(tag))
    if (!l) { console.log('MISSING listing', tag); continue }
    const j = await c.jobs.create({ listing_id: l.id, input: o.input, units: o.units ?? 1 })
    console.log('ordered', tag, j.id, 'price', j.price)
    jobs.push({ tag, id: j.id })
  }
  for (const j of jobs) {
    const done = await c.waitForJob(j.id, { until: ['delivered', 'declined', 'cancelled'], intervalMs: 3000, timeoutMs: 180_000 })
    console.log(j.tag, '->', done.status, JSON.stringify(done.output_preview ?? done.cancel_reason).slice(0, 400))
    if (done.status === 'delivered') await c.jobs.cancel(j.id, 'smoke test, walking away')
  }
} finally {
  await c.agents.delete(reg.agent.handle)
  console.log('throwaway buyer deleted')
}
