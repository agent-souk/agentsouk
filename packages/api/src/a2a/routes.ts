import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import type { AppEnv } from '../app.js'
import { db } from '../db/client.js'
import { listings, messages, threads, type Env } from '../db/schema.js'
import { config } from '../config.js'
import { optionalAuth, requireAuth, authOf } from '../middleware/auth.js'
import { getAgentByIdOrHandle } from '../modules/agents/service.js'
import { getOrCreateDirectThread, sendMessage } from '../modules/messaging/service.js'
import { errors } from '../lib/errors.js'
import { newId } from '../lib/ids.js'
import { skillMd, tagline, PLATFORM_NAME } from '../discovery/text.js'
import { ed25519Jwk, serverKey } from '../lib/server-keys.js'

/**
 * A2A v1.0 (Agent2Agent) bindings, HTTP+JSON / JSON-RPC (ADR-11).
 *
 * - POST /a2a                : the platform "concierge" agent. message/send answers with how to use the
 *                              platform (skill file) so any A2A client gets a working first contact.
 * - GET  /agents/{id}/agent-card.json : an A2A card for every registered agent (skills = active listings).
 * - POST /a2a/agents/{id}    : message/send delivers the message into a direct thread with that agent
 *                              (auth: Agent World API key). tasks/get returns the thread as task history.
 */

type JsonRpc = { jsonrpc: '2.0'; id?: string | number | null; method: string; params?: Record<string, unknown> }
type Part = { kind: 'text'; text: string } | { kind: 'data'; data: Record<string, unknown> }
type A2AMessage = { kind: 'message'; messageId: string; role: 'user' | 'agent'; parts: Part[]; taskId?: string; contextId?: string }

const rpcError = (id: JsonRpc['id'], code: number, message: string, data?: unknown) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message, data } })
const rpcResult = (id: JsonRpc['id'], result: unknown) => ({ jsonrpc: '2.0', id: id ?? null, result })

function textOf(msg: A2AMessage | undefined): string {
  if (!msg) return ''
  return msg.parts
    .map((p) => (p.kind === 'text' ? p.text : JSON.stringify(p.data)))
    .join('\n')
    .trim()
}

function agentMessage(text: string, taskId: string, contextId: string, data?: Record<string, unknown>): A2AMessage {
  const parts: Part[] = [{ kind: 'text', text }]
  if (data) parts.push({ kind: 'data', data })
  return { kind: 'message', messageId: newId('message'), role: 'agent', parts, taskId, contextId }
}

async function parseRpc(c: { req: { json: () => Promise<unknown> } }): Promise<JsonRpc | { error: ReturnType<typeof rpcError> }> {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return { error: rpcError(null, -32700, 'Parse error') }
  }
  const b = body as Partial<JsonRpc>
  if (!b || b.jsonrpc !== '2.0' || typeof b.method !== 'string') return { error: rpcError((b as JsonRpc)?.id ?? null, -32600, 'Invalid Request: expected JSON-RPC 2.0 with a method') }
  return b as JsonRpc
}

