/**
 * Smoke test against a deployed Agent Souk API: discovery, registration, wallet binding (real EIP-191 signature),
 * listing, job, sealed delivery, 402 terms, a real RPC lookup for an unknown hash, inbox, MCP, OpenAPI.
 *
 *   cd packages/api && npx tsx scripts/smoke.ts https://agentsouk-api.fly.dev
 */
import { randomBytes } from 'node:crypto'
import { privateKeyToAddress, signMessage } from '../src/modules/payments/evm-signature.js'

const base = (process.argv[2] ?? 'https://agentsouk-api.fly.dev').replace(/\/$/, '')
const wallet = () => {
  const privateKey = '0x' + randomBytes(32).toString('hex')
  return { privateKey, address: privateKeyToAddress(privateKey) }
}
async function call(method: string, path: string, opts: { key?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (opts.key) headers.authorization = `Bearer ${opts.key}`
  if (opts.body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(base + path, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined })
  const text = await res.text()
  let json: any
  try {
    json = JSON.parse(text)
  } catch {
    json = { raw: text.slice(0, 200) }
  }
  return { status: res.status, body: json }
}
let failed = false
function check(label: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${extra ? ' ' + extra : ''}`)
  if (!ok) failed = true
}

const health = await call('GET', '/health')
check('health', health.status === 200 && health.body.status === 'ok', JSON.stringify(health.body))
const skill = await fetch(base + '/skill.md').then((r) => r.text())
check('skill.md explains wallet binding, no CRD', skill.includes('agentsouk:wallet:') && !skill.includes('CRD'))
const pay = await call('GET', '/v1/payments?env=test')
check('GET /v1/payments (test)', pay.status === 200 && pay.body.model === 'proof_of_payment' && pay.body.network.id === 'eip155:84532', pay.body.network?.id)
const live = await call('GET', '/v1/payments')
check('GET /v1/payments (live)', live.status === 200 && live.body.network.id === 'eip155:8453')

const seller = await call('POST', '/v1/agents', { body: { name: 'Smoke Seller ' + Date.now(), framework: 'smoke' } })
check('register seller', seller.status === 201 && seller.body.wallet_address === null, seller.body.agent?.handle)
const buyer = await call('POST', '/v1/agents', { body: { name: 'Smoke Buyer ' + Date.now(), framework: 'smoke' } })
check('register buyer', buyer.status === 201)
const sk = seller.body.api_keys.test
const bk = buyer.body.api_keys.test
const sw = wallet()
const bw = wallet()
const msg = (id: string, addr: string) => `agentsouk:wallet:${id}:${addr.toLowerCase()}`
const noSig = await call('POST', '/v1/agents/me/wallet-address', { key: sk, body: { address: sw.address, signature: signMessage(msg(seller.body.agent.id, sw.address), bw.privateKey) } })
check('wallet binding rejects a signature by another key', noSig.status === 400 && noSig.body.error.code === 'wallet_signature_invalid')
const boundS = await call('POST', '/v1/agents/me/wallet-address', { key: sk, body: { address: sw.address, signature: signMessage(msg(seller.body.agent.id, sw.address), sw.privateKey) } })
check('seller binds wallet with EIP-191 signature', boundS.status === 200 && boundS.body.wallet_address.toLowerCase() === sw.address.toLowerCase(), JSON.stringify(boundS.body.error ?? ''))
const boundB = await call('POST', '/v1/agents/me/wallet-address', { key: bk, body: { address: bw.address, signature: signMessage(msg(buyer.body.agent.id, bw.address), bw.privateKey) } })
check('buyer binds wallet', boundB.status === 200)

const listing = await call('POST', '/v1/listings', { key: sk, body: { title: 'Smoke translation', description: 'Smoke-test listing: send {text}, receive {translation}.', category: 'text', pricing_model: 'fixed', price: 10_000, input_schema: { type: 'object', required: ['text'] }, turnaround_seconds: 600 } })
check('create listing', listing.status === 201 && listing.body.pricing.display === '0.010000 USDC per job', JSON.stringify(listing.body.error ?? ''))
const job = await call('POST', '/v1/jobs', { key: bk, body: { listing_id: listing.body.id, input: { text: 'hello' } } })
check('create job', job.status === 201 && job.body.status === 'open' && job.body.payment.pay_to === boundS.body.wallet_address)
const acc = await call('POST', `/v1/jobs/${job.body.id}/accept`, { key: sk, body: {} })
check('seller accepts', acc.body.status === 'in_progress')
const del = await call('POST', `/v1/jobs/${job.body.id}/deliver`, { key: sk, body: { output: { translation: 'hallo' }, preview: { words: 1 } } })
check('sealed delivery', del.body.status === 'delivered' && del.body.output_sealed === true)
const view = await call('GET', `/v1/jobs/${job.body.id}`, { key: bk })
check('buyer sees sealed job', view.body.output === null && view.body.payment.status === 'due' && view.body.available_actions.includes('pay'))
const terms = await call('POST', `/v1/jobs/${job.body.id}/pay`, { key: bk })
check('402 terms', terms.status === 402 && terms.body.error.code === 'payment_required' && terms.body.amount === 10_000 && terms.body.network === 'eip155:84532', JSON.stringify({ pay_to: terms.body.pay_to, asset: terms.body.asset }))
const bogus = await call('POST', `/v1/jobs/${job.body.id}/pay`, { key: bk, body: { transaction: '0x' + 'ab'.repeat(32) } })
check('unknown hash -> transaction_not_found via real RPC', bogus.status === 409 && bogus.body.error.code === 'transaction_not_found', String(bogus.body.error?.code))
const inbox = await call('GET', '/v1/inbox', { key: bk })
check('inbox tells the buyer to pay', !!inbox.body.jobs_awaiting_my_action?.[0]?.action_needed?.includes('pay'))
const cancel = await call('POST', `/v1/jobs/${job.body.id}/cancel`, { key: bk, body: { reason: 'smoke test' } })
check('walk away (cleanup)', cancel.body.status === 'cancelled')
const mcp = await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })
check('MCP tools/list reachable', mcp.status === 200 || mcp.status === 400, String(mcp.status))
const openapi = await call('GET', '/openapi.json')
check('openapi has pay + refund + wallet-address, no wallet', !!openapi.body.paths?.['/v1/jobs/{id}/pay'] && !!openapi.body.paths?.['/v1/jobs/{id}/refund'] && !!openapi.body.paths?.['/v1/agents/me/wallet-address'] && !openapi.body.paths?.['/v1/wallet'])
// ADR-32: the trust document is public, states no licence, lists the operator's own agents with wallets and quotes the live stats
const commitments = await call('GET', '/v1/commitments')
const opAgents = commitments.body.the_operator_is_a_participant?.agents ?? []
check('GET /v1/commitments', commitments.status === 200 && commitments.body.licences?.held?.length === 0 && commitments.body.licences?.planned === null && opAgents.length >= 1 && opAgents.every((a: { wallet_address: string | null }) => typeof a.wallet_address === 'string'), JSON.stringify({ agents: opAgents.map((a: { handle: string }) => a.handle), share: commitments.body.the_operator_is_a_participant?.share_today }))
const rep = await call('GET', `/v1/agents/${opAgents[0]?.id ?? 'souk-bounties'}/reputation`)
check('reputation carries the first/third-party split (backfilled)', rep.status === 200 && typeof rep.body.live?.as_buyer?.third_party_counterparties === 'number' && typeof rep.body.live?.as_buyer?.first_party_counterparties === 'number', JSON.stringify({ buyer: rep.body.live?.as_buyer?.distinct_counterparties, third: rep.body.live?.as_buyer?.third_party_counterparties }))
const byeS = await call('DELETE', '/v1/agents/me', { key: sk, body: { confirm: seller.body.agent.handle } })
const byeB = await call('DELETE', '/v1/agents/me', { key: bk, body: { confirm: buyer.body.agent.handle } })
check('smoke agents delete themselves (cleanup)', byeS.status === 200 && byeB.status === 200 && (await call('GET', '/v1/agents/me', { key: sk })).status === 401, JSON.stringify(byeS.body.error ?? ''))
console.log(failed ? 'SMOKE TEST FAILED' : 'SMOKE TEST PASSED', base)
process.exit(failed ? 1 : 0)
