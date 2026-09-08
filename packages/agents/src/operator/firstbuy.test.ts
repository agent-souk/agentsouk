/**
 * First-buy programme end to end against the real API in-process: an outside seller lists, the desk hires the
 * listing, pays the sealed delivery gas-free through a fake facilitator that mines on the same fake Base node the
 * platform's chain reader uses, grades the revealed work (scripted judge), accepts, reviews; caps and skips; a
 * lost facilitator answer is recovered from the chain by the job's nonce; silent sellers are cancelled; state is
 * re-read from platform memory every tick (restart, human edit); the state stays under the memory limit.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { App } from '../../../api/src/app.js'
import { installFakeChain, type FakeChain } from '../../../api/src/test/chain.js'
import { call, createTestAgent, freshApp, setWallet, type TestAgent } from '../../../api/src/test/setup.js'
import { AgentSouk } from '../../../sdk/src/index.js'
import { compactState, DEFAULT_FIRSTBUY, FirstBuyer, type FirstBuyConfig, type FirstBuyState, type Purchase } from './firstbuy.js'
import { escapeUntrusted, type Judge, type Verdict } from './judge.js'
import { AUTHORIZATION_USED_TOPIC, CHAINS, typedDataSigner, UsdcWallet, type RpcFetch } from './usdc.js'

const base = 'http://localhost:8787'
const SETTLE = 'https://x402.org/facilitator/settle'
const pad = (a: string) => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0')

/**
 * A fake public facilitator: verifies nothing, mines the authorized transfer on the fake chain (with USDC's
 * AuthorizationUsed log) and answers with the hash. `mode` injects failures; nonces are single-use like on-chain.
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
    const hash = chain.pay(a.from, a.to, Number(a.value), { logs: [{ address: chain.usdc, topics: [AUTHORIZATION_USED_TOPIC, pad(a.from), a.nonce] }] })
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

type World = Awaited<ReturnType<typeof world>>
async function world(judgeScript: Parameters<typeof scriptedJudge>[0] = {}, c: Partial<FirstBuyConfig> = {}) {
  const app = await freshApp()
  const chain = installFakeChain('test')
  const desk = await createTestAgent(app, { name: 'Souk Bounties' })
  const fac = fakeFacilitator(chain)
  const deskClient = clientFor(app, desk.api_keys.test, fac)
  const judge = scriptedJudge(judgeScript)
  const logs: Record<string, unknown>[] = []
  const spend: bigint[] = []
  const ledger: unknown[] = []
  let allow = true
  const mk = (over: Partial<FirstBuyConfig> = {}) => new FirstBuyer(deskClient, walletFor(desk.wallet!.privateKey, chain), typedDataSigner(desk.wallet!.privateKey, CHAINS.test), judge, 'test', (m, x) => logs.push({ m, ...x }), cfg({ ...c, ...over }), () => ({ id: desk.agent.id }), { canSpend: async (a) => (spend.push(a), allow), recordSpend: async (e) => void ledger.push(e) })
  return { app, chain, desk, fac, deskClient, judge, logs, spend, ledger, mk, setAllow: (v: boolean) => void (allow = v) }
}

const view = (w: World, key: string, jobId: string) => call(w.app, 'GET', `/v1/jobs/${jobId}`, { key }).then((r) => r.body)

afterEach(() => vi.useRealTimers())

describe('FirstBuyer', () => {
  it('hires a new outside listing, pays the sealed delivery gas-free, grades, accepts and reviews; skips what the rules forbid; survives a restart', async () => {
    const w = await world()
    const seller = await createTestAgent(w.app, { name: 'Outside Seller' })
    const other = await createTestAgent(w.app, { name: 'Other Seller' })
    const good = await listingBy(w.app, seller)
    const tooDear = await listingBy(w.app, other, { price: 2_000_000 })
    const upfront = await listingBy(w.app, other, { payment: 'upfront' })
    const free = await listingBy(w.app, other, { price: 0 })

    // 1. discovery: one purchase; the server-side filters hide upfront and too-dear listings, the free one is skipped for good
    const fb = w.mk()
    await fb.tick()
    let st = fb.stateOf()!
    expect(st.purchases).toHaveLength(1)
    expect(st.purchases[0]).toMatchObject({ listing_id: good.id, seller_id: seller.agent.id, price: 50_000, pay_hash: null, outcome: null })
    expect(st.purchases[0]!.wallet!.toLowerCase()).toBe(seller.wallet_address!.toLowerCase())
    expect(st.index[good.id]).toMatchObject({ seller_id: seller.agent.id, price: 50_000, outcome: null })
    expect(st.skipped[free.id]).toBe('free or unpriced')
    expect(st.skipped[tooDear.id]).toBeUndefined()
    expect(st.skipped[upfront.id]).toBeUndefined()
    const jobId = st.purchases[0]!.job_id
    const job = await view(w, seller.api_keys.test, jobId)
    expect(job.status).toBe('open')
    expect(job.input).toEqual({ html: '<h1>Hi</h1>' })
    expect(job.max_revisions).toBe(1)
    const thread = (await call(w.app, 'GET', `/v1/threads/${job.thread_id}/messages?order=asc`, { key: seller.api_keys.test })).body
    expect(thread.data.some((m: { body: string }) => m.body.includes('first-buy programme'))).toBe(true)
    await fb.tick() // nothing new: the listing is bought, the seller has an open purchase
    expect(fb.stateOf()!.purchases).toHaveLength(1)
    expect(w.spend).toEqual([50_000n])

    // 2. sealed delivery -> paid gas-free through the facilitator -> revealed -> graded -> accepted -> completed -> reviewed, all in one tick
    const s = clientFor(w.app, seller.api_keys.test)
    await s.jobs.accept(jobId)
    await s.jobs.deliver(jobId, { title: 'Hi', links: [] }, 'done', { title: 'Hi' })
    const restarted = w.mk() // a fresh instance loads the state from platform memory
    await restarted.tick()
    st = restarted.stateOf()!
    expect(st.purchases[0]!.pay_hash).toMatch(/^0x[0-9a-f]{64}$/)
    expect(w.fac.calls).toHaveLength(1)
    expect(w.ledger).toEqual([{ job_id: jobId, amount: '50000', hash: st.purchases[0]!.pay_hash, at: expect.any(String) }])
    expect(w.judge.seen).toHaveLength(1)
    expect((w.judge.seen[0] as { listing: { title: string } }).listing.title).toBe('HTML to JSON')
    expect(st.purchases[0]!.verdict).toMatchObject({ decision: 'accept', rating: 5, acted: true })
    const done = await view(w, seller.api_keys.test, jobId)
    expect(done.status).toBe('completed')
    expect(done.payment.status).toBe('paid')
    expect(done.payment.settlement.transaction).toBe(st.purchases[0]!.pay_hash)
    await restarted.tick()
    st = restarted.stateOf()!
    expect(st.purchases[0]).toMatchObject({ outcome: 'paid', reviewed: true, rating: 5 })
    expect(st.index[good.id]!.outcome).toBe('paid')
    const reviews = (await call(w.app, 'GET', `/v1/agents/${seller.agent.id}/reviews`)).body
    expect(reviews.data[0]).toMatchObject({ rating: 5 })
    expect(reviews.data[0].comment).toContain('First buy by the platform desk')
    expect(w.chain.calls.some((c) => c.method === 'eth_sendRawTransaction')).toBe(false) // the desk itself broadcast nothing
    expect(restarted.status()).toMatchObject({ purchases: 1, paid: 1, paid_total: '0.050000 USDC' })

    // 3. per-seller limit: a second listing is bought, a third is not; the limit survives a compacted history
    const second = await listingBy(w.app, seller, { title: 'Second service' })
    await restarted.tick()
    expect(Object.keys(restarted.stateOf()!.index)).toEqual([good.id, second.id])
    const third = await listingBy(w.app, seller, { title: 'Third service' })
    const p2 = restarted.stateOf()!.purchases.find((p) => p.listing_id === second.id)!
    await s.jobs.accept(p2.job_id)
    await s.jobs.deliver(p2.job_id, { title: 'x', links: [] })
    await restarted.tick()
    await restarted.tick()
    expect(restarted.stateOf()!.purchases.find((p) => p.listing_id === second.id)!.outcome).toBe('paid')
    await restarted.tick()
    expect(restarted.stateOf()!.skipped[third.id]).toContain('seller already bought 2 times')
  })

  it('recovers a lost facilitator answer by the job nonce (not by amount), asks for one revision, and stops for a human when the facilitator stays down; a human edit of the memory key is honoured', async () => {
    const w = await world({ verdict: 'revise', rating: 2 })
    const seller = await createTestAgent(w.app, { name: 'Outside Seller' })
    const fb = w.mk()
    await listingBy(w.app, seller)
    await fb.tick()
    const p = fb.stateOf()!.purchases[0]!
    const s = clientFor(w.app, seller.api_keys.test)
    await s.jobs.accept(p.job_id)
    await s.jobs.deliver(p.job_id, { title: 'Hi', links: [] })
    // a decoy: an unrelated transfer of the same amount from the desk to the same seller wallet (e.g. a bounty award)
    const decoy = w.chain.pay(w.desk.wallet_address!, seller.wallet_address!, 50_000)

    // the facilitator broadcasts but the answer is lost; the SDK re-sends the same body and is told the nonce is used
    w.fac.mode = 'lose_answer'
    await fb.tick()
    let q = fb.stateOf()!.purchases[0]!
    expect(q.pay_hash).toBeNull()
    expect(q.pay_attempt_at).toBeTruthy()
    expect(q.pay_failures).toBe(1)
    expect(w.fac.calls).toHaveLength(2)
    expect(w.fac.used.size).toBe(1)
    // next tick: the transfer with the job's nonce is found on the chain (not the decoy) and submitted, no second signature
    await fb.tick()
    q = fb.stateOf()!.purchases[0]!
    expect(q.pay_hash).toMatch(/^0x[0-9a-f]{64}$/)
    expect(q.pay_hash).not.toBe(decoy)
    expect(w.fac.calls).toHaveLength(2)
    expect(w.ledger).toHaveLength(1)
    let j = await view(w, seller.api_keys.test, p.job_id)
    expect(j.payment.status).toBe('paid')
    expect(j.payment.settlement.transaction).toBe(q.pay_hash)
    // revealed and graded "revise" in the same tick: one revision is requested; the re-delivery is graded again and accepted
    expect(j.status).toBe('in_progress')
    expect(q.verdict).toMatchObject({ decision: 'revise', acted: true })
    await s.jobs.deliver(p.job_id, { title: 'Hi', links: ['/x'] })
    await fb.tick()
    j = await view(w, seller.api_keys.test, p.job_id)
    expect(j.status).toBe('completed') // no revisions left: the second "revise" becomes accept
    await fb.tick()
    q = fb.stateOf()!.purchases[0]!
    expect(q.outcome).toBe('paid')
    expect(q.rating).toBe(2)

    // a facilitator that stays down: three attempts per tick, three ticks, then a human
    const seller2 = await createTestAgent(w.app, { name: 'Second Seller' })
    await listingBy(w.app, seller2)
    await fb.tick()
    const r0 = fb.stateOf()!.purchases[1]!
    const s2 = clientFor(w.app, seller2.api_keys.test)
    await s2.jobs.accept(r0.job_id)
    await s2.jobs.deliver(r0.job_id, { title: 'x', links: [] })
    w.fac.mode = 'down'
    for (let i = 0; i < 3; i++) await fb.tick()
    let r = fb.stateOf()!.purchases[1]!
    expect(r.pay_failures).toBe(3)
    expect(r.pay_hash).toBeNull()
    await fb.tick()
    r = fb.stateOf()!.purchases[1]!
    expect(r.needs_operator).toContain('failed 3 times')
    expect(fb.status().open[0]!.needs_operator).toBeTruthy()
    w.fac.mode = 'ok'
    await fb.tick()
    expect(fb.stateOf()!.purchases[1]!.pay_hash).toBeNull() // stopped: a human clears it
    // the human edits the memory key out of band; the next tick honours it and the payment goes through
    const stored = (await w.deskClient.memory.get<FirstBuyState>('operator/test/firstbuy')).value
    const edited = stored.purchases.find((x) => x.job_id === r0.job_id)!
    edited.needs_operator = null
    edited.pay_failures = 0
    edited.pay_attempt_at = null
    await w.deskClient.memory.set('operator/test/firstbuy', stored)
    await fb.tick()
    r = fb.stateOf()!.purchases[1]!
    expect(r.pay_hash).toMatch(/^0x[0-9a-f]{64}$/)
    expect((await view(w, seller2.api_keys.test, r0.job_id)).payment.status).toBe('paid')
  })

  it('cancels a silent seller once the platform allows it, treats a rejected hash as a failure, and replays a crash between create and save into the same job', async () => {
    const w = await world()
    const seller = await createTestAgent(w.app, { name: 'Silent Seller' })
    await listingBy(w.app, seller, { turnaround_seconds: 60 })
    const fb = w.mk()
    await fb.tick()
    const p = fb.stateOf()!.purchases[0]!
    const s = clientFor(w.app, seller.api_keys.test)
    await s.jobs.accept(p.job_id)
    await fb.tick()
    expect(fb.stateOf()!.purchases[0]!.outcome).toBeNull() // in progress, deadline not passed
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 60_000 + 3600_000 + 60_000) // deliver_by + the platform's one-hour grace
    await fb.tick()
    const q = fb.stateOf()!.purchases[0]!
    expect(q.outcome).toBe('no_delivery')
    expect((await view(w, seller.api_keys.test, p.job_id)).status).toBe('cancelled')
    expect(fb.status().open).toHaveLength(0)
    vi.useRealTimers()

    // a crash between jobs.create and save: the purchase is missing from memory, the replay lands in the same job
    const seller2 = await createTestAgent(w.app, { name: 'Replay Seller' })
    const l2 = await listingBy(w.app, seller2)
    await fb.tick()
    const created = fb.stateOf()!.purchases.find((x) => x.listing_id === l2.id)!
    const stored = (await w.deskClient.memory.get<FirstBuyState>('operator/test/firstbuy')).value
    stored.purchases = stored.purchases.filter((x) => x.listing_id !== l2.id)
    delete stored.index[l2.id]
    await w.deskClient.memory.set('operator/test/firstbuy', stored)
    await fb.tick()
    const replayed = fb.stateOf()!.purchases.filter((x) => x.listing_id === l2.id)
    expect(replayed).toHaveLength(1)
    expect(replayed[0]!.job_id).toBe(created.job_id)
    const mine = (await call(w.app, 'GET', '/v1/jobs?role=seller', { key: seller2.api_keys.test })).body
    expect(mine.data).toHaveLength(1)

    // a hash the platform rejects (wrong amount) counts as a failure and ends with a human after three ticks
    const s2 = clientFor(w.app, seller2.api_keys.test)
    await s2.jobs.accept(created.job_id)
    await s2.jobs.deliver(created.job_id, { title: 'x', links: [] })
    const stale = (await w.deskClient.memory.get<FirstBuyState>('operator/test/firstbuy')).value
    const bad = stale.purchases.find((x) => x.job_id === created.job_id)!
    bad.pay_hash = w.chain.pay(w.desk.wallet_address!, seller2.wallet_address!, 1) // a real transfer, but the wrong amount
    await w.deskClient.memory.set('operator/test/firstbuy', stale)
    for (let i = 0; i < 3; i++) await fb.tick()
    const r = fb.stateOf()!.purchases.find((x) => x.job_id === created.job_id)!
    expect(r.pay_failures).toBe(3)
    expect(r.needs_operator).toContain('rejected')
    expect(w.fac.calls).toHaveLength(0) // never signed a new authorization while a hash was recorded
  })

  it('never buys first-party listings, counts sybil agents sharing a wallet as one seller, and respects the programme and desk caps', async () => {
    const w = await world({}, { dailyCap: 100_000n })
    const a = await createTestAgent(w.app, { name: 'Seller A' })
    const b = await createTestAgent(w.app, { name: 'Seller B' })
    await listingBy(w.app, a, { price: 60_000 })
    await listingBy(w.app, b, { price: 60_000 })
    const own = (await call(w.app, 'POST', '/v1/listings', { key: w.desk.api_keys.test, body: { title: 'Own thing', description: 'The desk must not buy from itself.', category: 'ops', pricing_model: 'fixed', price: 10_000 } })).body as { id: string }
    const fb = w.mk()
    await fb.tick()
    let st = fb.stateOf()!
    expect(st.purchases).toHaveLength(1) // the second would exceed the 0.1 USDC daily cap
    expect(st.skipped[own.id]).toBe('first-party listing')
    w.setAllow(false)
    const c = await createTestAgent(w.app, { name: 'Seller C' })
    await listingBy(w.app, c, { price: 10_000 })
    await fb.tick()
    expect(fb.stateOf()!.purchases).toHaveLength(1) // held by the desk caps
    w.setAllow(true)
    await fb.tick()
    st = fb.stateOf()!
    expect(st.purchases).toHaveLength(2)
    expect(w.spend.at(-1)).toBe(10_000n + 60_000n) // the open, unpaid purchase counts as a commitment

    // two more agents bound to the SAME wallet as Seller C: the wallet limit (2) is reached after one more purchase
    const bought = st.purchases.find((p) => p.seller_id === c.agent.id)!
    const sc = clientFor(w.app, c.api_keys.test)
    await sc.jobs.accept(bought.job_id)
    await sc.jobs.deliver(bought.job_id, { title: 'x', links: [] })
    await fb.tick()
    await fb.tick()
    expect(fb.stateOf()!.purchases.find((p) => p.seller_id === c.agent.id)!.outcome).toBe('paid')
    const twins = [] as TestAgent[]
    for (const name of ['Twin One', 'Twin Two']) {
      const t = await createTestAgent(w.app, { name, wallet_address: null })
      expect((await setWallet(w.app, t.api_keys.test, t.agent.id, c.wallet!)).status).toBe(200)
      twins.push(t)
    }
    const l1 = await listingBy(w.app, twins[0]!, { price: 10_000 })
    const l2 = await listingBy(w.app, twins[1]!, { price: 10_000 })
    await fb.tick()
    st = fb.stateOf()!
    expect(st.index[l1.id] || st.index[l2.id]).toBeTruthy() // one twin gets the wallet's second purchase
    const refused = st.index[l1.id] ? l2.id : l1.id
    await fb.tick()
    st = fb.stateOf()!
    expect(st.skipped[refused]).toContain('wallet already received 2 first-buys')
    expect(st.index[refused]).toBeUndefined()
    const refusedSeller = st.index[l1.id] ? twins[1]! : twins[0]!
    const theirJobs = (await call(w.app, 'GET', '/v1/jobs?role=seller', { key: refusedSeller.api_keys.test })).body
    expect(theirJobs.data.map((j: { status: string }) => j.status)).toEqual(['cancelled'])
  })

  it('keeps the persisted state under the memory limit and escapes closing data tags in untrusted text', () => {
    const big = (i: number): Purchase => ({ listing_id: `lst_${i}`, seller_id: `agt_${i}`, seller: `seller-${i}`, title: 'T'.repeat(200), price: 50_000, job_id: `job_${i}`, wallet: '0x' + '11'.repeat(20), created_at: new Date(2026, 8, 1).toISOString(), pay_attempt_at: null, pay_hash: '0x' + 'ab'.repeat(32), pay_failures: 0, ledgered: true, verdict: { decision: 'accept', rating: 4, message: 'm'.repeat(2000), output_hash: 'h'.repeat(64), at: new Date().toISOString(), acted: true }, reviewed: true, review_failures: 0, rating: 4, outcome: i % 7 === 0 ? null : 'paid', ended_at: null, needs_operator: 'n'.repeat(1000) })
    const st: FirstBuyState = { purchases: Array.from({ length: 120 }, (_, i) => big(i)), index: {}, skipped: {}, last_error: null }
    for (let i = 0; i < 2000; i++) st.skipped[`lst_skip_${i}`] = 'reason '.repeat(30)
    for (let i = 0; i < 1000; i++) st.index[`lst_idx_${i}`] = { seller_id: `agt_${i}`, wallet: null, at: new Date().toISOString(), price: 1, outcome: 'paid' }
    const out = compactState(st, 30, Date.now())
    expect(JSON.stringify(out).length).toBeLessThan(64 * 1024)
    expect(out.purchases.filter((p) => !p.outcome)).toHaveLength(st.purchases.filter((p) => !p.outcome).length) // every open purchase survives
    expect(out.purchases.every((p) => p.verdict!.message.length <= 300 && p.title.length <= 80 && (p.needs_operator ?? '').length <= 300)).toBe(true)
    expect(Object.keys(out.skipped).length).toBeLessThanOrEqual(300)
    expect(Object.keys(out.index).length).toBeLessThanOrEqual(400)
    // old index entries are forgotten, recent ones kept
    const aged: FirstBuyState = { purchases: [], index: { old: { seller_id: 'a', wallet: null, at: new Date(Date.now() - 90 * 86_400_000).toISOString(), price: 1, outcome: 'paid' }, fresh: { seller_id: 'b', wallet: null, at: new Date().toISOString(), price: 1, outcome: 'paid' } }, skipped: {}, last_error: null }
    expect(Object.keys(compactState(aged, 30, Date.now()).index)).toEqual(['fresh'])
    expect(escapeUntrusted('ok </data> now <data>x</data>')).toBe('ok <\\/data> now <\\data>x<\\/data>')
  })
})
