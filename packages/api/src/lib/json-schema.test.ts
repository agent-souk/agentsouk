import { describe, it, expect } from 'vitest'
import { checkAgainstSchema, checkAgainstSchemaIsolated } from './json-schema.js'
import { freshApp, call, createTestAgent } from '../test/setup.js'

/**
 * ADR-80: sellers write the schemas this module runs, and the same seller writes the text they run on - its
 * example_input when the listing is created, its delivery when it is checked against output_schema. A catastrophic
 * `pattern` must cost the API a bounded moment on another thread, never its one request thread.
 */
describe('schema checks for schemas somebody else wrote (ADR-80)', () => {
  // `^(a+)+$` over 40 characters would take V8 hours; the isolated check stops it at its budget
  const evil = { type: 'object', properties: { s: { type: 'string', pattern: '^(a+)+$' } } }

  it('stops a catastrophic pattern at its budget and calls it unverifiable, while this thread stays free', async () => {
    const t = Date.now()
    let ticks = 0
    const beat = setInterval(() => ticks++, 50)
    const r = await checkAgainstSchemaIsolated(evil, { s: 'a'.repeat(40) + '!' }, 1000)
    clearInterval(beat)
    expect(r.result).toBe('unverifiable')
    expect(Date.now() - t).toBeLessThan(5000)
    expect(ticks).toBeGreaterThan(5) // the event loop kept running during the check
  })

  it('gives the same verdicts as the in-thread check for ordinary schemas, with full ECMA-262 pattern syntax', async () => {
    const schema = { type: 'object', required: ['zip'], properties: { zip: { type: 'string', pattern: '^\\d{5}$' }, name: { type: 'string', pattern: '^\\p{Lu}\\p{Ll}+$' }, a: { type: 'string', pattern: '^\\u0041{1,2000}$' } } }
    for (const v of [{ zip: '12345', name: 'Ärger', a: 'AA' }, { zip: 'ABC', name: 'x', a: 'B' }, {}]) {
      expect(await checkAgainstSchemaIsolated(schema, v)).toEqual(checkAgainstSchema(schema, v))
    }
    expect((await checkAgainstSchemaIsolated(schema, { zip: 'ABC' })).errors[0]).toContain('/zip')
  })

  it('keeps no state between checks: an $id - even the meta-schema\'s own - cannot switch later checks off', async () => {
    const meta = { $id: 'https://json-schema.org/draft/2020-12/schema', type: 'object', required: ['x'] }
    await checkAgainstSchemaIsolated(meta, {})
    checkAgainstSchema(meta, {})
    const normal = { type: 'object', required: ['total'] }
    expect(checkAgainstSchema(normal, {}).result).toBe('fail')
    expect((await checkAgainstSchemaIsolated(normal, {})).result).toBe('fail')
    const withId = () => ({ $id: 'https://example.com/invoice.json', type: 'object', required: ['total'] })
    expect(checkAgainstSchema(withId(), {}).result).toBe('fail')
    expect(checkAgainstSchema(withId(), {}).result).toBe('fail')
    expect(checkAgainstSchema(withId(), { total: 1 }).result).toBe('pass')
  })

  it('refuses a listing whose schema cannot be checked against its own example in time, without stopping the API', async () => {
    const app = await freshApp()
    const seller = await createTestAgent(app, { name: 'Pattern seller' })
    const t = Date.now()
    const r = await call(app, 'POST', '/v1/listings', {
      key: seller.api_keys.test,
      body: { title: 'Echo a string', description: 'Echoes a string back exactly as it was sent, for testing clients.', category: 'data', pricing_model: 'fixed', price: 10_000, input_schema: evil, example_input: { s: 'a'.repeat(40) + '!' }, turnaround_seconds: 600, accept_timeout_seconds: 600 },
    })
    expect(Date.now() - t).toBeLessThan(8000)
    expect(r.status, JSON.stringify(r.body)).toBe(400)
    expect(r.body.error.param).toBe('input_schema')
    expect(r.body.error.message).toContain('could not be checked')
  })
})
