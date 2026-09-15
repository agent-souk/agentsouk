import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { freshApp, call, createTestAgent, type TestAgent } from '../../test/setup.js'
import { installFakeChain, type FakeChain } from '../../test/chain.js'
import { db } from '../../db/client.js'
import { agents, jobs, listings, operatorAlerts } from '../../db/schema.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js'
import { platformState } from '../../db/schema.js'
import { privateKeyToAddress } from '../payments/evm-signature.js'
import { transferAuthorizationDigest } from '../payments/x402.js'
import { _setSettleFetchForTests, _setX402DeliveryWaitForTests } from './routes.js'
import { _setAlertFetchForTests } from '../../ops/alerts.js'
import { _setConfigForTests } from '../../config.js'
import { Ajv2020 } from 'ajv/dist/2020.js'
import type { App } from '../../app.js'

let app: App
let chain: FakeChain
const PRICE = 250_000

beforeEach(async () => {
  app = await freshApp()
  chain = installFakeChain('test')
})
afterEach(() => {
  _setSettleFetchForTests(null)
  _setX402DeliveryWaitForTests(null)
})

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

/** A throwaway buyer wallet with a real key: since ADR-58 the endpoint recovers the signer before it does anything. */
const pkOf = (digit: string) => '0x' + ('0' + digit).repeat(32)
const addr = (pk: string) => privateKeyToAddress(pk)

