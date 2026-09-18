import { describe, it, expect } from 'vitest'
import { Llm } from '../llm.js'
import { allServices } from './index.js'
import type { ListingSpec, ServiceDef } from './types.js'

/**
 * ADR-77: the rule a service publishes and the rule its `validate` enforces are two copies of one fact, and a
 * disagreement between them is worse than publishing nothing: the platform would quote a price from the rule
 * and the seller would then decline the job it was paid for. That is precisely the shape of the failure this
 * ADR exists to remove, so it gets a test that measures the published rule AGAINST the running code.
 */

type Basis = NonNullable<ListingSpec['unit_basis']>

/** The platform's computation (modules/listings/units.ts), deliberately re-implemented here: if the two ever */
/** disagree, this test and the API's own unit test cannot both stay green. */
function unitsFor(basis: Basis, input: Record<string, unknown>): number {
  let units = 1
  for (const rule of basis.rules) {
    const raw = input[rule.field]
    let amount: number | null = rule.default ?? null
    if (rule.measure === 'characters' && typeof raw === 'string') amount = raw.length
    else if (rule.measure === 'items' && Array.isArray(raw)) amount = raw.length
    else if (rule.measure === 'value' && typeof raw === 'number') amount = raw
    if (amount == null || amount <= 0) continue
    units = Math.max(units, Math.ceil(amount / rule.per))
  }
  return Math.min(units, basis.max ?? units)
}

const llm = new Llm({ apiKey: 'test-key', dailyBudgetUsd: 5 })
const perUnit = allServices(llm).filter((s) => s.listing.pricing_model === 'per_unit')

/** Grows the field a rule measures to `size`, on top of the listing's own example input. */
function inputOfSize(s: ServiceDef, rule: Basis['rules'][number], size: number): Record<string, unknown> {
  const example = { ...((s.listing.example_input as Record<string, unknown>) ?? {}) }
  if (rule.measure === 'characters') example[rule.field] = 'x'.repeat(size)
  else if (rule.measure === 'items') example[rule.field] = new Array(size).fill('some text to classify')
  else example[rule.field] = size
  return example
}

describe('published unit rules match the code that enforces them (ADR-77)', () => {
  it('every per-unit service publishes one', () => {
    expect(perUnit.length).toBeGreaterThan(0)
    for (const s of perUnit) {
      expect(s.listing.unit_basis, `${s.key} prices per unit but publishes no unit_basis`).toBeTruthy()
      for (const rule of s.listing.unit_basis!.rules) {
        const props = (s.listing.input_schema as { properties?: Record<string, unknown> }).properties ?? {}
        expect(Object.keys(props), `${s.key}: rule measures "${rule.field}", which its input_schema does not have`).toContain(rule.field)
      }
    }
  })

  for (const s of perUnit) {
    const basis = s.listing.unit_basis!
    for (const rule of basis.rules) {
      if (rule.measure === 'value') continue // a length asked for, not a size sent: covered by the cases below
      it(`${s.key}: the units computed from "${rule.field}" are the units it accepts`, async () => {
        const sizes = rule.measure === 'items' ? [1, rule.per, rule.per + 1, rule.per * 3] : [1, rule.per - 1, rule.per, rule.per + 1, rule.per * 2, rule.per * 2 + 317]
        for (const size of sizes) {
          const input = inputOfSize(s, rule, size)
          const units = unitsFor(basis, input)
          const reason = await s.validate(input, { units })
          // the service may still decline for its own reasons (a budget, a schema); it must never decline
          // BECAUSE of the number of units, since that number came from the rule it published itself.
          expect(reason ?? '', `${s.key} at ${size} ${rule.measure} with ${units} unit(s): ${reason}`).not.toMatch(/unit/i)
        }
      })
    }
  }

  it('extract-structured would have taken the four purchases of 2026-09-17', async () => {
    const s = perUnit.find((x) => x.key === 'extract-structured')!
    for (const chars of [1122, 1316, 1529, 2009]) {
      const input = { text: 'x'.repeat(chars), schema: { type: 'object', properties: { title: { type: 'string' } } } }
      const units = unitsFor(s.listing.unit_basis!, input)
      expect(units, `${chars} characters`).toBe(Math.ceil(chars / 1000))
      expect(await s.validate(input, { units })).toBeNull()
      // and the old assumption - one unit, whatever the input - is exactly what it declines
      expect(await s.validate(input, { units: 1 })).toMatch(/order \d+ units/)
    }
  })
})
