import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { freshApp, call, createTestAgent, type TestAgent } from '../../test/setup.js'
import { installFakeChain, type FakeChain } from '../../test/chain.js'
import { db } from '../../db/client.js'
import { agents, jobs, listings } from '../../db/schema.js'
import { _setSettleFetchForTests } from './routes.js'
import type { App } from '../../app.js'

let app: App
let chain: FakeChain
const PRICE = 250_000

beforeEach(async () => {
  app = await freshApp()
  chain = installFakeChain('test')
})
afterEach(() => _setSettleFetchForTests(null))

/** A platform-operated seller with one priced listing, as souk-services is on live. */
async function firstPartySeller(): Promise<{ seller: TestAgent; listingId: string }> {
  const seller = await createTestAgent(app, { name: 'Souk Services' })
  await db().update(agents).set({ firstParty: true }).where(eq(agents.id, seller.agent.id))
  const r = await call(app, 'POST', '/v1/listings', {
    key: seller.api_keys.test,
    body: { title: 'Translate text', description: 'Translate text between languages, preserving formatting and tone.', category: 'language', pricing_model: 'fixed', price: PRICE, input_schema: { type: 'object', required: ['text'] }, turnaround_seconds: 600, accept_timeout_seconds: 600 },
  })
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  return { seller, listingId: r.body.id as string }
}

/** What the seller runtime does on live: pick the job up and deliver it, within seconds. */
function deliverWhenOrdered(seller: TestAgent, listingId: string, output: unknown = { text: 'Hallo Welt' }) {
  let stop = false
  const done = (async () => {
    for (let i = 0; i < 60 && !stop; i++) {
      const job = await db().query.jobs.findFirst({ where: and(eq(jobs.listingId, listingId), eq(jobs.status, 'open')) })
      if (job) {
        await call(app, 'POST', `/v1/jobs/${job.id}/accept`, { key: seller.api_keys.test, body: {} })
        await call(app, 'POST', `/v1/jobs/${job.id}/deliver`, { key: seller.api_keys.test, body: { output } })
        return job.id
      }
      await new Promise((r) => setTimeout(r, 25))
    }
    return null
  })()
  return { done, cancel: () => (stop = true) }
}

/** The x402 payment payload a buyer builds after reading the 402, base64 as the header carries it. */
const paymentHeader = (from: string, to: string, value: number, validForSeconds = 900) =>
  Buffer.from(
    JSON.stringify({
      x402Version: 2,
      scheme: 'exact',
      payload: {
        signature: '0x' + 'ab'.repeat(65),
        authorization: { from, to, value: String(value), validAfter: '0', validBefore: String(Math.floor(Date.now() / 1000) + validForSeconds), nonce: '0x' + '11'.repeat(32) },
      },
    }),
  ).toString('base64')

const buy = (listingId: string, header?: string, body: Record<string, unknown> = { text: 'Hello world' }) =>
  call(app, 'POST', `/v1/x402/${listingId}?env=test`, { body, headers: header ? { 'x-payment': header } : {} })

/**
 * ADR-48. The endpoint exists to answer one question - does any agent out there pay for anything - and it is
 * hemmed in by two properties that have to hold in code, not in prose: it sells only what we operate ourselves,
 * and it submits the buyer's authorization only once the work exists.
 */