/** The x402 payment payload a buyer builds after reading the 402, base64 as the header carries it - signed by `pk`. */
const paymentHeader = (pk: string, to: string, value: number, validForSeconds = 900, opts: { from?: string; signWith?: string; validAfter?: number; nonce?: string } = {}) => {
  const authorization = { from: opts.from ?? addr(pk), to, value: String(value), validAfter: String(opts.validAfter ?? 0), validBefore: String(Math.floor(Date.now() / 1000) + validForSeconds), nonce: opts.nonce ?? '0x' + '11'.repeat(32) }
  const sig = secp256k1.sign(transferAuthorizationDigest('test', authorization), hexToBytes((opts.signWith ?? pk).slice(2)), { prehash: false, format: 'recovered', lowS: true })
  const signature = '0x' + bytesToHex(concatBytes(sig.slice(1, 65), Uint8Array.of(27 + sig[0]!)))
  return Buffer.from(JSON.stringify({ x402Version: 2, scheme: 'exact', payload: { signature, authorization } })).toString('base64')
}

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
    // ADR-65: the resource block names the service for the catalogues, within the facilitator's soft-drop rules
    expect(v2.resource.serviceName).toBe('Agent Souk')
    expect(v2.resource.iconUrl).toMatch(/^https?:\/\/.+\/icon\.png$/)
    expect(Array.isArray(v2.resource.tags)).toBe(true)
    expect(v2.resource.tags.length).toBeLessThanOrEqual(5)
    expect(v2.resource.tags.some((t: string) => t.startsWith('souk:'))).toBe(false)
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
    const pk = pkOf('9')
    const wallet = addr(pk)
    _setSettleFetchForTests(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ success: true, transaction: chain.pay(wallet, seller.wallet_address!, PRICE) }) }))
    const runtime = deliverWhenOrdered(seller, listingId)
    const r = await call(app, 'POST', `/v1/x402/${listingId}?env=test`, { body: { text: 'Hello' }, headers: { 'payment-signature': paymentHeader(pk, seller.wallet_address!, PRICE) } })
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
    const r = await buy(l.body.id, paymentHeader(pkOf('1'), '0x' + '2'.repeat(40), PRICE))
    expect(r.status).toBe(409)
    expect(r.body.error.code).toBe('x402_first_party_only')
    expect(r.body.error.hint).toContain('/v1/jobs')
  })

  it('does the work, then settles, and hands back the output with a receipt', async () => {
    const { seller, listingId } = await firstPartySeller()
    const pk = pkOf('7')
    const wallet = addr(pk)
    let settled: { url: string; body: string } | null = null
    _setSettleFetchForTests(async (url, init) => {
      settled = { url, body: init.body }
      // the facilitator broadcasts the buyer's authorization: the USDC moves buyer -> seller
      const tx = chain.pay(wallet, seller.wallet_address!, PRICE)
      return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, transaction: tx }) }
    })

    const runtime = deliverWhenOrdered(seller, listingId)
    const header = paymentHeader(pk, seller.wallet_address!, PRICE)
    const r = await buy(listingId, header)
    await runtime.done

    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.output).toEqual({ text: 'Hallo Welt' })
    expect(r.body.paid).toMatchObject({ amount: PRICE, payer: wallet, pay_to: seller.wallet_address })
    expect(r.body.receipt_url).toContain('/receipt')
    expect(settled).not.toBeNull()
    expect(settled!.url).toContain('/settle')
    // the settle body carries the buyer's own signature, unchanged
    expect(JSON.parse(settled!.body).paymentPayload.payload.signature).toBe(JSON.parse(Buffer.from(header, 'base64').toString('utf8')).payload.signature)

    // the payment is a real settlement on a real job, with the wallet as the buyer's identity
    const job = await db().query.jobs.findFirst({ where: eq(jobs.id, r.body.job_id) })
    expect(job!.status).toBe('completed')
    const buyer = await db().query.agents.findFirst({ where: eq(agents.id, job!.buyerAgentId) })
    expect(buyer!.walletAddress).toBe(wallet)
  })

  it('names the unit of a per-unit price in the index and in the 402 (ADR-61)', async () => {
    const seller = await createTestAgent(app, { name: 'Souk Pages' })
    await db().update(agents).set({ firstParty: true }).where(eq(agents.id, seller.agent.id))
    const l = await call(app, 'POST', '/v1/listings', { key: seller.api_keys.test, body: { title: 'OCR a scan', description: 'Optical character recognition of scanned pages, one price per page.', category: 'documents', pricing_model: 'per_unit', price: 20_000, unit_name: 'page', turnaround_seconds: 600 } })
    expect(l.status, JSON.stringify(l.body)).toBe(201)
    const index = await call(app, 'GET', '/v1/x402?env=test')
    const entry = index.body.services.find((s: { listing_id: string }) => s.listing_id === l.body.id)
    expect(entry).toMatchObject({ pricing_model: 'per_unit', unit_name: 'page' })
    expect(entry.price_note).toContain('per page')
    const terms = await call(app, 'POST', `/v1/x402/${l.body.id}?env=test&units=3`, { body: { scan: 'x' } })
    expect(terms.status).toBe(402)
    const required = JSON.parse(Buffer.from(terms.headers.get('payment-required')!, 'base64').toString('utf8'))
    expect(required.accepts[0].amount).toBe('60000')
    expect(required.resource.description).toContain('3 × page')
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

    const r = await buy(listingId, paymentHeader(pkOf('8'), seller.wallet_address!, PRICE))
    await giveUp
    expect(r.status).toBe(409)
    expect(r.body.error.code).toBe('x402_not_delivered')
    expect(r.body.error.hint).toContain('Nothing was charged')
    expect(r.body.error.message).toContain('declined it: "not today"') // ADR-61: the seller's reason reaches a buyer that has no key
    expect(settleCalls).toBe(0)
  })

  it('closes a job it stopped waiting for with no mark on either side, so a late delivery cannot become the buyer\'s unpaid mark (ADR-67)', async () => {
    const { seller, listingId } = await firstPartySeller()
    let settleCalls = 0
    _setSettleFetchForTests(async () => {
      settleCalls += 1
      return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, transaction: '0x' + '9'.repeat(64) }) }
    })
    _setX402DeliveryWaitForTests(600)
    // the seller accepts and is still working when the endpoint gives up
    const accepting = (async () => {
      for (let i = 0; i < 40; i++) {
        const job = await db().query.jobs.findFirst({ where: and(eq(jobs.listingId, listingId), eq(jobs.status, 'open')) })
        if (job) return call(app, 'POST', `/v1/jobs/${job.id}/accept`, { key: seller.api_keys.test, body: {} })
        await new Promise((r) => setTimeout(r, 25))
      }
      return null
    })()
    const r = await buy(listingId, paymentHeader(pkOf('d'), seller.wallet_address!, PRICE))
    expect((await accepting)?.status).toBe(200)
    expect(r.status).toBe(409)
    expect(r.body.error.code).toBe('x402_timeout')
    expect(r.body.error.hint).toContain('closed with no mark on either side')
    expect(settleCalls).toBe(0)
    const job = await db().query.jobs.findFirst({ where: eq(jobs.id, r.body.error.message.match(/job_[0-9A-Z]+/)?.[0] ?? '') }).catch(() => undefined)
    const row = job ?? (await db().query.jobs.findFirst({ where: eq(jobs.listingId, listingId) }))
    expect(row!.status).toBe('cancelled')
    expect(row!.cancelKind).toBeNull()
    expect(row!.cancelReason).toContain('stopped waiting')
    // the seller's late delivery is refused: the job is closed, nothing is sealed, nobody is marked
    const late = await call(app, 'POST', `/v1/jobs/${row!.id}/deliver`, { key: seller.api_keys.test, body: { output: { text: 'zu spaet' } } })
    expect(late.status).toBe(409)
    const rep = await call(app, 'GET', `/v1/agents/${seller.agent.handle}/reputation`)
    expect(rep.status).toBe(200)
    expect(JSON.stringify(rep.body)).not.toContain('"jobs_failed":1')
  })

  it('rejects an authorization made out to somebody else, or for too little, or already expired', async () => {
    const { seller, listingId } = await firstPartySeller()
    const pk = pkOf('7')
    const wallet = addr(pk)
    const wrongPayee = await buy(listingId, paymentHeader(pk, '0x' + '3'.repeat(40), PRICE))
    expect(wrongPayee.status).toBe(400)
    expect(String(wrongPayee.body.error.message)).toContain('must be the seller wallet')

    const tooLittle = await buy(listingId, paymentHeader(pk, seller.wallet_address!, PRICE - 1))
    expect(tooLittle.status).toBe(400)
    expect(String(tooLittle.body.error.message)).toContain('at least')

    const expired = await buy(listingId, paymentHeader(pk, seller.wallet_address!, PRICE, -10))
    expect(expired.status).toBe(400)
    expect(String(expired.body.error.message)).toContain('expired')
  })

  it('refuses a wallet that cannot pay before any work is ordered or any account created (ADR-66)', async () => {
    const { seller, listingId } = await firstPartySeller()
    const pk = pkOf('9')
    const wallet = addr(pk)
    let settleCalls = 0
    _setSettleFetchForTests(async () => {
      settleCalls += 1
      return { ok: false, status: 400, text: async () => JSON.stringify({ success: false, errorReason: 'insufficient_funds' }) }
    })
    chain.usdcBalanceOf = (a) => (a.toLowerCase() === wallet.toLowerCase() ? BigInt(PRICE - 1) : 50_000_000n)
    const r = await buy(listingId, paymentHeader(pk, seller.wallet_address!, PRICE))
    expect(r.status, JSON.stringify(r.body)).toBe(409)
    expect(r.body.error.code).toBe('x402_insufficient_funds')
    expect(r.body.error.message).toContain('0.249999 USDC')
    expect(r.body.error.hint).toContain('Nothing was charged and no job was created')
    expect(await db().query.jobs.findFirst({ where: eq(jobs.listingId, listingId) })).toBeUndefined()
    expect(await db().query.agents.findFirst({ where: eq(agents.walletAddress, wallet) })).toBeUndefined()
    expect(settleCalls).toBe(0)

    // read fresh on every purchase: a wallet topped up a moment later buys at once, not a minute later
    chain.usdcBalanceOf = () => 50_000_000n
    _setSettleFetchForTests(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ success: true, transaction: chain.pay(wallet, seller.wallet_address!, PRICE) }) }))
    const runtime = deliverWhenOrdered(seller, listingId)
    const ok = await buy(listingId, paymentHeader(pk, seller.wallet_address!, PRICE))
    await runtime.done
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
  })

  it('refuses every authorization that could not settle once the work is done, before any work (ADR-66 audit)', async () => {
    const { seller, listingId } = await firstPartySeller()
    const pk = pkOf('b')
    const wallet = addr(pk)
    let settleCalls = 0
    _setSettleFetchForTests(async () => {
      settleCalls += 1
      return { ok: false, status: 400, text: async () => '{}' }
    })
    // holds exactly the price, signs for more: EIP-3009 moves the signed value, which the wallet cannot cover
    chain.usdcBalanceOf = (a) => (a.toLowerCase() === wallet.toLowerCase() ? BigInt(PRICE) : 50_000_000n)
    const tooMuch = await buy(listingId, paymentHeader(pk, seller.wallet_address!, 1_000_000_000))
    expect(tooMuch.status, JSON.stringify(tooMuch.body)).toBe(409)
    expect(tooMuch.body.error.code).toBe('x402_insufficient_funds')
    expect(tooMuch.body.error.message).toContain('moves 1000.000000 USDC')
    chain.usdcBalanceOf = () => 50_000_000n

    const notYet = await buy(listingId, paymentHeader(pk, seller.wallet_address!, PRICE, 900, { validAfter: Math.floor(Date.now() / 1000) + 600 }))
    expect(notYet.status).toBe(400)
    expect(String(notYet.body.error.message)).toContain('validAfter is in the future')

    const tooShort = await buy(listingId, paymentHeader(pk, seller.wallet_address!, PRICE, 20))
    expect(tooShort.status).toBe(400)
    expect(String(tooShort.body.error.message)).toContain('at least 60 seconds ahead')

    const nonce = '0x' + 'ab'.repeat(32)
    chain.usedAuthorizations.add(`${wallet.toLowerCase()}:${nonce}`)
    const replayed = await buy(listingId, paymentHeader(pk, seller.wallet_address!, PRICE, 900, { nonce }))
    expect(replayed.status).toBe(409)
    expect(replayed.body.error.code).toBe('x402_authorization_used')

    expect(await db().query.jobs.findFirst({ where: eq(jobs.listingId, listingId) })).toBeUndefined()
    expect(settleCalls).toBe(0)
  })

  it('counts what a wallet\'s purchases still running will move, and refuses the same authorization twice at once', async () => {
    const { seller, listingId } = await firstPartySeller()
    const pk = pkOf('c')
    const wallet = addr(pk)
    chain.usdcBalanceOf = (a) => (a.toLowerCase() === wallet.toLowerCase() ? BigInt(PRICE) : 50_000_000n) // one purchase's worth
    _setSettleFetchForTests(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ success: true, transaction: chain.pay(wallet, seller.wallet_address!, PRICE) }) }))
    const first = buy(listingId, paymentHeader(pk, seller.wallet_address!, PRICE, 900, { nonce: '0x' + '01'.repeat(32) }))
    let open = null
    for (let i = 0; i < 80 && !open; i++) {
      open = (await db().query.jobs.findFirst({ where: and(eq(jobs.listingId, listingId), eq(jobs.status, 'open')) })) ?? null
      if (!open) await new Promise((r) => setTimeout(r, 25))
    }
    expect(open).not.toBeNull()
    // the first purchase is waiting for its delivery: a second from the same wallet sees its value as committed
    const second = await buy(listingId, paymentHeader(pk, seller.wallet_address!, PRICE, 900, { nonce: '0x' + '02'.repeat(32) }))
    expect(second.status, JSON.stringify(second.body)).toBe(409)
    expect(second.body.error.code).toBe('x402_insufficient_funds')
    expect(second.body.error.message).toContain('committed to purchases still running here')
    chain.usdcBalanceOf = () => 50_000_000n
    const same = await buy(listingId, paymentHeader(pk, seller.wallet_address!, PRICE, 900, { nonce: '0x' + '01'.repeat(32) }))
    expect(same.status).toBe(409)
    expect(same.body.error.code).toBe('x402_authorization_in_use')
    await call(app, 'POST', `/v1/jobs/${open!.id}/accept`, { key: seller.api_keys.test, body: {} })
    await call(app, 'POST', `/v1/jobs/${open!.id}/deliver`, { key: seller.api_keys.test, body: { output: { text: 'Hallo' } } })
    const done = await first
    expect(done.status, JSON.stringify(done.body)).toBe(200)
    // released: the wallet can buy again
    const runtime = deliverWhenOrdered(seller, listingId)
    const again = await buy(listingId, paymentHeader(pk, seller.wallet_address!, PRICE, 900, { nonce: '0x' + '03'.repeat(32) }))
    await runtime.done
    expect(again.status, JSON.stringify(again.body)).toBe(200)
  })

  it('goes ahead as before when the node cannot say what the wallet holds', async () => {
    const { seller, listingId } = await firstPartySeller()
    const pk = pkOf('a')
    const wallet = addr(pk)
    chain.usdcBalanceOf = () => {
      throw new Error('node unavailable')
    }
    _setSettleFetchForTests(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ success: true, transaction: chain.pay(wallet, seller.wallet_address!, PRICE) }) }))
    const runtime = deliverWhenOrdered(seller, listingId)
    const r = await buy(listingId, paymentHeader(pk, seller.wallet_address!, PRICE))
    await runtime.done
    expect(r.status, JSON.stringify(r.body)).toBe(200)
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
    const pk = pkOf('7')
    const wallet = addr(pk)
    _setSettleFetchForTests(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ success: true, transaction: chain.pay(wallet, seller.wallet_address!, PRICE) }) }))

    for (let i = 0; i < 2; i++) {
      const runtime = deliverWhenOrdered(seller, listingId)
      const r = await buy(listingId, paymentHeader(pk, seller.wallet_address!, PRICE))
      await runtime.done
      expect(r.status, JSON.stringify(r.body)).toBe(200)
    }
    const bound = await db().select().from(agents).where(eq(agents.walletAddress, wallet))
    expect(bound).toHaveLength(1)
  })
})

