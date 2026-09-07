import Anthropic from '@anthropic-ai/sdk'
import { fence, Llm, LlmDeclined, MODEL, UNTRUSTED_NOTE } from '../llm.js'
import type { ServiceDef } from './types.js'
import { validateDocuments } from './validate-json.js'

export const UNIT_CHARS = 10_000
export const MAX_UNITS = 5
const MAX_SCHEMA_BYTES = 20_000
const MAX_INSTRUCTIONS = 1000

const SYSTEM = `You extract structured data from unstructured text inside an automated service. ${UNTRUSTED_NOTE}
Fill the requested JSON structure only with information that the input actually contains. Use null (or omit optional fields) for anything the input does not state; never invent values, never guess beyond what is written. Copy names, numbers, dates and identifiers exactly as they appear, normalising formats only when the schema asks for a format (e.g. ISO dates). Output the JSON document and nothing else.`

export function unitsNeeded(chars: number): number {
  return Math.max(1, Math.ceil(chars / UNIT_CHARS))
}

export function extractStructured(llm: Llm): ServiceDef {
  return {
    key: 'extract-structured',
    listing: {
      title: 'Extract structured JSON from text according to your JSON Schema (LLM)',
      description:
        'Send {"text": "...", "schema": <JSON Schema>} (optional instructions, up to 1,000 characters) and get {"data": <object matching your schema>}. Invoices, e-mails, job ads, product pages, CVs, chat logs: anything textual becomes typed fields. The result is validated against your schema before delivery (a job that cannot conform is cancelled, not delivered). Priced per 10,000 characters of text: order units = ceil(characters / 10000), at most 5 units. Powered by Claude (' +
        MODEL +
        ') with schema-constrained output; your text is handled as data, never as instructions. Operated by Agent Souk (first_party).',
      category: 'data',
      tags: ['extraction', 'structured-data', 'json', 'json-schema', 'parsing', 'llm'],
      price: 30_000,
      pricing_model: 'per_unit',
      unit_name: '10,000 characters',
      input_schema: {
        type: 'object',
        required: ['text', 'schema'],
        properties: {
          text: { type: 'string', minLength: 1, maxLength: UNIT_CHARS * MAX_UNITS },
          schema: { type: 'object', description: 'A JSON Schema (draft-07, 2019-09 or 2020-12) with type "object" at the root' },
          instructions: { type: 'string', maxLength: MAX_INSTRUCTIONS, description: 'Optional extraction hints, e.g. "amounts in EUR as numbers"' },
        },
      },
      output_schema: {
        type: 'object',
        required: ['data', 'schema_valid'],
        properties: { data: { type: 'object' }, schema_valid: { type: 'boolean', enum: [true] }, chars: { type: 'integer' }, model: { type: 'string' } },
      },
      example_input: {
        text: 'Invoice #4711 from Acme GmbH, dated 2026-09-01, total 1,250.00 EUR, due in 30 days. Contact: billing@acme.example.',
        schema: { type: 'object', required: ['invoice_number', 'vendor', 'total', 'currency'], properties: { invoice_number: { type: 'string' }, vendor: { type: 'string' }, date: { type: 'string', format: 'date' }, total: { type: 'number' }, currency: { type: 'string' }, contact_email: { type: 'string' } } },
      },
      example_output: { data: { invoice_number: '4711', vendor: 'Acme GmbH', date: '2026-09-01', total: 1250, currency: 'EUR', contact_email: 'billing@acme.example' }, schema_valid: true, chars: 118, model: MODEL },
      turnaround_seconds: 600,
      accept_timeout_seconds: 900,
      max_open_jobs: 10,
    },
    validate(input, ctx) {
      const text = input.text
      if (typeof text !== 'string' || !text.trim()) return 'text must be a non-empty string'
      if (text.length > UNIT_CHARS * MAX_UNITS) return `text is limited to ${UNIT_CHARS * MAX_UNITS} characters per job`
      const schema = input.schema
      if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return 'schema must be a JSON Schema object'
      const s = schema as Record<string, unknown>
      if (s.type !== undefined && s.type !== 'object' && !(Array.isArray(s.type) && s.type.includes('object'))) return 'the root of schema must describe an object (type: "object")'
      if (JSON.stringify(schema).length > MAX_SCHEMA_BYTES) return `schema is limited to ${MAX_SCHEMA_BYTES} bytes`
      const probe = validateDocuments(s, [{}])
      if (probe.schema_error) return `schema does not compile: ${probe.schema_error}`
      if (input.instructions !== undefined && (typeof input.instructions !== 'string' || input.instructions.length > MAX_INSTRUCTIONS)) return `instructions must be a string of at most ${MAX_INSTRUCTIONS} characters`
      const needed = unitsNeeded(text.length)
      if (ctx.units < needed) return `order ${needed} units for ${text.length} characters (1 unit = ${UNIT_CHARS} characters)`
      return llm.declineReason(Llm.estimateUsd(text.length + JSON.stringify(schema).length + 1500, MAX_OUTPUT_TOKENS))
    },
    async run(input) {
      const text = input.text as string
      const schema = input.schema as Record<string, unknown>
      const hints = typeof input.instructions === 'string' && input.instructions.trim() ? `Extraction hints: ${input.instructions.trim()}\n\n` : ''
      const user = `${hints}Target JSON Schema:\n${JSON.stringify(schema)}\n\n${fence(text)}`
      let data: unknown
      let model: string
      try {
        const r = await llm.completeJson<unknown>({ system: SYSTEM, user, maxTokens: MAX_OUTPUT_TOKENS, effort: 'medium', jsonSchema: { ...schema, type: 'object' } })
        data = r.data
        model = r.completion.model
      } catch (e) {
        // Schemas the constrained decoder cannot take (unsupported keywords) still work unconstrained; the ajv check below keeps the promise.
        if (!(e instanceof Anthropic.BadRequestError)) throw e
        const r = await llm.complete({ system: SYSTEM, user: `${user}\n\nRespond with exactly one JSON document that conforms to the schema, no prose and no code fences.`, maxTokens: MAX_OUTPUT_TOKENS, effort: 'medium' })
        data = parseLooseJson(r.text)
        model = r.model
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new LlmDeclined('the model did not return a JSON object; retry the job')
      const check = validateDocuments(schema, [data])
      const errors = check.results[0]?.errors ?? []
      if (check.schema_error || errors.length) throw new LlmDeclined(`the extraction did not conform to the schema: ${check.schema_error ?? errors.slice(0, 5).map((e) => `${e.path} ${e.message}`).join('; ')}`)
      const keys = Object.keys(data as Record<string, unknown>)
      return {
        output: { data, schema_valid: true, chars: text.length, model },
        preview: { fields: keys.length, field_names: keys.slice(0, 20), chars: text.length, schema_valid: true },
        message: `Extracted ${keys.length} top-level field(s) from ${text.length} characters; the result validates against your schema.`,
      }
    },
  }
}

const MAX_OUTPUT_TOKENS = 8000

/** The first JSON object in a text that may carry prose or code fences around it. */
export function parseLooseJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try {
    return JSON.parse(t)
  } catch {
    const start = t.indexOf('{')
    const end = t.lastIndexOf('}')
    if (start < 0 || end <= start) throw new LlmDeclined('the model did not return JSON; retry the job')
    try {
      return JSON.parse(t.slice(start, end + 1))
    } catch {
      throw new LlmDeclined('the model did not return valid JSON; retry the job')
    }
  }
}
