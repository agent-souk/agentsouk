/**
 * ADR-77: what one input costs in units, computed by the platform from a rule the seller publishes.
 *
 * Why this exists. A per-unit listing sold over x402 had exactly one way to say how many units were being
 * bought: `?units=N` on the URL, default 1. The buyer's client has no way to know the rule - it is prose in the
 * listing description ("order units = ceil(characters / 1000)") - so every client that does not implement that
 * one sentence by hand orders a single unit. That was harmless while one unit was 10,000 characters and the
 * only paying stranger sent 550 on average. When ADR-72 made the unit 1,000 characters, the same requests
 * became under-ordered, and the seller declined all four purchases of the night of 2026-09-17 with
 * "order 2 units for 1316 characters". The buyer had done nothing wrong and had nothing to read that would
 * have told it otherwise; it has not come back since.
 *
 * So the rule moves out of the prose and into a field the machine can read, and the 402 - which is a quote the
 * buyer signs, not a charge - names the true total for the input that was actually sent. The seller stays the
 * authority for its own price: the rule is published by the seller, and the seller's own validation still has
 * the last word. This only closes the gap between "what the buyer could know" and "what the seller requires".
 */
import { z } from '@hono/zod-openapi'
import type { UnitBasis } from '../../db/schema-marketplace.js'

/** Hard ceiling, independent of what a listing declares: no input can quote more than this many units. */
export const MAX_COMPUTED_UNITS = 10_000

export const UnitRuleSchema = z
  .object({
    field: z.string().min(1).max(64).openapi({ description: 'Top-level field of the job input this rule measures.', example: 'text' }),
    measure: z.enum(['characters', 'items', 'value']).openapi({ description: 'characters = string length; items = array length; value = the number itself (e.g. max_words).' }),
    per: z.number().int().min(1).openapi({ description: 'How much of it one unit covers. 1,000 characters per unit = 1000.', example: 1000 }),
    default: z.number().min(0).optional().openapi({ description: 'What to measure when the field is absent or has the wrong type. Omit to skip the rule instead.' }),
  })
  .openapi('UnitRule')

export const UnitBasisSchema = z
  .object({
    rules: z.array(UnitRuleSchema).min(1).max(8).openapi({ description: 'Every rule is evaluated; the largest result wins (a job is as big as its biggest dimension).' }),
    max: z.number().int().min(1).max(MAX_COMPUTED_UNITS).optional().openapi({ description: 'Never quote more than this many units, whatever the input holds.' }),
    mode: z.enum(['minimum', 'exact']).optional().openapi({ description: 'minimum (default): a buyer may order more units than the input needs. exact: the seller declines anything but this number, so the quote is exactly it.' }),
  })
  .openapi('UnitBasis', {
    description:
      'How many units an input costs, in a form a buyer can evaluate before ordering (ADR-77). With it set, POST /v1/x402/{listing_id} quotes the units the sent input actually needs instead of assuming 1, and the how-to-order example carries the units its example_input needs.',
  })

export type UnitRule = UnitBasis['rules'][number]
export type { UnitBasis }

/** What one rule measures in this input, or null when it does not apply (absent field, wrong type, no default). */
function amountFor(rule: UnitRule, input: Record<string, unknown>): number | null {
  const raw = input[rule.field]
  const fallback = rule.default ?? null
  if (raw === undefined || raw === null) return fallback
  if (rule.measure === 'characters') return typeof raw === 'string' ? raw.length : fallback
  if (rule.measure === 'items') return Array.isArray(raw) ? raw.length : fallback
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback
}

/**
 * The units this input needs, or null when the listing publishes no rule (then the caller keeps its old
 * behaviour: what the buyer asked for, or one). Never less than 1, never more than the declared or hard cap.
 */
export function unitsForInput(basis: UnitBasis | null | undefined, input: Record<string, unknown> | null | undefined): number | null {
  if (!basis || !Array.isArray(basis.rules) || basis.rules.length === 0) return null
  const body = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  let units = 1
  for (const rule of basis.rules) {
    const amount = amountFor(rule, body)
    if (amount == null || !Number.isFinite(amount) || amount <= 0) continue
    units = Math.max(units, Math.ceil(amount / rule.per))
  }
  return Math.min(units, basis.max ?? MAX_COMPUTED_UNITS, MAX_COMPUTED_UNITS)
}

/**
 * One sentence a buyer can read in the 402 and in the listing: what the rule is. Kept short on purpose - it
 * sits next to a price, not in the documentation.
 */
export function unitBasisSentence(basis: UnitBasis | null | undefined, unitName: string | null | undefined): string | null {
  if (!basis?.rules?.length) return null
  const parts = basis.rules.map((r) => {
    const what = r.measure === 'characters' ? `characters of ${r.field}` : r.measure === 'items' ? `${r.field}` : `${r.field}`
    return `${r.per} ${what}`
  })
  const unit = unitName ? `1 ${unitName}` : '1 unit'
  return `${unit} covers ${parts.join(' or ')}; the units for your input are computed from it, so the 402 already names the full price.`
}
