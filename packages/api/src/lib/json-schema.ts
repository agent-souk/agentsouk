import { Worker } from 'node:worker_threads'
import { checkValues, type SchemaAnswer, type SchemaCheck, type SchemaJob } from './schema-worker.js'

export type { SchemaCheck }

/**
 * JSON Schema validation for listing promises (ADR-25, tier 0 of the dispute design): a seller who publishes an
 * output_schema is held to it mechanically. Draft is picked from $schema (default 2020-12; 04/06 run as draft-07).
 *
 * Two doors, and which one a caller uses is a security decision (ADR-80):
 *  - checkAgainstSchema: synchronous, on this thread. ONLY for schemas Agent Souk wrote itself (the x402 endpoint sells
 *    first-party listings only). A schema from anyone else can hold this thread - the one that serves every request -
 *    for as long as its `pattern` likes.
 *  - checkAgainstSchemaIsolated: the same check in a worker thread with a heap limit and a hard stop. Every schema a
 *    seller wrote goes through here: listing create and update, deliveries, disputes.
 */
export function checkAgainstSchema(schema: Record<string, unknown>, value: unknown): SchemaCheck {
  return checkValues(schema, [value])[0]!
}

/** How long a foreign schema check may run, and how much heap it gets, before it is stopped and called unverifiable. */
export const SCHEMA_CHECK_TIMEOUT_MS = 2_000
// The API machine has 512 MB (fly.toml): two checks of at most 64 MB heap each leave the process its room.
const SCHEMA_CHECK_HEAP_MB = 64
/** At most this many checks run at once; the rest wait their turn instead of starting threads without end. */
const MAX_PARALLEL = 2

const workerUrl = new URL(import.meta.url.endsWith('.ts') ? './schema-worker.ts' : './schema-worker.js', import.meta.url)
let running = 0
const waiting: (() => void)[] = []
async function slot(): Promise<() => void> {
  if (running >= MAX_PARALLEL) await new Promise<void>((resolve) => waiting.push(resolve))
  running++
  return () => {
    running--
    waiting.shift()?.()
  }
}

export async function checkAgainstSchemaIsolated(schema: Record<string, unknown>, value: unknown, timeoutMs = SCHEMA_CHECK_TIMEOUT_MS): Promise<SchemaCheck> {
  const release = await slot()
  try {
    return await new Promise<SchemaCheck>((resolve) => {
      let settled = false
      const unverifiable = (why: string): SchemaCheck => ({ result: 'unverifiable', errors: [why] })
      const job: SchemaJob = { __schemaCheck: true, schema, values: [value] }
      let worker: Worker
      try {
        worker = new Worker(workerUrl, { workerData: job, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: SCHEMA_CHECK_HEAP_MB, maxYoungGenerationSizeMb: 16 } })
      } catch (e) {
        // the value or schema could not even be handed over (not cloneable): nothing we can hold anyone to
        resolve(unverifiable(`the schema check could not start: ${String((e as Error)?.message ?? e).slice(0, 200)}`))
        return
      }
      const finish = (r: SchemaCheck) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        void worker.terminate().catch(() => undefined)
        resolve(r)
      }
      const timer = setTimeout(() => finish(unverifiable(`the schema check did not finish within ${timeoutMs / 1000} s (a pattern this expensive cannot be enforced)`)), timeoutMs)
      worker.once('message', (m: SchemaAnswer) => finish(m.ok ? m.results[0]! : { result: 'invalid_schema', errors: [m.message] }))
      worker.once('error', (e: Error & { code?: string }) =>
        finish(unverifiable(e.code === 'ERR_WORKER_OUT_OF_MEMORY' ? `the schema check ran out of its ${SCHEMA_CHECK_HEAP_MB} MB` : `the schema check failed: ${String(e.message).slice(0, 200)}`)),
      )
      worker.once('exit', (code) => finish(unverifiable(`the schema check stopped before it answered (exit ${code})`)))
    })
  } finally {
    release()
  }
}

/** True when the value looks like a usable JSON Schema object (non-empty plain object). */
export function isSchemaObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length > 0
}

const MAX_PLACEHOLDER_DEPTH = 4

function placeholderFor(name: string, schema: unknown, depth: number): unknown {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return `<${name}>`
  const sc = schema as Record<string, unknown>
  if (Array.isArray(sc.examples) && sc.examples.length) return sc.examples[0]
  if (sc.default !== undefined) return sc.default
  if (sc.const !== undefined) return sc.const
  if (Array.isArray(sc.enum) && sc.enum.length) return sc.enum[0]
  const t = Array.isArray(sc.type) ? String(sc.type[0]) : typeof sc.type === 'string' ? sc.type : sc.properties ? 'object' : sc.items ? 'array' : 'string'
  if (t === 'string') {
    const f = typeof sc.format === 'string' ? sc.format : ''
    if (f === 'uri' || f === 'url') return 'https://example.com/'
    if (f === 'email') return 'agent@example.com'
    if (f === 'date-time') return '2026-01-01T00:00:00Z'
    if (f === 'date') return '2026-01-01'
    return `<${name}${typeof sc.description === 'string' ? `: ${sc.description.slice(0, 60)}` : ''}>`
  }
  if (t === 'integer' || t === 'number') return typeof sc.minimum === 'number' ? sc.minimum : typeof sc.exclusiveMinimum === 'number' ? sc.exclusiveMinimum + 1 : 0
  if (t === 'boolean') return false
  if (t === 'null') return null
  if (t === 'array') return depth < MAX_PLACEHOLDER_DEPTH && sc.items && typeof sc.items === 'object' && !Array.isArray(sc.items) ? [placeholderFor(name, sc.items, depth + 1)] : []
  if (t === 'object') return depth < MAX_PLACEHOLDER_DEPTH ? placeholderFromSchema(sc, depth + 1) : {}
  return `<${name}>`
}

/**
 * A JSON object that satisfies the REQUIRED properties of an object schema, built from examples/defaults/enums
 * where the schema has them and readable `<name>` placeholders otherwise. Used for ready-to-send order bodies so
 * a listing without example_input never advertises a body the API would reject (reported by the first outside
 * agent, 2026-09-08). Never throws; a non-object schema yields {}.
 */
export function placeholderFromSchema(schema: unknown, depth = 0): Record<string, unknown> {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return {}
  const sc = schema as Record<string, unknown>
  const props = sc.properties && typeof sc.properties === 'object' && !Array.isArray(sc.properties) ? (sc.properties as Record<string, unknown>) : {}
  const required = Array.isArray(sc.required) ? (sc.required as unknown[]).filter((k): k is string => typeof k === 'string').slice(0, 50) : []
  const out: Record<string, unknown> = {}
  for (const k of required) out[k] = placeholderFor(k, props[k], depth)
  return out
}

/** The seller's example_input, completed with placeholders for every required field it leaves out. */
export function exampleInputFor(schema: unknown, example: unknown): Record<string, unknown> {
  const base = placeholderFromSchema(schema)
  if (example && typeof example === 'object' && !Array.isArray(example)) return { ...base, ...(example as Record<string, unknown>) }
  return base
}

