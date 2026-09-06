import { and, asc, eq, gt, like, lt, sql, type SQL } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { agentMemory } from '../../db/schema.js'
import { errors } from '../../lib/errors.js'
import { registerSweep } from '../../lib/scheduler.js'

/**
 * Persistent key-value memory per agent (ADR-14 extra #7). Agents lose context between sessions;
 * this gives them a durable, private notebook: PUT /v1/memory/{key}, GET /v1/memory/{key}.
 */
export type MemoryRow = typeof agentMemory.$inferSelect
export const MAX_KEYS = 1000
export const MAX_VALUE_BYTES = 64 * 1024
export const KEY_RE = /^[A-Za-z0-9_.:/-]{1,128}$/

export function assertKey(key: string) {
  if (!KEY_RE.test(key)) throw errors.validation('key must be 1-128 chars of letters, digits, "_", ".", ":", "/" or "-".', 'key', 'Example keys: "notes/customer-42", "state:last_run", "prefs.language".')
}

export async function putMemory(agentId: string, key: string, value: unknown, ttlSeconds?: number): Promise<MemoryRow> {
  assertKey(key)
  if (value === undefined) throw errors.validation('value is required (any JSON).', 'value')
  const serialised = JSON.stringify(value)
  const size = serialised.length
  if (size > MAX_VALUE_BYTES) throw errors.validation(`value must be at most ${MAX_VALUE_BYTES} bytes when serialised (got ${size}).`, 'value', 'Split large state across several keys.')
  const now = Date.now()
  const existing = await db().query.agentMemory.findFirst({ where: and(eq(agentMemory.agentId, agentId), eq(agentMemory.key, key)) })
  if (!existing) {
    const count = await db().select({ n: sql<number>`count(*)` }).from(agentMemory).where(eq(agentMemory.agentId, agentId))
    if ((count[0]?.n ?? 0) >= MAX_KEYS) throw errors.state('memory_limit', `You already store ${MAX_KEYS} keys.`, 'Delete unused keys with DELETE /v1/memory/{key}, or use TTLs.')
  }
  const expiresAt = ttlSeconds ? now + ttlSeconds * 1000 : null
  await db()
    .insert(agentMemory)
    .values({ agentId, key, value, size, expiresAt, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: [agentMemory.agentId, agentMemory.key], set: { value, size, expiresAt, updatedAt: now } })
  return (await db().query.agentMemory.findFirst({ where: and(eq(agentMemory.agentId, agentId), eq(agentMemory.key, key)) }))!
}

export async function getMemory(agentId: string, key: string, now = Date.now()): Promise<MemoryRow> {
  assertKey(key)
  const row = await db().query.agentMemory.findFirst({ where: and(eq(agentMemory.agentId, agentId), eq(agentMemory.key, key)) })
  if (!row || (row.expiresAt && row.expiresAt <= now)) throw errors.notFound('Memory key', key, 'GET /v1/memory lists your keys.')
  return row
}

export async function deleteMemory(agentId: string, key: string): Promise<boolean> {
  assertKey(key)
  const r = await db().delete(agentMemory).where(and(eq(agentMemory.agentId, agentId), eq(agentMemory.key, key)))
  return (r.rowsAffected ?? 0) > 0
}

export async function listMemory(agentId: string, opts: { prefix?: string; limit: number; cursor?: string }, now = Date.now()): Promise<MemoryRow[]> {
  const conds: SQL[] = [eq(agentMemory.agentId, agentId), sql`(${agentMemory.expiresAt} is null or ${agentMemory.expiresAt} > ${now})`]
  if (opts.prefix) conds.push(like(agentMemory.key, `${opts.prefix.replace(/[%_]/g, (m) => `\\${m}`)}%`))
  if (opts.cursor) conds.push(gt(agentMemory.key, opts.cursor))
  return db().query.agentMemory.findMany({ where: and(...conds), orderBy: [asc(agentMemory.key)], limit: opts.limit + 1 })
}

export async function sweepMemory(now = Date.now()): Promise<number> {
  const r = await db().delete(agentMemory).where(and(sql`${agentMemory.expiresAt} is not null`, lt(agentMemory.expiresAt, now)))
  return r.rowsAffected ?? 0
}

registerSweep('memory', async (now) => {
  await sweepMemory(now)
})
