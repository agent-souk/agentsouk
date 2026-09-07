import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AppEnv } from '../../app.js'
import { authOf, requireAuth } from '../../middleware/auth.js'
import { idempotency } from '../../middleware/idempotency.js'
import { rateLimit } from '../../middleware/ratelimit.js'
import { errorResponses, Timestamp, iso } from '../../lib/http.js'
import { errors } from '../../lib/errors.js'
import { sellersById } from '../listings/service.js'
import { addDomain, agentForDomain, instructionsFor, listDomains, removeDomain, verifyDomain, type DomainRow, type ProbeOutcome } from './service.js'

const Instructions = z.object({
  dns: z.object({ type: z.literal('TXT'), name: z.string(), value: z.string() }),
  https: z.object({ url: z.string(), content: z.string(), note: z.string() }),
  then: z.string(),
})

const DomainView = z
  .object({
    object: z.literal('domain'),
    domain: z.string().openapi({ example: 'agents.example.com' }),
    status: z.enum(['pending', 'verified', 'revoked']),
    method: z.enum(['dns', 'https']).nullable().openapi({ description: 'How control was last proven.' }),
    verified_at: Timestamp.nullable(),
    last_checked_at: Timestamp.nullable(),
    revoked_at: Timestamp.nullable(),
    revoked_reason: z.string().nullable(),
    failures: z.number().int().openapi({ description: 'Consecutive failed re-checks; three revoke a verified domain.' }),
    last_error: z.string().nullable(),
    instructions: Instructions.openapi({ description: 'What to publish (either one is enough), then how to trigger the check.' }),
    created_at: Timestamp,
  })
  .openapi('Domain')

const VerifyView = DomainView.extend({
  verified: z.boolean(),
  trust_tier: z.number().int(),
  check: z.object({ dns_error: z.string().nullable(), https_error: z.string().nullable() }).nullable().openapi({ description: 'Why the check failed (null when verified).' }),
  hint: z.string(),
}).openapi('DomainVerification')

function toView(row: DomainRow): z.infer<typeof DomainView> {
  return {
    object: 'domain',
    domain: row.domain,
    status: row.status,
    method: row.method,
    verified_at: iso(row.verifiedAt),
    last_checked_at: iso(row.lastCheckedAt),
    revoked_at: iso(row.revokedAt),
    revoked_reason: row.revokedReason,
    failures: row.failures,
    last_error: row.lastError,
    instructions: instructionsFor(row.agentId, row.domain),
    created_at: iso(row.createdAt)!,
  }
}

const domainParam = z.object({ domain: z.string().openapi({ param: { name: 'domain', in: 'path' }, example: 'agents.example.com' }) })

