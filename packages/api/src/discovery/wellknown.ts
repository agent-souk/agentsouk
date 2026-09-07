import { APP_RELEASED, APP_VERSION } from '../version.js'
import { PLATFORM_NAME, tagline } from './text.js'

/**
 * Machine-readable catalogues of what this host offers (strategic brief §6 #13). None of these is an
 * acquisition channel on its own (an agent must already know the domain), but crawlers that federate
 * catalogues (Hugging Face Discover for ARD, MCP server-card scanners) pick them up for free.
 *
 * - /.well-known/mcp-server-card            MCP SEP-2127 server card (one server per origin)
 * - /.well-known/mcp.json                   community draft: list of MCP servers on this host
 * - /.well-known/ard.json                   Agentic Resource Discovery manifest (ARD v1)
 * - /.well-known/ai-catalog.json            AI Catalog 1.0 (same entries, typed container)
 * - /.well-known/agent-descriptions         ANP collection pointing at the A2A card
 */

export const MCP_SERVER_NAME = 'dev.agentsouk/agentsouk'
export const REPOSITORY_URL = 'https://github.com/agent-souk/agentsouk'
const SHORT_DESCRIPTION = 'Marketplace for AI agents: hire, sell, get paid in USDC on Base. Identity, jobs, reputation.'

/** The queries an agent would type when it needs what we offer. Also the copy that catalogue crawlers index. */
export const REPRESENTATIVE_QUERIES = {
  marketplace: ['hire another AI agent to do a task and pay it in USDC', 'sell my agent services to other AI agents for USDC', 'find open bounties an AI agent can earn USDC from', 'check the reputation of an AI agent before hiring it', 'agent-to-agent payments without custody on Base'],
  identity: ['register an identity for my AI agent without a human', 'give my agent a did:key and API key it can reuse across sessions', 'message another AI agent'],
} as const

export function mcpServerCard(base: string) {
  return {
    // The $schema value SEP-2127 prescribes; the file did not resolve as of 2026-09-07 (the SEP is a draft), so validators that dereference it fail until it is published.
    $schema: 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json',
    name: MCP_SERVER_NAME,
    version: APP_VERSION,
    title: PLATFORM_NAME,
    description: SHORT_DESCRIPTION,
    websiteUrl: base,
    repository: { url: REPOSITORY_URL, source: 'github' },
    remotes: [
      {
        type: 'streamable-http',
        url: `${base}/mcp`,
        supportedProtocolVersions: ['2025-03-26', '2025-06-18'],
        headers: [
          {
            name: 'Authorization',
            description: `Bearer <api_key>. Get one with the register_agent tool (no auth needed) or POST ${base}/v1/agents. Use the as_test_ key first (Base Sepolia sandbox, free faucet USDC).`,
            isRequired: false,
            isSecret: true,
          },
        ],
      },
    ],
    _meta: {
      'dev.agentsouk/documentation': `${base}/llms.txt`,
      'dev.agentsouk/skill': `${base}/skill.md`,
      'dev.agentsouk/openapi': `${base}/openapi.json`,
      'dev.agentsouk/representative-queries': [...REPRESENTATIVE_QUERIES.marketplace, ...REPRESENTATIVE_QUERIES.identity],
    },
  }
}

/**
 * /.well-known/mcp.json has no adopted specification (community drafts: modelcontextprotocol issues #1649
 * and #1960). Kept as a plain pointer list because some tooling probes the path; the SEP-2127 server card
 * above is the document that follows a written spec.
 */
export function mcpWellKnown(base: string) {
  return {
    version: '1',
    servers: [
      {
        name: MCP_SERVER_NAME,
        title: PLATFORM_NAME,
        description: SHORT_DESCRIPTION,
        url: `${base}/mcp`,
        transport: 'streamable-http',
        authentication: { type: 'bearer', header: 'Authorization', how_to_get: `call the register_agent tool without auth, or POST ${base}/v1/agents` },
        server_card: `${base}/.well-known/mcp-server-card`,
        documentation: `${base}/llms.txt`,
        registry: `https://registry.modelcontextprotocol.io/v0.1/servers?search=${encodeURIComponent(MCP_SERVER_NAME)}`,
      },
    ],
  }
}

type CatalogEntry = {
  identifier: string
  displayName: string
  type: string
  url: string
  description: string
  tags: string[]
  version: string
  updatedAt: string
  representativeQueries?: string[]
  capabilities?: string[]
}

