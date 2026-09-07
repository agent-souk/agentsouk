import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { freshApp } from '../test/setup.js'
import type { App } from '../app.js'
import { _setConfigForTests } from '../config.js'
import { _resetHits, classifyUserAgent, discoverySummary, flushHits, recordHit, surfaceOf } from './hits.js'

let app: App
beforeEach(async () => {
  _resetHits()
  app = await freshApp()
})
afterEach(() => _setConfigForTests({ ADMIN_TOKEN: undefined }))

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

  it('maps requests to a bounded set of surfaces', () => {
    expect(surfaceOf('GET', '/skill.md')).toBe('skill.md')
    expect(surfaceOf('GET', '/SKILL.md')).toBe('skill.md')
    expect(surfaceOf('GET', '/llms.txt')).toBe('llms.txt')
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
    // ordinary API traffic is not counted
    expect(surfaceOf('GET', '/v1/listings')).toBeNull()
    expect(surfaceOf('GET', '/v1/agents')).toBeNull()
    expect(surfaceOf('PATCH', '/v1/agents/me')).toBeNull()
    expect(surfaceOf('POST', '/v1/jobs')).toBeNull()
  })

  it('counts reads per day and class, flushes additively, and shows up in the admin overview', async () => {
    const t0 = Date.UTC(2026, 8, 7, 12, 0, 0)
    recordHit('GET', '/skill.md', 'Claude-Code/2.1', 200, t0)
    recordHit('GET', '/skill.md', 'Claude-Code/2.1', 200, t0 + 1000)
    recordHit('GET', '/llms.txt', 'curl/8.7.1', 200, t0)
    recordHit('GET', '/skill.md', 'curl/8.7.1', 404, t0) // errors are not reads
    recordHit('POST', '/v1/agents', 'python-httpx/0.27', 201, t0)
    recordHit('GET', '/v1/listings', 'curl/8.7.1', 200, t0) // not a discovery surface
    recordHit('GET', '/llms.txt', 'curl/8.7.1', 200, t0 - 3 * 86_400_000) // three days earlier
    recordHit('GET', '/llms.txt', 'curl/8.7.1', 200, t0 - 30 * 86_400_000) // outside the 7-day window
    await flushHits(t0)
    recordHit('GET', '/skill.md', 'Claude-Code/2.1', 200, t0 + 2000)
    await flushHits(t0) // second flush adds, never overwrites

    const s = await discoverySummary(t0)
    const find = (list: { surface: string; ua_class: string; count: number }[], surface: string, cls: string) => list.find((r) => r.surface === surface && r.ua_class === cls)?.count
    expect(find(s.today, 'skill.md', 'claude')).toBe(3)
    expect(find(s.today, 'llms.txt', 'curl')).toBe(1)
    expect(find(s.today, 'register', 'python')).toBe(1)
    expect(find(s.today, 'skill.md', 'curl')).toBeUndefined()
    expect(find(s.last_7_days, 'llms.txt', 'curl')).toBe(2)
    expect(s.by_class_7d.claude).toBe(3)
    expect(s.by_surface_7d['skill.md']).toBe(3)
    expect(s.registrations_7d).toBe(1)
    expect(s.recent_user_agents.map((r) => r.ua)).toContain('Claude-Code/2.1')
    // no duplicates in the recent list for the same UA and surface
    expect(s.recent_user_agents.filter((r) => r.ua === 'Claude-Code/2.1' && r.surface === 'skill.md')).toHaveLength(1)

    // real requests through the app are counted too (middleware), and the operator sees them
    _setConfigForTests({ ADMIN_TOKEN: 'test-admin-token-1234567890' })
    expect((await app.request('/skill.md', { headers: { 'user-agent': 'Mozilla/5.0 (compatible; PerplexityBot/1.0)' } })).status).toBe(200)
    expect((await app.request('/.well-known/ard.json', { headers: { 'user-agent': 'hf-discover/0.1' } })).status).toBe(200)
    const res = await app.request('/v1/admin/overview', { headers: { 'x-admin-token': 'test-admin-token-1234567890' } })
    expect(res.status).toBe(200)
    const o = (await res.json()) as any
    expect(o.discovery.by_surface_7d['skill.md']).toBeGreaterThanOrEqual(1)
    expect(o.discovery.by_class_7d.perplexity).toBeGreaterThanOrEqual(1)
    expect(o.discovery.by_surface_7d['well-known:ard.json']).toBeGreaterThanOrEqual(1)
    expect(o.discovery.recent_user_agents.some((r: any) => r.ua === 'hf-discover/0.1')).toBe(true)
  })

  it('serves the IndexNow key file only when configured, and only under the exact name', async () => {
    expect((await app.request('/abcdef1234567890.txt')).status).toBe(404)
    _setConfigForTests({ INDEXNOW_KEY: 'abcdef1234567890' })
    const res = await app.request('/abcdef1234567890.txt')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('abcdef1234567890')
    expect((await app.request('/abcdef1234567891.txt')).status).toBe(404)
    expect((await app.request('/robots.txt')).status).toBe(200)
    _setConfigForTests({ INDEXNOW_KEY: undefined })
  })
})
