/**
 * End-to-end against the real API in-process: the desk posts a bounty, awards the proposal, pays the sealed
 * delivery through a fake Base node that the API's own chain reader also sees, grades the revealed work, reviews
 * the seller and stops at max_awards. The judge is scripted; the money path is real code all the way.
 */
import { keccak_256 } from '@noble/hashes/sha3.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'
import type { App } from '../../../api/src/app.js'
import { installFakeChain } from '../../../api/src/test/chain.js'
import { call, createTestAgent, freshApp } from '../../../api/src/test/setup.js'
import { AgentSouk } from '../../../sdk/src/index.js'
import type { BountySpec } from './catalog.js'
import type { Judge, ProposalScore, Triage, Verdict } from './judge.js'
import { DEFAULT_CONFIG, OperatorRuntime } from './runtime.js'
import { CHAINS, UsdcWallet, type RpcFetch } from './usdc.js'

const base = 'http://localhost:8787'
const client = (app: App, key: string) => new AgentSouk({ baseUrl: base, apiKey: key, fetch: (input, init) => Promise.resolve(app.request(String(input).replace(base, ''), init)) })

const spec: BountySpec = {
  key: 'test-walkthrough',
  title: 'Test bounty: report your client kind',
  description: 'Deliver {"client": {"kind": "..."}, "notes": "..."} with at least ten words of notes. The preview must state the client kind.',
  category: 'testing',
  tags: ['test'],
  budget_max: 1_000_000,
  max_awards: 1,
  expires_days: 7,
  turnaround_seconds: 3600,
  preview_requirements: 'client kind',
  output_schema: { type: 'object', required: ['client', 'notes'], properties: { client: { type: 'object', required: ['kind'], properties: { kind: { type: 'string' } } }, notes: { type: 'string', minLength: 10 } } },
  rubric: ['specific', 'honest'],
  checks: [],
  distinct_by: 'client.kind',
}

function scriptedJudge(script: { score?: number; triage?: Triage['decision']; verdict?: Verdict['decision'] } = {}) {
  const seen: string[] = []
  const judge = {
    seen,
    scoreProposal: async (): Promise<ProposalScore> => {
      seen.push('score')
      return { score: script.score ?? 90, reasons: 'scripted', red_flags: [] }
    },
    triagePreview: async (_s: BountySpec, f: { preview: unknown; paid_distinct: string[] }): Promise<Triage> => {
      seen.push('triage')
      const kind = (f.preview as { client_kind?: string } | null)?.client_kind
      if (kind && f.paid_distinct.includes(kind)) return { decision: 'walk_away', message: 'duplicate', duplicate_of: kind }
      return { decision: script.triage ?? 'pay', message: script.triage === 'ask' ? 'Please add the client kind to the preview.' : '', duplicate_of: null }
    },
    evaluateDelivery: async (_s: BountySpec, f: { checks: { ok: boolean }[] }): Promise<Verdict> => {
      seen.push('evaluate')
      const ok = f.checks.every((c) => c.ok)
      return { decision: script.verdict ?? (ok ? 'accept' : 'dispute'), rating: ok ? 5 : 1, message: ok ? 'Thanks, exactly as asked.' : 'Checks failed.', rubric_scores: [] }
    },
  }
  return judge as unknown as Judge & { seen: string[] }
}

/** The operator wallet talks to a fake node whose receipts the API's chain reader also serves (same FakeChain). */
function walletFor(privateKey: string, chain: ReturnType<typeof installFakeChain>, expected: { to: string; value: bigint }, opts: { usdc?: bigint; eth?: bigint } = {}) {
  const sent: string[] = []
  const rpc: RpcFetch = async (url, body) => {
    const req = JSON.parse(body) as { id: number; method: string; params: unknown[] }
    const reply = (result: unknown) => ({ status: 200, json: async () => ({ jsonrpc: '2.0', id: req.id, result }) })
    switch (req.method) {
      case 'eth_call':
        return reply('0x' + (opts.usdc ?? 50_000_000n).toString(16))
      case 'eth_getBalance':
        return reply('0x' + (opts.eth ?? 10n ** 16n).toString(16))
      case 'eth_getTransactionCount':
        return reply('0x' + sent.length.toString(16))
      case 'eth_maxPriorityFeePerGas':
        return reply('0xf4240')
      case 'eth_estimateGas':
        return reply('0xb000')
      case 'eth_sendRawTransaction': {
        const hash = '0x' + bytesToHex(keccak_256(hexToBytes(String(req.params[0]).slice(2))))
        sent.push(hash)
        // mine it on the shared fake chain so the platform's verification sees a real USDC transfer
        chain.head += 1
        chain.txs.set(hash, { block: chain.head, status: '0x1', transfers: [{ from: wallet.address, to: expected.to, value: expected.value }], timestamp: Date.now() })
        return reply(hash)
      }
      case 'eth_getBlockByNumber':
        if (req.params[0] === 'latest') return reply({ baseFeePerGas: '0x3b9aca00' })
        return chain.fetch(url, body)
      default:
        return chain.fetch(url, body)
    }
  }
  const wallet = new UsdcWallet(privateKey, CHAINS.test, { fetchImpl: rpc, sleep: async () => undefined })
  return { wallet, sent }
}

