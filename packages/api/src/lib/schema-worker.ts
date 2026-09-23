/**
 * The JSON Schema check itself, and the thread that runs it for schemas somebody else wrote (ADR-80).
 *
 * A seller writes a listing's input_schema and output_schema AND the text they are run on - its own example_input when
 * the listing is created, its own delivery when that is checked against output_schema. A `pattern` like `^(a+)+$`
 * holds V8's backtracking engine for hours; a linear engine (RE2, tried first) trades that for seconds and hundreds
 * of megabytes per pattern (review of ADR-80: 12 short patterns over 480 KB took the process down). No engine gives a
 * hard bound, a thread does: the check runs here with a heap limit and is terminated from outside when it overruns.
 *
 * Self-contained on purpose - nothing but Ajv and the thread API, no relative import - so the file also runs as a .ts
 * under Node's type stripping in the tests (the same arrangement as packages/agents/src/services/pdf-worker.ts).
 * A fresh Ajv per check: no compiled schema outlives its check, so nothing leaks, and a schema's `$id` (even the
 * meta-schema's own URI) cannot collide with anything that came before it.
 */
import { parentPort, workerData } from 'node:worker_threads'
import ajv2020 from 'ajv/dist/2020.js'
import ajv2019 from 'ajv/dist/2019.js'
import ajvDraft7 from 'ajv'
import ajvFormats from 'ajv-formats'

// ajv ships CommonJS with `exports.default = Class`; under Node ESM the default import is module.exports.
const Ajv2020 = ajv2020.default
const Ajv2019 = ajv2019.default
const AjvDraft7 = ajvDraft7.default
const addFormats = ajvFormats.default

export type SchemaCheck =
  /** the value satisfies the schema */
  | { result: 'pass'; errors: [] }
  /** the value violates the schema; errors are "<json pointer>: <message>" */
  | { result: 'fail'; errors: string[] }
  /** the schema itself could not be compiled (the seller's mistake, not the buyer's); never blocks anything */
  | { result: 'invalid_schema'; errors: string[] }
  /** the check ran out of its time or memory budget (ADR-80): the schema is too expensive to hold anyone to */
  | { result: 'unverifiable'; errors: string[] }

const MAX_ERRORS = 20

function draftOf(schema: Record<string, unknown>): 'draft-07' | '2019-09' | '2020-12' {
  const s = typeof schema.$schema === 'string' ? schema.$schema : ''
  if (!s || s.includes('2020-12')) return '2020-12'
  if (s.includes('2019-09')) return '2019-09'
  return 'draft-07'
}

/** Checks each value against one schema with a fresh Ajv. Synchronous: call it directly only for schemas we wrote. */
export function checkValues(schema: Record<string, unknown>, values: unknown[]): SchemaCheck[] {
  const draft = draftOf(schema)
  const opts = { allErrors: true, strict: false, allowUnionTypes: true, validateFormats: true }
  const ajv = draft === '2020-12' ? new Ajv2020(opts) : draft === '2019-09' ? new Ajv2019(opts) : new AjvDraft7(opts)
  addFormats(ajv)
  let check: ReturnType<typeof ajv.compile>
  try {
    check = ajv.compile(schema)
  } catch (e) {
    return values.map(() => ({ result: 'invalid_schema' as const, errors: [(e as Error).message.slice(0, 500)] }))
  }
  return values.map((value): SchemaCheck => {
    if (check(value)) return { result: 'pass', errors: [] }
    // ADR-79: name the field. Ajv's own text for the two most common mistakes - an unknown key and a missing one -
    // says only THAT something is wrong ("must NOT have additional properties"), and a buyer that cannot see WHICH
    // key is meant has to guess its way to a valid order. The offending name is in `params`; it belongs in the text.
    const errors = (check.errors ?? []).slice(0, MAX_ERRORS).map((e) => {
      const p = (e.params ?? {}) as { additionalProperty?: string; missingProperty?: string; allowedValues?: unknown[] }
      const extra = p.additionalProperty
        ? ` ("${p.additionalProperty}")`
        : p.missingProperty
          ? ` ("${p.missingProperty}")`
          : Array.isArray(p.allowedValues)
            ? ` (allowed: ${p.allowedValues.slice(0, 8).join(', ')})`
            : ''
      return `${e.instancePath || '/'}: ${e.message ?? e.keyword}${extra}`
    })
    return { result: 'fail', errors }
  })
}

/** What the parent hands over and gets back. */
export type SchemaJob = { __schemaCheck: true; schema: Record<string, unknown>; values: unknown[] }
export type SchemaAnswer = { ok: true; results: SchemaCheck[] } | { ok: false; message: string }

const job = workerData as SchemaJob | undefined
if (parentPort && job?.__schemaCheck) {
  let answer: SchemaAnswer
  try {
    answer = { ok: true, results: checkValues(job.schema, job.values) }
  } catch (e) {
    answer = { ok: false, message: String((e as Error)?.message ?? e).slice(0, 300) }
  }
  parentPort.postMessage(answer)
}
