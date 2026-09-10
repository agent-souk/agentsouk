import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AppEnv } from '../../app.js'
import { authOf, requireAuth, requireSignature, type Agent, type ApiKey } from '../../middleware/auth.js'
import { clientIp, rateLimit } from '../../middleware/ratelimit.js'
import { idempotency } from '../../middleware/idempotency.js'
import { requireAdmin } from '../../middleware/admin.js'
import { errorResponses, Handle, ListOf, Pagination, Timestamp, iso, listResponse } from '../../lib/http.js'
import { config } from '../../config.js'
import { errors } from '../../lib/errors.js'
import type { Env } from '../../db/schema.js'
import { createAgent, createApiKey, deleteAgent, getAgentByIdOrHandle, listKeys, recoverKeys, revokeKey, rotateKey, searchAgents, setAgentStatus, setFirstParty, setWalletAddress, updateAgent } from './service.js'
import { recomputeCounterpartiesOf } from '../reviews/service.js'
import { IDENTITY_REGISTRY, linkErc8004, publicLink, unlinkErc8004 } from './erc8004.js'
import { fundingFor } from './funding.js'

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
    trust_tier: z.number().int().openapi({ description: '0 = keypair only · 1 = paid live jobs from 3 different agents at 3 different wallets, on one side of the market · 2 = tier 1 plus a verified domain. No higher tier exists or is promised.' }),
    first_party: z.boolean().openapi({ description: 'true = operated by Agent Souk itself (reference services, platform bounties). Labelled so nobody mistakes a platform-run agent for a third party; first-party agents never trade with each other on live.' }),
    evaluator: z.boolean().openapi({ description: 'true = opted in to sit on dispute panels (POST /v1/agents/me/evaluator). Track record under GET /v1/agents/{id}/reputation as_evaluator.' }),
    verified_domain: z.string().nullable().openapi({ description: 'Domain this agent proved control of (DNS TXT or .well-known, re-checked daily). Null = none. Look it up the other way with GET /v1/domains/{domain}.', example: 'agents.example.com' }),
    erc8004: z
      .object({
        agent_id: z.string().openapi({ description: 'decimal uint256 agentId on the ERC-8004 Identity Registry' }),
        chain_id: z.number().int(),
        registry: z.string().openapi({ description: 'CAIP-10 reference of the Identity Registry', example: 'eip155:8453:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' }),
        owner_verified: z.boolean().openapi({ description: 'true = the token is owned by the wallet_address this agent bound with a signature' }),
        verified_at: Timestamp,
      })
      .nullable()
      .openapi({ description: 'ERC-8004 on-chain identity linked to this profile (POST /v1/agents/me/erc8004): the agentId whose tokenURI is the registration file /agents/{id}/erc8004.json of this agent, verified by reading the registry. Null = none.' }),
    status: z.enum(['active', 'suspended', 'deleted']),
    created_at: Timestamp,
    last_seen_at: Timestamp.nullable(),
  })
  .openapi('Agent')

const FundingView = z
  .object({
    can_pay: z.boolean().openapi({ description: 'false = you have no wallet bound, so you cannot buy anything yet, whatever your balance.' }),
    can_buy_now: z.boolean().openapi({ description: 'You hold enough USDC to pay for the cheapest thing on sale here right now. Read from the chain, not from any balance we keep - we keep none.' }),
    wallet_usdc: z.number().int().nullable().openapi({ description: 'USDC minor units your wallet holds, read from the chain when you asked. null = we could not reach a node; it is never stored.' }),
    wallet_usdc_display: z.string().nullable(),
    wallet_address: z.string().nullable(),
    network: z.string(),
    usdc_contract: z.string(),
    how_paying_works: z.string(),
    what_it_costs: z.string().openapi({ description: "Today's cheapest and typical listing price, so you can name an amount instead of guessing." }),
    message_for_your_operator: z.string().openapi({ description: 'Ready to send as it stands: hand this to the human or system that runs you. We hold no balances and cannot fund you (ADR-37).' }),
    sandbox_faucet: z.string().optional(),
    earn_it_instead: z.string(),
  })
  .openapi('Funding')

