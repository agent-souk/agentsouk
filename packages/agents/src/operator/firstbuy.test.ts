/**
 * First-buy programme end to end against the real API in-process: an outside seller lists, the desk hires the
 * listing, pays the sealed delivery gas-free through a fake facilitator that mines on the same fake Base node the
 * platform's chain reader uses, grades the revealed work (scripted judge), accepts, reviews; caps and skips; a
 * lost facilitator answer is recovered from the chain instead of a second signature; state survives a restart.
 */
import { describe, expect, it } from 'vitest'
import type { App } from '../../../api/src/app.js'
import { installFakeChain, type FakeChain } from '../../../api/src/test/chain.js'
import { call, createTestAgent, freshApp, type TestAgent } from '../../../api/src/test/setup.js'
import { AgentSouk } from '../../../sdk/src/index.js'
import { DEFAULT_FIRSTBUY, FirstBuyer, type FirstBuyConfig } from './firstbuy.js'
import type { Judge, Verdict } from './judge.js'
import { CHAINS, typedDataSigner, UsdcWallet, type RpcFetch } from './usdc.js'

const base = 'http://localhost:8787'
const SETTLE = 'https://x402.org/facilitator/settle'

/**
 * A fake public facilitator: verifies nothing, mines the authorized transfer on the fake chain and answers with the
 * hash. `mode` controls failure injection; nonces are single-use like on the real USDC contract.
 */
