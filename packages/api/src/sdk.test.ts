import { describe, it, expect, beforeEach } from 'vitest'
import { freshApp } from './test/setup.js'
import type { App } from './app.js'
import { AgentWorld, AgentWorldError } from '../../sdk/src/index.js'

/** The npm SDK exercised against the in-process app via an injected fetch. */
let app: App
let fetchLike: (input: string, init?: RequestInit) => Promise<Response>

beforeEach(async () => {
  app = await freshApp()
  fetchLike = (input, init) => Promise.resolve(app.request(input.replace('http://localhost:8787', ''), init))
})

describe('sdk', () => {
  it('registers, sells, buys and completes a job through the client', async () => {
    const base = { baseUrl: 'http://localhost:8787', fetch: fetchLike }
    const s = await AgentWorld.register({ name: 'SDK Seller', capabilities: ['translation'] }, base)
    const b = await AgentWorld.register({ name: 'SDK Buyer' }, base)
    const seller = new AgentWorld({ ...base, apiKey: s.api_keys.test })
    const buyer = new AgentWorld({ ...base, apiKey: b.api_keys.test })
    expect(seller.env).toBe('test')
    expect((await seller.agents.me()).handle).toBe('sdk-seller')

    const listing = await seller.listings.create({ title: 'Translate EN to DE', description: 'Send {text}; receive {translation}.', category: 'text', pricing_model: 'fixed', price: 400, input_schema: { type: 'object', required: ['text'] } })
    const found = await buyer.listings.search({ q: 'translate' })
    expect(found.data[0]!.id).toBe(listing.id)
    const job = await buyer.jobs.create({ listing_id: listing.id, input: { text: 'hi' } })
    expect(job.status).toBe('open')
    expect(job.next_steps.length).toBeGreaterThan(0)
    const inbox = await seller.inbox()
    expect(inbox.jobs_awaiting_my_action[0]!.id).toBe(job.id)
    await seller.jobs.accept(job.id)
    await seller.threads.send(job.thread_id!, 'working on it')
    await seller.jobs.deliver(job.id, { translation: 'hallo' })
    const waited = await buyer.waitForJob(job.id, { intervalMs: 1 })
    expect(waited.status).toBe('delivered')
    const done = await buyer.jobs.accept(job.id)
    expect(done.status).toBe('completed')
    await buyer.jobs.review(job.id, 5, 'great')
    const w = await seller.wallet.get()
    expect(w.balances[0]!.available).toBe(100_000 + 400 - 12)
    const ev = await seller.events.list({ types: 'job.completed' })
    expect(ev.data).toHaveLength(1)
    expect(ev.next_since).toBe(ev.data[0]!.id)
  })

  it('surfaces errors with hints and does not retry 4xx', async () => {
    const base = { baseUrl: 'http://localhost:8787', fetch: fetchLike }
    const anon = new AgentWorld(base)
    try {
      await anon.agents.me()
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(AgentWorldError)
      const err = e as AgentWorldError
      expect(err.status).toBe(401)
      expect(err.code).toBe('unauthenticated')
      expect(err.hint).toContain('POST /v1/agents')
      expect(err.message).toContain('Hint:')
    }
    const r = await AgentWorld.register({ name: 'Poor' }, base)
    const live = new AgentWorld({ ...base, apiKey: r.api_keys.live })
    await expect(live.wallet.transfer({ to: 'nobody', amount: 1 })).rejects.toMatchObject({ status: 404 })
  })

  it('signs requests with the Ed25519 secret key instead of an API key', async () => {
    const base = { baseUrl: 'http://localhost:8787', fetch: fetchLike }
    const r = await AgentWorld.register({ name: 'Signed Client' }, base)
    const signed = new AgentWorld({ ...base, secretKey: r.keypair!.secret_key, agentId: r.agent.id, env: 'test' })
    expect(signed.env).toBe('test')
    const me = await signed.agents.me()
    expect(me.id).toBe(r.agent.id)
    expect(me.env).toBe('test')
    const listing = await signed.listings.create({ title: 'Signed listing', description: 'Made with a signed POST including content-digest.', category: 'ops', pricing_model: 'fixed', price: 5 })
    expect(listing.seller.id).toBe(r.agent.id)
    const wrong = new AgentWorld({ ...base, secretKey: 'ab'.repeat(32), agentId: r.agent.id })
    await expect(wrong.agents.me()).rejects.toMatchObject({ status: 401, code: 'invalid_signature' })
  })

  it('SSE stream delivers events and can be stopped', async () => {
    const base = { baseUrl: 'http://localhost:8787', fetch: fetchLike }
    const r = await AgentWorld.register({ name: 'Streamer' }, base)
    const c = new AgentWorld({ ...base, apiKey: r.api_keys.test })
    const other = await AgentWorld.register({ name: 'Other' }, base)
    const got: string[] = []
    const stop = c.events.stream((e) => got.push(e.type))
    await new Promise((res) => setTimeout(res, 50))
    await new AgentWorld({ ...base, apiKey: other.api_keys.test }).threads.start(r.agent.handle, 'ping')
    for (let i = 0; i < 40 && !got.length; i++) await new Promise((res) => setTimeout(res, 25))
    stop()
    expect(got).toContain('message.received')
  })
})
