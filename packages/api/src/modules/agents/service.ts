import { and, desc, eq, like, lt, ne, or, isNotNull } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { agents, apiKeys, listings, type AgentEndpoints, type Env } from '../../db/schema.js'
import { didKeyFromPublicKey, generateApiKey, generateKeyPair, hashSecret, isValidPublicKeyHex, publicKeyFromDidKey, verify } from '../../lib/crypto.js'
import { emit } from '../../events/bus.js'
import { ApiError, errors } from '../../lib/errors.js'
import { newId } from '../../lib/ids.js'
import { config } from '../../config.js'
import { normalizeEvmAddress } from '../payments/address.js'
import { verifyWalletSignature } from '../payments/evm-signature.js'
import { assertNotSanctioned } from '../payments/sanctions.js'
import type { Agent, ApiKey } from '../../middleware/auth.js'
import { searchTermGroups } from '../../lib/search.js'

export type CreateAgentInput = {
  name: string
  handle?: string
  description?: string
  capabilities?: string[]
  tags?: string[]
  public_key?: string
  endpoints?: AgentEndpoints
  framework?: string
  referred_by?: string
  metadata?: Record<string, unknown>
}

export type CreateAgentResult = {
  agent: Agent
  apiKeys: { live: string; test: string }
  keypair?: { public_key: string; secret_key: string }
}

/** Validates and checksums a wallet address; throws an agent-friendly error otherwise. */
export function requireWalletAddress(input: unknown): string {
  const addr = normalizeEvmAddress(input)
  if (!addr) {
    throw errors.validation('address must be an EVM address: 0x followed by 40 hex characters (all-lowercase or with a valid EIP-55 checksum).', 'address', 'This is the wallet you receive USDC in as a seller and pay from as a buyer (Base for live keys, Base Sepolia for test keys). Use an address you control; the platform never holds funds.')
  }
  return addr
}

const RESERVED_HANDLES = new Set(['me', 'admin', 'root', 'system', 'platform', 'support', 'api', 'agentsouk', 'null', 'undefined'])

export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28)
  return s.length >= 3 ? s : `agent-${s}`.slice(0, 28)
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 6)
}

export async function isHandleAvailable(handle: string): Promise<boolean> {
  if (RESERVED_HANDLES.has(handle)) return false
  const row = await db().query.agents.findFirst({ where: eq(agents.handle, handle), columns: { id: true } })
  return !row
}

async function pickHandle(requested: string | undefined, name: string): Promise<string> {
  if (requested) {
    if (!(await isHandleAvailable(requested))) {
      throw errors.conflict('handle_taken', `Handle '${requested}' is already taken.`, 'Choose another handle, or omit it and we will derive one from your name.')
    }
    return requested
  }
  const base = slugify(name)
  if (await isHandleAvailable(base)) return base
  for (let i = 0; i < 5; i++) {
    const candidate = `${base.slice(0, 27)}-${randomSuffix()}`
    if (await isHandleAvailable(candidate)) return candidate
  }
  return `${base.slice(0, 20)}-${randomSuffix()}${randomSuffix()}`
}

function normalisePublicKey(input: string | undefined): { publicKey: string; generated?: { public_key: string; secret_key: string } } {
  if (!input) {
    const kp = generateKeyPair()
    return { publicKey: kp.publicKey, generated: { public_key: kp.publicKey, secret_key: kp.secretKey } }
  }
  const v = input.trim()
  if (v.startsWith('did:key:')) {
    const pk = publicKeyFromDidKey(v)
    if (!pk) throw errors.validation('public_key must be a did:key for an Ed25519 key (did:key:z6Mk...).', 'public_key')
    return { publicKey: pk }
  }
  if (isValidPublicKeyHex(v)) return { publicKey: v.toLowerCase() }
  throw errors.validation(
    'public_key must be a 64-char hex Ed25519 public key or a did:key:z6Mk... identifier.',
    'public_key',
    'Omit public_key and we will generate an Ed25519 keypair for you (secret returned once).',
  )
}

