/**
 * The JSON Schema validation itself, and the thread that runs it for schemas a buyer or a seller wrote (ADR-80).
 *
 * validate-json runs the buyer's schema over the buyer's documents; extract-image runs it over model output the
 * buyer's image steers; the desk runs a seller's input_schema over an input its judge wrote from the seller's own
 * listing. A `pattern` like `^(a+)+$` holds V8's backtracking engine for hours on the one thread that serves all
 * thirteen services, and x402 bills only after a delivery that then never comes. A linear engine was tried first
 * (re2js): it trades the hang for seconds and hundreds of megabytes per pattern (review of ADR-80, 12 short patterns
 * over 480 KB took the process down). A thread with a heap limit and a hard stop bounds both, whatever the engine.
 *
 * Self-contained on purpose - nothing but Ajv and the thread API - so the file also runs as a .ts under Node's type
 * stripping in the tests (the same arrangement as pdf-worker.ts). A fresh Ajv per call: nothing outlives a check.
 */
import { parentPort, workerData } from 'node:worker_threads'
import ajv2020 from 'ajv/dist/2020.js'
import ajv2019 from 'ajv/dist/2019.js'
import ajvDraft7 from 'ajv'
import ajvFormats from 'ajv-formats'

// ajv ships CommonJS with `exports.default = Class`; under Node ESM the default import is module.exports, whose
// `.default` is the class. Going through `.default` is what both the runtime and TypeScript (NodeNext) agree on.
const Ajv2020 = ajv2020.default
const Ajv2019 = ajv2019.default
const AjvDraft7 = ajvDraft7.default
const addFormats = ajvFormats.default

export type Draft = 'draft-07' | '2019-09' | '2020-12'
export type ValidationResult = { index: number; valid: boolean; errors: { path: string; keyword: string; message: string; params: unknown }[] }
export type Validation = { draft: Draft; results: ValidationResult[]; schema_error: string | null }

/** Pick the validator from $schema; no $schema means the current draft (2020-12). Older drafts (04/06) run as draft-07. */
export function draftOf(schema: Record<string, unknown>): Draft {
  const s = typeof schema.$schema === 'string' ? schema.$schema : ''
  if (!s || s.includes('2020-12')) return '2020-12'
  if (s.includes('2019-09')) return '2019-09'
  return 'draft-07'
}

/** Validates each document with a fresh Ajv. Synchronous: call it directly only for schemas Agent Souk wrote. */
export function validateWith(schema: Record<string, unknown>, documents: unknown[]): Validation {
  const draft = draftOf(schema)
  const opts = { allErrors: true, strict: false, allowUnionTypes: true, validateFormats: true }
  const ajv = draft === '2020-12' ? new Ajv2020(opts) : draft === '2019-09' ? new Ajv2019(opts) : new AjvDraft7(opts)
  addFormats(ajv)
  let check: ReturnType<typeof ajv.compile>
  try {
    check = ajv.compile(schema)
  } catch (e) {
    return { draft, results: [], schema_error: (e as Error).message.slice(0, 500) }
  }
  const results = documents.map((doc, index) => {
    const valid = check(doc) as boolean
    const errors = (check.errors ?? []).slice(0, 100).map((e) => ({ path: e.instancePath || '/', keyword: e.keyword, message: e.message ?? '', params: e.params }))
    return { index, valid, errors }
  })
  return { draft, results, schema_error: null }
}

/** What the parent hands over and gets back. */
export type SchemaJob = { __validate: true; schema: Record<string, unknown>; documents: unknown[] }
export type SchemaAnswer = { ok: true; validation: Validation } | { ok: false; message: string }

const job = workerData as SchemaJob | undefined
if (parentPort && job?.__validate) {
  let answer: SchemaAnswer
  try {
    answer = { ok: true, validation: validateWith(job.schema, job.documents) }
  } catch (e) {
    answer = { ok: false, message: String((e as Error)?.message ?? e).slice(0, 300) }
  }
  parentPort.postMessage(answer)
}
