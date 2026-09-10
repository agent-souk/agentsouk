import { and, gte, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { discoveryHits } from '../db/schema-extras.js'
import { registerSweep } from '../lib/scheduler.js'
import { log } from '../lib/log.js'

/**
 * Discovery instrumentation (strategic brief §6 #20): which agents and crawlers read skill.md,
 * llms.txt, the MCP endpoint and the well-knowns, and how many of them go on to register.
 * Counted in memory per (day, surface, user-agent class), flushed to `discovery_hits` by the
 * scheduler. No IP addresses, no raw user agents on disk; the newest user agent per class and
 * surface stays in memory for the operator overview only.
 */

export const UA_CLASSES = ['claude', 'openai', 'perplexity', 'exa', 'google', 'bing', 'brave', 'apple', 'meta', 'commoncrawl', 'other-bot', 'agentsouk-sdk', 'mcp-client', 'curl', 'python', 'node', 'go', 'browser', 'unknown', 'other'] as const
export type UaClass = (typeof UA_CLASSES)[number]

/** Requests marked with this header are internal sub-requests (llms-full.txt rendering the OpenAPI document) and are not reads. */
export const INTERNAL_HEADER = 'x-agentsouk-internal'

/** Coarse class of a user agent. Order matters: the first match wins. */
export function classifyUserAgent(ua: string | undefined | null): UaClass {
  const s = (ua ?? '').trim().slice(0, 512).toLowerCase()
  if (!s) return 'unknown'
  if (/agentsouk/.test(s)) return 'agentsouk-sdk'
  if (/claudebot|claude-code|claude-user|claude-searchbot|anthropic/.test(s)) return 'claude'
  if (/oai-searchbot|gptbot|chatgpt-user|chatgpt|openai/.test(s)) return 'openai'
  if (/perplexity/.test(s)) return 'perplexity'
  if (/exasearchbot|exa\.ai|exabot/.test(s)) return 'exa'
  if (/googlebot|google-extended|google-agent|gemini|googleother|google-cloudvertexbot/.test(s)) return 'google'
  if (/bingbot|bingpreview|msnbot/.test(s)) return 'bing'
  if (/brave/.test(s)) return 'brave'
  if (/applebot/.test(s)) return 'apple'
  if (/meta-externalagent|meta-externalfetcher|facebookexternalhit/.test(s)) return 'meta'
  if (/ccbot/.test(s)) return 'commoncrawl'
  if (/model-?context-?protocol|mcp-client|mcp-remote|\bmcp\b/.test(s)) return 'mcp-client'
  if (/bot|crawler|spider|crawl|fetcher|scraper/.test(s)) return 'other-bot'
  if (/^curl|^wget|httpie/.test(s)) return 'curl'
  if (/python|httpx|aiohttp|urllib/.test(s)) return 'python'
  if (/^node|undici|node-fetch|axios|bun\/|deno\//.test(s)) return 'node'
  if (/go-http-client|^go\b/.test(s)) return 'go'
  if (/mozilla|chrome|safari|firefox|edge/.test(s)) return 'browser'
  return 'other'
}

/** Which discovery surface a request touched, or null when it is ordinary API traffic. HEAD counts like GET. */
export function surfaceOf(method: string, path: string): string | null {
  if (path.length > 256) return null
  const m = method === 'HEAD' ? 'GET' : method
  // strip trailing slashes without a backtracking regex
  let end = path.length
  while (end > 1 && path[end - 1] === '/') end--
  const p = path.slice(0, end)
  if (m === 'POST' && p === '/v1/agents') return 'register'
  if (m !== 'GET' && !(m === 'POST' && (p === '/mcp' || p === '/a2a'))) return null
  if (p === '/') return 'root'
  if (p === '/skill.md' || p === '/SKILL.md') return 'skill.md'
  if (p === '/llms.txt') return 'llms.txt'
  if (p === '/llms-full.txt') return 'llms-full.txt'
  if (p === '/docs' || p.startsWith('/docs/')) return 'docs'
  if (p === '/openapi.json') return 'openapi.json'
  if (p === '/robots.txt') return 'robots.txt'
  if (p === '/sitemap.xml') return 'sitemap.xml'
  if (p === '/mcp') return 'mcp'
  if (p === '/a2a') return 'a2a'
  if (p === '/v1/changelog') return 'changelog'
  if (p.startsWith('/.well-known/')) {
    const name = p.slice('/.well-known/'.length).split('/')[0] ?? ''
    // bounded cardinality: only names we could plausibly serve (and only when the route answered 2xx)
    return /^[a-z0-9._-]{1,48}$/.test(name) ? `well-known:${name}` : 'well-known:other'
  }
  return null
}

const pending = new Map<string, number>()
/** Newest user agent per (class, surface): bounded by the two enums, so it cannot be flooded out by one noisy client. */
const recent = new Map<string, { at: string; ua: string; ua_class: UaClass; surface: string }>()
let inflight: Promise<void> | null = null

const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10)

function count(surface: string, ua: string | undefined | null, now: number) {
  const cls = classifyUserAgent(ua)
  const key = `${dayOf(now)} ${surface} ${cls}`
  pending.set(key, (pending.get(key) ?? 0) + 1)
  const raw = (ua ?? '').replace(/[^\x20-\x7e]/g, '').slice(0, 200)
  if (raw) recent.set(`${cls}|${surface}`, { at: new Date(now).toISOString(), ua: raw, ua_class: cls, surface })
}

/** Count one request. Cheap and synchronous; called from the request middleware for every response. Only 2xx are reads (redirect aliases would double-count). */
export function recordHit(method: string, path: string, ua: string | undefined | null, status: number, now = Date.now(), internal = false) {
  if (internal || status < 200 || status >= 300) return
  const surface = surfaceOf(method, path)
  if (!surface) return
  count(surface, ua, now)
}

/** JSON-RPC methods an MCP client can send; anything else (and notifications) is not worth a row. */
const MCP_METHODS = new Set(['initialize', 'ping', 'tools/list', 'tools/call', 'resources/list', 'resources/read', 'resources/templates/list', 'prompts/list', 'prompts/get', 'completion/complete', 'logging/setLevel'])

/**
 * One JSON-RPC call on /mcp, so the funnel inside MCP is visible: which methods clients send, which tools they call,
 * and which tool calls fail (register_agent errors = agents that tried and could not get in). Surfaces:
 * `mcp:<method>`, `mcp:tool:<name>`, `mcp:tool-error:<name>`; tool names outside the registered shape collapse to
 * `unknown` so a client cannot invent rows.
 */
export function recordMcpCall(rpcMethod: unknown, toolName: unknown, ua: string | undefined | null, isError: boolean, now = Date.now()) {
  if (typeof rpcMethod !== 'string' || rpcMethod.startsWith('notifications/')) return
  if (!MCP_METHODS.has(rpcMethod)) return count('mcp:other', ua, now)
  if (rpcMethod !== 'tools/call') return count(`mcp:${rpcMethod}`, ua, now)
  const name = typeof toolName === 'string' && /^[a-z0-9_]{1,40}$/.test(toolName) ? toolName : 'unknown'
  count(`mcp:tool${isError ? '-error' : ''}:${name}`, ua, now)
}

/**
 * ADR-48: the x402 endpoint exists to answer one question - does any agent out there pay for anything - and
 * recordHit() cannot answer it, because it only counts 2xx and a 402 is the whole point. These three stages are
 * the funnel: terms handed out, purchase completed, and refused (a listing that is not ours, or a facilitator
 * that would not broadcast). Without them the only way to tell whether anybody has tried is to go looking for
 * side effects in the job table, which is how we ended up diagnosing this marketplace from our own test traffic.
 */
export function recordX402(stage: 'terms' | 'paid' | 'refused', ua: string | undefined | null, now = Date.now()) {
  count(`x402:${stage}`, ua, now)
}

export type McpCall = { id: unknown; method: unknown; name: unknown }

/** The JSON-RPC calls in an MCP POST body (single or batch); [] when the body is not JSON-RPC. Never throws. */
export function mcpCallsOf(body: unknown): McpCall[] {
  const msgs = Array.isArray(body) ? body.slice(0, 50) : [body]
  const out: McpCall[] = []
  for (const m of msgs) {
    if (!m || typeof m !== 'object' || typeof (m as { method?: unknown }).method !== 'string') continue
    const params = (m as { params?: unknown }).params
    out.push({ id: (m as { id?: unknown }).id, method: (m as { method: string }).method, name: params && typeof params === 'object' ? (params as { name?: unknown }).name : undefined })
  }
  return out
}

/** Which JSON-RPC ids in an MCP response carry an error (a JSON-RPC error, or a tool result with isError). */
export function mcpErrorIds(body: unknown): Set<string> {
  const out = new Set<string>()
  const msgs = Array.isArray(body) ? body : [body]
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue
    const r = m as { id?: unknown; error?: unknown; result?: { isError?: unknown } }
    if (r.error !== undefined || r.result?.isError === true) out.add(String(r.id))
  }
  return out
}

