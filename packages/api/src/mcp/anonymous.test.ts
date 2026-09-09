import { describe, it, expect, beforeEach } from 'vitest'
import { freshApp, call, createTestAgent } from '../test/setup.js'
import { installFakeChain } from '../test/chain.js'
import type { App } from '../app.js'

let app: App
beforeEach(async () => {
  app = await freshApp()
  installFakeChain('test')
})

async function rpc(method: string, params: Record<string, unknown> = {}, key?: string) {
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

const tool = (name: string, args: Record<string, unknown> = {}, key?: string) => rpc('tools/call', { name, arguments: args }, key)
const textOf = (r: any) => String(r?.result?.content?.[0]?.text ?? '')

/**
 * In seven days the MCP endpoint saw 638 initialize calls, 630 tools/list calls and exactly one successful
 * tools/call. The first thing every unauthenticated client read was "You are NOT authenticated: call
 * register_agent first" - which is not true, and put a barrier at the top of the funnel that does not exist.
 * These tests hold the corrected promise to the code (ADR-42).
 */
describe('what an MCP client can do without a key', () => {
  it('says so in the server instructions instead of demanding registration first', async () => {
    const anon = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
    const instructions = String(anon?.result?.instructions ?? '')
    expect(instructions).toContain('Without a key you can already')
    expect(instructions).not.toContain('You are NOT authenticated')
    // and it leads with the reason to be here at all, not with the paperwork
    expect(instructions).toContain('stuck on something you cannot do from where you are')
  })

  it('really does answer search_listings, get_listing, demand and leaderboard unauthenticated', async () => {
    const seller = await createTestAgent(app, { name: 'Seller' })
    const created = await call(app, 'POST', '/v1/listings', {
      key: seller.api_keys.test,
      body: { title: 'Live DNS probe', description: 'Probe SPF, DKIM and DMARC for a domain and report what resolves.', category: 'data', pricing_model: 'fixed', price: 400_000, input_schema: { type: 'object', required: ['domain'] } },
    })
    expect(created.status, JSON.stringify(created.body)).toBe(201)

    const search = await tool('search_listings', { q: 'dns', env: 'test' })
    expect(search?.result?.isError).toBeFalsy()
    expect(textOf(search)).toContain('Live DNS probe')

    const one = await tool('get_listing', { id: created.body.id, env: 'test' })
    expect(one?.result?.isError).toBeFalsy()
    expect(textOf(one)).toContain('Live DNS probe')

    const demand = await tool('demand', { env: 'test' })
    expect(demand?.result?.isError).toBeFalsy()
    expect(textOf(demand)).toContain('open_bounties')

    const board = await tool('leaderboard', { env: 'test' })
    expect(board?.result?.isError).toBeFalsy()
  })

  it('still refuses what genuinely needs a key, with a hint that names the way in', async () => {
    const who = await tool('whoami')
    expect(who?.result?.isError).toBe(true)
    expect(textOf(who).toLowerCase()).toContain('key')
  })
})
