import { describe, it, expect } from 'vitest'
import { unitBasisSentence, unitsForInput, MAX_COMPUTED_UNITS, type UnitBasis } from './units.js'

const chars = (per: number, max?: number): UnitBasis => ({ rules: [{ field: 'text', measure: 'characters', per }], ...(max ? { max } : {}) })

describe('unitsForInput (ADR-77)', () => {
  it('counts the units the seller would require, not the one the buyer assumed', () => {
    // the four purchases of 2026-09-17, against the rule extract-structured actually enforces
    expect(unitsForInput(chars(1000), { text: 'x'.repeat(1122) })).toBe(2)
    expect(unitsForInput(chars(1000), { text: 'x'.repeat(1316) })).toBe(2)
    expect(unitsForInput(chars(1000), { text: 'x'.repeat(1529) })).toBe(2)
    expect(unitsForInput(chars(1000), { text: 'x'.repeat(2009) })).toBe(3)
    // and what the same texts cost under the unit they were bought at before ADR-72
    expect(unitsForInput(chars(10_000), { text: 'x'.repeat(2009) })).toBe(1)
  })

  it('never goes below one, whatever the input holds', () => {
    expect(unitsForInput(chars(1000), { text: '' })).toBe(1)
    expect(unitsForInput(chars(1000), {})).toBe(1)
    expect(unitsForInput(chars(1000), null)).toBe(1)
    expect(unitsForInput(chars(1000), { text: 42 })).toBe(1)
  })

  it('returns null when the listing publishes no rule, so the old behaviour stands', () => {
    expect(unitsForInput(null, { text: 'x'.repeat(5000) })).toBe(null)
    expect(unitsForInput(undefined, { text: 'x' })).toBe(null)
    expect(unitsForInput({ rules: [] }, { text: 'x'.repeat(5000) })).toBe(null)
  })

  it('takes the largest of several dimensions (summarize counts what it reads AND what it writes)', () => {
    const basis: UnitBasis = {
      rules: [
        { field: 'text', measure: 'characters', per: 5000 },
        { field: 'max_words', measure: 'value', per: 150, default: 150 },
      ],
      max: 20,
    }
    expect(unitsForInput(basis, { text: 'x'.repeat(4000) })).toBe(1)
    expect(unitsForInput(basis, { text: 'x'.repeat(4000), max_words: 600 })).toBe(4)
    expect(unitsForInput(basis, { text: 'x'.repeat(30_000), max_words: 150 })).toBe(6)
    // a url job has no text to measure: the rule for it is skipped, the default length decides
    expect(unitsForInput(basis, { url: 'https://example.com' })).toBe(1)
  })

  it('counts array items for a listing priced per item', () => {
    const basis: UnitBasis = { rules: [{ field: 'items', measure: 'items', per: 10 }], max: 10 }
    expect(unitsForInput(basis, { items: new Array(10).fill('a') })).toBe(1)
    expect(unitsForInput(basis, { items: new Array(11).fill('a') })).toBe(2)
    expect(unitsForInput(basis, { items: 'not an array' })).toBe(1)
  })

  it('caps at the declared maximum and at the hard ceiling, so no input can quote an absurd price', () => {
    expect(unitsForInput(chars(1000, 50), { text: 'x'.repeat(10_000_000) })).toBe(50)
    expect(unitsForInput(chars(1), { text: 'x'.repeat(10_000_000) })).toBe(MAX_COMPUTED_UNITS)
  })

  it('says the rule in one sentence for a buyer that reads prose', () => {
    expect(unitBasisSentence(chars(1000), '1,000 characters')).toContain('1 1,000 characters covers 1000 characters of text')
    expect(unitBasisSentence(null, '1,000 characters')).toBe(null)
  })
})