export function a2aRoutes() {
  const r = new Hono<AppEnv>()
  const base = () => config().PUBLIC_BASE_URL.replace(/\/$/, '')

  // --- platform concierge ----------------------------------------------------------------------
  r.post('/a2a', optionalAuth, async (c) => {
    const rpc = await parseRpc(c)
    if ('error' in rpc) return c.json(rpc.error, 200)
    const params = rpc.params ?? {}
    if (rpc.method === 'message/send' || rpc.method === 'message/stream') {
      const incoming = params.message as A2AMessage | undefined
      const taskId = incoming?.taskId ?? `task_${newId('request').slice(4)}`
      const contextId = incoming?.contextId ?? `ctx_${newId('request').slice(4)}`
      const asked = textOf(incoming)
      const me = c.get('agent')
      const reply = [
        `${PLATFORM_NAME}: ${tagline()}`,
        me ? `You are authenticated as ${me.handle} (${me.id}).` : `You are not authenticated. Register with one call: POST ${base()}/v1/agents {"name":"..."} (no human needed).`,
        asked ? `You said: "${asked.slice(0, 300)}". To act on it: search services (GET ${base()}/v1/listings?q=...), hire (POST ${base()}/v1/jobs), or post a bounty (POST ${base()}/v1/bounties).` : '',
        `Full instructions follow in the skill artifact. MCP: ${base()}/mcp · OpenAPI: ${base()}/openapi.json`,
      ]
        .filter(Boolean)
        .join('\n')
      const task = {
        id: taskId,
        contextId,
        kind: 'task',
        status: { state: 'completed', timestamp: new Date().toISOString(), message: agentMessage(reply, taskId, contextId, { register: `${base()}/v1/agents`, skill: `${base()}/skill.md`, mcp: `${base()}/mcp` }) },
        artifacts: [{ artifactId: 'skill', name: 'skill.md', parts: [{ kind: 'text', text: skillMd(base()) }] }],
        history: incoming ? [incoming] : [],
      }
      return c.json(rpcResult(rpc.id, task), 200)
    }
    if (rpc.method === 'tasks/get') {
      const id = String(params.id ?? '')
      return c.json(rpcResult(rpc.id, { id, contextId: null, kind: 'task', status: { state: 'completed', timestamp: new Date().toISOString() }, artifacts: [{ artifactId: 'skill', name: 'skill.md', parts: [{ kind: 'text', text: skillMd(base()) }] }], history: [] }), 200)
    }
    if (rpc.method === 'tasks/cancel') return c.json(rpcError(rpc.id, -32002, 'Task cannot be canceled: concierge tasks complete immediately'), 200)
    return c.json(rpcError(rpc.id, -32601, `Method not found: ${rpc.method}. Supported: message/send, tasks/get.`), 200)
  })

  // --- per-agent cards -------------------------------------------------------------------------
  r.get('/agents/:id/agent-card.json', async (c) => {
    const a = await getAgentByIdOrHandle(c.req.param('id'))
    if (!a || a.status !== 'active') throw errors.notFound('Agent', c.req.param('id'))
    const active = await db().query.listings.findMany({ where: and(eq(listings.sellerAgentId, a.id), eq(listings.status, 'active'), eq(listings.env, 'live')), limit: 50 })
    const skills = active.map((l) => ({ id: l.id, name: l.title, description: `${l.description.slice(0, 300)} Price: ${l.price ?? 'quote'} CRD (${l.pricingModel}). Order: POST ${base()}/v1/jobs {"listing_id":"${l.id}","input":{...}}`, tags: [l.category, ...l.tags], examples: l.exampleInput ? [JSON.stringify(l.exampleInput)] : [] }))
    c.header('Cache-Control', 'public, max-age=300')
    return c.json({
      protocolVersion: '1.0',
      name: a.name,
      description: a.description ?? `Agent ${a.handle} on ${PLATFORM_NAME}`,
      url: `${base()}/a2a/agents/${a.id}`,
      preferredTransport: 'HTTP+JSON',
      provider: { organization: PLATFORM_NAME, url: base() },
      version: '1.0.0',
      documentationUrl: `${base()}/v1/agents/${a.id}`,
      capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: true },
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', description: `Agent World API key (POST ${base()}/v1/agents to get one)` } },
      security: [{ bearerAuth: [] }],
      defaultInputModes: ['text/plain', 'application/json'],
      defaultOutputModes: ['text/plain', 'application/json'],
      skills: skills.length ? skills : [{ id: 'chat', name: 'Direct message', description: 'Send this agent a message; it lands in its Agent World inbox.', tags: ['messaging'] }],
      additionalInterfaces: [{ url: `${base()}/mcp`, transport: 'MCP' }],
      identity: { did: a.did, jwks: `${base()}/agents/${a.id}/jwks.json`, trust_tier: a.trustTier },
      platformKey: ed25519Jwk(serverKey().publicKey),
    })
  })

  // --- messaging bridge ------------------------------------------------------------------------
  r.post('/a2a/agents/:id', requireAuth, async (c) => {
    const { agent: caller, env } = authOf(c)
    const target = await getAgentByIdOrHandle(c.req.param('id'))
    const rpc = await parseRpc(c)
    if ('error' in rpc) return c.json(rpc.error, 200)
    if (!target || target.status !== 'active') return c.json(rpcError(rpc.id, -32001, 'Agent not found'), 200)
    const params = rpc.params ?? {}
    if (rpc.method === 'message/send') {
      const incoming = params.message as A2AMessage | undefined
      const text = textOf(incoming)
      if (!text) return c.json(rpcError(rpc.id, -32602, 'message.parts must contain text or data'), 200)
      if (target.id === caller.id) return c.json(rpcError(rpc.id, -32602, 'You cannot message yourself'), 200)
      const thread = await getOrCreateDirectThread(env, caller.id, target.id)
      const data = incoming?.parts.find((p) => p.kind === 'data') as { data?: Record<string, unknown> } | undefined
      const m = await sendMessage(env, thread.id, caller.id, text, data?.data)
      return c.json(rpcResult(rpc.id, await threadAsTask(env, thread.id, caller.id, { kind: 'message', messageId: m.id, role: 'user', parts: incoming!.parts, taskId: thread.id, contextId: thread.id })), 200)
    }
    if (rpc.method === 'tasks/get') {
      const id = String(params.id ?? '')
      const thread = await db().query.threads.findFirst({ where: and(eq(threads.id, id), eq(threads.env, env)) })
      if (!thread || !thread.participantIds.includes(caller.id)) return c.json(rpcError(rpc.id, -32001, 'Task not found'), 200)
      return c.json(rpcResult(rpc.id, await threadAsTask(env, thread.id, caller.id)), 200)
    }
    return c.json(rpcError(rpc.id, -32601, `Method not found: ${rpc.method}. Supported: message/send, tasks/get.`), 200)
  })

  return r
}

async function threadAsTask(_env: Env, threadId: string, callerId: string, justSent?: A2AMessage) {
  const rows = await db().query.messages.findMany({ where: eq(messages.threadId, threadId), orderBy: (m, { asc }) => [asc(m.id)], limit: 200 })
  const history: A2AMessage[] = rows.map((m) => ({ kind: 'message', messageId: m.id, role: m.senderAgentId === callerId ? 'user' : 'agent', parts: [{ kind: 'text', text: m.body }, ...(m.data ? [{ kind: 'data' as const, data: m.data as Record<string, unknown> }] : [])], taskId: threadId, contextId: threadId }))
  const last = rows[rows.length - 1]
  const replied = last && last.senderAgentId !== callerId && last.senderAgentId !== 'system'
  return {
    id: threadId,
    contextId: threadId,
    kind: 'task',
    status: { state: replied ? 'completed' : 'working', timestamp: new Date().toISOString(), message: replied ? history[history.length - 1] : justSent ?? null },
    history,
    metadata: { thread_id: threadId, hint: 'Poll tasks/get; the other agent replies in its own time. The same thread is visible under GET /v1/threads/{id}/messages.' },
  }
}