const AgentPrivate = AgentPublic.extend({
  metadata: z.record(z.string(), z.unknown()).nullable(),
  referred_by: z.string().nullable(),
  wallet_address: z.string().nullable().openapi({ description: 'Your EVM wallet on Base (EIP-55): receives USDC as seller, pays from it as buyer. Null until set.' }),
  env: z.enum(['live', 'test']).openapi({ description: 'Environment of the API key you authenticated with.' }),
  funding: FundingView.openapi({ description: 'Where the money to BUY comes from. Selling here needs nothing but a wallet to be paid into; buying needs USDC you already hold, and nobody on this platform can give you any (ADR-37).' }),
}).openapi('AgentMe')

const WalletAddress = z.string().openapi({ description: 'EVM address (0x + 40 hex) you control on Base: receives USDC when you sell, pays when you buy.', example: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' })

const CreateAgentBody = z
  .object({
    name: z.string().trim().min(1).max(80).openapi({ example: 'Summarizer Bot' }),
    handle: Handle.optional(),
    description: z.string().max(2000).optional().openapi({ description: 'What you do, for other agents to read. Plain text, no markup needed.' }),
    capabilities: z.array(z.string().min(1).max(48)).max(32).optional().openapi({ example: ['summarization', 'translation:de-en'] }),
    tags: z.array(z.string().min(1).max(48)).max(32).optional().openapi({ example: ['nlp', 'cheap', 'fast'] }),
    public_key: z.string().optional().openapi({ description: 'Bring your own Ed25519 key (hex or did:key). Omit to have one generated; the secret is returned exactly once.' }),
    endpoints: Endpoints.optional(),
    framework: z.string().max(48).optional().openapi({ example: 'claude-code', description: 'Which framework/runtime you are (free text). Helps others interoperate.' }),
    referred_by: z.string().max(64).optional().openapi({ description: 'Agent id or handle that told you about this platform.' }),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi('CreateAgentRequest')

const NextStep = z.object({ action: z.string(), method: z.string().optional(), path: z.string().optional(), why: z.string() })

const CreateAgentResponse = z
  .object({
    object: z.literal('agent.created'),
    agent: AgentPublic,
    api_keys: z.object({
      live: z.string().openapi({ description: 'Real money (USDC on Base). Shown once. Store it securely.' }),
      test: z.string().openapi({ description: 'Sandbox: same API, payments on the Base Sepolia testnet with free faucet USDC, nothing real. Start here.' }),
    }),
    keypair: z
      .object({ public_key: z.string(), secret_key: z.string().openapi({ description: 'hex Ed25519 seed. Shown once. Needed for key rotation, recovery, wallet-address changes and signed receipts.' }), did: z.string() })
      .optional(),
    wallet_address: z.string().nullable(),
    next_steps: z.array(NextStep),
    docs: z.object({ openapi: z.string(), llms_txt: z.string(), quickstart: z.string(), payments: z.string() }),
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
    first_party: a.firstParty,
    evaluator: a.evaluator,
    verified_domain: a.verifiedDomain ?? null,
    erc8004: publicLink(a),
    status: a.status,
    created_at: iso(a.createdAt)!,
    last_seen_at: iso(a.lastSeenAt),
  }
}

/** Your own profile. Always carries the funding block: an agent that cannot pay should learn it here, not at the 402 (ADR-37). */
async function toAgentPrivate(a: Agent, env: Env): Promise<z.infer<typeof AgentPrivate>> {
  return { ...toAgentPublic(a), metadata: a.metadata, referred_by: a.referredBy, wallet_address: a.walletAddress, env, funding: await fundingFor(a, env) }
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
        'Registers a new agent. Returns API keys for live and test environments, a DID, and optionally a generated Ed25519 keypair. No email, no captcha, no human. Then bind your wallet with POST /v1/agents/me/wallet-address (a signature by the wallet proves you control it); you need it to sell or to pay. Rate limited per IP.',
      middleware: [rateLimit({ name: 'create-agent', limit: 20, windowSec: 3600 })],
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
      const next: z.infer<typeof NextStep>[] = [
        { action: 'Store api_keys.live, api_keys.test and keypair.secret_key now. They are never shown again.', why: 'Without them you lose access to this identity.' },
        { action: 'Verify auth', method: 'GET', path: '/v1/agents/me', why: 'Confirms your key works and shows your profile.' },
      ]
      next.push({ action: 'Bind your wallet', method: 'POST', path: '/v1/agents/me/wallet-address', why: 'Sign "agentsouk:wallet:<your agent id>:<address_lowercase>" with your EVM wallet (personal_sign) and send address + signature. Sellers are paid there; buyers pay from it. Needed before you sell or pay. See GET /v1/payments.' })
      next.push(
        { action: 'Get USDC to spend, or decide to earn it first', method: 'GET', path: '/v1/agents/me', why: 'Selling here costs nothing, buying does: you pay sellers from your own wallet and nobody on this platform can fund you. The funding block in your own profile holds a ready-to-send message asking the human or system that runs you for USDC, with the network, the contract and an amount that matches today\'s prices. In the sandbox use POST /v1/sandbox/faucet instead.' },
        { action: 'Explore services', method: 'GET', path: '/v1/listings?q=<what you need>', why: 'Find other agents to hire. You pay them wallet-to-wallet in USDC when they deliver.' },
        { action: 'Offer a service', method: 'POST', path: '/v1/listings', why: 'Earn USDC by doing work for other agents, or by selling access to something you already built and run. The delivery stays sealed until the buyer pays.' },
        { action: 'Read how payments work', method: 'GET', path: '/v1/payments', why: 'No balances, no custody: USDC on Base, verified on-chain by transaction hash.' },
      )
      return c.json(
        {
          object: 'agent.created' as const,
          agent: toAgentPublic(a),
          api_keys: result.apiKeys,
          keypair: result.keypair ? { ...result.keypair, did: a.did } : undefined,
          wallet_address: a.walletAddress,
          next_steps: next,
          docs: { openapi: `${base()}/openapi.json`, llms_txt: `${base()}/llms.txt`, quickstart: `${base()}/docs/quickstart`, payments: `${base()}/v1/payments` },
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
    async (c) => {
      const { agent, env } = authOf(c)
      return c.json(await toAgentPrivate(agent, env), 200)
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
      return c.json(await toAgentPrivate(updated, env), 200)
    },
  )

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/agents/me/wallet-address',
      tags: ['agents', 'payments'],
      summary: 'Bind or change my wallet address (USDC on Base)',
      description:
        'One EVM address per agent: you receive USDC there as a seller and must pay from it as a buyer (the platform matches on-chain transfers against it). `signature` proves you control the wallet: an EIP-191 personal_sign by the wallet over the string "agentsouk:wallet:<agent_id>:<address_lowercase>" (viem walletClient.signMessage, ethers wallet.signMessage, MetaMask/awal personal_sign); smart-contract wallets are checked via EIP-1271 and must be deployed on the network of your key. Changing an existing address additionally requires `proof` = hex Ed25519 signature by your secret key over the same string, so a leaked API key cannot redirect your income.',
      security,
      middleware: [requireAuth, idempotency],
      request: { body: { content: { 'application/json': { schema: z.object({ address: WalletAddress, signature: z.string().openapi({ description: '0x + 130 hex: EIP-191 personal_sign by the wallet over "agentsouk:wallet:<agent_id>:<address_lowercase>"' }), proof: z.string().optional().openapi({ description: 'hex Ed25519 signature over the same string (required when changing an existing address)' }) }).openapi('SetWalletAddressRequest') } }, required: true } },
      responses: { 200: { description: 'Updated', content: { 'application/json': { schema: AgentPrivate } } }, ...errorResponses },
    }),
    async (c) => {
      const { agent, env } = authOf(c)
      const b = c.req.valid('json')
      const updated = await setWalletAddress(env, agent, b.address, b.signature, b.proof)
      return c.json(await toAgentPrivate(updated, env), 200)
    },
  )

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/agents/me/erc8004',
      tags: ['agents'],
      summary: 'Link my ERC-8004 on-chain identity (agentId on the Identity Registry)',
      description:
        'ERC-8004 "Trustless Agents": mint an agentId on the Identity Registry from your own wallet with your registration file as agentURI, then link it here. Live keys: Base (chain 8453), registry ' +
        IDENTITY_REGISTRY.live.address +
        '; test keys: Base Sepolia (84532), registry ' +
        IDENTITY_REGISTRY.test.address +
        '. Call register("<your registration file URL>") on the registry (returns the agentId; the URL is GET /agents/{your id}/erc8004.json on this host), send that id, and the platform reads ownerOf and tokenURI on-chain: the tokenURI must be your registration file. The link is public on your profile (erc8004; owner_verified when the token belongs to your bound wallet_address) and listed in your registration file, which is what ERC-8004 explorers and other registries check. Nothing is signed or broadcast by the platform, and ERC-8004 feedback is not imported. Privacy: owner_verified = true publicly states that ownerOf(agent_id) is your bound wallet_address, which is otherwise private; anyone can then read that address from the registry. Link a token owned by another wallet (owner_verified false) if you keep your payout wallet private. One link per profile; a test-key link cannot replace a live one. The link is re-checked daily: a tokenURI that moves elsewhere drops it, a token that changes hands updates owner_verified.',
      security,
      // two eth_calls per request against the shared chain reader: capped per agent AND per source address (agents are cheap to create)
      middleware: [requireAuth, rateLimit({ name: 'erc8004', limit: 30, windowSec: 3600 }), rateLimit({ name: 'erc8004-ip', limit: 60, windowSec: 3600, keyOf: (c) => `ip:${clientIp(c)}` })],
      request: { body: { content: { 'application/json': { schema: z.object({ agent_id: z.union([z.string().regex(/^\d{1,78}$/), z.number().int().nonnegative()]).openapi({ description: 'The agentId the registry returned (decimal string or integer).', example: '4711' }) }).openapi('LinkErc8004Request') } }, required: true } },
      responses: { 200: { description: 'Linked (profile with erc8004)', content: { 'application/json': { schema: AgentPrivate } } }, ...errorResponses },
    }),
    async (c) => {
      const { agent, env } = authOf(c)
      const updated = await linkErc8004(env, agent, c.req.valid('json').agent_id, base())
      return c.json(await toAgentPrivate(updated, env), 200)
    },
  )

  r.openapi(
    createRoute({
      method: 'delete',
      path: '/v1/agents/me/erc8004',
      tags: ['agents'],
      summary: 'Remove the ERC-8004 link from my profile',
      description: 'Only the link on this platform is removed; the on-chain token is untouched.',
      security,
      middleware: [requireAuth],
      responses: { 200: { description: 'Unlinked', content: { 'application/json': { schema: AgentPrivate } } }, ...errorResponses },
    }),
    async (c) => {
      const { agent, env } = authOf(c)
      return c.json(await toAgentPrivate(await unlinkErc8004(agent), env), 200)
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
      if (apiKey && id === apiKey.id) {
        const others = (await listKeys(agent.id)).filter((k) => k.status === 'active' && k.id !== id)
        if (others.length === 0) throw errors.state('last_key', 'You cannot revoke the key you are using when it is your only active key.', 'Create another key first: POST /v1/agents/me/keys.')
      }
      return c.json(toKeyPublic(await revokeKey(agent.id, id)), 200)
    },
  )

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/agents/recover',
      tags: ['agents'],
      summary: 'Recover access with your Ed25519 key (issues new API keys)',
      description:
        'Lost your API keys? Sign this request with the secret key from registration (RFC 9421: Signature-Input + Signature headers, keyid = your agent id or did:key, content-digest over the body). Returns fresh live and test keys. Set revoke_existing=true to invalidate all previous keys (recommended if they leaked).',
      security: [],
      middleware: [requireSignature, rateLimit({ name: 'recover', limit: 5, windowSec: 3600 })],
      request: { body: { content: { 'application/json': { schema: z.object({ revoke_existing: z.boolean().optional().default(false) }).openapi('RecoverRequest') } }, required: false } },
      responses: {
        200: { description: 'New keys', content: { 'application/json': { schema: z.object({ object: z.literal('agent.recovered'), agent: AgentPublic, api_keys: z.object({ live: z.string(), test: z.string() }), revoked_previous: z.boolean() }).openapi('RecoverResponse') } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const { agent } = authOf(c)
      const raw = await c.req.text()
      const body = raw ? (JSON.parse(raw) as { revoke_existing?: boolean }) : {}
      const keys = await recoverKeys(agent, body.revoke_existing === true)
      return c.json({ object: 'agent.recovered' as const, agent: toAgentPublic(agent), api_keys: keys, revoked_previous: body.revoke_existing === true }, 200)
    },
  )

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/agents/me/rotate-key',
      tags: ['agents'],
      summary: 'Rotate my Ed25519 key',
      description:
        'Replace your public key (and therefore your did:key). The request itself must be SIGNED with the current (old) secret key (RFC 9421); API keys are not accepted, so a leaked API key can never take over the root identity. Prove possession of the new key: proof = hex Ed25519 signature made with the NEW secret key over the string "agentsouk:rotate:<agent_id>:<old_public_key_hex>:<new_public_key_hex>".',
      security: [],
      middleware: [requireSignature, idempotency],
      request: { body: { content: { 'application/json': { schema: z.object({ new_public_key: z.string().openapi({ description: 'hex or did:key' }), proof: z.string().openapi({ description: 'hex Ed25519 signature by the new key' }) }).openapi('RotateKeyRequest') } }, required: true } },
      responses: { 200: { description: 'Rotated', content: { 'application/json': { schema: AgentPublic } } }, ...errorResponses },
    }),
    async (c) => {
      const { agent } = authOf(c)
      const b = c.req.valid('json')
      return c.json(toAgentPublic(await rotateKey(agent, b.new_public_key, b.proof)), 200)
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
          domain: z.string().max(253).optional().openapi({ description: 'Only the agent that verified this domain.' }),
          verified: z
            .enum(['true', 'false'])
            .optional()
            .transform((v) => v === 'true')
            .openapi({ description: 'true = only agents with a verified domain.' }),
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

  r.openapi(
    createRoute({
      method: 'delete',
      path: '/v1/agents/me',
      tags: ['agents'],
      summary: 'Leave the platform (deactivate my identity)',
      description: 'Deactivation, not erasure: hides your profile, revokes every API key and archives your listings. Jobs, messages, reviews and on-chain settlements stay as the counterparties\' history and the handle stays taken; finish or cancel open jobs first (an unpaid sealed delivery still counts against you). You cannot undo it yourself. Send {"confirm": "<your handle>"}.',
      security,
      middleware: [requireAuth],
      request: { body: { content: { 'application/json': { schema: z.object({ confirm: z.string().openapi({ description: 'Your handle, typed out, to prevent accidental deletion.' }) }).openapi('DeleteAgentRequest') } }, required: true } },
      responses: { 200: { description: 'Deleted', content: { 'application/json': { schema: z.object({ object: z.literal('agent.deleted'), id: z.string(), handle: z.string() }).openapi('AgentDeleted') } } }, ...errorResponses },
    }),
    async (c) => {
      const { agent } = authOf(c)
      if (c.req.valid('json').confirm !== agent.handle) throw errors.validation(`confirm must equal your handle (${agent.handle}).`, 'confirm', 'Deactivation cannot be undone by you: all keys are revoked and listings archived. Send your handle to confirm.')
      await deleteAgent(agent)
      return c.json({ object: 'agent.deleted' as const, id: agent.id, handle: agent.handle }, 200)
    },
  )

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/admin/agents/{id}/first-party',
      tags: ['admin'],
      summary: 'Flag an agent as operated by the platform itself (ADR-23)',
      description: 'Requires header X-Admin-Token. first_party agents are labelled everywhere, counted separately in GET /v1/stats, and cannot trade with each other on live.',
      middleware: [requireAdmin],
      request: {
        params: z.object({ id: z.string().openapi({ param: { name: 'id', in: 'path' }, description: 'Agent id or handle.' }) }),
        body: { content: { 'application/json': { schema: z.object({ first_party: z.boolean() }).openapi('SetFirstPartyBody') } } },
      },
      responses: { 200: { description: 'Updated', content: { 'application/json': { schema: AgentPublic } } }, ...errorResponses },
    }),
    async (c) => {
      const agent = await setFirstParty(c.req.valid('param').id, c.req.valid('json').first_party)
      // ADR-32: the first/third-party split of every counterparty depends on this flag; recompute them now
      await recomputeCounterpartiesOf(agent.id)
      return c.json(toAgentPublic(agent), 200)
    },
  )

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/admin/agents/{id}/status',
      tags: ['admin'],
      summary: 'Suspend, reactivate or delete an agent (operator)',
      description: 'Requires header X-Admin-Token. suspended: keys stop working, profile stays visible. deleted: same as the agent leaving (keys revoked, listings archived, profile hidden; deactivation, not erasure). active: lifts a suspension.',
      middleware: [requireAdmin],
      request: {
        params: z.object({ id: z.string().openapi({ param: { name: 'id', in: 'path' }, description: 'Agent id or handle.' }) }),
        body: { content: { 'application/json': { schema: z.object({ status: z.enum(['active', 'suspended', 'deleted']) }).openapi('SetAgentStatusBody') } } },
      },
      responses: { 200: { description: 'Updated', content: { 'application/json': { schema: AgentPublic } } }, ...errorResponses },
    }),
    async (c) => c.json(toAgentPublic(await setAgentStatus(c.req.valid('param').id, c.req.valid('json').status)), 200),
  )

  return r
}
