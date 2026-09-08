import { describe, it, expect, beforeEach } from 'vitest'
import { freshApp } from './test/setup.js'
import { installFakeChain } from './test/chain.js'
import type { App } from './app.js'
import { AgentSouk, AgentSoukError, walletMessage } from '../../sdk/src/index.js'
import { randomWallet } from './test/setup.js'

/** The npm SDK exercised against the in-process app via an injected fetch. */
let app: App
let fetchLike: (input: string, init?: RequestInit) => Promise<Response>
/** registers an agent and binds a throwaway wallet with a real personal_sign signature */
async function registerWithWallet(name: string, base: { baseUrl: string; fetch: typeof fetchLike }, extra: Record<string, unknown> = {}) {
  const reg = await AgentSouk.register({ name, ...extra }, base)
  const w = randomWallet()
  const c = new AgentSouk({ ...base, apiKey: reg.api_keys.test })
  const bound = await c.agents.setWalletAddress(w.address, w.sign(walletMessage(reg.agent.id, w.address)))
  return { ...reg, wallet_address: bound.wallet_address, wallet: w }
}

beforeEach(async () => {
  app = await freshApp()
  fetchLike = (input, init) => Promise.resolve(app.request(input.replace('http://localhost:8787', ''), init))
})

describe('sdk', () => {
  it('registers, sells, buys, pays wallet-to-wallet and completes a job through the client', async () => {
    const chain = installFakeChain('test')
    const base = { baseUrl: 'http://localhost:8787', fetch: fetchLike }
    const s = await registerWithWallet('SDK Seller', base, { capabilities: ['translation'] })
    const b = await registerWithWallet('SDK Buyer', base)
    const seller = new AgentSouk({ ...base, apiKey: s.api_keys.test })
    const buyer = new AgentSouk({ ...base, apiKey: b.api_keys.test })
    expect(seller.env).toBe('test')
    expect((await seller.agents.me()).handle).toBe('sdk-seller')
    expect((await buyer.payments.info()).model).toBe('proof_of_payment')

    const listing = await seller.listings.create({ title: 'Translate EN to DE', description: 'Send {text}; receive {translation}.', category: 'text', pricing_model: 'fixed', price: 400_000, input_schema: { type: 'object', required: ['text'] } })
    expect(listing.pricing.currency).toBe('USDC')
    const found = await buyer.listings.search({ q: 'translate' })
    expect(found.data[0]!.id).toBe(listing.id)
    const job = await buyer.jobs.create({ listing_id: listing.id, input: { text: 'hi' } })
    expect(job.status).toBe('open')
    expect(job.next_steps.length).toBeGreaterThan(0)
    expect(await buyer.jobs.paymentRequired(job.id)).toBeNull()
    const inbox = await seller.inbox()
    expect(inbox.jobs_awaiting_my_action[0]!.id).toBe(job.id)
    await seller.jobs.accept(job.id)
    await seller.threads.send(job.thread_id!, 'working on it')
    await seller.jobs.deliver(job.id, { translation: 'hallo' }, 'done', { first: 'hallo' })
    const waited = await buyer.waitForJob(job.id, { intervalMs: 1 })
    expect(waited.status).toBe('delivered')
    expect(waited.output_sealed).toBe(true)
    expect(waited.output).toBeNull()
    expect(waited.output_preview).toEqual({ first: 'hallo' })
    const terms = await buyer.jobs.paymentRequired(job.id)
    expect(terms).toMatchObject({ amount: 400_000, currency: 'USDC', network: 'eip155:84532' })
    expect(terms!.pay_to.toLowerCase()).toBe(s.wallet_address!.toLowerCase())
    const sent: string[] = []
    const paid = await buyer.jobs.pay(job.id, async (t) => {
      const tx = chain.pay(t.pay_from!, t.pay_to, t.amount)
      sent.push(tx)
      return tx
    })
    expect(paid.output).toEqual({ translation: 'hallo' })
    expect(paid.payment.status).toBe('paid')
    expect(paid.payment.settlement!.transaction).toBe(sent[0])
    expect((await buyer.jobs.pay(job.id, sent[0]!)).payment.settlement!.transaction).toBe(sent[0])
    const done = await buyer.jobs.accept(job.id)
    expect(done.status).toBe('completed')
    await buyer.jobs.review(job.id, 5, 'great')
    const stl = await seller.payments.settlements()
    expect(stl.data).toHaveLength(1)
    expect(stl.data[0]).toMatchObject({ direction: 'in', amount: 400_000, transaction: sent[0] })
    const ev = await seller.events.list({ types: 'job.completed' })
    expect(ev.data).toHaveLength(1)
    expect(ev.next_since).toBe(ev.data[0]!.id)
  })

  it('payGasless() signs the typed data, settles through the facilitator and submits the hash; declines surface with hints', async () => {
    const chain = installFakeChain('test')
    const facilitatorCalls: { url: string; init: RequestInit }[] = []
    let facilitatorAnswer: (body: any) => { status: number; json: unknown; text?: string } = (body) => {
      // a fake x402 facilitator: broadcasts the authorized transfer (mines it on the fake chain) and returns the hash
      const a = body.paymentPayload.payload.authorization
      return { status: 200, json: { success: true, transaction: chain.pay(a.from, a.to, Number(a.value)), network: body.paymentRequirements.network, payer: a.from } }
    }
    const fetchWithFacilitator: typeof fetchLike = async (input, init) => {
      if (input.startsWith('https://x402.org/facilitator')) {
        facilitatorCalls.push({ url: input, init: init! })
        const r = facilitatorAnswer(JSON.parse(String(init!.body))) // may throw: a transport failure
        return new Response(r.text ?? JSON.stringify(r.json), { status: r.status, headers: { 'content-type': 'application/json' } })
      }
      return fetchLike(input, init)
    }
    const base = { baseUrl: 'http://localhost:8787', fetch: fetchWithFacilitator }
    const s = await registerWithWallet('Gasless Seller', base)
    const b = await registerWithWallet('Gasless Buyer', base)
    const seller = new AgentSouk({ ...base, apiKey: s.api_keys.test })
    const buyer = new AgentSouk({ ...base, apiKey: b.api_keys.test })
    const listing = await seller.listings.create({ title: 'Gasless thing', description: 'Paid without ETH.', category: 'ops', pricing_model: 'fixed', price: 70_000 })
    const job = await buyer.jobs.create({ listing_id: listing.id, input: {} })
    await seller.jobs.accept(job.id)
    await seller.jobs.deliver(job.id, { ok: true })
    const signed: unknown[] = []
    const paid = await buyer.jobs.payGasless(job.id, (td) => {
      signed.push(td)
      expect(td.message).toMatchObject({ from: b.wallet_address, to: s.wallet_address, value: 70_000 })
      return 'ab'.repeat(65) // a wallet would sign here; the fake facilitator does not check signatures
    })
    expect(signed).toHaveLength(1)
    expect(facilitatorCalls).toHaveLength(1)
    expect(facilitatorCalls[0]!.url).toBe('https://x402.org/facilitator/settle')
    const sentBody = JSON.parse(String(facilitatorCalls[0]!.init.body))
    expect(sentBody.paymentPayload.payload.signature).toBe('0x' + 'ab'.repeat(65))
    expect(sentBody.paymentPayload.accepted.payTo.toLowerCase()).toBe(s.wallet_address!.toLowerCase())
    expect(sentBody.paymentRequirements.amount).toBe('70000')
    const facHeaders = facilitatorCalls[0]!.init.headers as Record<string, string>
    expect(Object.keys(facHeaders).map((h) => h.toLowerCase())).not.toContain('authorization') // the API key never reaches the facilitator
    expect(paid.payment.status).toBe('paid')
    expect(paid.output).toEqual({ ok: true })
    expect(chain.calls.some((c) => c.method === 'eth_sendRawTransaction')).toBe(false) // the platform never broadcasts

    // a declined authorization: nothing moved, the error says what to do
    const job2 = await buyer.jobs.create({ listing_id: listing.id, input: {} })
    await seller.jobs.accept(job2.id)
    await seller.jobs.deliver(job2.id, { ok: 2 })
    facilitatorAnswer = () => ({ status: 400, json: { success: false, errorReason: 'insufficient_funds' } })
    const declined = await buyer.jobs.payGasless(job2.id, () => '0x' + 'cd'.repeat(65)).catch((e) => e as AgentSoukError)
    expect(declined).toBeInstanceOf(AgentSoukError)
    expect((declined as AgentSoukError).code).toBe('facilitator_declined')
    expect((declined as AgentSoukError).message).toContain('insufficient_funds')
    expect((declined as AgentSoukError).hint).toContain('jobs.pay')
    expect((await buyer.jobs.get(job2.id)).payment.status).toBe('due')
    expect(facilitatorCalls).toHaveLength(2) // a 4xx decline is final: no retry
    // HTTP 200 with success:false (what x402 facilitators return for a failed settle) is a decline too
    facilitatorAnswer = () => ({ status: 200, json: { success: false, errorReason: 'invalid_exact_evm_payload_signature' } })
    const declined2 = await buyer.jobs.payGasless(job2.id, () => '0x' + 'cd'.repeat(65)).catch((e) => e as AgentSoukError)
    expect((declined2 as AgentSoukError).code).toBe('facilitator_declined')
    expect(facilitatorCalls).toHaveLength(3)
    // a signer that returns garbage never reaches the facilitator; a longer smart-wallet signature passes through
    const bad = await buyer.jobs.payGasless(job2.id, () => 'nope').catch((e) => e as AgentSoukError)
    expect((bad as AgentSoukError).code).toBe('signature_invalid')
    expect(facilitatorCalls).toHaveLength(3)
    facilitatorAnswer = () => ({ status: 400, json: { success: false, errorReason: 'x' } })
    await buyer.jobs.payGasless(job2.id, () => '0x' + 'ef'.repeat(130)).catch(() => undefined)
    expect(JSON.parse(String(facilitatorCalls[3]!.init.body)).paymentPayload.payload.signature).toBe('0x' + 'ef'.repeat(130))
    // transport failures and 5xx are NOT declines: the same body is re-sent (the derived nonce makes that safe), then the fate is reported as unknown with the body to re-POST
    facilitatorAnswer = () => {
      throw new Error('ECONNRESET')
    }
    const lost = await buyer.jobs.payGasless(job2.id, () => '0x' + 'cd'.repeat(65)).catch((e) => e as AgentSoukError)
    expect((lost as AgentSoukError).code).toBe('facilitator_unknown')
    expect((lost as AgentSoukError).hint).toContain('Do NOT sign')
    expect(((lost as AgentSoukError).details as { settle_body: { paymentPayload: { payload: { signature: string } } } }).settle_body.paymentPayload.payload.signature).toBe('0x' + 'cd'.repeat(65))
    expect(facilitatorCalls).toHaveLength(7) // three attempts with the identical body
    expect(new Set(facilitatorCalls.slice(4).map((c) => String(c.init.body))).size).toBe(1)
    facilitatorAnswer = () => ({ status: 503, json: {}, text: '<html>bad gateway</html>' })
    const gateway = await buyer.jobs.payGasless(job2.id, () => '0x' + 'cd'.repeat(65)).catch((e) => e as AgentSoukError)
    expect((gateway as AgentSoukError).code).toBe('facilitator_unknown')
    expect(facilitatorCalls).toHaveLength(10)
    // success without a usable hash: unknown as well
    facilitatorAnswer = () => ({ status: 200, json: { success: true, transaction: 'pending' } })
    expect(((await buyer.jobs.payGasless(job2.id, () => '0x' + 'cd'.repeat(65)).catch((e) => e as AgentSoukError)) as AgentSoukError).code).toBe('facilitator_unknown')
    // the facilitator broadcast a hash the chain does not show yet: the error keeps the hash so the agent resumes with jobs.pay instead of signing again
    facilitatorAnswer = () => ({ status: 200, json: { success: true, transaction: '0x' + '77'.repeat(32) } })
    const unseen = await buyer.jobs.payGasless(job2.id, () => '0x' + 'cd'.repeat(65), { retries: 1, intervalMs: 1 }).catch((e) => e as AgentSoukError)
    expect((unseen as AgentSoukError).code).toBe('transaction_not_found')
    expect(((unseen as AgentSoukError).details as { transaction: string }).transaction).toBe('0x' + '77'.repeat(32))
    expect((unseen as AgentSoukError).hint).toContain('do not sign a new authorization')
    // the terms must describe the advertised payment: the SDK refuses to sign anything else
    const tampering: typeof fetchLike = async (input, init) => {
      const res = await fetchWithFacilitator(input, init)
      if (input.endsWith('/pay') && res.status === 402) {
        const body = await res.json()
        body.gasless.typed_data.message.to = '0x' + '11'.repeat(20)
        return new Response(JSON.stringify(body), { status: 402, headers: { 'content-type': 'application/json' } })
      }
      return res
    }
    const tamperedBuyer = new AgentSouk({ ...base, apiKey: b.api_keys.test, fetch: tampering })
    const refused = await tamperedBuyer.jobs.payGasless(job2.id, () => '0x' + 'cd'.repeat(65)).catch((e) => e as AgentSoukError)
    expect((refused as AgentSoukError).code).toBe('terms_inconsistent')
    expect(facilitatorCalls).toHaveLength(12)
    // no wallet bound: no typed data to sign
    const nobody = await AgentSouk.register({ name: 'No Wallet Buyer' }, base)
    const nw = new AgentSouk({ ...base, apiKey: nobody.api_keys.test })
    const job3 = await nw.jobs.create({ listing_id: listing.id, input: {} })
    await seller.jobs.accept(job3.id)
    await seller.jobs.deliver(job3.id, { ok: 3 })
    const unbound = await nw.jobs.payGasless(job3.id, () => '0x' + 'ef'.repeat(65)).catch((e) => e as AgentSoukError)
    expect((unbound as AgentSoukError).code).toBe('wallet_address_required')
  })

  it('pay() waits for confirmations and retries with the same hash', async () => {
    const chain = installFakeChain('test')
    const { _setConfigForTests } = await import('./config.js')
    _setConfigForTests({ PAYMENT_CONFIRMATIONS_TEST: 2 })
    const base = { baseUrl: 'http://localhost:8787', fetch: fetchLike }
    const s = await registerWithWallet('Slow Seller', base)
    const b = await registerWithWallet('Patient Buyer', base)
    const seller = new AgentSouk({ ...base, apiKey: s.api_keys.test })
    const buyer = new AgentSouk({ ...base, apiKey: b.api_keys.test })
    const listing = await seller.listings.create({ title: 'Slow thing', description: 'Takes a while to confirm on-chain.', category: 'ops', pricing_model: 'fixed', price: 5 })
    const job = await buyer.jobs.create({ listing_id: listing.id, input: {} })
    await seller.jobs.accept(job.id)
    await seller.jobs.deliver(job.id, 'x')
    const tx = chain.pay(b.wallet_address!, s.wallet_address!, 5, { confirmations: 1 })
    setTimeout(() => chain.advance(1), 20)
    const paid = await buyer.jobs.pay(job.id, tx, { intervalMs: 10 })
    expect(paid.payment.status).toBe('paid')
    _setConfigForTests({ PAYMENT_CONFIRMATIONS_TEST: 1 })
  })

  it('surfaces errors with hints and does not retry 4xx', async () => {
    const base = { baseUrl: 'http://localhost:8787', fetch: fetchLike }
    const anon = new AgentSouk(base)
    try {
      await anon.agents.me()
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(AgentSoukError)
      const err = e as AgentSoukError
      expect(err.status).toBe(401)
      expect(err.code).toBe('unauthenticated')
      expect(err.hint).toContain('POST /v1/agents')
      expect(err.message).toContain('Hint:')
    }
    const r = await AgentSouk.register({ name: 'Poor' }, base)
    const live = new AgentSouk({ ...base, apiKey: r.api_keys.live })
    await expect(live.jobs.get('job_nobody')).rejects.toMatchObject({ status: 404 })
    await expect(live.agents.setWalletAddress('0x123', '0x00')).rejects.toMatchObject({ status: 400, param: 'address' })
  })

  it('signs requests with the Ed25519 secret key instead of an API key, including wallet-change proofs', async () => {
    const base = { baseUrl: 'http://localhost:8787', fetch: fetchLike }
    const r = await registerWithWallet('Signed Client', base)
    const signed = new AgentSouk({ ...base, secretKey: r.keypair!.secret_key, agentId: r.agent.id, env: 'test' })
    expect(signed.env).toBe('test')
    const me = await signed.agents.me()
    expect(me.id).toBe(r.agent.id)
    expect(me.env).toBe('test')
    const listing = await signed.listings.create({ title: 'Signed listing', description: 'Made with a signed POST including content-digest.', category: 'ops', pricing_model: 'fixed', price: 5 })
    expect(listing.seller.id).toBe(r.agent.id)
    const next = randomWallet()
    const changed = await signed.agents.setWalletAddress(next.address, next.sign(walletMessage(r.agent.id, next.address)))
    expect(changed.wallet_address!.toLowerCase()).toBe(next.address.toLowerCase())
    const wrong = new AgentSouk({ ...base, secretKey: 'ab'.repeat(32), agentId: r.agent.id })
    await expect(wrong.agents.me()).rejects.toMatchObject({ status: 401, code: 'invalid_signature' })
  })

  it('SSE stream delivers events and can be stopped', async () => {
    const base = { baseUrl: 'http://localhost:8787', fetch: fetchLike }
    const r = await AgentSouk.register({ name: 'Streamer' }, base)
    const c = new AgentSouk({ ...base, apiKey: r.api_keys.test })
    const other = await AgentSouk.register({ name: 'Other' }, base)
    const got: string[] = []
    const stop = c.events.stream((e) => got.push(e.type))
    await new Promise((res) => setTimeout(res, 50))
    await new AgentSouk({ ...base, apiKey: other.api_keys.test }).threads.start(r.agent.handle, 'ping')
    for (let i = 0; i < 40 && !got.length; i++) await new Promise((res) => setTimeout(res, 25))
    stop()
    expect(got).toContain('message.received')
  })
})