function fakeFacilitator(chain: FakeChain) {
  const used = new Set<string>()
  const calls: unknown[] = []
  const f = { mode: 'ok' as 'ok' | 'lose_answer' | 'down', calls, used, handle: async (_bodyText: string): Promise<Response> => new Response() }
  f.handle = async (bodyText: string): Promise<Response> => {
    const body = JSON.parse(bodyText) as { paymentPayload: { payload: { signature: string; authorization: { from: string; to: string; value: string; nonce: string } } } }
    calls.push(body)
    const a = body.paymentPayload.payload.authorization
    if (f.mode === 'down') return new Response('<html>502</html>', { status: 502 })
    if (used.has(a.nonce)) return new Response(JSON.stringify({ success: false, errorReason: 'invalid_exact_evm_payload_authorization_used' }), { status: 400, headers: { 'content-type': 'application/json' } })
    if (!/^0x[0-9a-f]{130}$/i.test(body.paymentPayload.payload.signature)) return new Response(JSON.stringify({ success: false, errorReason: 'invalid_exact_evm_payload_signature' }), { status: 400, headers: { 'content-type': 'application/json' } })
    used.add(a.nonce)
    const hash = chain.pay(a.from, a.to, Number(a.value))
    if (f.mode === 'lose_answer') {
      f.mode = 'ok'
      throw new Error('ECONNRESET') // broadcast, but the answer never arrived
    }
    return new Response(JSON.stringify({ success: true, transaction: hash, network: 'eip155:84532' }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return f
}

function clientFor(app: App, key: string, facilitator?: ReturnType<typeof fakeFacilitator>) {
  return new AgentSouk({
    baseUrl: base,
    apiKey: key,
    fetch: async (input, init) => {
      if (facilitator && String(input).startsWith(SETTLE)) return facilitator.handle(String(init?.body))
      return app.request(String(input).replace(base, ''), init)
    },
  })
}

/** The desk wallet reads balances and logs from the shared fake chain (no broadcasting: the facilitator does that). */
function walletFor(privateKey: string, chain: FakeChain) {
  const rpc: RpcFetch = (url, body) => chain.fetch(url, body)
  return new UsdcWallet(privateKey, CHAINS.test, { fetchImpl: rpc, sleep: async () => undefined })
}

function scriptedJudge(script: { verdict?: Verdict['decision']; rating?: Verdict['rating'] } = {}) {
  const seen: unknown[] = []
  const judge = {
    seen,
    evaluateListingDelivery: async (f: unknown): Promise<Verdict> => {
      seen.push(f)
      return { decision: script.verdict ?? 'accept', rating: script.rating ?? 5, message: script.verdict === 'revise' ? 'The links array is empty although the page has links; please add them.' : 'Exactly what the listing promised.', rubric_scores: [] }
    },
  }
  return judge as unknown as Pick<Judge, 'evaluateListingDelivery'> & { seen: unknown[] }
}

async function listingBy(app: App, seller: TestAgent, over: Record<string, unknown> = {}) {
  const r = await call(app, 'POST', '/v1/listings', {
    key: seller.api_keys.test,
    body: { title: 'HTML to JSON', description: 'Send {html}; get {title, links}. Deterministic extraction.', category: 'data', pricing_model: 'fixed', price: 50_000, input_schema: { type: 'object', required: ['html'] }, example_input: { html: '<h1>Hi</h1>' }, turnaround_seconds: 600, accept_timeout_seconds: 600, ...over },
  })
  if (r.status !== 201) throw new Error(JSON.stringify(r.body))
  return r.body as { id: string; seller: { id: string } }
}

const cfg = (over: Partial<FirstBuyConfig> = {}): FirstBuyConfig => ({ ...DEFAULT_FIRSTBUY.test, sellerCooldownMs: 0, ...over })

describe('FirstBuyer', () => {
  it('hires a new outside listing, pays the sealed delivery gas-free, grades, accepts and reviews; skips what the rules forbid; survives a restart', async () => {
    const app = await freshApp()
    const chain = installFakeChain('test')
    const desk = await createTestAgent(app, { name: 'Souk Bounties' })
    const seller = await createTestAgent(app, { name: 'Outside Seller' })
    const other = await createTestAgent(app, { name: 'Other Seller' })
    const fac = fakeFacilitator(chain)
    const deskClient = clientFor(app, desk.api_keys.test, fac)
    const judge = scriptedJudge()
    const logs: Record<string, unknown>[] = []
    const spend: bigint[] = []
    const mk = (c: FirstBuyConfig = cfg()) => new FirstBuyer(deskClient, walletFor(desk.wallet!.privateKey, chain), typedDataSigner(desk.wallet!.privateKey, CHAINS.test), judge, 'test', (m, x) => logs.push({ m, ...x }), c, () => ({ id: desk.agent.id }), { canSpend: async (a) => (spend.push(a), true) })

    const good = await listingBy(app, seller)
    const tooDear = await listingBy(app, other, { price: 2_000_000 })
    const upfront = await listingBy(app, other, { payment: 'upfront' })
    const free = await listingBy(app, other, { price: 0 })

    // 1. discovery: one purchase, three skips
    const fb = mk()
    await fb.tick()
    let st = fb.stateOf()!
    expect(st.purchases).toHaveLength(1)
    expect(st.purchases[0]).toMatchObject({ listing_id: good.id, seller_id: seller.agent.id, price: 50_000, pay_hash: null, outcome: null })
    expect(st.skipped[tooDear.id]).toContain('above the cap')
    expect(st.skipped[upfront.id]).toBe('upfront payment')
    expect(st.skipped[free.id]).toBe('free or unpriced')
    const jobId = st.purchases[0]!.job_id
    const job = (await call(app, 'GET', `/v1/jobs/${jobId}`, { key: seller.api_keys.test })).body
    expect(job.status).toBe('open')
    expect(job.input).toEqual({ html: '<h1>Hi</h1>' })
    expect(job.max_revisions).toBe(1)
    const thread = (await call(app, 'GET', `/v1/threads/${job.thread_id}/messages?order=asc`, { key: seller.api_keys.test })).body
    expect(thread.data.some((m: { body: string }) => m.body.includes('first-buy programme'))).toBe(true)
    await fb.tick() // nothing new: the listing is bought, the seller has an open purchase
    expect(fb.stateOf()!.purchases).toHaveLength(1)
    expect(spend).toEqual([50_000n])

    // 2. sealed delivery -> paid gas-free through the facilitator -> revealed -> graded -> accepted -> completed -> reviewed
    const s = clientFor(app, seller.api_keys.test)
    await s.jobs.accept(jobId)
    await s.jobs.deliver(jobId, { title: 'Hi', links: [] }, 'done', { title: 'Hi' })
    const restarted = mk() // a fresh instance loads the state from platform memory
    await restarted.tick()
    st = restarted.stateOf()!
    expect(st.purchases[0]!.pay_hash).toMatch(/^0x[0-9a-f]{64}$/)
    expect(fac.calls).toHaveLength(1)
    expect(judge.seen).toHaveLength(1)
    expect((judge.seen[0] as { listing: { title: string }; input: unknown }).listing.title).toBe('HTML to JSON')
    expect(st.purchases[0]!.verdict).toMatchObject({ decision: 'accept', rating: 5, acted: true })
    let view = (await call(app, 'GET', `/v1/jobs/${jobId}`, { key: seller.api_keys.test })).body
    expect(view.status).toBe('completed')
    expect(view.payment.status).toBe('paid')
    expect(view.payment.settlement.transaction).toBe(st.purchases[0]!.pay_hash)
    await restarted.tick()
    st = restarted.stateOf()!
    expect(st.purchases[0]).toMatchObject({ outcome: 'paid', reviewed: true, rating: 5 })
    const reviews = (await call(app, 'GET', `/v1/agents/${seller.agent.id}/reviews`)).body
    expect(reviews.data[0]).toMatchObject({ rating: 5 })
    expect(reviews.data[0].comment).toContain('First buy by the platform desk')
    expect(chain.calls.some((c) => c.method === 'eth_sendRawTransaction')).toBe(false) // the desk itself broadcast nothing
    expect(restarted.status()).toMatchObject({ purchases: 1, paid: 1, paid_total: '0.050000 USDC' })

    // 3. per-seller limit: a second listing is bought, a third is not
    const second = await listingBy(app, seller, { title: 'Second service' })
    await restarted.tick()
    expect(restarted.stateOf()!.purchases.map((p) => p.listing_id)).toEqual([good.id, second.id])
    const third = await listingBy(app, seller, { title: 'Third service' })
    const p2 = restarted.stateOf()!.purchases[1]!
    await s.jobs.accept(p2.job_id)
    await s.jobs.deliver(p2.job_id, { title: 'x', links: [] })
    await restarted.tick()
    await restarted.tick()
    expect(restarted.stateOf()!.purchases[1]!.outcome).toBe('paid')
    await restarted.tick()
    expect(restarted.stateOf()!.skipped[third.id]).toContain('seller already bought 2 times')
  })

  it('recovers a payment whose facilitator answer was lost from the chain, and stops for a human when the facilitator stays down', async () => {
    const app = await freshApp()
    const chain = installFakeChain('test')
    const desk = await createTestAgent(app, { name: 'Souk Bounties' })
    const seller = await createTestAgent(app, { name: 'Outside Seller' })
    const fac = fakeFacilitator(chain)
    const deskClient = clientFor(app, desk.api_keys.test, fac)
    const judge = scriptedJudge({ verdict: 'revise', rating: 2 })
    const fb = new FirstBuyer(deskClient, walletFor(desk.wallet!.privateKey, chain), typedDataSigner(desk.wallet!.privateKey, CHAINS.test), judge, 'test', () => undefined, cfg(), () => ({ id: desk.agent.id }), { canSpend: async () => true })
    await listingBy(app, seller)
    await fb.tick()
    const p = fb.stateOf()!.purchases[0]!
    const s = clientFor(app, seller.api_keys.test)
    await s.jobs.accept(p.job_id)
    await s.jobs.deliver(p.job_id, { title: 'Hi', links: [] })

    // the facilitator broadcasts but the answer is lost; the SDK re-sends the same body and is told the nonce is used
    fac.mode = 'lose_answer'
    await fb.tick()
    expect(p.pay_hash).toBeNull()
    expect(p.pay_attempt_at).toBeTruthy()
    expect(p.pay_failures).toBe(1)
    expect(fac.calls).toHaveLength(2)
    expect(fac.used.size).toBe(1)
    // next tick: the transfer is found on the chain and submitted, no second signature
    await fb.tick()
    expect(p.pay_hash).toMatch(/^0x[0-9a-f]{64}$/)
    expect(fac.calls).toHaveLength(2)
    let view = (await call(app, 'GET', `/v1/jobs/${p.job_id}`, { key: seller.api_keys.test })).body
    expect(view.payment.status).toBe('paid')
    // revealed and graded "revise": one revision is requested, the re-delivery is graded again and accepted
    expect(view.status).toBe('in_progress')
    expect(p.verdict).toMatchObject({ decision: 'revise', acted: true })
    await s.jobs.deliver(p.job_id, { title: 'Hi', links: ['/x'] })
    await fb.tick()
    view = (await call(app, 'GET', `/v1/jobs/${p.job_id}`, { key: seller.api_keys.test })).body
    expect(view.status).toBe('completed') // no revisions left: the second verdict "revise" becomes accept
    await fb.tick()
    expect(p.outcome).toBe('paid')
    expect(p.rating).toBe(2)

    // a facilitator that stays down: three attempts per tick, three ticks, then a human
    const seller2 = await createTestAgent(app, { name: 'Second Seller' })
    await listingBy(app, seller2)
    await fb.tick()
    const q = fb.stateOf()!.purchases[1]!
    const s2 = clientFor(app, seller2.api_keys.test)
    await s2.jobs.accept(q.job_id)
    await s2.jobs.deliver(q.job_id, { title: 'x', links: [] })
    fac.mode = 'down'
    for (let i = 0; i < 3; i++) await fb.tick()
    expect(q.pay_failures).toBe(3)
    expect(q.pay_hash).toBeNull()
    await fb.tick()
    expect(q.needs_operator).toContain('failed 3 times')
    expect(fb.status().open[0]!.needs_operator).toBeTruthy()
    fac.mode = 'ok'
    await fb.tick()
    expect(q.pay_hash).toBeNull() // stopped: a human clears it
  })

  it('never buys first-party listings, respects the programme daily cap and the desk caps', async () => {
    const app = await freshApp()
    const chain = installFakeChain('test')
    const desk = await createTestAgent(app, { name: 'Souk Bounties' })
    const a = await createTestAgent(app, { name: 'Seller A' })
    const b = await createTestAgent(app, { name: 'Seller B' })
    const fac = fakeFacilitator(chain)
    const deskClient = clientFor(app, desk.api_keys.test, fac)
    await listingBy(app, a, { price: 60_000 })
    await listingBy(app, b, { price: 60_000 })
    const own = (await call(app, 'POST', '/v1/listings', { key: desk.api_keys.test, body: { title: 'Own thing', description: 'The desk must not buy from itself.', category: 'ops', pricing_model: 'fixed', price: 10_000 } })).body as { id: string }
    let allow = true
    const fb = new FirstBuyer(deskClient, walletFor(desk.wallet!.privateKey, chain), typedDataSigner(desk.wallet!.privateKey, CHAINS.test), scriptedJudge(), 'test', () => undefined, cfg({ dailyCap: 100_000n }), () => ({ id: desk.agent.id }), { canSpend: async () => allow })
    await fb.tick()
    const st = fb.stateOf()!
    expect(st.purchases).toHaveLength(1) // the second would exceed the 0.1 USDC daily cap
    expect(st.skipped[own.id]).toBe('first-party listing')
    allow = false
    const c = await createTestAgent(app, { name: 'Seller C' })
    await listingBy(app, c, { price: 10_000 })
    await fb.tick()
    expect(st.purchases).toHaveLength(1) // held by the desk caps
    allow = true
    await fb.tick()
    expect(st.purchases).toHaveLength(2)
  })
})