describe('x402 endpoint for platform-operated listings (ADR-48)', () => {
  it('answers 402 with the v2 terms in the PAYMENT-REQUIRED header and the v1 terms in the body', async () => {
    const { listingId } = await firstPartySeller()
    const r = await buy(listingId)
    expect(r.status).toBe(402)

    // v2 (current clients): the whole object, base64, in the header. This is the only place they look.
    const header = r.headers.get('payment-required')
    expect(header).toBeTruthy()
    expect(header!).toMatch(/^[A-Za-z0-9+/]*={0,2}$/) // standard base64, never base64url: the client enforces it
    const v2 = JSON.parse(Buffer.from(header!, 'base64').toString('utf8'))
    expect(v2.x402Version).toBe(2)
    expect(v2.resource.url).toContain(`/v1/x402/${listingId}`)
    expect(v2.accepts[0]).toMatchObject({ scheme: 'exact', amount: String(PRICE), network: 'eip155:84532' })
    expect(v2.accepts[0].payTo).toBeTruthy()
    expect(v2.extensions.bazaar).toBeTruthy()
    expect(r.headers.get('access-control-expose-headers')).toContain('PAYMENT-REQUIRED')

    // v1 (the older generation): the body, in the shape its schema requires - a different name for the price,
    // a different name for the network, and resource/description/mimeType inside the entry.
    expect(r.body.x402Version).toBe(1)
    expect(r.body.accepts).toHaveLength(1)
    expect(r.body.accepts[0]).toMatchObject({ scheme: 'exact', maxAmountRequired: String(PRICE), network: 'base-sepolia', mimeType: 'application/json' })
    expect(r.body.accepts[0].resource).toContain(`/v1/x402/${listingId}`)
    expect(r.body.accepts[0].description).toBeTruthy()
    // the published v1 example prints outputSchema: null, but the shipped schema is optional and rejects a null
    expect('outputSchema' in r.body.accepts[0]).toBe(false)
    expect(String(r.body.error)).toContain('costs you nothing')
    expect(String(r.body.error)).toContain('PAYMENT-SIGNATURE')
  })

  it('takes the payment from PAYMENT-SIGNATURE as well as from X-PAYMENT', async () => {
    const { seller, listingId } = await firstPartySeller()
    const wallet = '0x' + '9'.repeat(40)
    _setSettleFetchForTests(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ success: true, transaction: chain.pay(wallet, seller.wallet_address!, PRICE) }) }))
    const runtime = deliverWhenOrdered(seller, listingId)
    const r = await call(app, 'POST', `/v1/x402/${listingId}?env=test`, { body: { text: 'Hello' }, headers: { 'payment-signature': paymentHeader(wallet, seller.wallet_address!, PRICE) } })
    await runtime.done
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    // both names on the way back, too: v2 reads PAYMENT-RESPONSE, v1 read X-PAYMENT-RESPONSE
    expect(r.headers.get('payment-response')).toBeTruthy()
    expect(r.headers.get('x-payment-response')).toBe(r.headers.get('payment-response'))
  })

  it('refuses a listing we do not operate, and says where the payment would otherwise go', async () => {
    const outsider = await createTestAgent(app, { name: 'Outside seller' })
    const l = await call(app, 'POST', '/v1/listings', {
      key: outsider.api_keys.test,
      body: { title: 'Live DNS probe', description: 'Probe SPF, DKIM and DMARC for a domain and report what resolves.', category: 'data', pricing_model: 'fixed', price: PRICE, input_schema: { type: 'object' }, turnaround_seconds: 600, accept_timeout_seconds: 600 },
    })
    const r = await buy(l.body.id, paymentHeader('0x' + '1'.repeat(40), '0x' + '2'.repeat(40), PRICE))
    expect(r.status).toBe(409)
    expect(r.body.error.code).toBe('x402_first_party_only')
    expect(r.body.error.hint).toContain('/v1/jobs')
  })

  it('does the work, then settles, and hands back the output with a receipt', async () => {
    const { seller, listingId } = await firstPartySeller()
    const wallet = '0x' + '7'.repeat(40)
    let settled: { url: string; body: string } | null = null
    _setSettleFetchForTests(async (url, init) => {
      settled = { url, body: init.body }
      // the facilitator broadcasts the buyer's authorization: the USDC moves buyer -> seller
      const tx = chain.pay(wallet, seller.wallet_address!, PRICE)
      return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, transaction: tx }) }
    })

    const runtime = deliverWhenOrdered(seller, listingId)
    const r = await buy(listingId, paymentHeader(wallet, seller.wallet_address!, PRICE))
    await runtime.done

    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.output).toEqual({ text: 'Hallo Welt' })
    expect(r.body.paid).toMatchObject({ amount: PRICE, payer: wallet, pay_to: seller.wallet_address })
    expect(r.body.receipt_url).toContain('/receipt')
    expect(settled).not.toBeNull()
    expect(settled!.url).toContain('/settle')
    // the settle body carries the buyer's own signature, unchanged
    expect(JSON.parse(settled!.body).paymentPayload.payload.signature).toBe('0x' + 'ab'.repeat(65))

    // the payment is a real settlement on a real job, with the wallet as the buyer's identity
    const job = await db().query.jobs.findFirst({ where: eq(jobs.id, r.body.job_id) })
    expect(job!.status).toBe('completed')
    const buyer = await db().query.agents.findFirst({ where: eq(agents.id, job!.buyerAgentId) })
    expect(buyer!.walletAddress).toBe(wallet)
  })

  it('charges nothing when the seller never delivers', async () => {
    const { seller, listingId } = await firstPartySeller()
    let settleCalls = 0
    _setSettleFetchForTests(async () => {
      settleCalls += 1
      return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, transaction: '0x' + '9'.repeat(64) }) }
    })
    // nobody delivers; make the wait short by cancelling the job from the seller side
    const giveUp = (async () => {
      for (let i = 0; i < 80; i++) {
        const job = await db().query.jobs.findFirst({ where: and(eq(jobs.listingId, listingId), eq(jobs.status, 'open')) })
        if (job) return call(app, 'POST', `/v1/jobs/${job.id}/decline`, { key: seller.api_keys.test, body: { reason: 'not today' } })
        await new Promise((r) => setTimeout(r, 25))
      }
      return null
    })()

    const r = await buy(listingId, paymentHeader('0x' + '8'.repeat(40), seller.wallet_address!, PRICE))
    await giveUp
    expect(r.status).toBe(409)
    expect(r.body.error.code).toBe('x402_not_delivered')
    expect(r.body.error.hint).toContain('Nothing was charged')
    expect(settleCalls).toBe(0)
  })

  it('rejects an authorization made out to somebody else, or for too little, or already expired', async () => {
    const { seller, listingId } = await firstPartySeller()
    const wallet = '0x' + '7'.repeat(40)
    const wrongPayee = await buy(listingId, paymentHeader(wallet, '0x' + '3'.repeat(40), PRICE))
    expect(wrongPayee.status).toBe(400)
    expect(String(wrongPayee.body.error.message)).toContain('must be the seller wallet')

    const tooLittle = await buy(listingId, paymentHeader(wallet, seller.wallet_address!, PRICE - 1))
    expect(tooLittle.status).toBe(400)
    expect(String(tooLittle.body.error.message)).toContain('at least')

    const expired = await buy(listingId, paymentHeader(wallet, seller.wallet_address!, PRICE, -10))
    expect(expired.status).toBe(400)
    expect(String(expired.body.error.message)).toContain('expired')
  })

  it('refuses a free listing and a quote listing rather than putting a meaningless price in a 402', async () => {
    const seller = await createTestAgent(app, { name: 'Souk Services' })
    await db().update(agents).set({ firstParty: true }).where(eq(agents.id, seller.agent.id))
    const free = await call(app, 'POST', '/v1/listings', {
      key: seller.api_keys.test,
      body: { title: 'Validate JSON', description: 'Validate a JSON document against a JSON Schema and report every error.', category: 'data', pricing_model: 'fixed', price: 0, input_schema: { type: 'object' }, turnaround_seconds: 600, accept_timeout_seconds: 600 },
    })
    expect((await buy(free.body.id)).body.error.code).toBe('x402_needs_a_price')

    const quote = await call(app, 'POST', '/v1/listings', {
      key: seller.api_keys.test,
      body: { title: 'Research brief', description: 'A researched brief on one specific question, with sources and a stated confidence.', category: 'research', pricing_model: 'quote', input_schema: { type: 'object' }, turnaround_seconds: 600, accept_timeout_seconds: 600 },
    })
    expect((await buy(quote.body.id)).body.error.code).toBe('x402_needs_a_price')
  })

  it('reuses the agent behind a wallet instead of registering a new one every time', async () => {
    const { seller, listingId } = await firstPartySeller()
    const wallet = '0x' + '7'.repeat(40)
    _setSettleFetchForTests(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ success: true, transaction: chain.pay(wallet, seller.wallet_address!, PRICE) }) }))

    for (let i = 0; i < 2; i++) {
      const runtime = deliverWhenOrdered(seller, listingId)
      const r = await buy(listingId, paymentHeader(wallet, seller.wallet_address!, PRICE))
      await runtime.done
      expect(r.status, JSON.stringify(r.body)).toBe(200)
    }
    const bound = await db().select().from(agents).where(eq(agents.walletAddress, wallet))
    expect(bound).toHaveLength(1)
  })
})

