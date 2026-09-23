import { Worker } from 'node:worker_threads'
import type { ServiceDef } from './types.js'
import { validateWith, type SchemaAnswer, type SchemaJob, type Validation } from './schema-worker.js'

export type { ValidationResult } from './schema-worker.js'

/**
 * Validation on this thread, with a fresh Ajv. ONLY for schemas Agent Souk wrote itself (exploit-chain's own output
 * schema, the desk's bounty specs): a schema from a buyer or a seller goes through validateDocumentsIsolated, because
 * its `pattern` can hold this thread for as long as it likes (ADR-80).
 */
export function validateDocuments(schema: Record<string, unknown>, documents: unknown[]): Validation {
  return validateWith(schema, documents)
}

/** ADR-80: the budget of one isolated validation. Past it the thread is stopped and the schema is called too expensive. */
export const SCHEMA_TIMEOUT_MS = 5_000
// The agents machine has 512 MB and also runs the PDF worker: two checks of at most 96 MB heap each.
const SCHEMA_HEAP_MB = 96
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

/** The schema did not finish within its budget: the job is cancelled (nothing is charged), never answered wrongly. */
export class SchemaTooExpensive extends Error {}

/**
 * The same validation in a worker thread with a heap limit and a hard stop. Throws SchemaTooExpensive when the
 * schema overruns its time or memory - the caller cancels instead of delivering an answer it could not compute.
 */
export async function validateDocumentsIsolated(schema: Record<string, unknown>, documents: unknown[], timeoutMs = SCHEMA_TIMEOUT_MS): Promise<Validation> {
  const release = await slot()
  try {
    return await new Promise<Validation>((resolve, reject) => {
      let settled = false
      const job: SchemaJob = { __validate: true, schema, documents }
      let worker: Worker
      try {
        worker = new Worker(workerUrl, { workerData: job, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: SCHEMA_HEAP_MB, maxYoungGenerationSizeMb: 16 } })
      } catch (e) {
        reject(new SchemaTooExpensive(`the schema check could not start: ${String((e as Error)?.message ?? e).slice(0, 200)}`))
        return
      }
      const finish = (f: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        void worker.terminate().catch(() => undefined)
        f()
      }
      const timer = setTimeout(() => finish(() => reject(new SchemaTooExpensive(`validating against this schema did not finish within ${timeoutMs / 1000} s; a pattern that expensive is refused, and nothing is charged`))), timeoutMs)
      worker.once('message', (m: SchemaAnswer) => finish(() => (m.ok ? resolve(m.validation) : reject(new Error(`the schema check failed: ${m.message}`)))))
      worker.once('error', (e: Error & { code?: string }) =>
        finish(() => reject(new SchemaTooExpensive(e.code === 'ERR_WORKER_OUT_OF_MEMORY' ? `validating against this schema needed more than ${SCHEMA_HEAP_MB} MB; refused, and nothing is charged` : `the schema check failed: ${String(e.message).slice(0, 200)}`))),
      )
      worker.once('exit', (code) => finish(() => reject(new SchemaTooExpensive(`the schema check stopped before it answered (exit ${code})`))))
    })
  } finally {
    release()
  }
}

/**
 * ADR-80, third review round (R3-S1): compiling a schema somebody else wrote is itself unbounded work - a `$ref` tree
 * that doubles per level held this thread 7-12 s at 2 KB without a single pattern, and practically forever at the
 * 20 KB the services allow. So even the "does it compile" probe before accepting a job runs isolated. Returns the
 * reason to decline, or null.
 */
export async function foreignSchemaProblem(schema: Record<string, unknown>): Promise<string | null> {
  try {
    const r = await validateDocumentsIsolated(schema, [{}])
    return r.schema_error ? `schema does not compile: ${r.schema_error}` : null
  } catch (e) {
    return e instanceof SchemaTooExpensive ? `schema is too expensive to check: ${e.message}` : `schema could not be checked: ${(e as Error).message ?? String(e)}`
  }
}

const MAX_DOCS = 100
const MAX_BYTES = 512 * 1024

export const validateJson: ServiceDef = {
  key: 'validate-json',
  listing: {
    title: 'Validate JSON against a JSON Schema (draft-07, 2019-09, 2020-12)',
    description:
      'Send {"schema": <JSON Schema>, "data": <document>} or {"schema", "documents": [<doc>, ...]} (up to 100). You get, per document, valid: true|false and every violation with its JSON pointer path, keyword and message (formats like email, uri, date-time are checked). Deterministic, no LLM. Operated by Agent Souk (first_party).',
    category: 'data',
    tags: ['json', 'json-schema', 'validation', 'data-quality', 'deterministic'],
    price: 10_000,
    input_schema: {
      type: 'object',
      required: ['schema'],
      properties: { schema: { type: 'object', description: 'A JSON Schema object' }, data: { description: 'One document to validate' }, documents: { type: 'array', maxItems: MAX_DOCS, description: 'Several documents to validate' } },
    },
    output_schema: {
      type: 'object',
      properties: {
        draft: { type: 'string', enum: ['draft-07', '2019-09', '2020-12'] },
        schema_error: { type: ['string', 'null'] },
        all_valid: { type: 'boolean' },
        results: { type: 'array', items: { type: 'object', properties: { index: { type: 'integer' }, valid: { type: 'boolean' }, errors: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, keyword: { type: 'string' }, message: { type: 'string' } } } } } } },
      },
    },
    example_input: { schema: { type: 'object', required: ['email'], properties: { email: { type: 'string', format: 'email' } } }, data: { email: 'not-an-email' } },
    example_output: { draft: '2020-12', schema_error: null, all_valid: false, results: [{ index: 0, valid: false, errors: [{ path: '/email', keyword: 'format', message: 'must match format "email"', params: { format: 'email' } }] }] },
    turnaround_seconds: 120,
    accept_timeout_seconds: 600,
    max_open_jobs: 20,
  },
  validate(input) {
    const schema = input.schema
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return 'schema must be a JSON Schema object'
    const docs = 'documents' in input ? input.documents : 'data' in input ? [input.data] : undefined
    if (!Array.isArray(docs)) return 'send data (one document) or documents (an array of documents)'
    if (docs.length === 0) return 'documents is empty'
    if (docs.length > MAX_DOCS) return `at most ${MAX_DOCS} documents per job`
    if (JSON.stringify(input).length > MAX_BYTES) return `input larger than ${MAX_BYTES} bytes; split it into several jobs`
    return null
  },
  async run(input) {
    const schema = input.schema as Record<string, unknown>
    const docs = (Array.isArray(input.documents) ? input.documents : [input.data]) as unknown[]
    // ADR-80: the buyer's schema over the buyer's documents - in its own thread, with a time and heap budget
    const r = await validateDocumentsIsolated(schema, docs)
    const allValid = r.schema_error == null && r.results.every((x) => x.valid)
    const invalid = r.results.filter((x) => !x.valid).length
    return {
      output: { draft: r.draft, schema_error: r.schema_error, all_valid: allValid, results: r.results },
      preview: { draft: r.draft, documents: docs.length, all_valid: allValid, invalid_documents: invalid, schema_error: r.schema_error },
      message: r.schema_error ? `The schema itself does not compile: ${r.schema_error}` : allValid ? `All ${docs.length} document(s) are valid.` : `${invalid} of ${docs.length} document(s) have violations; see results.`,
    }
  },
}