describe('the edges around the wire (ADR-54, ADR-57)', () => {
  it('answers the CORS preflight a browser client sends before the payment request', async () => {
    const { listingId } = await firstPartySeller()
    for (const path of ['/v1/x402', `/v1/x402/${listingId}?env=test`]) {
      // straight to the app: a preflight has no JSON body for the test helper to parse
      const r = await app.request(path, { method: 'OPTIONS', headers: { origin: 'https://example.com', 'access-control-request-method': 'POST', 'access-control-request-headers': 'PAYMENT-SIGNATURE' } })
      expect(r.status, path).toBe(204)
      expect(r.headers.get('access-control-allow-origin')).toBe('*')
      expect(r.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('payment-signature')
      expect(r.headers.get('access-control-expose-headers')).toContain('PAYMENT-REQUIRED')
    }
  })

  it('binds one account to a wallet however the client spells it', async () => {
    const { seller, listingId } = await firstPartySeller()
    const pk = pkOf('c')
    const checksummed = addr(pk)
    _setSettleFetchForTests(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ success: true, transaction: chain.pay(checksummed, seller.wallet_address!, PRICE) }) }))
    for (const spelled of [checksummed.toLowerCase(), checksummed]) {
      const runtime = deliverWhenOrdered(seller, listingId)
      const r = await buy(listingId, paymentHeader(pk, seller.wallet_address!, PRICE, 900, { from: spelled }))
      await runtime.done
      expect(r.status, JSON.stringify(r.body)).toBe(200)
    }
    const bound = (await db().select().from(agents)).filter((a) => a.walletAddress?.toLowerCase() === checksummed.toLowerCase())
    expect(bound).toHaveLength(1)
    expect(bound[0]!.walletAddress).toBe(checksummed) // stored checksummed, like every other binding
  })

  it('refuses an authorization the named wallet did not sign, before it looks up or creates anything (ADR-58)', async () => {
    const { seller, listingId } = await firstPartySeller()
    const victim = pkOf('a')
    const attacker = pkOf('b')
    // a real account for the victim's wallet, created by a real purchase
    _setSettleFetchForTests(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ success: true, transaction: chain.pay(addr(victim), seller.wallet_address!, PRICE) }) }))
    const first = deliverWhenOrdered(seller, listingId)
    const one = await buy(listingId, paymentHeader(victim, seller.wallet_address!, PRICE))
    await first.done
    expect(one.status, JSON.stringify(one.body)).toBe(200)
    const keyBefore = one.body.account.api_keys.test as string
    // an authorization naming the victim's wallet, signed by somebody else: refused at the door
    const forged = await buy(listingId, paymentHeader(attacker, seller.wallet_address!, PRICE, 900, { from: addr(victim) }))
    expect(forged.status).toBe(400)
    expect(String(forged.body.error.message)).toContain('not made by authorization.from')
    // nothing happened to the victim: its key still works, no job was created for it
    expect((await call(app, 'GET', '/v1/agents/me', { key: keyBefore })).status).toBe(200)
    const victimJobs = await db().query.jobs.findMany({ where: eq(jobs.buyerAgentId, one.body.account.agent_id) })
    expect(victimJobs).toHaveLength(1)
    // and a wallet nobody has ever used gets no account from a forged payload either
    const stranger = pkOf('d')
    const squat = await buy(listingId, paymentHeader(attacker, seller.wallet_address!, PRICE, 900, { from: addr(stranger) }))
    expect(squat.status).toBe(400)
    expect(await db().select().from(agents).where(eq(agents.walletAddress, addr(stranger)))).toHaveLength(0)
  })

  it('never rotates the keys of an account this endpoint did not record as its own (accounts from before 0.5.8)', async () => {
    const { seller, listingId } = await firstPartySeller()
    const pk = pkOf('e')
    const wallet = addr(pk)
    _setSettleFetchForTests(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ success: true, transaction: chain.pay(wallet, seller.wallet_address!, PRICE) }) }))
    const first = deliverWhenOrdered(seller, listingId)
    const one = await buy(listingId, paymentHeader(pk, seller.wallet_address!, PRICE))
    await first.done
    expect(one.status, JSON.stringify(one.body)).toBe(200)
    // an account from before the origin record existed: no platform_state row
    await db().delete(platformState).where(eq(platformState.key, `x402/account/${one.body.account.agent_id}`))
    const second = deliverWhenOrdered(seller, listingId)
    const two = await buy(listingId, paymentHeader(pk, seller.wallet_address!, PRICE))
    await second.done
    expect(two.status, JSON.stringify(two.body)).toBe(200)
    expect(two.body.account.api_keys).toBeUndefined()
    expect((await call(app, 'GET', '/v1/agents/me', { key: one.body.account.api_keys.test })).status).toBe(200) // the old key still works
  })

  it('hands the credentials over on the next purchase when the first one failed after creating the account, once', async () => {
    const { seller, listingId } = await firstPartySeller()
    const pk = pkOf('6')
    const wallet = addr(pk)
    _setSettleFetchForTests(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ success: true, transaction: chain.pay(wallet, seller.wallet_address!, PRICE) }) }))
    // first purchase: the account is created, then the seller backs out - the buyer never sees its keys
    const giveUp = (async () => {
      for (let i = 0; i < 80; i++) {
        const job = await db().query.jobs.findFirst({ where: and(eq(jobs.listingId, listingId), eq(jobs.status, 'open')) })
        if (job) return call(app, 'POST', `/v1/jobs/${job.id}/decline`, { key: seller.api_keys.test, body: { reason: 'not today' } })
        await new Promise((r) => setTimeout(r, 25))
      }
      return null
    })()
    const failed = await buy(listingId, paymentHeader(pk, seller.wallet_address!, PRICE))
    await giveUp
    expect(failed.status).toBe(409)
    expect(await db().select().from(agents).where(eq(agents.walletAddress, wallet))).toHaveLength(1)

    // second purchase: the same wallet gets fresh keys, and is told what could not be recovered
    const second = deliverWhenOrdered(seller, listingId)
    const two = await buy(listingId, paymentHeader(pk, seller.wallet_address!, PRICE))
    await second.done
    expect(two.status, JSON.stringify(two.body)).toBe(200)
    expect(two.body.account.api_keys.test).toMatch(/^as_test_/)
    expect(two.body.account.keypair).toBeNull()
    expect(String(two.body.account.keypair_note)).toContain('cannot be recovered')
    expect((await call(app, 'GET', `/v1/jobs/${two.body.job_id}/receipt`, { key: two.body.account.api_keys.test })).status).toBe(200)

    // third purchase: shown once means once
    const third = deliverWhenOrdered(seller, listingId)
    const three = await buy(listingId, paymentHeader(pk, seller.wallet_address!, PRICE))
    await third.done
    expect(three.status).toBe(200)
    expect(three.body.account.api_keys).toBeUndefined()
    expect(three.body.account.agent_id).toBe(two.body.account.agent_id)
  })
})

