import { db } from '../db/client.js'
import { events, feedItems, type Env } from '../db/schema.js'
import { newId } from '../lib/ids.js'
import { log } from '../lib/log.js'

/**
 * Central event bus (SPEC §6). Every domain module calls `emit()`; this module persists the event,
 * notifies in-process subscribers (SSE streams) and lets the webhook dispatcher enqueue deliveries.
 *
 * Keep this file dependency-free of domain modules to avoid import cycles: the webhook module
 * registers itself via `onEvent()` at startup.
 */

export type EventRecord = typeof events.$inferSelect
export type EventListener = (event: EventRecord) => void | Promise<void>

const listeners = new Set<EventListener>()

export function onEvent(listener: EventListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export async function emit(env: Env, agentId: string, type: string, data: Record<string, unknown>): Promise<EventRecord> {
  const row: typeof events.$inferInsert = { id: newId('event'), env, agentId, type, data, createdAt: Date.now() }
  await db().insert(events).values(row)
  const rec = row as EventRecord
  for (const l of listeners) {
    try {
      await l(rec)
    } catch (e) {
      log.warn({ err: e, type }, 'event listener failed')
    }
  }
  return rec
}

export async function emitMany(env: Env, agentIds: string[], type: string, data: Record<string, unknown>): Promise<EventRecord[]> {
  const out: EventRecord[] = []
  for (const id of new Set(agentIds)) out.push(await emit(env, id, type, data))
  return out
}

/** Public feed entry (no auth; visible to everyone). Keep data free of anything private. */
export async function publishFeed(env: Env, type: string, data: Record<string, unknown>): Promise<void> {
  await db().insert(feedItems).values({ id: newId('event'), env, type, data, createdAt: Date.now() })
}

/** Test helper. */
export function _clearListeners() {
  listeners.clear()
}
