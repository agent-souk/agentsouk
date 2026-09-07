import ajv2020 from 'ajv/dist/2020.js'
import ajv2019 from 'ajv/dist/2019.js'
import ajvDraft7 from 'ajv'
import ajvFormats from 'ajv-formats'

/**
 * JSON Schema validation for listing promises (ADR-25, tier 0 of the dispute design): a seller who publishes an
 * output_schema is held to it mechanically. Draft is picked from $schema (default 2020-12; 04/06 run as draft-07).
 *
 * ajv ships CommonJS with `exports.default = Class`; under Node ESM the default import is module.exports, whose
 * `.default` is the class (same trick as packages/agents).
 */
const Ajv2020 = ajv2020.default
const Ajv2019 = ajv2019.default
const AjvDraft7 = ajvDraft7.default
const addFormats = ajvFormats.default

type Draft = 'draft-07' | '2019-09' | '2020-12'

function draftOf(schema: Record<string, unknown>): Draft {
  const s = typeof schema.$schema === 'string' ? schema.$schema : ''
  if (!s || s.includes('2020-12')) return '2020-12'
  if (s.includes('2019-09')) return '2019-09'
  return 'draft-07'
}

const validators = new Map<Draft, InstanceType<typeof AjvDraft7>>()
function validator(draft: Draft) {
  let ajv = validators.get(draft)
  if (!ajv) {
    const opts = { allErrors: true, strict: false, allowUnionTypes: true, validateFormats: true }
    ajv = draft === '2020-12' ? new Ajv2020(opts) : draft === '2019-09' ? new Ajv2019(opts) : new AjvDraft7(opts)
    addFormats(ajv)
    validators.set(draft, ajv)
  }
  return ajv
}

export type SchemaCheck =
  /** the value satisfies the schema */
  | { result: 'pass'; errors: [] }
  /** the value violates the schema; errors are "<json pointer>: <message>" */
  | { result: 'fail'; errors: string[] }
  /** the schema itself could not be compiled (the seller's mistake, not the buyer's); never blocks anything */
  | { result: 'invalid_schema'; errors: string[] }

const MAX_ERRORS = 20

/** Validates `value` against a JSON Schema. Schemas are compiled per call (no cache: listings change) but keep ajv instances warm. */
export function checkAgainstSchema(schema: Record<string, unknown>, value: unknown): SchemaCheck {
  const ajv = validator(draftOf(schema))
  let check: ReturnType<typeof ajv.compile>
  try {
    check = ajv.compile(schema)
  } catch (e) {
    return { result: 'invalid_schema', errors: [(e as Error).message.slice(0, 500)] }
  }
  const ok = check(value) as boolean
  if (ok) return { result: 'pass', errors: [] }
  const errors = (check.errors ?? []).slice(0, MAX_ERRORS).map((e) => `${e.instancePath || '/'}: ${e.message ?? e.keyword}`)
  return { result: 'fail', errors }
}

/** True when the value looks like a usable JSON Schema object (non-empty plain object). */
export function isSchemaObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length > 0
}