/** ADR-48: "the wallet is the identity" is only true if the first purchase actually hands the account over. */
describe('the account a purchase creates (ADR-48)', () => {
  it('hands back the credentials the first time a wallet pays, and never again', async () => {
    const { seller, listingId } = await firstPartySeller()
    const pk = pkOf('5')
    const wallet = addr(pk)
    _setSettleFetchForTests(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ success: true, transaction: chain.pay(wallet, seller.wallet_address!, PRICE) }) }))

    const first = deliverWhenOrdered(seller, listingId)
    const one = await buy(listingId, paymentHeader(pk, seller.wallet_address!, PRICE))
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
    const two = await buy(listingId, paymentHeader(pk, seller.wallet_address!, PRICE))
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
    const pk = pkOf('4')
    const wallet = addr(pk)
    _setSettleFetchForTests(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ success: true, transaction: chain.pay(wallet, seller.wallet_address!, PRICE) }) }))

    await buy(listingId) // 402: terms
    const outsider = await createTestAgent(app, { name: 'Outside seller' })
    const l = await call(app, 'POST', '/v1/listings', {
      key: outsider.api_keys.test,
      body: { title: 'Live DNS probe', description: 'Probe SPF, DKIM and DMARC for a domain and report what resolves.', category: 'data', pricing_model: 'fixed', price: PRICE, input_schema: { type: 'object' }, turnaround_seconds: 600, accept_timeout_seconds: 600 },
    })
    await buy(l.body.id, paymentHeader(pk, seller.wallet_address!, PRICE)) // refused: not ours
    const runtime = deliverWhenOrdered(seller, listingId)
    const ok = await buy(listingId, paymentHeader(pk, seller.wallet_address!, PRICE))
    await runtime.done
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)

    const summary = await discoverySummary()
    expect(summary.by_surface_7d['x402:terms']).toBe(1)
    expect(summary.by_surface_7d['x402:refused']).toBe(1)
    expect(summary.by_surface_7d['x402:paid']).toBe(1)
  })
})

