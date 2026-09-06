import { describe, it, expect, beforeEach } from 'vitest'
import { freshApp, createTestAgent } from '../test/setup.js'
import type { App } from '../app.js'

let app: App
beforeEach(async () => {
  app = await freshApp()
})

async function rpc(method: string, params: Record<string, unknown> = {}, opts: { key?: string; id?: number; query?: string } = {}) {
  const res = await app.request(`/mcp${opts.query ?? ''}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', ...(opts.key ? { authorization: `Bearer ${opts.key}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: opts.id ?? 1, method, params }),
  })
  const text = await res.text()
  let body: any = null
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: res.status, body }
}

const INIT = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } }

describe('mcp', () => {
  it('initializes and lists tools with agent-facing descriptions', async () => {
    const init = await rpc('initialize', INIT)
    expect(init.status).toBe(200)
    expect(init.body.result.serverInfo.name).toBe('agentsouk')
    expect(init.body.result.instructions).toContain('register_agent')
    const tools = await rpc('tools/list')
    const names = tools.body.result.tools.map((t: any) => t.name)
    for (const n of ['register_agent', 'whoami', 'wallet', 'search_listings', 'create_listing', 'create_job', 'job_action', 'inbox', 'send_message', 'events', 'api_request', 'search_bounties', 'review_job']) expect(names).toContain(n)
    expect(tools.body.result.tools.length).toBeLessThan(40)
    const createJob = tools.body.result.tools.find((t: any) => t.name === 'create_job')
    expect(createJob.description).toContain('escrow')
    expect(createJob.inputSchema.required).toContain('listing_id')
  })

  it('registers via tool, then uses authenticated tools end to end', async () => {
    const reg = await rpc('tools/call', { name: 'register_agent', arguments: { name: 'MCP Seller', capabilities: ['translation'], framework: 'mcp-test' } })
    expect(reg.status).toBe(200)
    expect(reg.body.result.isError).toBe(false)
    const created = reg.body.result.structuredContent
    expect(created.api_keys.test).toMatch(/^as_test_/)
    const key = created.api_keys.test

    const who = await rpc('tools/call', { name: 'whoami', arguments: {} }, { key })
    expect(who.body.result.structuredContent.handle).toBe('mcp-seller')
    const unauth = await rpc('tools/call', { name: 'whoami', arguments: {} })
    expect(unauth.body.result.isError).toBe(true)
    expect(unauth.body.result.structuredContent.error.hint).toContain('POST /v1/agents')

    const listing = await rpc('tools/call', { name: 'create_listing', arguments: { title: 'Translate EN to DE', description: 'Send text, get German back within minutes.', category: 'text', pricing_model: 'fixed', price: 300, input_schema: { type: 'object', required: ['text'] } } }, { key })
    expect(listing.body.result.isError).toBe(false)
    const listingId = listing.body.result.structuredContent.id

    const buyer = await createTestAgent(app, { name: 'MCP Buyer' })
    const found = await rpc('tools/call', { name: 'search_listings', arguments: { q: 'german' } }, { query: `?api_key=${buyer.api_keys.test}` })
    expect(found.body.result.structuredContent.data[0].id).toBe(listingId)
    const job = await rpc('tools/call', { name: 'create_job', arguments: { listing_id: listingId, input: { text: 'hi' } } }, { key: buyer.api_keys.test })
    expect(job.body.result.isError).toBe(false)
    const jobId = job.body.result.structuredContent.id
    const inbox = await rpc('tools/call', { name: 'inbox', arguments: {} }, { key })
    expect(inbox.body.result.structuredContent.jobs_awaiting_my_action[0].id).toBe(jobId)
    const acc = await rpc('tools/call', { name: 'job_action', arguments: { id: jobId, action: 'accept' } }, { key })
    expect(acc.body.result.structuredContent.status).toBe('in_progress')
    const del = await rpc('tools/call', { name: 'job_action', arguments: { id: jobId, action: 'deliver', output: { translation: 'hallo' } } }, { key })
    expect(del.body.result.structuredContent.status).toBe('delivered')
    const done = await rpc('tools/call', { name: 'job_action', arguments: { id: jobId, action: 'accept' } }, { key: buyer.api_keys.test })
    expect(done.body.result.structuredContent.status).toBe('completed')
    const wallet = await rpc('tools/call', { name: 'wallet', arguments: {} }, { key })
    expect(wallet.body.result.structuredContent.balances[0].available).toBe(100_000 + 300 - 9)
    const raw = await rpc('tools/call', { name: 'api_request', arguments: { method: 'GET', path: '/v1/jobs/' + jobId + '/events' } }, { key })
    expect(raw.body.result.structuredContent.data.length).toBe(4)
    const bad = await rpc('tools/call', { name: 'api_request', arguments: { method: 'GET', path: '/health' } }, { key })
    expect(bad.body.error ?? bad.body.result?.isError).toBeTruthy()
  })

  it('serves docs as resources', async () => {
    const list = await rpc('resources/list')
    expect(list.body.result.resources.map((r: any) => r.uri)).toContain('agentsouk://skill.md')
    const read = await rpc('resources/read', { uri: 'agentsouk://skill.md' })
    expect(read.body.result.contents[0].text).toContain('name: agentsouk')
  })
})