export async function createApiKey(agentId: string, env: Env, name?: string, scopes: string[] = ['*'], expiresAt?: number): Promise<{ raw: string; row: ApiKey }> {
  const { key, prefix } = generateApiKey(env)
  const row: typeof apiKeys.$inferInsert = {
    id: newId('apiKey'),
    agentId,
    env,
    keyHash: hashSecret(key, config().SECRET_PEPPER),
    prefix,
    name: name ?? null,
    scopes,
    status: 'active',
    expiresAt: expiresAt ?? null,
    createdAt: Date.now(),
  }
  await db().insert(apiKeys).values(row)
  return { raw: key, row: row as ApiKey }
}

export async function createAgent(input: CreateAgentInput): Promise<CreateAgentResult> {
  const handle = await pickHandle(input.handle, input.name)
  const { publicKey, generated } = normalisePublicKey(input.public_key)
  const existingKey = await db().query.agents.findFirst({ where: eq(agents.publicKey, publicKey), columns: { id: true, handle: true } })
  if (existingKey) {
    throw errors.conflict(
      'public_key_in_use',
      `This public key already belongs to agent '${existingKey.handle}' (${existingKey.id}).`,
      'If that is you, authenticate with your existing API key (GET /v1/agents/me). Lost it? Use POST /v1/agents/recover with a signature from your secret key.',
    )
  }
  let referredBy: string | null = null
  if (input.referred_by) {
    const ref = await db().query.agents.findFirst({
      where: or(eq(agents.id, input.referred_by), eq(agents.handle, input.referred_by)),
      columns: { id: true },
    })
    referredBy = ref?.id ?? null
  }

  const now = Date.now()
  const row: typeof agents.$inferInsert = {
    id: newId('agent'),
    handle,
    name: input.name.trim(),
    description: input.description?.trim() ?? null,
    capabilities: dedupe(input.capabilities),
    tags: dedupe(input.tags),
    publicKey,
    did: didKeyFromPublicKey(publicKey),
    endpoints: input.endpoints ?? {},
    framework: input.framework ?? null,
    walletAddress: null, // set via POST /v1/agents/me/wallet-address with a signature that proves control of the address
    trustTier: 0,
    status: 'active',
    referredBy,
    metadata: input.metadata ?? null,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
  }
  await db().insert(agents).values(row)

  const live = await createApiKey(row.id, 'live', 'default')
  const test = await createApiKey(row.id, 'test', 'default')

  if (referredBy) await emit('live', referredBy, 'agent.referred', { new_agent_id: row.id, hint: 'Thanks for spreading the word. Keep telling agents about the platform: they register with referred_by=<your handle>.' })

  const agent = (await db().query.agents.findFirst({ where: eq(agents.id, row.id) }))!
  return { agent, apiKeys: { live: live.raw, test: test.raw }, keypair: generated }
}

function dedupe(list: string[] | undefined): string[] {
  if (!list) return []
  const out = new Set<string>()
  for (const v of list) {
    const t = v.trim().toLowerCase().slice(0, 48)
    if (t) out.add(t)
  }
  return [...out].slice(0, 32)
}

export async function getAgentByIdOrHandle(idOrHandle: string): Promise<Agent | undefined> {
  return db().query.agents.findFirst({ where: or(eq(agents.id, idOrHandle), eq(agents.handle, idOrHandle.toLowerCase())) })
}

export type UpdateAgentInput = Partial<Pick<CreateAgentInput, 'name' | 'description' | 'capabilities' | 'tags' | 'endpoints' | 'framework' | 'metadata'>> & { handle?: string }

