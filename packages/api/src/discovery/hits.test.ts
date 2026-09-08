import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { freshApp } from '../test/setup.js'
import type { App } from '../app.js'
import { _setConfigForTests } from '../config.js'
import { _resetHits, _setUpsertForTests, classifyUserAgent, discoverySummary, flushHits, mcpCallsOf, mcpErrorIds, recordHit, recordMcpCall, surfaceOf } from './hits.js'

let app: App
beforeEach(async () => {
  _resetHits()
  app = await freshApp()
})
afterEach(() => {
  _resetHits()
  _setConfigForTests({ ADMIN_TOKEN: undefined, INDEXNOW_KEY: undefined })
})

const find = (list: { surface: string; ua_class: string; count: number }[], surface: string, cls: string) => list.find((r) => r.surface === surface && r.ua_class === cls)?.count

describe('discovery instrumentation', () => {
  it('classifies user agents coarsely and never explodes cardinality', () => {
    expect(classifyUserAgent('Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)')).toBe('claude')
    expect(classifyUserAgent('Claude-Code/2.1')).toBe('claude')
    expect(classifyUserAgent('Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot')).toBe('openai')
    expect(classifyUserAgent('Mozilla/5.0 (compatible; GPTBot/1.2)')).toBe('openai')
    expect(classifyUserAgent('Mozilla/5.0 (compatible; PerplexityBot/1.0)')).toBe('perplexity')
    expect(classifyUserAgent('Mozilla/5.0 (compatible; ExaSearchBot/1.0; +https://crawler.exa.ai)')).toBe('exa')
    expect(classifyUserAgent('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)')).toBe('google')
    expect(classifyUserAgent('Mozilla/5.0 (compatible; bingbot/2.0)')).toBe('bing')
    expect(classifyUserAgent('agentsouk-node/0.3.3')).toBe('agentsouk-sdk')
    expect(classifyUserAgent('agentsouk-python/0.3.3')).toBe('agentsouk-sdk')
    expect(classifyUserAgent('curl/8.7.1')).toBe('curl')
    expect(classifyUserAgent('python-requests/2.32')).toBe('python')
    expect(classifyUserAgent('python-httpx/0.27')).toBe('python')
    expect(classifyUserAgent('node')).toBe('node')
    expect(classifyUserAgent('undici')).toBe('node')
    expect(classifyUserAgent('Go-http-client/2.0')).toBe('go')
    expect(classifyUserAgent('Mozilla/5.0 (Windows NT 10.0) Chrome/128 Safari/537.36')).toBe('browser')
    expect(classifyUserAgent('SomeRandomCrawler/1.0')).toBe('other-bot')
    expect(classifyUserAgent('')).toBe('unknown')
    expect(classifyUserAgent(undefined)).toBe('unknown')
    expect(classifyUserAgent('x'.repeat(5000))).toBe('other')
  })

  it('maps requests to a bounded set of surfaces (HEAD counts like GET, long paths are ignored)', () => {
    expect(surfaceOf('GET', '/skill.md')).toBe('skill.md')
    expect(surfaceOf('HEAD', '/skill.md')).toBe('skill.md')
    expect(surfaceOf('GET', '/SKILL.md')).toBe('skill.md')
    expect(surfaceOf('GET', '/llms.txt')).toBe('llms.txt')
    expect(surfaceOf('GET', '/llms.txt///')).toBe('llms.txt')
    expect(surfaceOf('GET', '/llms-full.txt')).toBe('llms-full.txt')
    expect(surfaceOf('GET', '/docs/quickstart')).toBe('docs')
    expect(surfaceOf('GET', '/openapi.json')).toBe('openapi.json')
    expect(surfaceOf('GET', '/')).toBe('root')
    expect(surfaceOf('POST', '/mcp')).toBe('mcp')
    expect(surfaceOf('GET', '/mcp')).toBe('mcp')
    expect(surfaceOf('POST', '/a2a')).toBe('a2a')
    expect(surfaceOf('POST', '/v1/agents')).toBe('register')
    expect(surfaceOf('GET', '/.well-known/agent-card.json')).toBe('well-known:agent-card.json')
    expect(surfaceOf('GET', '/.well-known/mcp/server-card.json')).toBe('well-known:mcp')
    expect(surfaceOf('GET', '/.well-known/' + 'A'.repeat(100))).toBe('well-known:other')
    expect(surfaceOf('GET', '/x' + '/'.repeat(300) + 'a')).toBeNull()
    // ordinary API traffic is not counted
    expect(surfaceOf('GET', '/v1/listings')).toBeNull()
    expect(surfaceOf('GET', '/v1/agents')).toBeNull()
    expect(surfaceOf('PATCH', '/v1/agents/me')).toBeNull()
    expect(surfaceOf('POST', '/v1/jobs')).toBeNull()
  })

  it('counts 2xx reads per day and class, flushes additively, and shows up in the admin overview', async () => {
    const t0 = Date.UTC(2026, 8, 7, 12, 0, 0)
    recordHit('GET', '/skill.md', 'Claude-Code/2.1', 200, t0)
    recordHit('GET', '/skill.md', 'Claude-Code/2.1', 200, t0 + 1000)
    recordHit('GET', '/llms.txt', 'curl/8.7.1', 200, t0)
    recordHit('GET', '/skill.md', 'curl/8.7.1', 404, t0) // errors are not reads
    recordHit('GET', '/.well-known/agent.json', 'curl/8.7.1', 301, t0) // redirect aliases are not reads (the follow-up GET is)
    recordHit('GET', '/openapi.json', undefined, 200, t0, true) // internal sub-request
    recordHit('POST', '/v1/agents', 'python-httpx/0.27', 201, t0)
    recordHit('GET', '/v1/listings', 'curl/8.7.1', 200, t0) // not a discovery surface
    recordHit('GET', '/llms.txt', 'curl/8.7.1', 200, t0 - 3 * 86_400_000) // three days earlier
    recordHit('GET', '/llms.txt', 'curl/8.7.1', 200, t0 - 30 * 86_400_000) // outside the 7-day window
    await flushHits(t0)
    recordHit('GET', '/skill.md', 'Claude-Code/2.1', 200, t0 + 2000)
    await flushHits(t0) // second flush adds, never overwrites

    const s = await discoverySummary(t0)
    expect(find(s.today, 'skill.md', 'claude')).toBe(3)
    expect(find(s.today, 'llms.txt', 'curl')).toBe(1)
    expect(find(s.today, 'register', 'python')).toBe(1)
    expect(find(s.today, 'skill.md', 'curl')).toBeUndefined()
    expect(s.by_surface_7d['well-known:agent.json']).toBeUndefined()
    expect(s.by_surface_7d['openapi.json']).toBeUndefined()
    expect(find(s.last_7_days, 'llms.txt', 'curl')).toBe(2)
    expect(s.by_class_7d.claude).toBe(3)
    expect(s.by_surface_7d['skill.md']).toBe(3)
    expect(s.registrations_7d).toBe(1)
    expect(s.recent_user_agents.map((r) => r.ua)).toContain('Claude-Code/2.1')
    // one entry per (class, surface): a flood of distinct user agents cannot evict the others
    for (let i = 0; i < 200; i++) recordHit('GET', '/skill.md', `Flooder/${i}`, 200, t0 + 5000 + i)
    const after = await discoverySummary(t0)
    expect(after.recent_user_agents.filter((r) => r.surface === 'skill.md' && r.ua_class === 'other')).toHaveLength(1)
    expect(after.recent_user_agents.some((r) => r.ua === 'Claude-Code/2.1')).toBe(true)
    // control characters never reach the operator view
    recordHit('GET', '/llms.txt', 'Evil\x1b[31m\x00Bot/1.0', 200, t0 + 9000)
    const evil = (await discoverySummary(t0)).recent_user_agents.find((r) => r.ua.startsWith('Evil'))
    expect(evil?.ua).toBe('Evil[31mBot/1.0')

    // real requests through the app are counted too (middleware), and the operator sees them
    _setConfigForTests({ ADMIN_TOKEN: 'test-admin-token-1234567890' })
    const before = await discoverySummary()
    const delta = (aft: Record<string, number>, bef: Record<string, number>) => Object.fromEntries(Object.entries(aft).map(([k, v]) => [k, v - (bef[k] ?? 0)]).filter(([, v]) => v !== 0))
    expect((await app.request('/skill.md', { headers: { 'user-agent': 'Mozilla/5.0 (compatible; PerplexityBot/1.0)' } })).status).toBe(200)
    expect((await app.request('/skill.md', { method: 'HEAD', headers: { 'user-agent': 'Mozilla/5.0 (compatible; bingbot/2.0)' } })).status).toBe(200)
    expect((await app.request('/.well-known/ard.json', { headers: { 'user-agent': 'hf-discover/0.1' } })).status).toBe(200)
    expect((await app.request('/.well-known/openapi.json', { headers: { 'user-agent': 'curl/8.7.1' } })).status).toBe(301)
    expect((await app.request('/llms-full.txt', { headers: { 'user-agent': 'curl/8.7.1' } })).status).toBe(200)
    const res = await app.request('/v1/admin/overview', { headers: { 'x-admin-token': 'test-admin-token-1234567890' } })
    expect(res.status).toBe(200)
    const o = (await res.json()) as any
    // exact deltas: no phantom openapi.json read behind llms-full.txt, no hit for the 301 alias
    expect(delta(o.discovery.by_surface_7d, before.by_surface_7d)).toEqual({ 'skill.md': 2, 'well-known:ard.json': 1, 'llms-full.txt': 1 })
    expect(delta(o.discovery.by_class_7d, before.by_class_7d)).toEqual({ perplexity: 1, bing: 1, other: 1, curl: 1 })
    expect(o.discovery.recent_user_agents.some((r: any) => r.ua === 'hf-discover/0.1')).toBe(true)
  })

  it('keeps exactly the unflushed rows when the database fails mid-flush (no loss, no double count)', async () => {
    const t0 = Date.UTC(2026, 8, 7, 12, 0, 0)
    recordHit('GET', '/skill.md', 'Claude-Code/2.1', 200, t0)
    recordHit('GET', '/skill.md', 'Claude-Code/2.1', 200, t0)
    recordHit('GET', '/llms.txt', 'curl/8.7.1', 200, t0)
    recordHit('GET', '/docs', 'curl/8.7.1', 200, t0)
    let writes = 0
    _setUpsertForTests(async () => {
      writes++
      if (writes === 2) throw new Error('SQLITE_BUSY')
    })
    await flushHits(t0) // first row written by the stub, second throws, third never attempted
    expect(writes).toBe(2)
    _setUpsertForTests(undefined)
    await flushHits(t0) // the two unflushed rows land now
    const s = await discoverySummary(t0)
    expect(find(s.today, 'skill.md', 'claude')).toBeUndefined() // the stub "wrote" it (not to the DB) and it was not re-queued
    expect(find(s.today, 'llms.txt', 'curl')).toBe(1)
    expect(find(s.today, 'docs', 'curl')).toBe(1)
    // concurrent callers share one in-flight flush and both see the result
    recordHit('GET', '/skill.md', 'Claude-Code/2.1', 200, t0)
    const p1 = flushHits(t0)
    const p2 = flushHits(t0)
    expect(p2).toBe(p1)
    await Promise.all([p1, p2])
    expect(find((await discoverySummary(t0)).today, 'skill.md', 'claude')).toBe(1)
  })

  it('serves the IndexNow key file only when configured, and only under the exact name', async () => {
    expect((await app.request('/abcdef1234567890.txt')).status).toBe(404)
    _setConfigForTests({ INDEXNOW_KEY: 'abcdef1234567890' })
    const res = await app.request('/abcdef1234567890.txt')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('abcdef1234567890')
    expect(res.headers.get('cache-control')).toBe('public, max-age=86400')
    expect((await app.request('/abcdef1234567891.txt')).status).toBe(404)
    expect((await app.request('/robots.txt')).status).toBe(200)
    expect((await app.request('/llms-full.txt')).status).toBe(200)
  })
})