/**
 * ADR-49: the operator hears about a purchase once, not twice. The payment goes through payJob, which emits
 * job.paid, which the classifier turns into `paid:<job>`; the endpoint then raises the same key with the one
 * thing only it knows - that the buyer had no account at all. Two keys would mean two alerts for one payment.
 */
describe('an x402 purchase raises exactly one operator alert (ADR-49)', () => {
  afterEach(() => {
    _setAlertFetchForTests(null)
    _setConfigForTests({ OPERATOR_ALERT_WEBHOOK_URL: undefined, OPERATOR_ALERT_MIN_TIER: 'notable' })
  })

  it('upgrades the payment alert instead of adding a second one', async () => {
    _setConfigForTests({ OPERATOR_ALERT_WEBHOOK_URL: 'https://ntfy.sh/agentsouk-x402-test', OPERATOR_ALERT_MIN_TIER: 'quiet' })
    _setAlertFetchForTests(async () => ({ status: 200, text: async () => 'ok' }))
    const { seller, listingId } = await firstPartySeller()
    const pk = pkOf('5')
    const wallet = addr(pk)
    _setSettleFetchForTests(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ success: true, transaction: chain.pay(wallet, seller.wallet_address!, PRICE) }) }))
    const runtime = deliverWhenOrdered(seller, listingId)
    const r = await buy(listingId, paymentHeader(pk, seller.wallet_address!, PRICE))
    await runtime.done
    expect(r.status, JSON.stringify(r.body)).toBe(200)

    const rows = await db().query.operatorAlerts.findMany()
    const paid = rows.filter((a) => a.key.startsWith('paid:'))
    expect(paid).toHaveLength(1)
    expect(rows.some((a) => a.key.startsWith('x402:'))).toBe(false)
    // the surviving row carries what only the endpoint knew
    expect(paid[0]!.title).toContain('x402')
    expect((paid[0]!.data as Record<string, unknown>).via).toBe('x402')
    expect((paid[0]!.data as Record<string, unknown>).first_buy).toBe(true)
  })

  it('a buyer paying again and again gets one line per slot from its fourth payment, kept up to date (ADR-66)', async () => {
    _setConfigForTests({ OPERATOR_ALERT_WEBHOOK_URL: 'https://ntfy.sh/agentsouk-x402-test', OPERATOR_ALERT_MIN_TIER: 'quiet' })
    _setAlertFetchForTests(async () => ({ status: 200, text: async () => 'ok' }))
    const { seller, listingId } = await firstPartySeller()
    const pk = pkOf('6')
    const wallet = addr(pk)
    _setSettleFetchForTests(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ success: true, transaction: chain.pay(wallet, seller.wallet_address!, PRICE) }) }))
    const { deliverAlerts } = await import('../../ops/alerts.js')
    for (let i = 0; i < 5; i++) {
      const runtime = deliverWhenOrdered(seller, listingId)
      const r = await buy(listingId, paymentHeader(pk, seller.wallet_address!, PRICE))
      await runtime.done
      expect(r.status, JSON.stringify(r.body)).toBe(200)
      await deliverAlerts(Date.now()) // the sweep runs every 15 s in production: the slot line must not go out with the fourth payment
    }
    const rows = await db().query.operatorAlerts.findMany()
    expect(rows.filter((a) => a.key.startsWith('paid:'))).toHaveLength(3)
    const again = rows.filter((a) => a.key.startsWith('paid-again:'))
    expect(again).toHaveLength(1)
    expect(again[0]!.status).toBe('pending')
    expect(again[0]!.title).toContain('keeps paying us: 5 payments in 24 h, 1.250000 USDC')
    expect(again[0]!.data).toMatchObject({ payments_24h: 5, amount_24h: 5 * PRICE, payers: [wallet.toLowerCase()], via: 'x402' })
    expect(again[0]!.tier).toBe('notable')
    await deliverAlerts(Date.now() + 11 * 60_000)
    const out = await db().query.operatorAlerts.findFirst({ where: eq(operatorAlerts.id, again[0]!.id) })
    expect(out!.status).toBe('sent')
    expect(out!.title).toContain('5 payments')
  })
})

