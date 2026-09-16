/**
 * Diagnostic (2026-09-16): PayAI answered `bazaar: processing` for extract-pdf at 13:48 UTC and never listed it,
 * while the seven other services registered in the same run were listed within seconds. The only structural
 * difference in the eight PAYMENT-REQUIRED payloads: extract-pdf's input schema carries a regex with backslashes
 * (`\d` in the `pages` pattern), the others none.
 *
 * This script re-registers ONE listing at PayAI's /verify exactly the way the desk does (CatalogRegistrar, operator
 * wallet, nothing settled, nothing broadcast), optionally with the 402's extension rewritten, prints PayAI's raw
 * answer, and polls the public catalogue for the entry.
 *
 *   cd packages/agents && npx tsx scripts/probe-payai-catalogue.ts --listing lst_... [--variant no-backslash|control]
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CatalogRegistrar, type RegistrarFetch } from '../src/operator/bazaar.js'
import { CHAINS } from '../src/operator/usdc.js'

const args = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const listing = flag('--listing') ?? 'lst_01M2N6GWB06867BFMSKJATK2QC'
const variant = flag('--variant') ?? 'control'

const envFile = join(homedir(), '.agentsouk-ops', 'operator.env')
if (!existsSync(envFile)) throw new Error(`missing ${envFile}`)
const env: Record<string, string> = {}
for (const line of readFileSync(envFile, 'utf8').split('\n')) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
  if (m) env[m[1]] = m[2]
}
const privateKey = env.OPERATOR_PRIVATE_KEY
if (!privateKey) throw new Error('OPERATOR_PRIVATE_KEY missing')

const baseUrl = 'https://api.agentsouk.dev'
const payai = CHAINS.live.facilitator!

const donorHeader: string | null = variant === 'web-content' ? await (async () => {
  const r = await fetch(`${baseUrl}/v1/x402/lst_01M1XYP3M9411Q18YT0MDB3V6S`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ url: 'https://example.com/', max_chars: 5000 }) })
  await r.text()
  return r.headers.get('payment-required')
})() : null

function rewriteHeader(b64: string): string {
  const pr = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as Record<string, unknown>
  let raw = JSON.stringify(pr)
  if (variant === 'web-content') {
    const donor = JSON.parse(Buffer.from(donorHeader!, 'base64').toString('utf8')) as Record<string, unknown>
    const res = pr.resource as Record<string, unknown>
    const dres = donor.resource as Record<string, unknown>
    res.description = dres.description
    res.tags = dres.tags
    pr.extensions = donor.extensions
    raw = JSON.stringify(pr)
    console.log('[variant web-content] extract-pdf URL/terms with extract-web description, tags and bazaar extension')
  }
  if (variant === 'no-backslash') {
    const before = raw
    raw = raw.replace(/\\\\d/g, '[0-9]')
    console.log(`[variant no-backslash] replaced ${(before.match(/\\\\d/g) ?? []).length} occurrences of \\d`)
  } else if (variant === 'no-schema') {
    const ext = (pr.extensions as { bazaar: Record<string, unknown> }).bazaar
    delete ext.schema
    raw = JSON.stringify(pr)
    console.log('[variant no-schema] dropped extensions.bazaar.schema')
  } else if (variant === 'no-pattern') {
    raw = raw.replace(/"pattern":"[^"]*",?/g, '')
    console.log('[variant no-pattern] dropped every "pattern" key')
  } else if (variant === 'no-output') {
    const ext = (pr.extensions as { bazaar: Record<string, unknown> }).bazaar
    delete (ext.info as Record<string, unknown>).output
    raw = JSON.stringify(pr)
    console.log('[variant no-output] dropped extensions.bazaar.info.output')
  } else if (variant === 'min') {
    const ext = (pr.extensions as { bazaar: Record<string, unknown> }).bazaar
    delete (ext.info as Record<string, unknown>).output
    delete ext.schema
    raw = JSON.stringify(pr)
    console.log('[variant min] info.input only, no output, no schema')
  } else if (variant === 'no-tags') {
    const r = pr.resource as Record<string, unknown>
    r.tags = ['documents', 'text']
    r.description = 'Fetch a document and extract its text per page'
    raw = JSON.stringify(pr)
    console.log('[variant no-tags] tags without pdf, description without PDF')
  } else if (variant === 'no-w3url') {
    raw = raw.replace(/https:\/\/www\.w3\.org\/[^"]*dummy\.pdf/g, 'https://example.com/report.pdf')
    console.log('[variant no-w3url] example URL replaced by example.com')
  }
  console.log(`payload after rewrite: ${raw.length} bytes, backslashes: ${(raw.match(/\\\\/g) ?? []).length}`)
  return Buffer.from(raw, 'utf8').toString('base64')
}

const fetchImpl: RegistrarFetch = async (url, init) => {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) })
  const text = await res.text()
  if (url.startsWith(`${baseUrl}/v1/x402?`)) {
    const body = JSON.parse(text) as { services: { listing_id: string }[] }
    const one = body.services.filter((s) => s.listing_id === listing)
    if (!one.length) throw new Error(`listing ${listing} not in the index`)
    console.log(`index: ${body.services.length} services, probing ${listing} (${(one[0] as { title?: string }).title})`)
    return { status: res.status, headers: res.headers, text: async () => JSON.stringify({ ...body, services: one }) }
  }
  if (url === `${baseUrl}/v1/x402/${listing}`) {
    const hdr = res.headers.get('payment-required')
    if (!hdr) throw new Error('no PAYMENT-REQUIRED header')
    const rewritten = variant === 'control' ? hdr : rewriteHeader(hdr)
    const headers = new Headers(res.headers)
    headers.set('payment-required', rewritten)
    return { status: res.status, headers, text: async () => text }
  }
  if (url.startsWith(payai)) {
    console.log(`PayAI ${url} -> HTTP ${res.status}`)
    console.log(`  body: ${text.slice(0, 400)}`)
    const ext = res.headers.get('extension-responses')
    console.log(`  extension-responses: ${ext ? Buffer.from(ext, 'base64').toString('utf8') : '(none)'}`)
    return { status: res.status, headers: res.headers, text: async () => text }
  }
  return { status: res.status, headers: res.headers, text: async () => text }
}

const registrar = new CatalogRegistrar({
  baseUrl,
  env: 'live',
  chain: CHAINS.live,
  privateKey,
  facilitators: [{ name: 'payai', url: payai }],
  fetchImpl,
  userAgent: 'agentsouk-agents probe-payai-catalogue (diagnostic, one listing, /verify only)',
  log: (msg, extra) => console.log(`[registrar] ${msg}`, extra ? JSON.stringify(extra) : ''),
})

console.log(`operator wallet ${registrar.address}, variant ${variant}`)
const regs = await registrar.run()
console.log('registrations:', JSON.stringify(regs, null, 1))

async function listed(): Promise<{ found: boolean; lastUpdated?: string; pages: number }> {
  let off = 0
  let pages = 0
  for (;;) {
    const r = await fetch(`${payai}/discovery/resources?limit=500&offset=${off}`, { signal: AbortSignal.timeout(60_000) })
    const d = (await r.json()) as { items?: { resource: string; lastUpdated?: string }[]; pagination?: { total?: number } }
    pages++
    const hit = (d.items ?? []).find((it) => it.resource === `${baseUrl}/v1/x402/${listing}`)
    if (hit) return { found: true, lastUpdated: hit.lastUpdated, pages }
    off += 500
    if (!d.items?.length || pages >= 3) return { found: false, pages } // newest first: three pages are plenty
  }
}

const checks = Number(flag('--checks') ?? 6)
for (let i = 0; i < checks; i++) {
  await new Promise((r) => setTimeout(r, i === 0 ? 10_000 : 15_000))
  const l = await listed()
  console.log(`${new Date().toISOString()} catalogue check ${i + 1}: ${l.found ? `LISTED (lastUpdated ${l.lastUpdated})` : 'not listed'} (${l.pages} pages read)`)
  if (l.found) break
}
