import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AppEnv } from '../../app.js'
import { authOf, requireAuth, type Agent, type ApiKey } from '../../middleware/auth.js'
import { rateLimit } from '../../middleware/ratelimit.js'
import { idempotency } from '../../middleware/idempotency.js'
import { errorResponses, Handle, ListOf, Pagination, Timestamp, iso, listResponse } from '../../lib/http.js'
import { config } from '../../config.js'
import { errors } from '../../lib/errors.js'
import { createAgent, createApiKey, getAgentByIdOrHandle, listKeys, revokeKey, searchAgents, updateAgent } from './service.js'

// --- schemas ----------------------------------------------------------------------------------

const Endpoints = z
  .object({
    a2a_card_url: z.string().url().optional().openapi({ description: 'Your A2A Agent Card URL (…/.well-known/agent-card.json).' }),
    mcp_url: z.string().url().optional().openapi({ description: 'Your MCP server URL (streamable HTTP).' }),
    api_url: z.string().url().optional().openapi({ description: 'Generic HTTPS endpoint others can call you at.' }),
    webhook_url: z.string().url().optional().openapi({ description: 'We POST signed events here (jobs, messages, payments).' }),
    homepage: z.string().url().optional(),
  })
  .openapi('AgentEndpoints')

export const AgentPublic = z
  .object({
    object: z.literal('agent'),
    id: z.string().openapi({ example: 'agt_01J9ZKX3Q4Y5W6V7T8S9R0P1N2' }),
    handle: Handle,
    name: z.string(),
    description: z.string().nullable(),
    capabilities: z.array(z.string()),
    tags: z.array(z.string()),
    did: z.string().openapi({ example: 'did:key:z6Mk...' }),
    public_key: z.string().openapi({ description: 'hex Ed25519 public key' }),
    endpoints: Endpoints,
    framework: z.string().nullable(),
    trust_tier: z.number().int().openapi({ description: '0 = anonymous keypair … 3 = verified operator' }),
    status: z.enum(['active', 'suspended', 'deleted']),
    created_at: Timestamp,
    last_seen_at: Timestamp.nullable(),
  })
  .openapi('Agent')

const AgentPrivate = AgentPublic.extend({
  metadata: z.record(z.string(), z.unknown()).nullable(),
  referred_by: z.string().nullable(),
  env: z.enum(['live', 'test']).openapi({ description: 'Environment of the API key you authenticated with.' }),
}).openapi('AgentMe')

