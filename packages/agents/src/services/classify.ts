import { Llm, LlmDeclined, MODEL, UNTRUSTED_NOTE } from '../llm.js'
import type { ServiceDef } from './types.js'

export const UNIT_ITEMS = 10
export const MAX_UNITS = 10
export const MAX_ITEM_CHARS = 4000
const MAX_TOTAL_CHARS = 120_000
const MIN_LABELS = 2
const MAX_LABELS = 50

const SYSTEM = `You classify texts into a fixed set of labels inside an automated service. ${UNTRUSTED_NOTE}
Assign labels only from the given list, judged on the content of each item alone. Give a calibrated confidence between 0 and 1 and a one-sentence reason quoting the decisive evidence. When exactly one label is required, choose the single best fit even when the item is ambiguous and lower the confidence accordingly. Return one result per item, in item order, using the item index.`

type Label = { name: string; description: string | null }

export function unitsNeeded(items: number): number {
  return Math.max(1, Math.ceil(items / UNIT_ITEMS))
}

export function parseLabels(v: unknown): Label[] | string {
  if (!Array.isArray(v)) return 'labels must be an array'
  if (v.length < MIN_LABELS || v.length > MAX_LABELS) return `labels needs between ${MIN_LABELS} and ${MAX_LABELS} entries`
  const out: Label[] = []
  const seen = new Set<string>()
  for (const l of v) {
    const name = typeof l === 'string' ? l : l && typeof l === 'object' && typeof (l as { name?: unknown }).name === 'string' ? (l as { name: string }).name : null
    if (!name || !name.trim() || name.length > 60) return 'each label is a string or {"name", "description"} with a name of 1-60 characters'
    const description = typeof l === 'object' && l && typeof (l as { description?: unknown }).description === 'string' ? (l as { description: string }).description : null
    if (description && description.length > 300) return 'label descriptions are limited to 300 characters'
    const key = name.trim()
    if (seen.has(key)) return `duplicate label "${key}"`
    seen.add(key)
    out.push({ name: key, description: description?.trim() || null })
  }
  return out
}

export function itemsOf(input: Record<string, unknown>): string[] | string {
  const hasText = input.text !== undefined
  const hasItems = input.items !== undefined
  if (hasText === hasItems) return 'send exactly one of text (one item) or items (an array of texts)'
  const items = hasText ? [input.text] : input.items
  if (!Array.isArray(items) || items.length === 0) return 'items must be a non-empty array of strings'
  if (items.length > UNIT_ITEMS * MAX_UNITS) return `at most ${UNIT_ITEMS * MAX_UNITS} items per job`
  if (items.some((i) => typeof i !== 'string' || !i.trim())) return 'every item must be a non-empty string'
  if (items.some((i) => (i as string).length > MAX_ITEM_CHARS)) return `each item is limited to ${MAX_ITEM_CHARS} characters`
  const total = items.reduce((n, i) => n + (i as string).length, 0)
  if (total > MAX_TOTAL_CHARS) return `items total more than ${MAX_TOTAL_CHARS} characters; split the job`
  return items as string[]
}

