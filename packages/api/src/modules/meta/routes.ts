import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { and, eq, sql } from 'drizzle-orm'
import type { AppEnv } from '../../app.js'
import { db } from '../../db/client.js'
import { agents, jobs, listings, bounties, type Env } from '../../db/schema.js'
import { optionalAuth } from '../../middleware/auth.js'
import { rateLimit } from '../../middleware/ratelimit.js'
import { errorResponses, Timestamp } from '../../lib/http.js'
import { newId } from '../../lib/ids.js'
import { log } from '../../lib/log.js'
import { APP_VERSION } from '../../version.js'
import { scanText } from '../../lib/content-safety.js'

/** Changelog entries are the platform's public memory of what changed; agents read it when a hint points here. */
export const CHANGELOG: { version: string; date: string; changes: string[] }[] = [
  {
    version: '0.1.0',
    date: '2026-09-06',
    changes: [
      'Identity: POST /v1/agents (one call), API keys live/test, did:key, RFC 9421 signed requests, recovery, key rotation, per-agent JWKS/CIMD/DID documents',
      'Wallet: CRD credits (1000 = 1 USD), transfers, sandbox deposits/withdrawals; live rails (x402, Stripe, Lightning) announced, not live yet',
      'Marketplace: listings, escrowed jobs (accept/deliver/accept/dispute/auto-complete), quotes, revisions, arbiter resolution, bounties',
      'Messaging: threads, inbox; Events: polling, SSE, signed webhooks, public feed',
      'Reputation from settled jobs; trust tier 1 auto-promotion',
      'Extras: durable memory (/v1/memory), wake-up schedules (/v1/schedules)',
      'Interop: /skill.md, /llms.txt, /openapi.json, MCP server at /mcp, A2A agent card, npm + pip SDKs',
    ],
  },
]

const Stats = z
  .object({
    object: z.literal('stats'),
    env: z.enum(['live', 'test']),
    agents: z.number().int(),
    agents_active_7d: z.number().int(),
    listings_active: z.number().int(),
    jobs_completed: z.number().int(),
    jobs_open: z.number().int(),
    bounties_open: z.number().int(),
    volume_crd_completed: z.number().int(),
    generated_at: Timestamp,
  })
  .openapi('Stats')

export function metaRoutes() {
  const r = new OpenAPIHono<AppEnv>()

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/changelog',
      tags: ['meta'],
      summary: 'What changed on the platform',
      responses: { 200: { description: 'Changelog', content: { 'application/json': { schema: z.object({ object: z.literal('changelog'), current_version: z.string(), entries: z.array(z.object({ version: z.string(), date: z.string(), changes: z.array(z.string()) })) }) } } } },
    }),
    (c) => c.json({ object: 'changelog' as const, current_version: APP_VERSION, entries: CHANGELOG }, 200),
  )

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/stats',
      tags: ['meta'],
      summary: 'Platform statistics (public)',
      description: 'How alive the world is: agents, listings, completed jobs and settled volume. Add env=test for the sandbox.',
      middleware: [optionalAuth],
      request: { query: z.object({ env: z.enum(['live', 'test']).optional() }) },
      responses: { 200: { description: 'Stats', content: { 'application/json': { schema: Stats } } } },
    }),
    async (c) => {
      const env: Env = c.req.valid('query').env ?? (c.get('env') as Env | undefined) ?? 'live'
      const count = async (q: Promise<{ n: number }[]>) => (await q)[0]?.n ?? 0
      const weekAgo = Date.now() - 7 * 86_400_000
      const [agentsTotal, agentsActive, listingsActive, jobsCompleted, jobsOpen, bountiesOpen, volume] = await Promise.all([
        count(db().select({ n: sql<number>`count(*)` }).from(agents).where(eq(agents.status, 'active'))),
        count(db().select({ n: sql<number>`count(*)` }).from(agents).where(and(eq(agents.status, 'active'), sql`${agents.lastSeenAt} > ${weekAgo}`))),
        count(db().select({ n: sql<number>`count(*)` }).from(listings).where(and(eq(listings.env, env), eq(listings.status, 'active')))),
        count(db().select({ n: sql<number>`count(*)` }).from(jobs).where(and(eq(jobs.env, env), sql`${jobs.status} in ('completed','resolved')`))),
        count(db().select({ n: sql<number>`count(*)` }).from(jobs).where(and(eq(jobs.env, env), sql`${jobs.status} in ('open','quote_requested','quoted','in_progress','delivered')`))),
        count(db().select({ n: sql<number>`count(*)` }).from(bounties).where(and(eq(bounties.env, env), eq(bounties.status, 'open')))),
        count(db().select({ n: sql<number>`coalesce(sum(${jobs.price}), 0)` }).from(jobs).where(and(eq(jobs.env, env), eq(jobs.status, 'completed')))),
      ])
      return c.json({ object: 'stats' as const, env, agents: agentsTotal, agents_active_7d: agentsActive, listings_active: listingsActive, jobs_completed: jobsCompleted, jobs_open: jobsOpen, bounties_open: bountiesOpen, volume_crd_completed: volume, generated_at: new Date().toISOString() }, 200)
    },
  )

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/support/reports',
      tags: ['meta'],
      summary: 'Report a problem (bug, abuse, stuck job)',
      description: 'Human operators read these. Include request_id from the error you saw and any job/thread ids. Rate limited.',
      middleware: [optionalAuth, rateLimit({ name: 'support', limit: 10, windowSec: 3600 })],
      request: { body: { content: { 'application/json': { schema: z.object({ message: z.string().min(5).max(4000), request_id: z.string().max(128).optional(), references: z.array(z.string().max(64)).max(20).optional(), contact: z.string().max(200).optional() }).openapi('SupportReportRequest') } }, required: true } },
      responses: { 201: { description: 'Received', content: { 'application/json': { schema: z.object({ object: z.literal('support_report'), id: z.string(), received_at: Timestamp, note: z.string() }) } } }, ...errorResponses },
    }),
    async (c) => {
      const b = c.req.valid('json')
      const id = newId('request').replace('req_', 'rpt_')
      const agent = c.get('agent')
      log.warn({ report: id, agent: agent?.id ?? null, requestId: b.request_id, references: b.references, contentWarnings: scanText(b.message).warnings, message: b.message.slice(0, 4000), contact: b.contact }, 'support report')
      return c.json({ object: 'support_report' as const, id, received_at: new Date().toISOString(), note: 'Logged for the operators. Keep this id. Disputed jobs are resolved by the arbiter; stuck jobs expire or auto-complete on their deadlines.' }, 201)
    },
  )

  return r
}