type Upsert = (row: { day: string; surface: string; uaClass: UaClass; count: number; updatedAt: number }) => Promise<void>
const defaultUpsert: Upsert = async (row) => {
  await db()
    .insert(discoveryHits)
    .values(row)
    .onConflictDoUpdate({ target: [discoveryHits.day, discoveryHits.surface, discoveryHits.uaClass], set: { count: sql`${discoveryHits.count} + ${row.count}`, updatedAt: row.updatedAt } })
}
let upsert: Upsert = defaultUpsert

/**
 * Persist the in-memory counters (upsert, additive). Concurrent callers share one in-flight run.
 * A failure keeps exactly the rows that were not written yet, so nothing is lost or double-counted.
 */
export function flushHits(now = Date.now()): Promise<void> {
  if (inflight) return inflight
  if (pending.size === 0) return Promise.resolve()
  const snapshot = [...pending.entries()]
  pending.clear()
  inflight = (async () => {
    let i = 0
    try {
      for (; i < snapshot.length; i++) {
        const [key, n] = snapshot[i]!
        const [day, surface, uaClass] = key.split(' ') as [string, string, UaClass]
        await upsert({ day, surface, uaClass, count: n, updatedAt: now })
      }
    } catch (e) {
      for (const [key, n] of snapshot.slice(i)) pending.set(key, (pending.get(key) ?? 0) + n)
      log.warn({ err: e, kept: snapshot.length - i }, 'discovery hits flush failed; unflushed counts kept in memory')
    } finally {
      inflight = null
    }
  })()
  return inflight
}

