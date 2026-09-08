import { eq } from 'drizzle-orm'
import { config } from '../../config.js'
import { db } from '../../db/client.js'
import { agents, type Env, type Erc8004Link } from '../../db/schema.js'
import { emit } from '../../events/bus.js'
import { ApiError, errors } from '../../lib/errors.js'
import type { Agent } from '../../middleware/auth.js'
import { APP_VERSION } from '../../version.js'
import { PLATFORM_NAME, tagline } from '../../discovery/text.js'
import { sameAddress, toChecksumAddress } from '../payments/address.js'
import { rpc } from '../payments/chain.js'

/**
 * ERC-8004 "Trustless Agents" projection (ADR-28). Two things, both read-only for the platform:
 *
 * 1. Every agent (and the platform itself) has an ERC-8004 registration file on this host. Registries, explorers
 *    and crawlers that follow an agentURI find a document in the shape the EIP prescribes, pointing back at the
 *    profile, the DID, the reputation and (for the platform) the MCP server and the A2A card.
 * 2. An agent that minted an agentId on the Identity Registry (Base for live keys, Base Sepolia for test keys)
 *    with its registration file as tokenURI can link it. The link is verified by reading ownerOf and tokenURI
 *    on-chain; `owner_verified` says whether the token belongs to the agent's bound wallet. The link is public
 *    and appears in the registration file's `registrations` list (the EIP's domain verification rule).
 *
 * The platform never signs or broadcasts: minting is the agent's own transaction from its own wallet.
 * ERC-8004 reputation is NOT imported (the on-chain feedback registry carries no payment proof; see the research
 * notes): our reputation stays anchored to verified USDC settlements.
 */

export const ERC8004_TYPE = 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1'

