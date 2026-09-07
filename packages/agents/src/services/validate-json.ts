import ajv2020 from 'ajv/dist/2020.js'
import ajv2019 from 'ajv/dist/2019.js'
import ajvDraft7 from 'ajv'
import ajvFormats from 'ajv-formats'
import type { ServiceDef } from './types.js'

// ajv ships CommonJS with `exports.default = Class`; under Node ESM the default import is module.exports, whose
// `.default` is the class. Going through `.default` is what both the runtime and TypeScript (NodeNext) agree on.
const Ajv2020 = ajv2020.default
const Ajv2019 = ajv2019.default
const AjvDraft7 = ajvDraft7.default
const addFormats = ajvFormats.default

type Draft = 'draft-07' | '2019-09' | '2020-12'

/** Pick the validator from $schema; no $schema means the current draft (2020-12). Older drafts (04/06) run as draft-07. */
function draftOf(schema: Record<string, unknown>): Draft {
  const s = typeof schema.$schema === 'string' ? schema.$schema : ''
  if (!s || s.includes('2020-12')) return '2020-12'
  if (s.includes('2019-09')) return '2019-09'
  return 'draft-07'
}

function validator(draft: Draft) {
  const opts = { allErrors: true, strict: false, allowUnionTypes: true, validateFormats: true }
  const ajv = draft === '2020-12' ? new Ajv2020(opts) : draft === '2019-09' ? new Ajv2019(opts) : new AjvDraft7(opts)
  addFormats(ajv)
  return ajv
}

export type ValidationResult = { index: number; valid: boolean; errors: { path: string; keyword: string; message: string; params: unknown }[] }

export function validateDocuments(schema: Record<string, unknown>, documents: unknown[]): { draft: Draft; results: ValidationResult[]; schema_error: string | null } {
  const draft = draftOf(schema)
  const ajv = validator(draft)
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
    const r = validateDocuments(schema, docs)
    const allValid = r.schema_error == null && r.results.every((x) => x.valid)
    const invalid = r.results.filter((x) => !x.valid).length
    return {
      output: { draft: r.draft, schema_error: r.schema_error, all_valid: allValid, results: r.results },
      preview: { draft: r.draft, documents: docs.length, all_valid: allValid, invalid_documents: invalid, schema_error: r.schema_error },
      message: r.schema_error ? `The schema itself does not compile: ${r.schema_error}` : allValid ? `All ${docs.length} document(s) are valid.` : `${invalid} of ${docs.length} document(s) have violations; see results.`,
    }
  },
}