describe('mcp call instrumentation', () => {
  it('bounds surfaces: known methods, registered-shaped tool names, error split, notifications ignored', async () => {
    recordMcpCall('initialize', undefined, 'node', false)
    recordMcpCall('tools/list', undefined, 'node', false)
    recordMcpCall('tools/call', 'register_agent', 'node', false)
    recordMcpCall('tools/call', 'register_agent', 'node', true)
    recordMcpCall('tools/call', 'Drop Table; --', 'node', false)
    recordMcpCall('tools/call', 'x'.repeat(41), 'node', true)
    recordMcpCall('notifications/initialized', undefined, 'node', false)
    recordMcpCall('made/up', undefined, 'node', false)
    recordMcpCall(42, undefined, 'node', false)
    const s = await discoverySummary()
    expect(s.by_surface_7d).toMatchObject({ 'mcp:initialize': 1, 'mcp:tools/list': 1, 'mcp:tool:register_agent': 1, 'mcp:tool-error:register_agent': 1, 'mcp:tool:unknown': 1, 'mcp:tool-error:unknown': 1, 'mcp:other': 1 })
    expect(Object.keys(s.by_surface_7d).some((k) => k.includes('Drop') || k.includes('notifications') || k.includes('made'))).toBe(false)
  })

  it('parses single and batch JSON-RPC bodies and error ids without throwing on garbage', () => {
    expect(mcpCallsOf({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami' } })).toEqual([{ id: 1, method: 'tools/call', name: 'whoami' }])
    expect(mcpCallsOf([{ id: 'a', method: 'tools/list' }, { id: 'b', method: 'ping', params: 'nope' }, 'junk', null, { id: 'c' }])).toEqual([{ id: 'a', method: 'tools/list', name: undefined }, { id: 'b', method: 'ping', name: undefined }])
    expect(mcpCallsOf(null)).toEqual([])
    expect(mcpCallsOf('text')).toEqual([])
    expect(mcpCallsOf(Array.from({ length: 80 }, (_, i) => ({ id: i, method: 'ping' })))).toHaveLength(50)
    const errs = mcpErrorIds([{ id: 1, result: { isError: true } }, { id: 2, result: { isError: false } }, { id: 3, error: { code: -32601 } }, { id: 4, result: {} }, 'x'])
    expect([...errs].sort()).toEqual(['1', '3'])
    expect(mcpErrorIds(null).size).toBe(0)
  })

  it('counts real MCP traffic through the route: method, tool, and failed tool calls', async () => {
    const rpc = (body: unknown, key?: string) =>
      app.request('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', 'user-agent': 'python-httpx/0.28', ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body) })
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } })).status).toBe(200)
    expect((await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).status).toBe(200)
    const reg = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'register_agent', arguments: { name: 'Counted Bot' } } })
    expect(reg.status).toBe(200)
    const unauth = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'whoami', arguments: {} } })
    expect(((await unauth.json()) as any).result.isError).toBe(true)
    const missing = await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } })
    expect(missing.status).toBe(200)
    const s = await discoverySummary()
    expect(find(s.last_7_days, 'mcp:initialize', 'python')).toBe(1)
    expect(find(s.last_7_days, 'mcp:tools/list', 'python')).toBe(1)
    expect(find(s.last_7_days, 'mcp:tool:register_agent', 'python')).toBe(1)
    expect(find(s.last_7_days, 'mcp:tool-error:whoami', 'python')).toBe(1)
    expect(find(s.last_7_days, 'mcp:tool-error:no_such_tool', 'python')).toBe(1)
    expect(find(s.last_7_days, 'mcp', 'python')).toBe(5) // the generic surface still counts every POST /mcp
    expect(s.registrations_7d).toBe(1) // register_agent's POST /v1/agents sub-request counts as a registration
  })
})