/**
 * ADR-50: a parseable 402 makes the endpoint payable; this makes it findable. The index has to agree with the
 * endpoint, because a list that advertises something the endpoint then refuses is worse than no list.
 */
describe('the index of what one x402 payment buys (ADR-50)', () => {
  it('lists exactly what the endpoint would sell, and nothing it would refuse', async () => {
    const { seller, listingId } = await firstPartySeller()
    // an outside seller's listing: never buyable here (ADR-22), so never listed here either
    const outsider = await createTestAgent(app, { name: 'Outside seller' })
    await call(app, 'POST', '/v1/listings', { key: outsider.api_keys.test, body: { title: 'Outside probe', description: 'Probes a domain and reports what resolves, for anyone who asks.', category: 'data', pricing_model: 'fixed', price: PRICE, input_schema: { type: 'object' } } })
    // our own free listing and our own quote listing: the endpoint refuses both, so they must not be advertised
    await call(app, 'POST', '/v1/listings', { key: seller.api_keys.test, body: { title: 'Free thing', description: 'A platform-operated listing that costs nothing at all.', category: 'ops', pricing_model: 'fixed', price: 0 } })
    await call(app, 'POST', '/v1/listings', { key: seller.api_keys.test, body: { title: 'Quoted thing', description: 'A platform-operated listing whose price is agreed per job.', category: 'ops', pricing_model: 'quote' } })

    const r = await call(app, 'GET', '/v1/x402?env=test')
    expect(r.status).toBe(200)
    expect(r.body.object).toBe('x402_index')
    expect(r.body.services.map((s: { listing_id: string }) => s.listing_id)).toEqual([listingId])
    const svc = r.body.services[0]
    expect(svc).toMatchObject({ price: PRICE, pay_to: seller.wallet_address, seller: seller.agent.handle })
    // ADR-65: no query string - the id names the environment, and a facilitator catalogues the URL without its query
    expect(svc.url.endsWith(`/v1/x402/${listingId}`)).toBe(true)
    expect(svc.input_schema).toMatchObject({ type: 'object' })
    expect(r.body.protocol).toMatchObject({ x402_version: 2, scheme: 'exact', network: 'base-sepolia', network_caip2: 'eip155:84532' })
    expect(String(r.body.limit)).toContain('POST /v1/jobs')
  })

  it('is served at /.well-known/x402 too, where an index looks without being told', async () => {
    const r = await app.request('/.well-known/x402')
    expect(r.status).toBe(200)
    const body = (await r.json()) as { object: string; env: string }
    expect(body.object).toBe('x402_index')
    expect(body.env).toBe('live') // the well-known is the real marketplace, never the sandbox
  })

  it('describes the listing to the public indexes from the listing itself, not from a guess', async () => {
    const seller = await createTestAgent(app, { name: 'Souk Services' })
    await db().update(agents).set({ firstParty: true }).where(eq(agents.id, seller.agent.id))
    const l = await call(app, 'POST', '/v1/listings', {
      key: seller.api_keys.test,
      body: {
        title: 'Translate text',
        description: 'Translate text between languages, preserving formatting and tone.',
        category: 'language',
        pricing_model: 'fixed',
        price: PRICE,
        input_schema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
        output_schema: { type: 'object', properties: { text: { type: 'string' } } },
        example_input: { text: 'Hello world', target_language: 'de' },
        example_output: { text: 'Hallo Welt' },
      },
    })
    expect(l.status).toBe(201)
    const r = await buy(l.body.id)
    const v2 = JSON.parse(Buffer.from(r.headers.get('payment-required')!, 'base64').toString('utf8'))
    // exactly the paths Coinbase's public validator checks
    expect(v2.extensions.bazaar.info.input).toMatchObject({ type: 'http', method: 'POST', bodyType: 'json', body: { text: 'Hello world', target_language: 'de' } })
    expect(v2.extensions.bazaar.info.output).toMatchObject({ type: 'json', example: { text: 'Hallo Welt' } })
    // ADR-62: schema is the JSON Schema of `info` (bazaar spec); the listing's schemas are the leaves the indexes read
    const schema = v2.extensions.bazaar.schema
    expect(schema).toMatchObject({ $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', required: ['input'] })
    expect(schema.properties.input.properties.body).toMatchObject({ required: ['text'] })
    expect(schema.properties.input.properties.type).toEqual({ type: 'string', const: 'http' })
    expect(schema.properties.output.properties.example).toMatchObject({ type: 'object', properties: { text: { type: 'string' } } })
    expect(schema.properties.input.required).toEqual(['type', 'method', 'bodyType', 'body'])
    expect(v2.extensions.bazaar.schema.input).toBeUndefined() // the pre-0.5.14 shape nobody could read
    // the spec: facilitators MUST validate info against schema before cataloging - so it has to pass, here, with a real validator
    const validate = new Ajv2020({ strict: false }).compile(schema)
    expect(validate(v2.extensions.bazaar.info), JSON.stringify(validate.errors)).toBe(true)
  })
})

/** From the adversarial audit: the index must not advertise what the endpoint would refuse. */
describe('upfront listings are neither advertised nor hung (audit fix)', () => {
  it('refuses an upfront listing at once instead of waiting 90 seconds for a delivery that cannot come', async () => {
    const seller = await createTestAgent(app, { name: 'Souk Services' })
    await db().update(agents).set({ firstParty: true }).where(eq(agents.id, seller.agent.id))
    const l = await call(app, 'POST', '/v1/listings', { key: seller.api_keys.test, body: { title: 'Pay first', description: 'A platform-operated listing that wants payment before it delivers.', category: 'ops', pricing_model: 'fixed', price: PRICE, payment: 'upfront' } })
    expect(l.status).toBe(201)
    const started = Date.now()
    const r = await buy(l.body.id, paymentHeader(pkOf('3'), seller.wallet_address!, PRICE))
    expect(r.status).toBe(409)
    expect(r.body.error.code).toBe('x402_upfront_not_supported')
    expect(r.body.error.hint).toContain('/v1/jobs')
    expect(Date.now() - started).toBeLessThan(10_000) // not the 90s delivery wait
    // and it is absent from the index, so nobody is sent there in the first place
    const idx = await call(app, 'GET', '/v1/x402?env=test')
    expect(idx.body.services.map((s: { listing_id: string }) => s.listing_id)).not.toContain(l.body.id)
  })

  it('says how to call what it advertises: a GET on the published url is a 404', async () => {
    const { listingId } = await firstPartySeller()
    const idx = await call(app, 'GET', '/v1/x402?env=test')
    const svc = idx.body.services.find((s: { listing_id: string }) => s.listing_id === listingId)
    expect(svc.method).toBe('POST')
    expect(svc.content_type).toBe('application/json')
    expect((await app.request(new URL(svc.url).pathname + new URL(svc.url).search)).status).toBe(404)
  })
})

/**
 * ADR-65: a facilitator catalogues a resource from the `bazaar` extension in the PaymentPayload it receives - and
 * from nothing else. This endpoint is the party that talks to the facilitator, so the payload it sends has to
 * carry the extension of its own 402 and its own resource block; until 0.5.19 it carried neither, and no public
 * x402 catalogue knew the endpoint existed.
 */
describe('the settle payload carries the bazaar extension and the service metadata (ADR-65)', () => {
  const answer = (bazaar: Record<string, unknown>) => Buffer.from(JSON.stringify({ bazaar })).toString('base64')

  it('echoes our extension and resource block, and counts the facilitator answer to it', async () => {
    const { _resetHits, discoverySummary } = await import('../../discovery/hits.js')
    _resetHits()
    const { seller, listingId } = await firstPartySeller()
    const pk = pkOf('6')
    const wallet = addr(pk)
    let sent: Record<string, any> | null = null
    _setSettleFetchForTests(async (_url, init) => {
      sent = JSON.parse(init.body)
      return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, transaction: chain.pay(wallet, seller.wallet_address!, PRICE) }), headers: { get: (n: string) => (n.toLowerCase() === 'extension-responses' ? answer({ status: 'processing' }) : null) } }
    })
    const runtime = deliverWhenOrdered(seller, listingId)
    const r = await buy(listingId, paymentHeader(pk, seller.wallet_address!, PRICE))
    await runtime.done
    expect(r.status, JSON.stringify(r.body)).toBe(200)

    const payload = sent!.paymentPayload
    // the extension is OURS - built from the listing, not copied from whatever the buyer sent
    expect(payload.extensions.bazaar.info.input).toMatchObject({ type: 'http', method: 'POST', bodyType: 'json' })
    expect(payload.extensions.bazaar.schema).toBeTruthy()
    const ajv = new Ajv2020({ strict: false })
    expect(ajv.validate(payload.extensions.bazaar.schema, payload.extensions.bazaar.info), JSON.stringify(ajv.errors)).toBe(true)
    // the resource block names the service for the catalogue, and the URL has no query string to be stripped
    expect(payload.resource).toMatchObject({ serviceName: 'Agent Souk', mimeType: 'application/json' })
    expect(payload.resource.url.endsWith(`/v1/x402/${listingId}`)).toBe(true)
    expect(payload.resource.iconUrl.endsWith('/icon.png')).toBe(true)
    expect(payload.resource.tags.length).toBeLessThanOrEqual(5)
    expect(payload.accepted).toEqual(sent!.paymentRequirements)

    const summary = await discoverySummary()
    expect(summary.by_surface_7d['x402:catalogued']).toBe(1)
    expect(summary.by_surface_7d['x402:catalog_rejected']).toBeUndefined()
  })

  it('counts a rejection separately, and a facilitator without discovery counts nothing', async () => {
    const { _resetHits, discoverySummary } = await import('../../discovery/hits.js')
    _resetHits()
    const { seller, listingId } = await firstPartySeller()
    const pk = pkOf('8')
    const wallet = addr(pk)
    _setSettleFetchForTests(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ success: true, transaction: chain.pay(wallet, seller.wallet_address!, PRICE) }), headers: { get: (n: string) => (n.toLowerCase() === 'extension-responses' ? answer({ status: 'rejected', rejectedReason: 'info failed schema validation' }) : null) } }))
    let runtime = deliverWhenOrdered(seller, listingId)
    expect((await buy(listingId, paymentHeader(pk, seller.wallet_address!, PRICE))).status).toBe(200)
    await runtime.done

    // the same buyer again, at a facilitator that says nothing about extensions (no headers at all, as before 0.5.19)
    _setSettleFetchForTests(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ success: true, transaction: chain.pay(wallet, seller.wallet_address!, PRICE) }) }))
    runtime = deliverWhenOrdered(seller, listingId)
    expect((await buy(listingId, paymentHeader(pk, seller.wallet_address!, PRICE))).status).toBe(200)
    await runtime.done

    const summary = await discoverySummary()
    expect(summary.by_surface_7d['x402:paid']).toBe(2)
    expect(summary.by_surface_7d['x402:catalog_rejected']).toBe(1)
    expect(summary.by_surface_7d['x402:catalogued']).toBeUndefined()
  })
})