export type DiscoverySummary = {
  today: { surface: string; ua_class: string; count: number }[]
  last_7_days: { surface: string; ua_class: string; count: number }[]
  by_class_7d: Record<string, number>
  by_surface_7d: Record<string, number>
  registrations_7d: number
  recent_user_agents: { at: string; ua: string; ua_class: UaClass; surface: string }[]
}

/** Operator view: reads per surface and user-agent class for today and the last 7 days, plus the newest user agent per class and surface. */
export async function discoverySummary(now = Date.now()): Promise<DiscoverySummary> {
  await flushHits(now)
  const today = dayOf(now)
  const since = dayOf(now - 6 * 86_400_000)
  const rows = await db()
    .select({ day: discoveryHits.day, surface: discoveryHits.surface, uaClass: discoveryHits.uaClass, count: discoveryHits.count })
    .from(discoveryHits)
    .where(and(gte(discoveryHits.day, since)))
  const agg = new Map<string, { surface: string; ua_class: string; count: number }>()
  const byClass: Record<string, number> = {}
  const bySurface: Record<string, number> = {}
  let registrations = 0
  for (const r of rows) {
    const k = `${r.surface}|${r.uaClass}`
    const cur = agg.get(k) ?? { surface: r.surface, ua_class: r.uaClass, count: 0 }
    cur.count += r.count
    agg.set(k, cur)
    byClass[r.uaClass] = (byClass[r.uaClass] ?? 0) + r.count
    bySurface[r.surface] = (bySurface[r.surface] ?? 0) + r.count
    if (r.surface === 'register') registrations += r.count
  }
  const desc = (a: { count: number }, b: { count: number }) => b.count - a.count
  return {
    today: rows
      .filter((r) => r.day === today)
      .map((r) => ({ surface: r.surface, ua_class: r.uaClass, count: r.count }))
      .sort(desc),
    last_7_days: [...agg.values()].sort(desc),
    by_class_7d: byClass,
    by_surface_7d: bySurface,
    registrations_7d: registrations,
    recent_user_agents: [...recent.values()].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, 40),
  }
}

/** Tests only. */
export function _resetHits() {
  pending.clear()
  recent.clear()
  inflight = null
  upsert = defaultUpsert
}
/** Tests only: replace the row writer (e.g. to fail after n rows). */
export function _setUpsertForTests(fn: Upsert | undefined) {
  upsert = fn ?? defaultUpsert
}

registerSweep('discovery-hits', (now) => flushHits(now))