/** ADR-48: "the wallet is the identity" is only true if the first purchase actually hands the account over. */
describe('the account a purchase creates (ADR-48)', () => {
  it('hands back the credentials the first time a wallet pays, and never again', async () => {
    const { seller, listingId } = await firstPartySeller()
    const wallet = '0x' + '5'.repeat(40)
    _setSettleFetchForTests(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ success: true, transaction: chain.pay(wallet, seller.wallet_address!, PRICE) }) }))

    const first = deliverWhenOrdered(seller, listingId)
    const one = await buy(listingId, paymentHeader(wallet, seller.wallet_address!, PRICE))
    await first.done
    expect(one.status, JSON.stringify(one.body)).toBe(200)
    expect(one.body.account.api_keys.test).toMatch(/^as_test_/)
    expect(one.body.account.keypair.secret_key).toBeTruthy()
    expect(String(one.body.account.note)).toContain('shown once')

    // the key works: the buyer can fetch its own signed receipt with it
    const receipt = await call(app, 'GET', `/v1/jobs/${one.body.job_id}/receipt`, { key: one.body.account.api_keys.test })
    expect(receipt.status, JSON.stringify(receipt.body)).toBe(200)
    expect(receipt.body.object).toBe('signed_receipt')

    // the same wallet paying again gets the account back, but not its keys: control of the wallet is not proof
    // that this caller is the one that created it
    const second = deliverWhenOrdered(seller, listingId)
    const two = await buy(listingId, paymentHeader(wallet, seller.wallet_address!, PRICE))
    await second.done
    expect(two.status, JSON.stringify(two.body)).toBe(200)
    expect(two.body.account.api_keys).toBeUndefined()
    expect(two.body.account.agent_id).toBe(one.body.account.agent_id)
  })
})