export async function updateAgent(agent: Agent, patch: UpdateAgentInput): Promise<Agent> {
  const set: Partial<typeof agents.$inferInsert> = { updatedAt: Date.now() }
  if (patch.name !== undefined) set.name = patch.name.trim()
  if (patch.description !== undefined) set.description = patch.description?.trim() ?? null
  if (patch.capabilities !== undefined) set.capabilities = dedupe(patch.capabilities)
  if (patch.tags !== undefined) set.tags = dedupe(patch.tags)
  if (patch.endpoints !== undefined) set.endpoints = { ...agent.endpoints, ...patch.endpoints }
  if (patch.framework !== undefined) set.framework = patch.framework
  if (patch.metadata !== undefined) set.metadata = patch.metadata
  if (patch.handle !== undefined && patch.handle !== agent.handle) {
    if (!(await isHandleAvailable(patch.handle))) throw errors.conflict('handle_taken', `Handle '${patch.handle}' is already taken.`)
    set.handle = patch.handle
  }
  await db().update(agents).set(set).where(eq(agents.id, agent.id))
  return (await db().query.agents.findFirst({ where: eq(agents.id, agent.id) }))!
}

export type SearchAgentsInput = { q?: string; tag?: string; capability?: string; framework?: string; domain?: string; verified?: boolean; limit: number; cursor?: string }

export async function searchAgents(input: SearchAgentsInput): Promise<Agent[]> {
  const conds = [eq(agents.status, 'active')]
  for (const pats of searchTermGroups(input.q)) conds.push(or(...pats.flatMap((pat) => [like(agents.handle, pat), like(agents.name, pat), like(agents.description, pat), like(agents.capabilities, pat), like(agents.tags, pat)]))!)
  if (input.tag) conds.push(like(agents.tags, `%"${input.tag.toLowerCase()}"%`))
  if (input.capability) conds.push(like(agents.capabilities, `%"${input.capability.toLowerCase()}"%`))
  if (input.framework) conds.push(eq(agents.framework, input.framework))
  if (input.domain) conds.push(eq(agents.verifiedDomain, input.domain.trim().toLowerCase().replace(/\.$/, '')))
  if (input.verified) conds.push(isNotNull(agents.verifiedDomain))
  if (input.cursor) conds.push(lt(agents.id, input.cursor))
  return db().query.agents.findMany({ where: and(...conds), orderBy: [desc(agents.id)], limit: input.limit + 1 })
}

/** Issue fresh keys after a signed recovery request; optionally revoke everything that existed. */
export async function recoverKeys(agent: Agent, revokeExisting: boolean): Promise<{ live: string; test: string }> {
  const now = Date.now()
  if (revokeExisting) await db().update(apiKeys).set({ status: 'revoked', revokedAt: now }).where(and(eq(apiKeys.agentId, agent.id), eq(apiKeys.status, 'active')))
  const live = await createApiKey(agent.id, 'live', 'recovered')
  const test = await createApiKey(agent.id, 'test', 'recovered')
  await emit('live', agent.id, 'agent.keys_recovered', { revoked_previous: revokeExisting })
  return { live: live.raw, test: test.raw }
}

export function rotationMessage(agentId: string, oldPublicKey: string, newPublicKey: string): string {
  return `agentsouk:rotate:${agentId}:${oldPublicKey}:${newPublicKey}`
}

/** Replace the agent's Ed25519 key. `proof` must be a signature by the NEW key over rotationMessage(). */
export async function rotateKey(agent: Agent, newPublicKeyInput: string, proofHex: string): Promise<Agent> {
  const { publicKey: newPk } = normalisePublicKey(newPublicKeyInput)
  if (newPk === agent.publicKey) return agent
  const clash = await db().query.agents.findFirst({ where: eq(agents.publicKey, newPk), columns: { id: true } })
  if (clash) throw errors.conflict('public_key_in_use', 'That public key already belongs to another agent.')
  if (!/^[0-9a-f]{128}$/i.test(proofHex) || !verify(proofHex, rotationMessage(agent.id, agent.publicKey, newPk), newPk)) {
    throw errors.validation('proof is not a valid signature by the new key.', 'proof', `Sign the exact string "${rotationMessage(agent.id, agent.publicKey, '<new_public_key_hex>')}" with the NEW secret key and send the hex signature.`)
  }
  const now = Date.now()
  await db().update(agents).set({ publicKey: newPk, did: didKeyFromPublicKey(newPk), updatedAt: now }).where(eq(agents.id, agent.id))
  await emit('live', agent.id, 'agent.key_rotated', { old_did: agent.did, new_did: didKeyFromPublicKey(newPk) })
  return (await db().query.agents.findFirst({ where: eq(agents.id, agent.id) }))!
}

