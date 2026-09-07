import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { freshApp, call, createTestAgent, setWallet, type TestAgent } from '../../test/setup.js'
import { installFakeChain, type FakeChain } from '../../test/chain.js'
import type { App } from '../../app.js'
import { _setConfigForTests, config } from '../../config.js'
import { evaluatorEligibility, requiredFor, sweepDisputes } from './service.js'
import { db } from '../../db/client.js'
import { jobs } from '../../db/schema.js'
import { eq } from 'drizzle-orm'

let app: App
let chain: FakeChain
let seller: TestAgent
let buyer: TestAgent
const PRICE = 400_000
const SCHEMA = { type: 'object', required: ['translation'], properties: { translation: { type: 'string', minLength: 1 } }, additionalProperties: false }

beforeEach(async () => {
  app = await freshApp()
  chain = installFakeChain('test')
  seller = await createTestAgent(app, { name: 'Zorbulax Seller' })
  buyer = await createTestAgent(app, { name: 'Quixotic Buyer' })
})
afterEach(() => _setConfigForTests({ ADMIN_TOKEN: undefined }))

const key = (a: TestAgent) => a.api_keys.test
const act = (a: TestAgent, id: string, action: string, body: Record<string, unknown> = {}) => call(app, 'POST', `/v1/jobs/${id}/${action}`, { key: key(a), body })
const getJob = (a: TestAgent, id: string) => call(app, 'GET', `/v1/jobs/${id}`, { key: key(a) })
const getDispute = (a: TestAgent, id: string) => call(app, 'GET', `/v1/disputes/${id}`, { key: key(a) })
const vote = (a: TestAgent, id: string, outcome: string, rationale = 'because') => call(app, 'POST', `/v1/disputes/${id}/verdict`, { key: key(a), body: { outcome, rationale } })
const optIn = (a: TestAgent, categories?: string[]) => call(app, 'POST', '/v1/agents/me/evaluator', { key: key(a), body: { enabled: true, categories } })
const events = async (a: TestAgent, type: string) => (await call(app, 'GET', `/v1/events?types=${type}`, { key: key(a) })).body.data as any[]

async function makeListing(over: Record<string, unknown> = {}) {
  const r = await call(app, 'POST', '/v1/listings', { key: key(seller), body: { title: 'Translate', description: 'Translate EN to DE. Send {text}, receive {translation}.', category: 'text', pricing_model: 'fixed', price: PRICE, input_schema: { type: 'object', required: ['text'] }, output_schema: SCHEMA, turnaround_seconds: 600, ...over } })
  if (r.status !== 201) throw new Error(JSON.stringify(r.body))
  return r.body as { id: string }
}

/** create -> accept -> deliver -> pay -> dispute; returns the job id and the dispute id */
async function disputedJob(listingId?: string): Promise<{ job: string; dispute: string }> {
  const l = listingId ? { id: listingId } : await makeListing()
  const j = await call(app, 'POST', '/v1/jobs', { key: key(buyer), body: { listing_id: l.id, input: { text: 'hi' } } })
  expect(j.status).toBe(201)
  expect((await act(seller, j.body.id, 'accept')).status).toBe(200)
  expect((await act(seller, j.body.id, 'deliver', { output: { translation: 'hallo' } })).status).toBe(200)
  const tx = chain.pay(buyer.wallet_address!, seller.wallet_address!, PRICE)
  expect((await act(buyer, j.body.id, 'pay', { transaction: tx })).status).toBe(200)
  const d = await act(buyer, j.body.id, 'dispute', { reason: 'this is not a translation' })
  expect(d.status).toBe(200)
  expect(d.body.status).toBe('disputed')
  expect(d.body.dispute_id).toMatch(/^dsp_/)
  return { job: j.body.id, dispute: d.body.dispute_id }
}

async function evaluators(n: number, categories?: string[]): Promise<TestAgent[]> {
  const out: TestAgent[] = []
  for (let i = 0; i < n; i++) {
    const e = await createTestAgent(app, { name: `Evaluator ${i + 1}` })
    expect((await optIn(e, categories)).status).toBe(200)
    out.push(e)
  }
  return out
}

async function assigned(disputeId: string, pool: TestAgent[]): Promise<TestAgent[]> {
  const out: TestAgent[] = []
  for (const e of pool) {
    const r = await getDispute(e, disputeId)
    if (r.status === 200 && r.body.role === 'evaluator') out.push(e)
  }
  return out
}

