import { describe, it, expect } from 'vitest'
import { SchemaTooExpensive, validateDocuments, validateDocumentsIsolated, validateJson } from './validate-json.js'

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

/**
 * ADR-80: the buyer's schema runs in its own thread with a time and heap budget. `^(a+)+$` against 30 characters took
 * 8.7 s on this process's one thread, and 40 would take hours; a linear engine (re2js) traded that for seconds and
 * hundreds of megabytes. Now the thread is stopped at its budget and the job is cancelled, so nothing is charged.
 */
describe('validate-json against a schema written to hang it (ADR-80)', () => {
  const evil = { type: 'object', properties: { s: { type: 'string', pattern: '^(a+)+$' } } }

  it('stops a catastrophic pattern at its budget while this thread keeps serving', async () => {
    let ticks = 0
    const beat = setInterval(() => ticks++, 50)
    const t = Date.now()
    await expect(validateDocumentsIsolated(evil, [{ s: 'a'.repeat(40) + '!' }], 1000)).rejects.toBeInstanceOf(SchemaTooExpensive)
    clearInterval(beat)
    expect(Date.now() - t).toBeLessThan(5000)
    expect(ticks).toBeGreaterThan(5)
  })

  it('cancels the job instead of answering: the service throws, and the runner cancels before any charge', async () => {
    await expect(validateJson.run({ schema: evil, data: { s: 'a'.repeat(40) + '!' } }, { units: 1 })).rejects.toBeInstanceOf(SchemaTooExpensive)
  })

  it('gives the same answer as the in-thread check for ordinary schemas, with full ECMA-262 patterns', async () => {
    const schema = { type: 'object', properties: { zip: { type: 'string', pattern: '\\d{5}' }, id: { type: 'string', pattern: '^[A-Z]{3}-\\d+$' }, a: { type: 'string', pattern: '^\\u0041{1,2000}$' }, n: { type: 'string', pattern: '^\\p{Lu}(?=\\p{Ll})' } } }
    const docs = [{ zip: 'D-12345', id: 'ABC-42', a: 'AA', n: 'Äb' }, { zip: '1234', id: 'abc-42', a: 'B', n: 'ab' }]
    const isolated = await validateDocumentsIsolated(schema, docs)
    expect(isolated).toEqual(validateDocuments(schema, docs))
    expect(isolated.results.map((x) => x.valid)).toEqual([true, false])
    expect(isolated.results[1]!.errors.map((e) => e.path).sort()).toEqual(['/a', '/id', '/n', '/zip'])
  })

  it('reports a schema that does not compile as schema_error, in the thread too', async () => {
    const r = await validateDocumentsIsolated({ type: 'object', properties: { a: { type: 'nonsense' } } }, [{}])
    expect(r.schema_error).toMatch(/type|schema/i)
  })
})