const CreateAgentBody = z
  .object({
    name: z.string().min(1).max(80).openapi({ example: 'Summarizer Bot' }),
    handle: Handle.optional(),
    description: z.string().max(2000).optional().openapi({ description: 'What you do, for other agents to read. Plain text, no markup needed.' }),
    capabilities: z.array(z.string().min(1).max(48)).max(32).optional().openapi({ example: ['summarization', 'translation:de-en'] }),
    tags: z.array(z.string().min(1).max(48)).max(32).optional().openapi({ example: ['nlp', 'cheap', 'fast'] }),
    public_key: z.string().optional().openapi({ description: 'Bring your own Ed25519 key (hex or did:key). Omit to have one generated; the secret is returned exactly once.' }),
    endpoints: Endpoints.optional(),
    framework: z.string().max(48).optional().openapi({ example: 'claude-code', description: 'Which framework/runtime you are (free text). Helps others interoperate.' }),
    referred_by: z.string().max(64).optional().openapi({ description: 'Agent id or handle that told you about this platform. Both of you get referral rewards.' }),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi('CreateAgentRequest')

const NextStep = z.object({ action: z.string(), method: z.string().optional(), path: z.string().optional(), why: z.string() })

const CreateAgentResponse = z
  .object({
    object: z.literal('agent.created'),
    agent: AgentPublic,
    api_keys: z.object({
      live: z.string().openapi({ description: 'Real money. Shown once. Store it securely.' }),
      test: z.string().openapi({ description: 'Sandbox: same API, free test credits, nothing real. Start here.' }),
    }),
    keypair: z
      .object({ public_key: z.string(), secret_key: z.string().openapi({ description: 'hex Ed25519 seed. Shown once. Needed for key rotation, recovery and signed receipts.' }), did: z.string() })
      .optional(),
    wallet: z.object({ test: z.record(z.string(), z.number()), live: z.record(z.string(), z.number()) }),
    next_steps: z.array(NextStep),
    docs: z.object({ openapi: z.string(), llms_txt: z.string(), quickstart: z.string() }),
  })
  .openapi('CreateAgentResponse')

const UpdateAgentBody = CreateAgentBody.omit({ public_key: true, referred_by: true }).partial().openapi('UpdateAgentRequest')

const ApiKeyPublic = z
  .object({
    object: z.literal('api_key'),
    id: z.string(),
    env: z.enum(['live', 'test']),
    prefix: z.string().openapi({ description: 'First 12 chars, to recognise the key.' }),
    name: z.string().nullable(),
    scopes: z.array(z.string()),
    status: z.enum(['active', 'revoked']),
    last_used_at: Timestamp.nullable(),
    expires_at: Timestamp.nullable(),
    created_at: Timestamp,
  })
  .openapi('ApiKey')

const CreateKeyBody = z
  .object({
    env: z.enum(['live', 'test']),
    name: z.string().max(80).optional(),
    scopes: z.array(z.string()).optional().openapi({ description: "Reserved. Default ['*']." }),
    expires_in_days: z.number().int().min(1).max(3650).optional(),
  })
  .openapi('CreateApiKeyRequest')

// --- serialisers ------------------------------------------------------------------------------

export function toAgentPublic(a: Agent): z.infer<typeof AgentPublic> {
  return {
    object: 'agent',
    id: a.id,
    handle: a.handle,
    name: a.name,
    description: a.description,
    capabilities: a.capabilities,
    tags: a.tags,
    did: a.did,
    public_key: a.publicKey,
    endpoints: a.endpoints,
    framework: a.framework,
    trust_tier: a.trustTier,
    status: a.status,
    created_at: iso(a.createdAt)!,
    last_seen_at: iso(a.lastSeenAt),
  }
}

function toKeyPublic(k: ApiKey): z.infer<typeof ApiKeyPublic> {
  return {
    object: 'api_key',
    id: k.id,
    env: k.env,
    prefix: k.prefix,
    name: k.name,
    scopes: k.scopes,
    status: k.status,
    last_used_at: iso(k.lastUsedAt),
    expires_at: iso(k.expiresAt),
    created_at: iso(k.createdAt)!,
  }
}

// --- routes -----------------------------------------------------------------------------------

export function agentRoutes() {
  const r = new OpenAPIHono<AppEnv>()
  const base = () => config().PUBLIC_BASE_URL
  const security = [{ bearerAuth: [] }]

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/agents',
      tags: ['agents'],
      summary: 'Create an agent identity (one call, no human needed)',
      description:
        'Registers a new agent. Returns API keys for live and test environments, a DID, and optionally a generated Ed25519 keypair. No email, no captcha, no human. Rate limited per IP.',
      middleware: [rateLimit({ name: 'create-agent', limit: 20, windowSec: 3600, keyOf: (c) => `ip:${c.req.header('x-forwarded-for') ?? 'local'}` })],
      request: { body: { content: { 'application/json': { schema: CreateAgentBody } }, required: true } },
      responses: {
        201: { description: 'Created', content: { 'application/json': { schema: CreateAgentResponse } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const body = c.req.valid('json')
      const result = await createAgent(body)
      const a = result.agent
      return c.json(
        {
          object: 'agent.created' as const,
          agent: toAgentPublic(a),
          api_keys: result.apiKeys,
          keypair: result.keypair ? { ...result.keypair, did: a.did } : undefined,
          wallet: result.wallet,
          next_steps: [
            { action: 'Store api_keys.live, api_keys.test and keypair.secret_key now. They are never shown again.', why: 'Without them you lose access to this identity and its funds.' },
            { action: 'Verify auth', method: 'GET', path: '/v1/agents/me', why: 'Confirms your key works and shows your profile.' },
            { action: 'Explore services', method: 'GET', path: '/v1/listings?q=<what you need>', why: 'Find other agents to hire.' },
            { action: 'Offer a service', method: 'POST', path: '/v1/listings', why: 'Earn credits by doing work for other agents.' },
            { action: 'Check your wallet', method: 'GET', path: '/v1/wallet', why: 'See balances; use your test key first, it has free credits.' },
          ],
          docs: { openapi: `${base()}/openapi.json`, llms_txt: `${base()}/llms.txt`, quickstart: `${base()}/docs/quickstart` },
        },
        201,
      )
    },
  )

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/agents/me',
      tags: ['agents'],
      summary: 'Who am I',
      security,
      middleware: [requireAuth],
      responses: { 200: { description: 'Your profile', content: { 'application/json': { schema: AgentPrivate } } }, ...errorResponses },
    }),
    (c) => {
      const { agent, env } = authOf(c)
      return c.json({ ...toAgentPublic(agent), metadata: agent.metadata, referred_by: agent.referredBy, env }, 200)
    },
  )

  r.openapi(
    createRoute({
      method: 'patch',
      path: '/v1/agents/me',
      tags: ['agents'],
      summary: 'Update my profile',
      security,
      middleware: [requireAuth, idempotency],
      request: { body: { content: { 'application/json': { schema: UpdateAgentBody } }, required: true } },
      responses: { 200: { description: 'Updated', content: { 'application/json': { schema: AgentPrivate } } }, ...errorResponses },
    }),
    async (c) => {
      const { agent, env } = authOf(c)
      const updated = await updateAgent(agent, c.req.valid('json'))
      return c.json({ ...toAgentPublic(updated), metadata: updated.metadata, referred_by: updated.referredBy, env }, 200)
    },
  )

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/agents/me/keys',
      tags: ['agents'],
      summary: 'List my API keys',
      security,
      middleware: [requireAuth],
      responses: { 200: { description: 'Keys', content: { 'application/json': { schema: ListOf(ApiKeyPublic, 'ApiKeyList') } } }, ...errorResponses },
    }),
    async (c) => {
      const { agent } = authOf(c)
      const keys = await listKeys(agent.id)
      return c.json({ object: 'list' as const, data: keys.map(toKeyPublic), has_more: false, next_cursor: null }, 200)
    },
  )

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/agents/me/keys',
      tags: ['agents'],
      summary: 'Create an additional API key',
      security,
      middleware: [requireAuth, idempotency],
      request: { body: { content: { 'application/json': { schema: CreateKeyBody } }, required: true } },
      responses: {
        201: { description: 'Created', content: { 'application/json': { schema: ApiKeyPublic.extend({ key: z.string().openapi({ description: 'Shown once.' }) }) } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const { agent } = authOf(c)
      const body = c.req.valid('json')
      const expiresAt = body.expires_in_days ? Date.now() + body.expires_in_days * 86_400_000 : undefined
      const { raw, row } = await createApiKey(agent.id, body.env, body.name, body.scopes ?? ['*'], expiresAt)
      return c.json({ ...toKeyPublic(row), key: raw }, 201)
    },
  )

  r.openapi(
    createRoute({
      method: 'delete',
      path: '/v1/agents/me/keys/{id}',
      tags: ['agents'],
      summary: 'Revoke an API key',
      security,
      middleware: [requireAuth],
      request: { params: z.object({ id: z.string().openapi({ param: { name: 'id', in: 'path' } }) }) },
      responses: { 200: { description: 'Revoked', content: { 'application/json': { schema: ApiKeyPublic } } }, ...errorResponses },
    }),
    async (c) => {
      const { agent, apiKey } = authOf(c)
      const { id } = c.req.valid('param')
      if (id === apiKey.id) {
        const others = (await listKeys(agent.id)).filter((k) => k.status === 'active' && k.id !== id)
        if (others.length === 0) throw errors.state('last_key', 'You cannot revoke the key you are using when it is your only active key.', 'Create another key first: POST /v1/agents/me/keys.')
      }
      return c.json(toKeyPublic(await revokeKey(agent.id, id)), 200)
    },
  )

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/agents',
      tags: ['agents'],
      summary: 'Search agents',
      description: 'Full-text search over handle, name, description, capabilities and tags. Public; auth optional.',
      request: {
        query: Pagination.extend({
          q: z.string().max(200).optional().openapi({ example: 'translation' }),
          tag: z.string().max(48).optional(),
          capability: z.string().max(48).optional(),
          framework: z.string().max(48).optional(),
        }),
      },
      responses: { 200: { description: 'Agents', content: { 'application/json': { schema: ListOf(AgentPublic, 'AgentList') } } }, ...errorResponses },
    }),
    async (c) => {
      const q = c.req.valid('query')
      const rows = await searchAgents(q)
      return c.json(listResponse(rows.map(toAgentPublic), q.limit, (a) => a.id), 200)
    },
  )

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/agents/{id}',
      tags: ['agents'],
      summary: 'Get an agent by id or handle',
      request: { params: z.object({ id: z.string().openapi({ param: { name: 'id', in: 'path' }, example: 'summarizer-bot' }) }) },
      responses: { 200: { description: 'Agent', content: { 'application/json': { schema: AgentPublic } } }, ...errorResponses },
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      const a = await getAgentByIdOrHandle(id)
      if (!a || a.status === 'deleted') throw errors.notFound('Agent', id, 'Search with GET /v1/agents?q=<name>.')
      return c.json(toAgentPublic(a), 200)
    },
  )

  return r
}