const windowMs = () => config().DISPUTE_VERDICT_WINDOW_SECONDS_TEST * 1000

describe('evaluator opt-in', () => {
  it('sets the flag, explains eligibility per environment, shows on the public profile and can be switched off', async () => {
    const e = await createTestAgent(app, { name: 'Judge' })
    const before = await call(app, 'GET', '/v1/agents/me/evaluator', { key: key(e) })
    expect(before.status).toBe(200)
    expect(before.body).toMatchObject({ object: 'evaluator', enabled: false, eligibility: { test: { eligible: false }, live: { eligible: false } } })
    expect(before.body.hint).toContain('enabled')

    const on = await optIn(e, ['Text', 'code', 'text'])
    expect(on.body).toMatchObject({ enabled: true, categories: ['text', 'code'], eligibility: { test: { eligible: true, reason: null }, live: { eligible: false } }, stats: { test: { verdicts: 0, missed: 0, pending: 0, agreement_rate: null } } })
    expect(on.body.eligibility.live.reason).toContain('trust tier 1')
    expect((await call(app, 'GET', `/v1/agents/${e.agent.id}`)).body.evaluator).toBe(true)
    expect((await call(app, 'GET', `/v1/agents/${e.agent.id}/reputation`)).body.test.as_evaluator).toMatchObject({ enabled: true, categories: ['text', 'code'], eligible_live: false, verdicts: 0 })

    // a live key sees the live view of the same flag
    const live = await call(app, 'GET', '/v1/agents/me/evaluator', { key: e.api_keys.live })
    expect(live.body.hint).toContain('not drawable on live')

    const off = await call(app, 'POST', '/v1/agents/me/evaluator', { key: key(e), body: { enabled: false } })
    expect(off.body).toMatchObject({ enabled: false, categories: [] })
    expect((await call(app, 'GET', `/v1/agents/${e.agent.id}`)).body.evaluator).toBe(false)
  })

  it('eligibility rules: live needs trust tier 1 or first party; sandbox takes any active opted-in agent', () => {
    const base = { evaluator: true, status: 'active' as const, trustTier: 0, firstParty: false }
    expect(evaluatorEligibility(base, 'test').eligible).toBe(true)
    expect(evaluatorEligibility(base, 'live').eligible).toBe(false)
    expect(evaluatorEligibility({ ...base, trustTier: 1 }, 'live').eligible).toBe(true)
    expect(evaluatorEligibility({ ...base, firstParty: true }, 'live').eligible).toBe(true)
    expect(evaluatorEligibility({ ...base, status: 'suspended' }, 'test').eligible).toBe(false)
    expect(evaluatorEligibility({ ...base, evaluator: false }, 'test').eligible).toBe(false)
    expect([requiredFor(1), requiredFor(2), requiredFor(3), requiredFor(4), requiredFor(5)]).toEqual([1, 2, 2, 3, 3])
  })
})

describe('tier 0: deliveries are checked against the listing output_schema', () => {
  it('rejects an output that breaks the promised schema with the violations, accepts a matching one', async () => {
    const l = await makeListing()
    const j = await call(app, 'POST', '/v1/jobs', { key: key(buyer), body: { listing_id: l.id, input: { text: 'hi' } } })
    await act(seller, j.body.id, 'accept')
    const bad = await act(seller, j.body.id, 'deliver', { output: { result: 'meh' } })
    expect(bad.status).toBe(400)
    expect(bad.body.error.details.code).toBe('output_schema_mismatch')
    expect(bad.body.error.message).toContain("must have required property 'translation'")
    expect(bad.body.error.hint).toContain('output_schema')
    const wrongType = await act(seller, j.body.id, 'deliver', { output: { translation: 42 } })
    expect(wrongType.status).toBe(400)
    expect((await getJob(seller, j.body.id)).body.status).toBe('in_progress')
    const ok = await act(seller, j.body.id, 'deliver', { output: { translation: 'hallo' } })
    expect(ok.status).toBe(200)
    expect(ok.body.status).toBe('delivered')
  })

  it('an uncompilable schema never blocks a delivery (the seller made the mistake, not the buyer)', async () => {
    const l = await makeListing({ output_schema: { type: 'object', properties: { x: { type: 'nonsense-type' } } } })
    const j = await call(app, 'POST', '/v1/jobs', { key: key(buyer), body: { listing_id: l.id, input: { text: 'hi' } } })
    await act(seller, j.body.id, 'accept')
    expect((await act(seller, j.body.id, 'deliver', { output: { anything: true } })).status).toBe(200)
  })
})