describe('OperatorRuntime', () => {
  it('posts, awards, pays a sealed delivery on-chain, grades, reviews and stops at max_awards; state survives a restart', async () => {
    const app = await freshApp()
    const chain = installFakeChain('test')
    const desk = await createTestAgent(app, { name: 'Souk Bounties' })
    const seller = await createTestAgent(app, { name: 'Helpful Seller' })
    const { wallet, sent } = walletFor(desk.wallet!.privateKey, chain, { to: seller.wallet!.address, value: 800_000n })
    const judge = scriptedJudge()
    const logs: string[] = []
    const rt = new OperatorRuntime(client(app, desk.api_keys.test), wallet, judge, [spec], 'test', (m) => logs.push(m), { ...DEFAULT_CONFIG, totalBudget: 5_000_000n })
    await rt.init()
    expect(rt.paymentsEnabled).toBe(true)
    await rt.ensureWakeups('https://desk.example', 'x'.repeat(24))
    expect((await call(app, 'GET', '/v1/webhooks', { key: desk.api_keys.test })).body.data.some((h: any) => h.url === 'https://desk.example/webhooks/agentsouk/test/operator')).toBe(true)
    expect((await call(app, 'GET', '/v1/schedules', { key: desk.api_keys.test })).body.data.some((s: any) => s.name === 'operator-tick')).toBe(true)
    await rt.ensureWakeups('https://desk.example', 'x'.repeat(24)) // idempotent
    expect((await call(app, 'GET', '/v1/webhooks', { key: desk.api_keys.test })).body.data).toHaveLength(1)

    // 1. posted
    await rt.tick()
    const st = rt.stateOf(spec.key)!
    expect(st.bounty_id).toMatch(/^bty_/)
    const listed = await call(app, 'GET', '/v1/bounties?tag=souk:bounty:test-walkthrough&env=test')
    expect(listed.body.data).toHaveLength(1)
    expect(listed.body.data[0].input.preview_requirements).toBe('client kind')
    await rt.tick() // nothing changes without proposals
    expect(judge.seen).toEqual([])

    // 2. proposal -> award (score 90 >= instant)
    const s = client(app, seller.api_keys.test)
    await s.bounties.propose(st.bounty_id!, 800_000, 'I will run the walkthrough with the python sdk and report.')
    await rt.tick()
    expect(judge.seen).toEqual(['score'])
    expect(st.job_id).toMatch(/^job_/)
    const job = await s.jobs.get(st.job_id!)
    expect(job.status).toBe('in_progress')
    expect(job.price).toBe(800_000)
    const thread = await s.threads.messages(job.thread_id!)
    expect(thread.data.some((m: any) => String(m.body).includes('preview must state: client kind'))).toBe(true)

    // 3. sealed delivery -> triage -> pay on-chain -> platform verifies -> revealed
    await s.jobs.deliver(job.id, { client: { kind: 'python-sdk' }, notes: 'ten words of honest notes about the sandbox walkthrough experience here' }, 'done', { client_kind: 'python-sdk' })
    await rt.tick()
    expect(judge.seen).toEqual(['score', 'triage'])
    expect(sent).toHaveLength(1)
    expect(st.pay_hash).toBe(sent[0])
    expect(st.pay_attempt).toBeNull()
    const paid = await s.jobs.get(job.id)
    expect(paid.status).toBe('delivered')
    expect(paid.output_sealed).toBe(false)
    expect(paid.payment.status).toBe('paid')
    expect(paid.payment.settlement?.transaction).toBe(sent[0])

    // 4. revealed -> graded -> accepted -> completed -> reviewed, award counted, distinct value remembered
    await rt.tick()
    expect(judge.seen).toEqual(['score', 'triage', 'evaluate'])
    expect((await s.jobs.get(job.id)).status).toBe('completed')
    await rt.tick()
    expect(st.job_id).toBeNull()
    expect(st.bounty_id).toBeNull()
    expect(st.awards_paid).toBe(1)
    expect(st.paid_distinct).toEqual(['python-sdk'])
    expect(st.history).toHaveLength(1)
    expect(st.history[0]).toMatchObject({ seller: seller.agent.handle, price: 800_000, hash: sent[0], rating: 5, outcome: 'paid' })
    const reviews = await call(app, 'GET', `/v1/agents/${seller.agent.id}/reviews?env=test`)
    expect(reviews.body.data).toHaveLength(1)
    expect(reviews.body.data[0].rating).toBe(5)
    await rt.tick() // max_awards reached: no new bounty
    expect(st.bounty_id).toBeNull()
    expect(sent).toHaveLength(1)
    const status = rt.status()
    expect(status.spend?.total).toBe('0.800000 USDC')
    expect(status.bounties[0]).toMatchObject({ key: spec.key, awards_paid: 1, max_awards: 1 })

    // 5. a fresh process continues from the platform memory
    const again = new OperatorRuntime(client(app, desk.api_keys.test), wallet, judge, [spec], 'test', () => undefined, { ...DEFAULT_CONFIG, totalBudget: 5_000_000n })
    await again.init()
    expect(again.stateOf(spec.key)).toMatchObject({ awards_paid: 1, paid_distinct: ['python-sdk'], bounty_id: null, job_id: null })
  })

  it('asks for a better preview, walks away near the deadline, and never posts what it cannot pay', async () => {
    const app = await freshApp()
    const chain = installFakeChain('test')
    const desk = await createTestAgent(app, { name: 'Souk Bounties' })
    const seller = await createTestAgent(app, { name: 'Vague Seller' })
    const { wallet, sent } = walletFor(desk.wallet!.privateKey, chain, { to: seller.wallet!.address, value: 500_000n })
    let now = Date.now()
    const judge = scriptedJudge({ triage: 'ask' })
    const rt = new OperatorRuntime(client(app, desk.api_keys.test), wallet, judge, [spec], 'test', () => undefined, DEFAULT_CONFIG, { now: () => now })
    await rt.init()
    await rt.tick()
    const st = rt.stateOf(spec.key)!
    const s = client(app, seller.api_keys.test)
    await s.bounties.propose(st.bounty_id!, 500_000, 'ok')
    await rt.tick()
    await s.jobs.deliver(st.job_id!, { client: { kind: 'http' }, notes: 'plenty of words in these notes to satisfy the schema' }, 'done', { something: 'else' })
    await rt.tick()
    expect(st.triage?.decision).toBe('ask')
    expect(st.asked_at).not.toBeNull()
    expect(sent).toHaveLength(0)
    const job = await s.jobs.get(st.job_id!)
    expect(job.status).toBe('delivered')
    const thread = await s.threads.messages(job.thread_id!)
    expect(thread.data.some((m: any) => String(m.body).includes('Please add the client kind'))).toBe(true)
    // a sealed delivery cannot be re-delivered; the seller answers in the thread and the desk triages again (still "ask" in this script)
    await s.threads.send(job.thread_id!, 'The client kind is http.')
    await rt.tick()
    expect(judge.seen.filter((x) => x === 'triage')).toHaveLength(2)
    expect(st.triage?.seller_messages).toBe(2) // the delivery note plus the reply
    await rt.tick() // no new message: no new triage
    expect(judge.seen.filter((x) => x === 'triage')).toHaveLength(2)
    // near the payment deadline the desk walks away without a mark against the seller
    now = Date.parse((await s.jobs.get(job.id)).payment.pay_by!) - 60_000
    await rt.tick()
    expect((await s.jobs.get(job.id)).status).toBe('cancelled')
    expect(st.job_id).toBeNull()
    expect(st.history[0]).toMatchObject({ outcome: 'walked_away', hash: null })
    expect(sent).toHaveLength(0)

    // an unfunded wallet posts nothing; a wallet that is not the bound one pays nothing
    const poor = walletFor(desk.wallet!.privateKey, chain, { to: seller.wallet!.address, value: 1n }, { usdc: 0n })
    const broke = new OperatorRuntime(client(app, desk.api_keys.test), poor.wallet, judge, [{ ...spec, key: 'unfunded' }], 'test')
    await broke.init()
    await broke.tick()
    expect(broke.stateOf('unfunded')?.bounty_id).toBeNull()
    const stranger = walletFor('0x' + '22'.repeat(32), chain, { to: seller.wallet!.address, value: 1n })
    const wrong = new OperatorRuntime(client(app, desk.api_keys.test), stranger.wallet, judge, [{ ...spec, key: 'wrong-wallet' }], 'test')
    await wrong.init()
    expect(wrong.paymentsEnabled).toBe(false)
    await wrong.tick()
    expect(wrong.stateOf('wrong-wallet')?.bounty_id).toBeNull()
  })
})