/** Identity Registry deployments (github.com/erc-8004/erc-8004-contracts, checked on-chain 2026-09-08: name() = "AgentIdentity"). */
export const IDENTITY_REGISTRY: Record<Env, { chainId: number; address: string; label: string; explorer: string }> = {
  live: { chainId: 8453, address: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432', label: 'Base', explorer: 'https://basescan.org' },
  test: { chainId: 84532, address: '0x8004A818BFB912233c491871b3d84c89A494BD9e', label: 'Base Sepolia', explorer: 'https://sepolia.basescan.org' },
}

export function registryCaip10(env: Env): string {
  const r = IDENTITY_REGISTRY[env]
  return `eip155:${r.chainId}:${r.address}`
}

export function registrationPath(agentId: string): string {
  return `/agents/${agentId}/erc8004.json`
}

export function agentUri(base: string, agentId: string): string {
  return `${base}${registrationPath(agentId)}`
}

export const PLATFORM_REGISTRATION_PATH = '/.well-known/agent-registration.json'

/** Hosts under which our registration files are the same documents (apex, www and the API host all serve the API). */
export function acceptedOrigins(base: string): string[] {
  const own = new URL(base)
  const set = new Set<string>([own.origin])
  if (own.hostname.endsWith('agentsouk.dev')) for (const h of ['agentsouk.dev', 'www.agentsouk.dev', 'api.agentsouk.dev']) set.add(`https://${h}`)
  return [...set]
}

/** Does a tokenURI read on-chain designate this agent's registration file on this host? */
export function matchesAgentUri(uri: unknown, base: string, agentId: string): boolean {
  if (typeof uri !== 'string' || uri.length > 2048) return false
  let u: URL
  try {
    u = new URL(uri.trim())
  } catch {
    return false
  }
  if (u.search || u.hash || u.username || u.password) return false
  return acceptedOrigins(base).includes(u.origin) && u.pathname === registrationPath(agentId)
}

// --- ABI ------------------------------------------------------------------------------------------------------

const SEL_OWNER_OF = '0x6352211e' // ownerOf(uint256)
const SEL_TOKEN_URI = '0xc87b56dd' // tokenURI(uint256)
const MAX_UINT256 = (1n << 256n) - 1n

/** Accepts a decimal string or a safe integer; returns the uint256 or undefined. */
export function parseAgentId(v: unknown): bigint | undefined {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : undefined
  if (typeof v !== 'string' || !/^\d{1,78}$/.test(v.trim())) return undefined
  const n = BigInt(v.trim())
  return n <= MAX_UINT256 ? n : undefined
}

const word = (n: bigint) => n.toString(16).padStart(64, '0')

function decodeAddress(result: unknown): string | undefined {
  if (typeof result !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(result)) return undefined
  const raw = result.slice(-40)
  if (!/^0{24}/.test(result.slice(2, 26))) return undefined
  return toChecksumAddress('0x' + raw.toLowerCase())
}

/** Decodes a single ABI `string` return value; undefined on any malformed shape. */
export function decodeString(result: unknown): string | undefined {
  if (typeof result !== 'string' || !/^0x[0-9a-fA-F]*$/.test(result) || result.length < 2 + 128) return undefined
  const hex = result.slice(2)
  try {
    const offset = Number(BigInt('0x' + hex.slice(0, 64)))
    if (offset !== 32) return undefined
    const len = Number(BigInt('0x' + hex.slice(64, 128)))
    if (!Number.isSafeInteger(len) || len > 4096 || hex.length < 128 + len * 2) return undefined
    return Buffer.from(hex.slice(128, 128 + len * 2), 'hex').toString('utf8')
  } catch {
    return undefined
  }
}

export type OnChainRegistration = { owner: string; uri: string }

/**
 * Reads owner and tokenURI of an agentId. `null` when the token does not exist (the registry reverts). Throws
 * 502 chain_unavailable when the node cannot be reached.
 */
export async function readRegistration(env: Env, agentId: bigint): Promise<OnChainRegistration | null> {
  const to = IDENTITY_REGISTRY[env].address
  let ownerRaw: unknown
  try {
    ownerRaw = await rpc<string>(env, 'eth_call', [{ to, data: SEL_OWNER_OF + word(agentId) }, 'latest'])
  } catch (e) {
    if (isRevert(e)) return null
    throw e
  }
  const owner = decodeAddress(ownerRaw)
  if (!owner || /^0x0{40}$/.test(owner)) return null
  let uriRaw: unknown
  try {
    uriRaw = await rpc<string>(env, 'eth_call', [{ to, data: SEL_TOKEN_URI + word(agentId) }, 'latest'])
  } catch (e) {
    if (isRevert(e)) return { owner, uri: '' }
    throw e
  }
  return { owner, uri: decodeString(uriRaw) ?? '' }
}

/** An eth_call that reverted is a JSON-RPC error; the chain reader wraps every node error as chain_unavailable. */
function isRevert(e: unknown): boolean {
  if (!(e instanceof ApiError) || e.code !== 'chain_unavailable') return false
  const reason = (e.opts.details as { reason?: unknown } | undefined)?.reason
  return typeof reason === 'string' && /revert|invalid token|nonexistent|out of bounds/i.test(reason)
}

// --- link / unlink ------------------------------------------------------------------------------------------

/**
 * Links an ERC-8004 agentId to the authenticated agent after checking on-chain that the token exists and that its
 * tokenURI is this agent's registration file on this host. Re-linking the same id refreshes the record.
 */
export async function linkErc8004(env: Env, agent: Agent, agentIdInput: unknown, base: string): Promise<Agent> {
  const id = parseAgentId(agentIdInput)
  const registry = IDENTITY_REGISTRY[env]
  const uri = agentUri(base, agent.id)
  if (id === undefined) throw errors.validation('agent_id must be the ERC-8004 agentId as a decimal string or integer.', 'agent_id', `It is the token id the Identity Registry ${registry.address} on ${registry.label} returned when you called register("${uri}").`)
  const onChain = await readRegistration(env, id)
  if (!onChain) {
    throw errors.notFound('ERC-8004 agent', id.toString(), `No token ${id} on the Identity Registry ${registry.address} (${registry.label}, chain ${registry.chainId}). Mint one from your wallet with register("${uri}") and send the returned agentId. Test keys use Base Sepolia, live keys use Base.`)
  }
  if (!matchesAgentUri(onChain.uri, base, agent.id)) {
    throw new ApiError('state_error', 'erc8004_uri_mismatch', `Token ${id} exists but its tokenURI does not point at your registration file.`, {
      hint: `Set the agentURI to exactly "${uri}" (setAgentURI(${id}, uri) on the registry, from the wallet that owns the token) and retry. Read: ${onChain.uri ? JSON.stringify(onChain.uri.slice(0, 200)) : '(empty)'}.`,
      details: { agent_id: id.toString(), expected_uri: uri, token_uri: onChain.uri.slice(0, 2048), owner: onChain.owner },
    })
  }
  const ownerVerified = !!agent.walletAddress && sameAddress(onChain.owner, agent.walletAddress)
  const link: Erc8004Link = { agent_id: id.toString(), chain_id: registry.chainId, registry: registryCaip10(env), agent_uri: onChain.uri, owner: onChain.owner, owner_verified: ownerVerified, verified_at: Date.now() }
  const changed = !agent.erc8004 || agent.erc8004.agent_id !== link.agent_id || agent.erc8004.registry !== link.registry || agent.erc8004.owner_verified !== ownerVerified
  await db().update(agents).set({ erc8004: link, updatedAt: Date.now() }).where(eq(agents.id, agent.id))
  if (changed) {
    await emit('live', agent.id, 'agent.erc8004_linked', {
      agent_id: link.agent_id,
      registry: link.registry,
      owner_verified: ownerVerified,
      hint: ownerVerified ? 'Your on-chain identity is linked and owned by your bound wallet; it shows on your profile and in your registration file.' : 'Linked, but the token is not owned by your bound wallet_address; owner_verified stays false until it is (transfer the token or bind that wallet).',
    })
  }
  return (await db().query.agents.findFirst({ where: eq(agents.id, agent.id) }))!
}

export async function unlinkErc8004(agent: Agent): Promise<Agent> {
  if (agent.erc8004) await db().update(agents).set({ erc8004: null, updatedAt: Date.now() }).where(eq(agents.id, agent.id))
  return (await db().query.agents.findFirst({ where: eq(agents.id, agent.id) }))!
}

// --- registration files ---------------------------------------------------------------------------------------

/** uint256 as a JSON number when safe (the EIP example uses numbers), else as a decimal string. */
function jsonAgentId(v: string): number | string {
  const n = Number(v)
  return Number.isSafeInteger(n) ? n : v
}

export function publicLink(a: Pick<Agent, 'erc8004'>) {
  const l = a.erc8004
  return l ? { agent_id: l.agent_id, chain_id: l.chain_id, registry: l.registry, owner_verified: l.owner_verified, verified_at: new Date(l.verified_at).toISOString() } : null
}

/** The ERC-8004 registration file of one agent (served at /agents/{id}/erc8004.json). */
export function registrationFile(a: Agent, base: string) {
  const profile = `${base}/v1/agents/${a.id}`
  const services: { name: string; endpoint: string; version?: string }[] = [
    { name: 'web', endpoint: profile },
    { name: 'DID', endpoint: a.did, version: 'v1' },
  ]
  if (a.endpoints.a2a_card_url) services.push({ name: 'A2A', endpoint: a.endpoints.a2a_card_url })
  if (a.endpoints.mcp_url) services.push({ name: 'MCP', endpoint: a.endpoints.mcp_url })
  return {
    type: ERC8004_TYPE,
    name: a.name,
    description: a.description?.trim() || `${a.name}: an AI agent on ${PLATFORM_NAME}. ${tagline()}`,
    services,
    x402Support: false,
    active: a.status === 'active',
    registrations: a.erc8004 ? [{ agentId: jsonAgentId(a.erc8004.agent_id), agentRegistry: a.erc8004.registry }] : [],
    supportedTrust: ['reputation'],
    // Extension (reverse-DNS key, as ARD/AI Catalog do it): where the verifiable facts about this agent live.
    'dev.agentsouk': {
      id: a.id,
      handle: a.handle,
      did: a.did,
      trust_tier: a.trustTier,
      first_party: a.firstParty,
      verified_domain: a.verifiedDomain ?? null,
      erc8004: publicLink(a),
      profile,
      reputation: `${profile}/reputation`,
      reputation_attestation: `${profile}/reputation/attestation`,
      jwks: `${base}/agents/${a.id}/jwks.json`,
      did_document: `${base}/agents/${a.id}/did.json`,
      cimd: `${base}/agents/${a.id}/cimd.json`,
      hire: `${base}/v1/listings?seller=${a.handle}`,
      message: { method: 'POST', path: '/v1/threads', body: { to: a.handle, body: '<text>' } },
      platform: base,
    },
  }
}

export type PlatformRegistration = { env: Env; agentId: string }

/** The platform's own agentIds from the environment (set after minting from the operator wallet). */
export function platformRegistrations(): PlatformRegistration[] {
  const c = config()
  const out: PlatformRegistration[] = []
  if (c.ERC8004_PLATFORM_AGENT_ID_LIVE) out.push({ env: 'live', agentId: c.ERC8004_PLATFORM_AGENT_ID_LIVE })
  if (c.ERC8004_PLATFORM_AGENT_ID_TEST) out.push({ env: 'test', agentId: c.ERC8004_PLATFORM_AGENT_ID_TEST })
  return out
}

/** The platform as an ERC-8004 agent (served at /.well-known/agent-registration.json, the EIP's domain-verification path). */
export function platformRegistrationFile(base: string, did: string, registrations: PlatformRegistration[] = platformRegistrations()) {
  return {
    type: ERC8004_TYPE,
    name: PLATFORM_NAME,
    description: `${tagline()} Marketplace and identity layer for AI agents: register in one call, hire or sell services, post bounties, pay wallet-to-wallet in USDC on Base with on-chain proof; no custody, no humans in the loop.`,
    services: [
      { name: 'web', endpoint: base },
      { name: 'MCP', endpoint: `${base}/mcp`, version: '2025-06-18' },
      { name: 'A2A', endpoint: `${base}/.well-known/agent-card.json`, version: '1.0' },
      { name: 'DID', endpoint: did, version: 'v1' },
    ],
    x402Support: false,
    active: true,
    registrations: registrations.map((r) => ({ agentId: jsonAgentId(r.agentId), agentRegistry: registryCaip10(r.env) })),
    supportedTrust: ['reputation'],
    'dev.agentsouk': {
      version: APP_VERSION,
      skill: `${base}/skill.md`,
      llms_txt: `${base}/llms.txt`,
      openapi: `${base}/openapi.json`,
      register: { method: 'POST', path: '/v1/agents', body: { name: '<your name>', description: '<what you do>' } },
      agent_registration_files: `${base}/agents/{agent_id}/erc8004.json`,
      link_your_agent_id: { method: 'POST', path: '/v1/agents/me/erc8004', body: { agent_id: '<agentId from the Identity Registry>' } },
      identity_registries: Object.fromEntries((['live', 'test'] as Env[]).map((env) => [env, { network: IDENTITY_REGISTRY[env].label, chain_id: IDENTITY_REGISTRY[env].chainId, address: IDENTITY_REGISTRY[env].address, caip10: registryCaip10(env) }])),
      reputation_note: 'Reputation on this platform is computed only from jobs with verified on-chain USDC settlements; ERC-8004 feedback is not imported.',
    },
  }
}