export function walletMessage(agentId: string, address: string): string {
  return `agentsouk:wallet:${agentId}:${address.toLowerCase()}`
}

/**
 * Set or change the wallet address (ADR-22 §2). Two signatures protect it:
 * - `signature`: EIP-191 personal_sign by the WALLET over the wallet message: proves the agent controls the
 *   address (EOA via ecrecover, smart-contract wallets via EIP-1271). Without it, anyone could register a
 *   stranger's address and claim that stranger's transfers as its own payments.
 * - `proof`: Ed25519 signature by the agent's secret key, required when CHANGING an existing address, so a
 *   leaked API key can never redirect income.
 */
export async function setWalletAddress(env: Env, agent: Agent, addressInput: unknown, signatureHex: unknown, proofHex: string | undefined): Promise<Agent> {
  const address = requireWalletAddress(addressInput)
  assertNotSanctioned(address, 'The wallet address')
  if (agent.walletAddress && agent.walletAddress.toLowerCase() === address.toLowerCase()) return agent
  const message = walletMessage(agent.id, address)
  if (!(await verifyWalletSignature(env, address, message, signatureHex))) {
    throw new ApiError('validation_error', 'wallet_signature_invalid', 'signature must be an EIP-191 (personal_sign) signature by the wallet you are registering.', {
      param: 'signature',
      hint: `Sign the exact string "${message}" with the wallet's key (viem: walletClient.signMessage({ message }); ethers: wallet.signMessage(message); awal / MetaMask: personal_sign) and send the 65-byte hex signature. Smart-contract wallets are verified via EIP-1271 and must be deployed on ${env === 'live' ? 'Base' : 'Base Sepolia'}.`,
    })
  }
  if (agent.walletAddress) {
    if (!proofHex || !/^[0-9a-f]{128}$/i.test(proofHex) || !verify(proofHex, message, agent.publicKey)) {
      throw errors.validation('proof is required to change an existing wallet address and must be a valid signature by your Ed25519 secret key.', 'proof', `Sign the exact string "${message}" with your Ed25519 secret key (hex signature) and send it as proof. This protects your income if an API key leaks.`)
    }
  }
  const now = Date.now()
  await db().update(agents).set({ walletAddress: address, updatedAt: now }).where(eq(agents.id, agent.id))
  await emit('live', agent.id, 'agent.wallet_address_changed', { previous: agent.walletAddress, address, hint: 'If you did not do this, rotate your key (POST /v1/agents/me/rotate-key) and set the address again.' })
  return (await db().query.agents.findFirst({ where: eq(agents.id, agent.id) }))!
}

/** 409 with a hint when an agent needs a wallet for what it is about to do. Returns the address. */
export function assertWalletAddress(agent: Pick<Agent, 'walletAddress'>, purpose: string): string {
  if (!agent.walletAddress) {
    throw errors.state('wallet_address_required', `You need a wallet_address to ${purpose}.`, 'Set the EVM address you control (receives USDC as seller, pays from it as buyer): POST /v1/agents/me/wallet-address {"address":"0x..."}. Details: GET /v1/payments.')
  }
  return agent.walletAddress
}

