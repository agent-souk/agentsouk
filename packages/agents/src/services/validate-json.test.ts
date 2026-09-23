import { describe, it, expect } from 'vitest'
import { validateDocuments, validateJson } from './validate-json.js'

describe('validateDocuments', () => {
  it('validates with formats and reports every error with a path', () => {
    const schema = { type: 'object', required: ['email', 'age'], properties: { email: { type: 'string', format: 'email' }, age: { type: 'integer', minimum: 0 } } }
    const r = validateDocuments(schema, [{ email: 'a@b.co', age: 3 }, { email: 'nope', age: -1 }, {}])
    expect(r.draft).toBe('2020-12')
    expect(r.schema_error).toBeNull()
    expect(r.results.map((x) => x.valid)).toEqual([true, false, false])
    expect(r.results[1].errors.map((e) => e.path).sort()).toEqual(['/age', '/email'])
    expect(r.results[2].errors.map((e) => e.keyword)).toEqual(['required', 'required'])
  })
  it('honours $schema for older drafts', () => {
    const d7 = validateDocuments({ $schema: 'http://json-schema.org/draft-07/schema#', type: 'array', items: { type: 'number' } }, [[1, 2], ['x']])
    expect(d7.draft).toBe('draft-07')
    expect(d7.results.map((x) => x.valid)).toEqual([true, false])
    const d19 = validateDocuments({ $schema: 'https://json-schema.org/draft/2019-09/schema', type: 'string' }, ['ok'])
    expect(d19.draft).toBe('2019-09')
    expect(d19.results[0].valid).toBe(true)
  })
  it('reports a schema that does not compile instead of throwing', () => {
    const r = validateDocuments({ type: 'object', properties: { a: { type: 'nonsense' } } }, [{}])
    expect(r.schema_error).toMatch(/type|schema/i)
    expect(r.results).toEqual([])
  })
})

describe('validateJson service', () => {
  it('declines bad input shapes and runs good ones', async () => {
    expect(await validateJson.validate({})).toMatch(/schema/)
    expect(await validateJson.validate({ schema: { type: 'object' } })).toMatch(/data|documents/)
    expect(await validateJson.validate({ schema: { type: 'object' }, documents: [] })).toMatch(/empty/)
    expect(await validateJson.validate({ schema: { type: 'object' }, data: {} })).toBeNull()
    const r = await validateJson.run({ schema: { type: 'object', required: ['x'] }, documents: [{ x: 1 }, {}] })
    expect((r.output as { all_valid: boolean }).all_valid).toBe(false)
    expect(r.preview).toMatchObject({ documents: 2, invalid_documents: 1 })
    expect(r.message).toContain('1 of 2')
  })
})

/** ADR-80: the buyer's `pattern` runs on RE2. `^(a+)+$` against 30 characters took 8.7 s in V8, and 40 would take hours. */
describe('validateDocuments against a pattern written to hang it (ADR-80)', () => {
  it('answers a catastrophic pattern at once, with the right verdict', () => {
    const schema = { type: 'object', properties: { s: { type: 'string', pattern: '^(a+)+$' } } }
    const t = Date.now()
    const r = validateDocuments(schema, [{ s: 'a'.repeat(5000) + '!' }, { s: 'a'.repeat(5000) }])
    expect(Date.now() - t).toBeLessThan(1000)
    expect(r.schema_error).toBeNull()
    expect(r.results.map((x) => x.valid)).toEqual([false, true])
  })

  it('runs patternProperties on the same engine', () => {
    const schema = { type: 'object', patternProperties: { '^(a|a)+$': { type: 'number' } } }
    const t = Date.now()
    const r = validateDocuments(schema, [{ ['a'.repeat(3000) + '!']: 'not a number' }])
    expect(Date.now() - t).toBeLessThan(1000)
    expect(r.results[0]!.valid).toBe(true) // the key does not match, so the string value is not checked
  })

  it('keeps ordinary patterns working, searched anywhere as JSON Schema says', () => {
    const schema = { type: 'object', properties: { zip: { type: 'string', pattern: '\\d{5}' }, id: { type: 'string', pattern: '^[A-Z]{3}-\\d+$' } } }
    const r = validateDocuments(schema, [{ zip: 'D-12345', id: 'ABC-42' }, { zip: '1234', id: 'abc-42' }])
    expect(r.results.map((x) => x.valid)).toEqual([true, false])
    expect(r.results[1]!.errors.map((e) => e.path).sort()).toEqual(['/id', '/zip'])
  })

  it('reads ECMA-262 pattern syntax the way JSON Schema writes it (unicode escapes, named groups)', () => {
    const schema = { type: 'object', properties: { a: { type: 'string', pattern: '^\\u0041+$' }, y: { type: 'string', pattern: '^(?<year>\\d{4})-' } } }
    const r = validateDocuments(schema, [{ a: 'AAA', y: '2026-09' }, { a: 'B', y: '26-09' }])
    expect(r.schema_error).toBeNull()
    expect(r.results.map((x) => x.valid)).toEqual([true, false])
  })

  it('reports a pattern RE2 cannot run (lookahead, backreference) as a schema that does not compile', () => {
    const r = validateDocuments({ type: 'string', pattern: '^(?=a)a$' }, ['a'])
    expect(r.schema_error).toBeTruthy()
    expect(r.results).toEqual([])
  })
})
