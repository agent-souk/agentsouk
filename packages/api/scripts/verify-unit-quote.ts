/**
 * Would the purchases of 2026-09-17 go through today? (ADR-77)
 *
 * Usage (from packages/api):  npx tsx scripts/verify-unit-quote.ts [base_url]
 *
 * The only paying stranger this marketplace ever had came back in the night of 2026-09-17 and ordered
 * extract-structured four times, with texts of 1,122 / 1,316 / 1,529 / 2,009 characters and no ?units= - which
 * is what its client had always sent. ADR-72 had just made one unit 1,000 characters instead of 10,000, so the
 * 402 quoted one unit, it paid, and the seller declined all four ("order 2 units for 1316 characters").
 *
 * This asks the live endpoint for the terms of exactly those four inputs and checks that the quote now covers
 * them. It sends no payment and creates no record: a 402 is an offer, and reading an offer costs nothing.
 */
const BASE = process.argv[2] ?? 'https://api.agentsouk.dev'
const SIZES = [1122, 1316, 1529, 2009]

type Accept = { amount?: string; maxAmountRequired?: string }

async function main() {
  const index = (await (await fetch(`${BASE}/v1/x402`)).json()) as { services: { listing_id: string; title: string; price: number; pricing_model: string; unit_name?: string; unit_basis?: unknown; price_note?: string }[] }
  const service = index.services.find((s) => s.title.startsWith('Extract structured JSON'))
  if (!service) throw new Error('extract-structured is not in the live x402 index')
  console.log(`listing ${service.listing_id}`)
  console.log(`price   ${service.price} minor units per ${service.unit_name}`)
  console.log(`rule    ${JSON.stringify(service.unit_basis)}`)
  console.log(`note    ${service.price_note}\n`)
  if (!service.unit_basis) throw new Error('the listing publishes no unit_basis: the API or the seller is not deployed yet')

  let failed = 0
  for (const chars of SIZES) {
    const body = { text: 'x'.repeat(chars), schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } }
    const res = await fetch(`${BASE}/v1/x402/${service.listing_id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (res.status !== 402) throw new Error(`expected 402 for ${chars} characters, got ${res.status}`)
    const header = res.headers.get('payment-required')
    const terms = header ? JSON.parse(Buffer.from(header, 'base64').toString('utf8')) : null
    const accept: Accept = terms?.accepts?.[0] ?? {}
    const amount = Number(accept.amount ?? accept.maxAmountRequired ?? 0)
    const expected = service.price * Math.ceil(chars / 1000)
    const ok = amount === expected
    if (!ok) failed++
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${String(chars).padStart(4)} characters -> ${amount} minor units (expected ${expected}) · ${terms?.resource?.description ?? ''}`)
  }
  console.log(failed === 0 ? '\nUNIT QUOTE PASSED: the four inputs of 2026-09-17 are now quoted for what they need.' : `\nUNIT QUOTE FAILED: ${failed} of ${SIZES.length} inputs are still quoted as one unit.`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
