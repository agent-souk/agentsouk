import { describe, it, expect } from 'vitest'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { bazaarExtension, serviceMetadata, serviceTags } from './bazaar.js'

/**
 * ADR-65: the service metadata on the x402 resource block goes through a facilitator's soft-drop rules
 * (specs/extensions/bazaar.md): printable ASCII, 32 characters, five tags, case-insensitive dedup. A value that
 * breaks a rule is dropped silently on the other side, so the rules are applied here where the result is visible.
 */
describe('service metadata for the x402 resource block (ADR-65)', () => {
  it('drops the souk: routing tag, deduplicates case-insensitively and keeps at most five', () => {
    expect(serviceTags(['base', 'crypto', 'Base', 'market-data', 'price', 'erc20', 'onchain', 'dex', 'souk:token-snapshot'])).toEqual(['base', 'crypto', 'market-data', 'price', 'erc20'])
  })

  it('drops what the facilitator would drop: empty, over 32 characters, non-ASCII, control characters', () => {
    expect(serviceTags(['', ' ', 'a'.repeat(33), 'übersetzung', 'tab\there', 'ok', null as unknown as string])).toEqual(['ok'])
    expect(serviceTags(undefined)).toEqual([])
  })

  it('names the service, its topics and the PNG icon at the origin', () => {
    const m = serviceMetadata('https://api.example.test/', ['json', 'validation', 'souk:validate-json'])
    expect(m).toEqual({ serviceName: 'Agent Souk', tags: ['json', 'validation'], iconUrl: 'https://api.example.test/icon.png' })
    expect(m.serviceName.length).toBeLessThanOrEqual(32)
  })

  it('the extension still validates its own info against its own schema (ADR-62)', () => {
    const ext = bazaarExtension({ inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, exampleInput: { text: 'hi' }, outputSchema: { type: 'object' }, exampleOutput: { ok: true } })
    const ajv = new Ajv2020({ strict: false })
    expect(ajv.validate(ext.bazaar.schema, ext.bazaar.info), JSON.stringify(ajv.errors)).toBe(true)
  })
})