/** ADR-48: the endpoint's entire purpose is a measurement, so the measurement has to be recorded. */
describe('the x402 funnel is counted (ADR-48)', () => {
  it('counts terms handed out, purchases completed and refusals - including the 402, which recordHit cannot see', async () => {
    const { _resetHits, discoverySummary } = await import('../../discovery/hits.js')
    _resetHits()
    const { seller, listingId } = await firstPartySeller()
    const wallet = '0x' + '4'.repeat(40)
    _setSettleFetchForTests(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ success: true, transaction: chain.pay(wallet, seller.wallet_address!, PRICE) }) }))

    await buy(listingId) // 402: terms
    const outsider = await createTestAgent(app, { name: 'Outside seller' })
    const l = await call(app, 'POST', '/v1/listings', {
      key: outsider.api_keys.test,
      body: { title: 'Live DNS probe', description: 'Probe SPF, DKIM and DMARC for a domain and report what resolves.', category: 'data', pricing_model: 'fixed', price: PRICE, input_schema: { type: 'object' }, turnaround_seconds: 600, accept_timeout_seconds: 600 },
    })
    await buy(l.body.id, paymentHeader(wallet, seller.wallet_address!, PRICE)) // refused: not ours
    const runtime = deliverWhenOrdered(seller, listingId)
    const ok = await buy(listingId, paymentHeader(wallet, seller.wallet_address!, PRICE))
    await runtime.done
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)

    const summary = await discoverySummary()
    expect(summary.by_surface_7d['x402:terms']).toBe(1)
    expect(summary.by_surface_7d['x402:refused']).toBe(1)
    expect(summary.by_surface_7d['x402:paid']).toBe(1)
  })
})
