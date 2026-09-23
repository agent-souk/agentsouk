import { describe, it, expect } from 'vitest'
import { checkAgainstSchema } from './json-schema.js'
import { freshApp, call, createTestAgent } from '../test/setup.js'

/**
 * ADR-80: sellers write the schemas this module runs, and the same seller writes the text they run on - its
 * example_input when the listing is created, its delivery when it is checked against output_schema. `^(a+)+$` over
 * 40 characters would hold V8's backtracking engine for hours on the one thread that serves every request.
 */
describe('checkAgainstSchema runs sellers\' patterns on RE2 (ADR-80)', () => {
  it('answers a catastrophic pattern at once, with the right verdict', () => {
    const schema = { type: 'object', properties: { s: { type: 'string', pattern: '^(a+)+$' } } }
    const t = Date.now()
    expect(checkAgainstSchema(schema, { s: 'a'.repeat(5000) + '!' }).result).toBe('fail')
    expect(checkAgainstSchema(schema, { s: 'a'.repeat(5000) }).result).toBe('pass')
    expect(Date.now() - t).toBeLessThan(1000)
  })

  it('keeps distinct patterns distinct inside one warm Ajv instance', () => {
    const schema = { type: 'object', properties: { zip: { type: 'string', pattern: '^\\d{5}$' }, code: { type: 'string', pattern: '^[A-Z]{3}$' } } }
    expect(checkAgainstSchema(schema, { zip: '12345', code: 'ABC' }).result).toBe('pass')
    const bad = checkAgainstSchema(schema, { zip: 'ABC', code: '12345' })
    expect(bad.result).toBe('fail')
    expect(bad.errors.map((e) => e.split(':')[0]).sort()).toEqual(['/code', '/zip'])
  })

  it('checks a schema with an $id the same way the second time (it used to become invalid_schema, which never blocks)', () => {
    const schema = () => ({ $id: 'https://example.com/invoice.json', type: 'object', required: ['total'] })
    expect(checkAgainstSchema(schema(), {}).result).toBe('fail')
    expect(checkAgainstSchema(schema(), {}).result).toBe('fail')
    expect(checkAgainstSchema(schema(), { total: 1 }).result).toBe('pass')
  })

  it('refuses a listing whose example fails its own catastrophic pattern without stopping the API', async () => {
    const app = await freshApp()
    const seller = await createTestAgent(app, { name: 'Pattern seller' })
    const t = Date.now()
    const r = await call(app, 'POST', '/v1/listings', {
      key: seller.api_keys.test,
      body: { title: 'Echo a string', description: 'Echoes a string back exactly as it was sent, for testing clients.', category: 'data', pricing_model: 'fixed', price: 10_000, input_schema: { type: 'object', properties: { s: { type: 'string', pattern: '^(a+)+$' } } }, example_input: { s: 'a'.repeat(40) + '!' }, turnaround_seconds: 600, accept_timeout_seconds: 600 },
    })
    expect(Date.now() - t).toBeLessThan(2000)
    expect(r.status).toBe(400)
    expect(r.body.error.param).toBe('example_input')
  })
})