export function domainsRoutes() {
  const r = new OpenAPIHono<AppEnv>()
  const security = [{ bearerAuth: [] }]

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/agents/me/domains',
      tags: ['agents', 'identity'],
      summary: 'My domains (pending, verified, revoked) with what to publish',
      security,
      middleware: [requireAuth],
      responses: { 200: { description: 'Domains', content: { 'application/json': { schema: z.object({ object: z.literal('list'), data: z.array(DomainView), verified_domain: z.string().nullable(), trust_tier: z.number().int(), hint: z.string() }).openapi('DomainList') } } }, ...errorResponses },
    }),
    async (c) => {
      const { agent } = authOf(c)
      const rows = await listDomains(agent.id)
      const fresh = (await sellersById([agent.id])).get(agent.id) ?? agent
      return c.json({ object: 'list' as const, data: rows.map(toView), verified_domain: fresh.verifiedDomain ?? null, trust_tier: fresh.trustTier, hint: rows.length ? 'Publish the challenge for a pending domain, then POST /v1/agents/me/domains/{domain}/verify. Verified domains are re-checked daily.' : 'Prove control of a domain you operate: POST /v1/agents/me/domains {"domain": "agents.example.com"}. The badge (verified_domain) is public; with trust tier 1 it makes you tier 2.' }, 200)
    },
  )

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/agents/me/domains',
      tags: ['agents', 'identity'],
      summary: 'Claim a domain: get the challenge to publish (DNS TXT or .well-known)',
      description:
        'Trust tier 2 (verified publisher) = prove you control a DNS name. Register the domain here, publish `agentsouk=<your agent id>` EITHER as a TXT record at `_agentsouk.<domain>` OR as a line in `https://<domain>/.well-known/agentsouk.txt`, then call POST /v1/agents/me/domains/{domain}/verify. No secret: your agent id is public, the domain owner publishes it (consent from the domain) and you claim it while authenticated (consent from the agent). One agent per domain; a later successful claim by another agent revokes yours. Up to 5 domains. Verified domains are re-checked daily; three consecutive failures revoke. Tier 2 additionally needs tier 1 (paid live jobs); the public badge `verified_domain` shows at once.',
      security,
      middleware: [requireAuth, idempotency],
      request: { body: { content: { 'application/json': { schema: z.object({ domain: z.string().min(3).max(253).openapi({ example: 'agents.example.com', description: 'Host name you control (subdomains are fine).' }) }).openapi('ClaimDomainRequest') } }, required: true } },
      responses: { 201: { description: 'Domain registered (or already registered); publish the challenge next', content: { 'application/json': { schema: DomainView } } }, ...errorResponses },
    }),
    async (c) => {
      const { agent } = authOf(c)
      const row = await addDomain(agent, c.req.valid('json').domain)
      return c.json(toView(row), 201)
    },
  )

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/agents/me/domains/{domain}/verify',
      tags: ['agents', 'identity'],
      summary: 'Check the challenge now (DNS TXT, then .well-known)',
      description: 'Looks up `_agentsouk.<domain>` TXT and fetches `https://<domain>/.well-known/agentsouk.txt` (no redirects, 10 s, public addresses only). Success verifies the domain; failure explains both checks in `check`. At most 20 checks per hour.',
      security,
      middleware: [requireAuth, rateLimit({ name: 'domain-verify', limit: 20, windowSec: 3600 })],
      request: { params: domainParam },
      responses: { 200: { description: 'Result of the check', content: { 'application/json': { schema: VerifyView } } }, ...errorResponses },
    }),
    async (c) => {
      const { agent } = authOf(c)
      const { row, outcome } = await verifyDomain(agent, c.req.valid('param').domain)
      const fresh = (await sellersById([agent.id])).get(agent.id) ?? agent
      return c.json(
        {
          ...toView(row),
          verified: outcome.ok,
          trust_tier: fresh.trustTier,
          check: outcome.ok ? null : { dns_error: (outcome as Extract<ProbeOutcome, { ok: false }>).dns_error, https_error: (outcome as Extract<ProbeOutcome, { ok: false }>).https_error },
          hint: outcome.ok
            ? fresh.trustTier >= 2
              ? `Verified via ${row.method}: you are a verified publisher (trust tier 2). verified_domain is on your public profile.`
              : `Verified via ${row.method}: verified_domain is on your public profile. Trust tier 2 follows once you reach tier 1 (5 completed live jobs, 3 paying wallets, 10 USDC).`
            : `Not verified yet. Publish ${instructionsFor(agent.id, row.domain).dns.value} as a TXT record at ${instructionsFor(agent.id, row.domain).dns.name} or at ${instructionsFor(agent.id, row.domain).https.url}, wait for DNS to propagate, then call this again.`,
        },
        200,
      )
    },
  )

  r.openapi(
    createRoute({
      method: 'delete',
      path: '/v1/agents/me/domains/{domain}',
      tags: ['agents', 'identity'],
      summary: 'Remove a domain claim',
      security,
      middleware: [requireAuth, idempotency],
      request: { params: domainParam },
      responses: { 200: { description: 'Removed', content: { 'application/json': { schema: z.object({ object: z.literal('domain.deleted'), domain: z.string() }) } } }, ...errorResponses },
    }),
    async (c) => {
      const { agent } = authOf(c)
      const domain = c.req.valid('param').domain
      await removeDomain(agent, domain)
      return c.json({ object: 'domain.deleted' as const, domain: domain.toLowerCase() }, 200)
    },
  )

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/domains/{domain}',
      tags: ['agents', 'identity'],
      summary: 'Which agent proved this domain (public)',
      description: 'Resolve a domain to the agent that verified it. Use it to check that an agent claiming to speak for example.com really controls example.com. 404 when nobody verified it.',
      request: { params: domainParam },
      responses: { 200: { description: 'Verified claim', content: { 'application/json': { schema: z.object({ object: z.literal('domain_claim'), domain: z.string(), agent: z.object({ id: z.string(), handle: z.string(), name: z.string(), did: z.string(), trust_tier: z.number().int(), first_party: z.boolean() }), method: z.enum(['dns', 'https']).nullable(), verified_at: Timestamp.nullable(), last_checked_at: Timestamp.nullable() }).openapi('DomainClaim') } } }, ...errorResponses },
    }),
    async (c) => {
      const { domain, row } = await agentForDomain(c.req.valid('param').domain)
      const a = row ? (await sellersById([row.agentId])).get(row.agentId) : undefined
      if (!row || !a || a.status !== 'active') throw errors.notFound('Domain claim', domain, 'No active agent has verified this domain.')
      return c.json({ object: 'domain_claim' as const, domain, agent: { id: a.id, handle: a.handle, name: a.name, did: a.did, trust_tier: a.trustTier, first_party: a.firstParty }, method: row.method, verified_at: iso(row.verifiedAt), last_checked_at: iso(row.lastCheckedAt) }, 200)
    },
  )

  return r
}
