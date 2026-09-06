import { describe, it, expect, beforeEach } from 'vitest'
import { freshApp } from './test/setup.js'
import { installFakeChain } from './test/chain.js'
import type { App } from './app.js'
import { AgentSouk, AgentSoukError } from '../../sdk/src/index.js'

/** The npm SDK exercised against the in-process app via an injected fetch. */
let app: App
let fetchLike: (input: string, init?: RequestInit) => Promise<Response>
const wallet = () => '0x' + Array.from({ length: 40 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('')

beforeEach(async () => {
  app = await freshApp()
  fetchLike = (input, init) => Promise.resolve(app.request(input.replace('http://localhost:8787', ''), init))
})

describe('sdk', () => {
  it('registers, sells, buys, pays wallet-to-wallet and completes a job through the client', async () => {
    const chain = installFakeChain('test')
    const base = { baseUrl: 'http://localhost:8787', fetch: fetchLike }
    const s = await AgentSouk.register({ name: 'SDK Seller', capabilities: ['translation'], wallet_address: wallet() }, base)
    const b = await AgentSouk.register({ name: 'SDK Buyer', wallet_address: wallet() }, base)
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

  it('pay() waits for confirmations and retries with the same hash', async () => {
    const chain = installFakeChain('test')
    const { _setConfigForTests } = await import('./config.js')
    _setConfigForTests({ PAYMENT_CONFIRMATIONS_TEST: 2 })
    const base = { baseUrl: 'http://localhost:8787', fetch: fetchLike }
    const s = await AgentSouk.register({ name: 'Slow Seller', wallet_address: wallet() }, base)
    const b = await AgentSouk.register({ name: 'Patient Buyer', wallet_address: wallet() }, base)
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
    await expect(live.agents.setWalletAddress('0x123')).rejects.toMatchObject({ status: 400, param: 'wallet_address' })
  })

  it('signs requests with the Ed25519 secret key instead of an API key, including wallet-change proofs', async () => {
    const base = { baseUrl: 'http://localhost:8787', fetch: fetchLike }
    const r = await AgentSouk.register({ name: 'Signed Client', wallet_address: wallet() }, base)
    const signed = new AgentSouk({ ...base, secretKey: r.keypair!.secret_key, agentId: r.agent.id, env: 'test' })
    expect(signed.env).toBe('test')
    const me = await signed.agents.me()
    expect(me.id).toBe(r.agent.id)
    expect(me.env).toBe('test')
    const listing = await signed.listings.create({ title: 'Signed listing', description: 'Made with a signed POST including content-digest.', category: 'ops', pricing_model: 'fixed', price: 5 })
    expect(listing.seller.id).toBe(r.agent.id)
    const next = wallet()
    const changed = await signed.agents.setWalletAddress(next)
    expect(changed.wallet_address!.toLowerCase()).toBe(next)
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
