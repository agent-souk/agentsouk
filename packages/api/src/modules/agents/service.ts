import { and, desc, eq, like, lt, or } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { agents, apiKeys, type AgentEndpoints, type Env } from '../../db/schema.js'
import { didKeyFromPublicKey, generateApiKey, generateKeyPair, hashSecret, isValidPublicKeyHex, publicKeyFromDidKey } from '../../lib/crypto.js'
import { errors } from '../../lib/errors.js'
import { newId } from '../../lib/ids.js'
import { config } from '../../config.js'
import { Ledger } from '../../ledger/ledger.js'
import type { Agent, ApiKey } from '../../middleware/auth.js'

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
  wallet: { test: Record<string, number>; live: Record<string, number> }
}

const RESERVED_HANDLES = new Set(['me', 'admin', 'root', 'system', 'platform', 'support', 'api', 'agentworld', 'null', 'undefined'])

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

  // Welcome credits: generous sandbox money so the first transaction can happen within seconds.
  const ledger = new Ledger(db())
  const testGrant = config().FAUCET_CREDITS * 100
  const wallet: CreateAgentResult['wallet'] = { test: { CRD: 0 }, live: { CRD: 0 } }
  if (testGrant > 0) {
    await ledger.post({
      env: 'test',
      type: 'faucet',
      currency: 'CRD',
      amount: testGrant,
      legs: [
        { account: { ownerType: 'platform', ownerId: 'platform', currency: 'CRD', kind: 'faucet' }, delta: -testGrant },
        { account: { ownerType: 'agent', ownerId: row.id, currency: 'CRD', kind: 'available' }, delta: +testGrant },
      ],
      initiatorAgentId: row.id,
      idempotencyKey: 'welcome',
      referenceType: 'agent',
      referenceId: row.id,
      memo: 'welcome credits (sandbox)',
    })
    wallet.test.CRD = testGrant
  }

  const agent = (await db().query.agents.findFirst({ where: eq(agents.id, row.id) }))!
  return { agent, apiKeys: { live: live.raw, test: test.raw }, keypair: generated, wallet }
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

export type SearchAgentsInput = { q?: string; tag?: string; capability?: string; framework?: string; limit: number; cursor?: string }

export async function searchAgents(input: SearchAgentsInput): Promise<Agent[]> {
  const conds = [eq(agents.status, 'active')]
  if (input.q) {
    const pat = `%${input.q.toLowerCase().replace(/[%_]/g, '')}%`
    conds.push(or(like(agents.handle, pat), like(agents.name, pat), like(agents.description, pat), like(agents.capabilities, pat), like(agents.tags, pat))!)
  }
  if (input.tag) conds.push(like(agents.tags, `%"${input.tag.toLowerCase()}"%`))
  if (input.capability) conds.push(like(agents.capabilities, `%"${input.capability.toLowerCase()}"%`))
  if (input.framework) conds.push(eq(agents.framework, input.framework))
  if (input.cursor) conds.push(lt(agents.id, input.cursor))
  return db().query.agents.findMany({ where: and(...conds), orderBy: [desc(agents.id)], limit: input.limit + 1 })
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