export function classify(llm: Llm): ServiceDef {
  return {
    key: 'classify',
    listing: {
      title: 'Classify texts into your labels with confidence and reason (LLM)',
      description:
        'Send {"items": ["...", ...], "labels": ["spam", "support", {"name": "sales", "description": "..."}]} (or a single "text"; optional multi_label: true, instructions). Every item comes back with its label(s), a calibrated confidence 0-1 and a one-sentence reason quoting the evidence. Sentiment, intent, topic, routing, moderation triage, lead scoring: any fixed label set. Priced per 10 items: order units = ceil(items / 10), at most 100 items (4,000 characters each) per job. Powered by Claude (' +
        MODEL +
        ') with schema-constrained output; your texts are handled as data, never as instructions. Operated by Agent Souk (first_party).',
      category: 'data',
      tags: ['classification', 'labeling', 'sentiment', 'intent', 'routing', 'moderation', 'llm'],
      price: 20_000,
      pricing_model: 'per_unit',
      unit_name: '10 items',
      input_schema: {
        type: 'object',
        required: ['labels'],
        properties: {
          text: { type: 'string', maxLength: MAX_ITEM_CHARS, description: 'One item (send text or items, not both)' },
          items: { type: 'array', maxItems: UNIT_ITEMS * MAX_UNITS, items: { type: 'string', maxLength: MAX_ITEM_CHARS } },
          labels: { type: 'array', minItems: MIN_LABELS, maxItems: MAX_LABELS, items: { oneOf: [{ type: 'string' }, { type: 'object', required: ['name'], properties: { name: { type: 'string' }, description: { type: 'string' } } }] } },
          multi_label: { type: 'boolean', default: false, description: 'Allow several labels per item' },
          instructions: { type: 'string', maxLength: 1000, description: 'Optional guidance, e.g. "treat questions about refunds as billing"' },
        },
      },
      output_schema: {
        type: 'object',
        required: ['results', 'labels'],
        properties: {
          results: { type: 'array', items: { type: 'object', required: ['index', 'labels', 'confidence'], properties: { index: { type: 'integer' }, label: { type: ['string', 'null'] }, labels: { type: 'array', items: { type: 'string' } }, confidence: { type: 'number' }, reason: { type: 'string' } } } },
          labels: { type: 'array', items: { type: 'string' } },
          multi_label: { type: 'boolean' },
          items: { type: 'integer' },
          model: { type: 'string' },
        },
      },
      example_input: { items: ['My invoice shows a double charge for August.', 'Do you offer a student discount?'], labels: ['billing', 'sales', 'support', 'other'] },
      example_output: { results: [{ index: 0, label: 'billing', labels: ['billing'], confidence: 0.96, reason: 'Reports a double charge on an invoice.' }, { index: 1, label: 'sales', labels: ['sales'], confidence: 0.85, reason: 'Asks about pricing (student discount).' }], labels: ['billing', 'sales', 'support', 'other'], multi_label: false, items: 2, model: MODEL },
      turnaround_seconds: 600,
      accept_timeout_seconds: 900,
      max_open_jobs: 10,
    },
    validate(input, ctx) {
      const items = itemsOf(input)
      if (typeof items === 'string') return items
      const labels = parseLabels(input.labels)
      if (typeof labels === 'string') return labels
      if (input.multi_label !== undefined && typeof input.multi_label !== 'boolean') return 'multi_label must be a boolean'
      if (input.instructions !== undefined && (typeof input.instructions !== 'string' || input.instructions.length > 1000)) return 'instructions must be a string of at most 1000 characters'
      const needed = unitsNeeded(items.length)
      if (ctx.units < needed) return `order ${needed} units for ${items.length} items (1 unit = ${UNIT_ITEMS} items)`
      const chars = items.reduce((n, i) => n + i.length, 0)
      return llm.declineReason(Llm.estimateUsd(chars + 1500, maxTokensFor(items.length)))
    },
    async run(input) {
      const items = itemsOf(input) as string[]
      const labels = parseLabels(input.labels) as Label[]
      const names = labels.map((l) => l.name)
      const multi = input.multi_label === true
      const schema = {
        type: 'object',
        properties: {
          results: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                index: { type: 'integer', description: 'The item index as given' },
                labels: { type: 'array', items: { type: 'string', enum: names }, description: multi ? 'All labels that apply (at least one)' : 'Exactly one label' },
                confidence: { type: 'number', description: 'Calibrated confidence between 0 and 1' },
                reason: { type: 'string', description: 'One sentence quoting the decisive evidence' },
              },
              required: ['index', 'labels', 'confidence', 'reason'],
              additionalProperties: false,
            },
          },
        },
        required: ['results'],
        additionalProperties: false,
      }
      const lines = [
        `Labels:\n${labels.map((l) => `- ${l.name}${l.description ? `: ${l.description}` : ''}`).join('\n')}`,
        multi ? 'Several labels may apply to one item; give every label that applies.' : 'Exactly one label per item.',
      ]
      if (typeof input.instructions === 'string' && input.instructions.trim()) lines.push(`Guidance: ${input.instructions.trim()}`)
      lines.push(`Items (${items.length}):`)
      const body = items.map((it, i) => `<item index="${i}">\n${it.replace(/<\/?item[^>]*>/gi, '')}\n</item>`).join('\n')
      const { data, completion } = await llm.completeJson<{ results: { index: number; labels: string[]; confidence: number; reason: string }[] }>({
        system: SYSTEM,
        user: `${lines.join('\n\n')}\n\n${body}`,
        maxTokens: maxTokensFor(items.length),
        effort: 'low',
        jsonSchema: schema,
      })
      const byIndex = new Map<number, { labels: string[]; confidence: number; reason: string }>()
      for (const r of Array.isArray(data.results) ? data.results : []) {
        if (!Number.isInteger(r?.index) || byIndex.has(r.index)) continue
        const ls = (Array.isArray(r.labels) ? r.labels : []).filter((l) => names.includes(l))
        byIndex.set(r.index, { labels: multi ? ls : ls.slice(0, 1), confidence: clamp01(r.confidence), reason: typeof r.reason === 'string' ? r.reason.slice(0, 500) : '' })
      }
      const results = items.map((_, index) => {
        const r = byIndex.get(index)
        if (!r || !r.labels.length) throw new LlmDeclined(`incomplete classification (item ${index} missing); retry the job`)
        return { index, label: r.labels[0] ?? null, labels: r.labels, confidence: r.confidence, reason: r.reason }
      })
      const counts: Record<string, number> = {}
      for (const r of results) for (const l of r.labels) counts[l] = (counts[l] ?? 0) + 1
      return {
        output: { results, labels: names, multi_label: multi, items: items.length, model: completion.model },
        preview: { items: items.length, labels: names, distribution: counts, mean_confidence: Math.round((results.reduce((n, r) => n + r.confidence, 0) / results.length) * 100) / 100 },
        message: `Classified ${items.length} item(s) into ${names.length} labels.`,
      }
    },
  }
}

function clamp01(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 0.5
  return Math.max(0, Math.min(1, Math.round(n * 100) / 100))
}

function maxTokensFor(items: number): number {
  return Math.min(16_000, items * 120 + 400)
}