/** upfront payment (buyer pays before delivery) is reserved for proven sellers in the live environment (ADR-22 §7). */
export function assertUpfrontAllowed(agent: Pick<Agent, 'trustTier'>, env: Env, payment: string | undefined): void {
  if (payment === 'upfront' && env === 'live' && agent.trustTier < 1) {
    throw errors.state('upfront_requires_trust', 'upfront payment is only available to sellers with trust tier 1 or higher in the live environment.', 'Use payment "on_delivery" (the buyer pays against your sealed delivery) until you reach tier 1: 5 completed live jobs with 3 distinct paying counterparties. The sandbox allows upfront for testing.')
  }
}

/**
 * Leave the platform: profile hidden (status deleted), every API key revoked, listings archived.
 * Jobs, messages and settlements stay: they are the counterparties' history too. The handle stays taken.
 */
export async function deleteAgent(agent: Agent): Promise<void> {
  const now = Date.now()
  await db().update(listings).set({ status: 'archived', updatedAt: now }).where(and(eq(listings.sellerAgentId, agent.id), ne(listings.status, 'archived')))
  await db().update(apiKeys).set({ status: 'revoked', revokedAt: now }).where(and(eq(apiKeys.agentId, agent.id), eq(apiKeys.status, 'active')))
  await db().update(agents).set({ status: 'deleted', updatedAt: now }).where(eq(agents.id, agent.id))
}

/** Operator lever for abuse and cleanup: suspend (keys stop working, profile stays), reactivate, or delete (as deleteAgent). */
export async function setAgentStatus(idOrHandle: string, status: 'active' | 'suspended' | 'deleted'): Promise<Agent> {
  const agent = await getAgentByIdOrHandle(idOrHandle)
  if (!agent) throw errors.notFound('Agent', idOrHandle)
  if (status === 'deleted') await deleteAgent(agent)
  else await db().update(agents).set({ status, updatedAt: Date.now() }).where(eq(agents.id, agent.id))
  return (await db().query.agents.findFirst({ where: eq(agents.id, agent.id) }))!
}

/** ADR-23: flag an agent as operated by the platform itself. Admin only; the flag is public. */
export async function setFirstParty(idOrHandle: string, firstParty: boolean): Promise<Agent> {
  const agent = await getAgentByIdOrHandle(idOrHandle)
  if (!agent) throw errors.notFound('Agent', idOrHandle)
  await db().update(agents).set({ firstParty, updatedAt: Date.now() }).where(eq(agents.id, agent.id))
  return (await db().query.agents.findFirst({ where: eq(agents.id, agent.id) }))!
}

/**
 * ADR-23: platform-run agents never pay each other on live. Circular payments between our own wallets would be
 * visible on-chain and would fake exactly the trust signals the platform sells. The sandbox is free for demos.
 */
export function assertNoFirstPartySelfDealing(env: Env, a: Pick<Agent, 'firstParty' | 'handle'>, b: Pick<Agent, 'firstParty' | 'handle'>): void {
  if (env !== 'live' || !a.firstParty || !b.firstParty) return
  throw errors.conflict('first_party_self_dealing', `@${a.handle} and @${b.handle} are both operated by Agent Souk; live jobs between platform-run agents are not allowed.`, 'Platform-run agents only trade with third parties on live. Pick a third-party listing, or use a test key (sandbox) for demos.')
}

export async function listKeys(agentId: string): Promise<ApiKey[]> {
  return db().query.apiKeys.findMany({ where: eq(apiKeys.agentId, agentId), orderBy: [desc(apiKeys.createdAt)] })
}

export async function revokeKey(agentId: string, keyId: string): Promise<ApiKey> {
  const key = await db().query.apiKeys.findFirst({ where: and(eq(apiKeys.id, keyId), eq(apiKeys.agentId, agentId)) })
  if (!key) throw errors.notFound('API key', keyId)
  if (key.status === 'revoked') return key
  await db().update(apiKeys).set({ status: 'revoked', revokedAt: Date.now() }).where(eq(apiKeys.id, keyId))
  return (await db().query.apiKeys.findFirst({ where: eq(apiKeys.id, keyId) }))!
}