/**
 * ADR-65: the URL a catalogue holds is the URL without its query string. So the listing id has to name the
 * environment on its own, and the index has to publish that URL.
 */
describe('the listing id names the environment (ADR-65)', () => {
  it('a sandbox listing answers 402 without ?env=test, still answers with it, and is a 404 under ?env=live', async () => {
    const { listingId } = await firstPartySeller()
    const plain = await call(app, 'POST', `/v1/x402/${listingId}`, { body: { text: 'Hello' } })
    expect(plain.status).toBe(402)
    const v2 = JSON.parse(Buffer.from(plain.headers.get('payment-required')!, 'base64').toString('utf8'))
    expect(v2.accepts[0].network).toBe('eip155:84532') // the sandbox network, read from the listing, not from the query
    expect(v2.resource.url.endsWith(`/v1/x402/${listingId}`)).toBe(true)
    expect(v2.resource.url).not.toContain('?')
    expect((await call(app, 'POST', `/v1/x402/${listingId}?env=test`, { body: { text: 'Hello' } })).status).toBe(402)
    const wrong = await call(app, 'POST', `/v1/x402/${listingId}?env=live`, { body: { text: 'Hello' } })
    expect(wrong.status).toBe(404)
    expect(wrong.body.error.hint).toContain('/v1/x402')
  })

  it('the index publishes the plain URL and the 402 behind it is reachable as published', async () => {
    const { listingId } = await firstPartySeller()
    const idx = await call(app, 'GET', '/v1/x402?env=test')
    expect(idx.body.resources).toContain(`${new URL(idx.body.services[0].url).origin}/v1/x402/${listingId}`)
    const svc = idx.body.services.find((s: { listing_id: string }) => s.listing_id === listingId)
    expect(svc.url).not.toContain('?')
    const r = await app.request(new URL(svc.url).pathname, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Hello' }) })
    expect(r.status).toBe(402)
  })
})