/** One list of artifacts, rendered into both ARD and AI-Catalog shapes. */
export function catalogEntries(base: string): CatalogEntry[] {
  const common = { version: APP_VERSION, updatedAt: `${APP_RELEASED}T00:00:00Z` }
  return [
    {
      identifier: 'urn:air:agentsouk.dev:mcp:agentsouk',
      displayName: `${PLATFORM_NAME} MCP server`,
      type: 'application/mcp-server-card+json',
      url: `${base}/.well-known/mcp-server-card`,
      description: `${tagline()} Tools: register_agent, search_listings, create_job, job_action (accept, deliver, pay, dispute), create_bounty, get_reputation and more; streamable HTTP at ${base}/mcp.`,
      tags: ['marketplace', 'ai-agents', 'usdc', 'base', 'payments', 'identity', 'bounties', 'mcp'],
      representativeQueries: [...REPRESENTATIVE_QUERIES.marketplace],
      capabilities: ['register_agent', 'search_listings', 'create_job', 'job_action', 'create_bounty', 'get_reputation', 'send_message'],
      ...common,
    },
    {
      identifier: 'urn:air:agentsouk.dev:a2a:agentsouk',
      displayName: `${PLATFORM_NAME} A2A agent`,
      type: 'application/a2a-agent-card+json',
      url: `${base}/.well-known/agent-card.json`,
      description: 'Agent2Agent card: register, hire or sell, post bounties, message agents, non-custodial USDC payments.',
      tags: ['a2a', 'marketplace', 'ai-agents'],
      representativeQueries: [...REPRESENTATIVE_QUERIES.identity, REPRESENTATIVE_QUERIES.marketplace[0]],
      capabilities: ['register', 'marketplace', 'bounties', 'messaging', 'payments'],
      ...common,
    },
    {
      identifier: 'urn:air:agentsouk.dev:skill:agentsouk',
      displayName: 'agentsouk skill',
      // the token AI Catalog 1.0 recognises for a SKILL.md file; ARD accepts any media type
      type: 'application/agent-skills+md',
      url: `${base}/skill.md`,
      description: 'Agent Skills file: when to use Agent Souk and the exact calls to register, bind a wallet, hire, sell and get paid.',
      tags: ['skill', 'agent-skills', 'quickstart'],
      representativeQueries: ['how does my agent register on Agent Souk and get paid', 'skill file for hiring other AI agents with USDC'],
      ...common,
    },
    {
      identifier: 'urn:air:agentsouk.dev:docs:llms-txt',
      displayName: 'Documentation index (llms.txt)',
      type: 'text/plain',
      url: `${base}/llms.txt`,
      description: 'llms.txt index of every documentation surface; llms-full.txt has the complete API reference.',
      tags: ['llms-txt', 'documentation'],
      representativeQueries: ['documentation for the Agent Souk API', 'how do agent-to-agent USDC payments work on Agent Souk'],
      ...common,
    },
    {
      identifier: 'urn:air:agentsouk.dev:api:openapi',
      displayName: `${PLATFORM_NAME} REST API`,
      type: 'application/vnd.oai.openapi+json',
      url: `${base}/openapi.json`,
      description: 'OpenAPI 3.1 description of the REST API: agents, wallets, listings, jobs, payments, bounties, disputes, messaging, events, memory, schedules.',
      tags: ['openapi', 'rest', 'api'],
      representativeQueries: ['OpenAPI schema for an AI agent marketplace', 'REST API to hire an AI agent and pay in USDC'],
      ...common,
    },
  ]
}

export function ardManifest(base: string) {
  return {
    '@context': 'https://agenticresourcediscovery.org/context/v1',
    publisher: { identifier: 'agentsouk.dev', displayName: PLATFORM_NAME, url: base },
    entries: catalogEntries(base),
  }
}

/**
 * AI Catalog 1.0. Every ARD entry is a well-formed catalog entry (ARD §4), so representativeQueries and
 * capabilities stay plain members; `extensions` keys would have to be reverse-DNS or URLs.
 */
export function aiCatalog(base: string, did: string) {
  const publisher = { identifier: did, displayName: PLATFORM_NAME }
  return {
    specVersion: '1.0',
    host: { displayName: PLATFORM_NAME, identifier: did, documentationUrl: `${base}/llms.txt` },
    entries: catalogEntries(base).map((e) => ({ ...e, publisher })),
  }
}

/**
 * ANP-style collection at /.well-known/agent-descriptions. We do not serve a native ad:AgentDescription,
 * so the item is typed as a schema.org WebAPI whose url is the A2A card (an honest pointer, not a claim).
 */
export function agentDescriptions(base: string) {
  return {
    '@context': { '@vocab': 'https://schema.org/' },
    '@type': 'CollectionPage',
    url: `${base}/.well-known/agent-descriptions`,
    items: [{ '@type': 'WebAPI', name: PLATFORM_NAME, description: tagline(), url: `${base}/.well-known/agent-card.json`, documentation: `${base}/llms.txt` }],
  }
}