describe('dispute panel', () => {
  it('draws an independent panel, gives evaluators an anonymised case file, decides by majority and records the verdict on the job', async () => {
    const pool = await evaluators(4, ['text'])
    // not drawable: the buyer itself, and an evaluator sharing the buyer wallet
    await optIn(buyer)
    const twin = await createTestAgent(app, { name: 'Twin', wallet_address: null })
    expect((await setWallet(app, key(twin), twin.agent.id, buyer.wallet!)).status).toBe(200)
    await optIn(twin)

    const { job, dispute } = await disputedJob()
    const asBuyer = await getDispute(buyer, dispute)
    expect(asBuyer.status).toBe(200)
    expect(asBuyer.body).toMatchObject({ object: 'dispute', job_id: job, status: 'panel', role: 'buyer', seats: 3, required: 2, round: 1, votes_received: 0, outcome: null, tally: null, verdicts: null, case: null, my_vote: null })
    expect(asBuyer.body.verdict_by).toBeTruthy()
    expect(asBuyer.body.thread_id).toMatch(/^thr_/)
    expect(asBuyer.body.checks).toMatchObject({ output_schema: 'pass', delivered_on_time: true, paid: true, price: PRICE, revisions_used: 0 })
    expect((await getDispute(seller, dispute)).body.role).toBe('seller')
    const stranger = await createTestAgent(app, { name: 'Stranger' })
    expect((await getDispute(stranger, dispute)).status).toBe(404)
    expect((await getDispute(twin, dispute)).status).toBe(404)

    const panel = await assigned(dispute, pool)
    expect(panel).toHaveLength(3)
    const bench = await getDispute(panel[0]!, dispute)
    expect(bench.body).toMatchObject({ role: 'evaluator', my_vote: { status: 'pending', outcome: null }, thread_id: null })
    expect(bench.body.how_to_vote).toContain(`/v1/disputes/${dispute}/verdict`)
    expect(bench.body.case.job).toMatchObject({ id: job, input: { text: 'hi' }, output: { translation: 'hallo' }, price: PRICE, paid: true, dispute_reason: 'this is not a translation' })
    expect(bench.body.case.listing).toMatchObject({ title: 'Translate', output_schema: SCHEMA })
    expect(bench.body.case.parties).toEqual({ buyer: { trust_tier: 0, first_party: false }, seller: { trust_tier: 0, first_party: false } })
    expect(JSON.stringify(bench.body.case)).not.toContain(buyer.agent.id)
    expect(JSON.stringify(bench.body.case)).not.toContain(seller.agent.id)
    expect(JSON.stringify(bench.body.case).toLowerCase()).not.toContain('zorbulax')
    expect(JSON.stringify(bench.body.case).toLowerCase()).not.toContain('quixotic')
    expect(bench.body.case.messages.map((m: any) => m.from)).toEqual(expect.arrayContaining(['system', 'buyer']))
    expect(bench.body.case.messages.some((m: any) => m.from === 'buyer' && m.body === 'this is not a translation')).toBe(true)

    // notifications and inbox
    const ev = await events(panel[0]!, 'dispute.assigned')
    expect(ev).toHaveLength(1)
    expect(ev[0].data).toMatchObject({ dispute_id: dispute, job_title: 'Translate', category: 'text', round: 1 })
    expect(ev[0].data.how).toContain('/verdict')
    expect((await events(buyer, 'dispute.panel'))[0].data).toMatchObject({ dispute_id: dispute, seats: 3, required: 2 })
    const inbox = await call(app, 'GET', '/v1/inbox', { key: key(panel[0]!) })
    expect(inbox.body.disputes_awaiting_my_verdict).toHaveLength(1)
    expect(inbox.body.disputes_awaiting_my_verdict[0]).toMatchObject({ id: dispute, job_title: 'Translate', round: 1 })
    expect(inbox.body.hint).toContain('evaluator')
    expect((await call(app, 'GET', '/v1/disputes', { key: key(panel[0]!) })).body.data.map((d: any) => d.id)).toEqual([dispute])
    expect((await call(app, 'GET', '/v1/disputes?role=party', { key: key(panel[0]!) })).body.data).toEqual([])
    expect((await call(app, 'GET', '/v1/disputes', { key: key(seller) })).body.data[0]).toMatchObject({ id: dispute, role: 'seller' })
    expect((await getJob(buyer, job)).body.available_actions).toEqual([])

    // outsiders cannot vote
    expect((await vote(pool.find((e) => !panel.includes(e))!, dispute, 'buyer')).status).toBe(404)
    expect((await vote(buyer, dispute, 'buyer')).status).toBe(404)
    expect((await vote(panel[0]!, dispute, 'maybe')).status).toBe(400)

    // 1 buyer, 1 seller: still open; the tally stays hidden while voting
    const v1 = await vote(panel[0]!, dispute, 'buyer', 'no translation at all')
    expect(v1.status).toBe(200)
    expect(v1.body).toMatchObject({ status: 'panel', votes_received: 1, my_vote: { status: 'voted', outcome: 'buyer', rationale: 'no translation at all' }, tally: null })
    expect((await vote(panel[0]!, dispute, 'buyer')).status).toBe(200) // idempotent
    expect((await vote(panel[0]!, dispute, 'seller')).body.error.code).toBe('already_voted')
    expect((await vote(panel[1]!, dispute, 'seller', 'looks fine')).body.votes_received).toBe(2)
    expect((await getJob(buyer, job)).body.status).toBe('disputed')

    // second buyer vote = majority: decided by the panel, refund due
    const v3 = await vote(panel[2]!, dispute, 'buyer', 'the buyer is right')
    expect(v3.body).toMatchObject({ status: 'resolved', outcome: 'buyer', resolved_by: 'panel', votes_received: 3, tally: { buyer: 2, seller: 1, split: 0 }, my_vote: { agreed: true } })
    expect(v3.body.verdicts.map((x: any) => x.outcome).sort()).toEqual(['buyer', 'buyer', 'seller'])
    expect(v3.body.resolved_at).toBeTruthy()
    const done = await getJob(buyer, job)
    expect(done.body.status).toBe('resolved')
    expect(done.body.resolution).toMatchObject({ outcome: 'buyer', by: 'panel' })
    expect(done.body.resolution.note).toContain('2 buyer, 1 seller')
    expect(done.body.payment.refund_due).toBe(true)
    expect(done.body.payment.refund_expected).toBe(PRICE)
    expect((await getJob(seller, job)).body.available_actions).toEqual(['review', 'refund'])
    // parties now see the tally and the anonymised rationales, but still no evaluator identities
    const after = await getDispute(seller, dispute)
    expect(after.body.tally).toEqual({ buyer: 2, seller: 1, split: 0 })
    expect(after.body.verdicts.map((x: any) => x.rationale).sort()).toEqual(['looks fine', 'no translation at all', 'the buyer is right'])
    for (const e of panel) expect(JSON.stringify(after.body)).not.toContain(e.agent.id)
    expect((await vote(panel[1]!, dispute, 'buyer')).body.error.code).toBe('already_voted')

    // reputation of the evaluators and decided events
    const rep0 = (await call(app, 'GET', `/v1/agents/${panel[0]!.agent.id}/reputation`)).body.test.as_evaluator
    expect(rep0).toMatchObject({ verdicts: 1, missed: 0, pending: 0, agreement_rate: 1 })
    expect((await call(app, 'GET', `/v1/agents/${panel[1]!.agent.id}/reputation`)).body.test.as_evaluator.agreement_rate).toBe(0)
    const decided = await events(panel[1]!, 'dispute.decided')
    expect(decided[0].data).toMatchObject({ dispute_id: dispute, outcome: 'buyer', decided_by: 'panel', your_vote: 'seller', agreed: false })
    expect((await events(buyer, 'job.resolved'))[0].data).toMatchObject({ outcome: 'buyer', by: 'panel' })
    expect((await call(app, 'GET', `/v1/agents/${seller.agent.id}/reputation`)).body.test.as_seller).toMatchObject({ jobs_failed: 1, refunds_due: 1, jobs_disputed: 1 })
    // the evaluator inbox is clear again
    expect((await call(app, 'GET', '/v1/inbox', { key: key(panel[0]!) })).body.disputes_awaiting_my_verdict).toEqual([])
  })

  it('missed deadline: round 1 redraws the missed seats, then a plurality decides', async () => {
    const pool = await evaluators(4)
    const { job, dispute } = await disputedJob()
    const panel = await assigned(dispute, pool)
    expect(panel).toHaveLength(3)
    const spare = pool.find((e) => !panel.includes(e))!

    // one evaluator votes split, the others sleep through the deadline
    expect((await vote(panel[0]!, dispute, 'split', 'half done')).body.status).toBe('panel')
    expect(await sweepDisputes(Date.now() + 1000)).toMatchObject({ settled: 0 })
    const later = Date.now() + windowMs() + 1000
    expect(await sweepDisputes(later)).toMatchObject({ settled: 1 })

    const r2 = await getDispute(buyer, dispute)
    expect(r2.body).toMatchObject({ status: 'panel', round: 2, seats: 3, required: 2, votes_received: 1 })
    expect(new Date(r2.body.verdict_by).getTime()).toBeGreaterThan(later)
    expect((await getDispute(spare, dispute)).body).toMatchObject({ role: 'evaluator', my_vote: { status: 'pending', round: 2 } })
    expect((await getDispute(panel[1]!, dispute)).body.my_vote.status).toBe('missed')
    expect((await vote(panel[1]!, dispute, 'buyer')).body.error.code).toBe('deadline_missed')
    expect((await call(app, 'GET', `/v1/agents/${panel[1]!.agent.id}/reputation`)).body.test.as_evaluator).toMatchObject({ missed: 1, verdicts: 0 })
    expect((await events(spare, 'dispute.assigned'))[0].data.round).toBe(2)

    // the replacement votes seller: 1 split vs 1 seller, no plurality, seats all voted or missed -> escalate?
    // No: only one seat is still open; with it voted the panel is complete. 1:1 is a tie -> escalated.
    const v = await vote(spare, dispute, 'seller', 'fine by me')
    expect(v.body).toMatchObject({ status: 'escalated', escalation_reason: 'no_plurality', tally: { buyer: 0, seller: 1, split: 1 } })
    expect((await getJob(buyer, job)).body.status).toBe('disputed')
    expect((await events(seller, 'dispute.escalated'))[0].data).toMatchObject({ dispute_id: dispute, reason: 'no_plurality' })
    expect((await vote(spare, dispute, 'buyer')).body.error.code).toBe('already_voted')

    // the operator decides; the case file records the arbiter
    _setConfigForTests({ ADMIN_TOKEN: 'test-admin-token-1234567890' })
    const overview = await call(app, 'GET', '/v1/admin/overview', { headers: { 'x-admin-token': 'test-admin-token-1234567890' } })
    expect(overview.body.disputes.find((d: any) => d.job_id === job).panel).toMatchObject({ status: 'escalated', needs_operator: true, escalation_reason: 'no_plurality' })
    const res = await call(app, 'POST', `/v1/admin/jobs/${job}/resolve`, { headers: { 'x-admin-token': 'test-admin-token-1234567890' }, body: { outcome: 'split', note: 'half back' } })
    expect(res.status).toBe(200)
    expect(res.body.resolution).toMatchObject({ outcome: 'split', by: 'arbiter' })
    const closed = await getDispute(buyer, dispute)
    expect(closed.body).toMatchObject({ status: 'resolved', outcome: 'split', resolved_by: 'arbiter' })
    expect((await call(app, 'GET', `/v1/agents/${panel[0]!.agent.id}/reputation`)).body.test.as_evaluator).toMatchObject({ verdicts: 1, agreement_rate: 1 })
    expect((await call(app, 'GET', `/v1/agents/${spare.agent.id}/reputation`)).body.test.as_evaluator).toMatchObject({ verdicts: 1, agreement_rate: 0 })
  })

  it('a plurality decides after round 2 when the majority never forms', async () => {
    const pool = await evaluators(4)
    const { job, dispute } = await disputedJob()
    const panel = await assigned(dispute, pool)
    const spare = pool.find((e) => !panel.includes(e))!
    await vote(panel[0]!, dispute, 'seller', 'delivered as promised')
    await sweepDisputes(Date.now() + windowMs() + 1000) // round 2: one replacement for two missed seats
    expect((await getDispute(buyer, dispute)).body).toMatchObject({ round: 2, votes_received: 1 })
    expect((await getDispute(spare, dispute)).body.my_vote.status).toBe('pending')
    // the replacement also misses; round 2 deadline: plurality 1 seller vs 0 -> decided
    const t2 = Date.now() + 2 * windowMs() + 5000
    expect(await sweepDisputes(t2)).toMatchObject({ settled: 1 })
    const d = await getDispute(seller, dispute)
    expect(d.body).toMatchObject({ status: 'resolved', outcome: 'seller', resolved_by: 'panel', tally: { seller: 1, buyer: 0, split: 0 } })
    const j = await getJob(buyer, job)
    expect(j.body.status).toBe('resolved')
    expect(j.body.resolution.note).toContain('plurality')
    expect(j.body.payment.refund_due).toBe(false)
    expect((await call(app, 'GET', `/v1/agents/${spare.agent.id}/reputation`)).body.test.as_evaluator).toMatchObject({ missed: 1 })
  })

  it('no votes at all: escalated to the operator after round 2; no evaluators: escalated immediately', async () => {
    const pool = await evaluators(3)
    const { job, dispute } = await disputedJob()
    expect(await assigned(dispute, pool)).toHaveLength(3)
    await sweepDisputes(Date.now() + windowMs() + 1000) // nobody to redraw (all three already sat): straight to escalation
    const d = await getDispute(buyer, dispute)
    expect(d.body).toMatchObject({ status: 'escalated', escalation_reason: 'no_votes', round: 1 })
    for (const e of pool) expect((await getDispute(e, dispute)).body.my_vote.status).toBe('missed')
    expect((await getJob(buyer, job)).body.status).toBe('disputed')

    // a second seller with no evaluators around at all
    for (const e of pool) await call(app, 'POST', '/v1/agents/me/evaluator', { key: key(e), body: { enabled: false } })
    const second = await disputedJob()
    const d2 = await getDispute(seller, second.dispute)
    expect(d2.body).toMatchObject({ status: 'escalated', escalation_reason: 'no_eligible_evaluators', seats: 0, required: 0 })
    expect((await events(buyer, 'dispute.escalated')).some((e: any) => e.data.dispute_id === second.dispute && e.data.reason === 'no_eligible_evaluators')).toBe(true)
    _setConfigForTests({ ADMIN_TOKEN: 'test-admin-token-1234567890' })
    const res = await call(app, 'POST', `/v1/admin/jobs/${second.job}/resolve`, { headers: { 'x-admin-token': 'test-admin-token-1234567890' }, body: { outcome: 'seller', note: 'delivery matches' } })
    expect(res.body.status).toBe('resolved')
    expect((await getDispute(seller, second.dispute)).body).toMatchObject({ status: 'resolved', outcome: 'seller', resolved_by: 'arbiter' })
  })

  it('prefers evaluators whose categories match the listing and records the mechanical checks', async () => {
    const text = await evaluators(3, ['text'])
    const code = await evaluators(3, ['code'])
    const { dispute } = await disputedJob()
    const panel = await assigned(dispute, [...text, ...code])
    expect(panel.every((e) => text.includes(e))).toBe(true)
    // a late delivery shows up in the checks
    const l = await makeListing({ turnaround_seconds: 10 })
    const j = await call(app, 'POST', '/v1/jobs', { key: key(buyer), body: { listing_id: l.id, input: { text: 'late' } } })
    await act(seller, j.body.id, 'accept')
    await db().update(jobs).set({ deadlineAt: Date.now() - 5000 }).where(eq(jobs.id, j.body.id)) // the clock ran out
    await act(seller, j.body.id, 'deliver', { output: { translation: 'spaet' } })
    await act(buyer, j.body.id, 'pay', { transaction: chain.pay(buyer.wallet_address!, seller.wallet_address!, PRICE) })
    const d = await act(buyer, j.body.id, 'dispute', { reason: 'too late' })
    const view = await getDispute(buyer, d.body.dispute_id)
    expect(view.body.checks).toMatchObject({ output_schema: 'pass', delivered_on_time: false })
    expect(view.body.checks.delivered_after_deadline_seconds).toBeGreaterThanOrEqual(5)
  })
})
