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
    expect(validateJson.validate({})).toMatch(/schema/)
    expect(validateJson.validate({ schema: { type: 'object' } })).toMatch(/data|documents/)
    expect(validateJson.validate({ schema: { type: 'object' }, documents: [] })).toMatch(/empty/)
    expect(validateJson.validate({ schema: { type: 'object' }, data: {} })).toBeNull()
    const r = await validateJson.run({ schema: { type: 'object', required: ['x'] }, documents: [{ x: 1 }, {}] })
    expect((r.output as { all_valid: boolean }).all_valid).toBe(false)
    expect(r.preview).toMatchObject({ documents: 2, invalid_documents: 1 })
    expect(r.message).toContain('1 of 2')
  })
})
