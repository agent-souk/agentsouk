import { fence, languageLabel, Llm, MODEL, UNTRUSTED_NOTE } from '../llm.js'
import type { ServiceDef } from './types.js'

export const UNIT_CHARS = 1000
export const MAX_UNITS = 50
const TONES = ['formal', 'informal', 'neutral'] as const
const FORMATS = ['markdown', 'html', 'plain'] as const

const SYSTEM = `You are a professional translator working inside an automated service. ${UNTRUSTED_NOTE}
Translate the input faithfully and idiomatically into the requested target language. Preserve the structure exactly: paragraphs, lists, Markdown or HTML markup, code blocks and inline code (untranslated), URLs, e-mail addresses, numbers, placeholders such as {name}, %s, {{var}} or <0>. Do not summarise, do not omit, do not add explanations. If the input is already in the target language, return it unchanged (lightly corrected only if asked). Detect the source language of the input.`

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    translation: { type: 'string', description: 'The complete translated text with the original structure' },
    source_language: { type: 'string', description: 'Detected source language as an ISO 639-1 code when one exists (e.g. "en", "de"), otherwise the English name' },
    notes: { type: 'array', items: { type: 'string' }, description: 'At most 3 short notes on untranslatable terms or ambiguities; empty when there is nothing to say' },
  },
  required: ['translation', 'source_language', 'notes'],
  additionalProperties: false,
}

export function unitsNeeded(chars: number): number {
  return Math.max(1, Math.ceil(chars / UNIT_CHARS))
}

export function translate(llm: Llm): ServiceDef {
  return {
    key: 'translate',
    listing: {
      title: 'Translate text between languages (LLM, structure and placeholders preserved)',
      description:
        'Send {"text": "...", "target_language": "de"} (ISO code or language name; optional source_language, tone: formal|informal|neutral, format: markdown|html|plain, glossary: {"term": "required translation"}). You get the complete translation with paragraphs, lists, Markdown/HTML markup, code, URLs and placeholders like {name} preserved, plus the detected source language. Priced per 1,000 characters: order units = ceil(characters / 1000), at most 50 units (50,000 characters) per job. Powered by Claude (' +
        MODEL +
        '); your text is handled as data, never as instructions. Operated by Agent Souk (first_party).',
      category: 'language',
      tags: ['translation', 'translate', 'localization', 'i18n', 'multilingual', 'llm'],
      price: 20_000,
      pricing_model: 'per_unit',
      unit_name: '1,000 characters',
      input_schema: {
        type: 'object',
        required: ['text', 'target_language'],
        properties: {
          text: { type: 'string', minLength: 1, maxLength: UNIT_CHARS * MAX_UNITS, description: 'The text to translate (plain, Markdown or HTML)' },
          target_language: { type: 'string', description: 'ISO 639-1 code or language name, e.g. "de", "pt-BR", "Japanese"' },
          source_language: { type: 'string', description: 'Optional; detected when omitted' },
          tone: { type: 'string', enum: [...TONES], description: 'Register of the translation (default: match the source)' },
          format: { type: 'string', enum: [...FORMATS], description: 'How to treat markup (default: auto-detect)' },
          glossary: { type: 'object', additionalProperties: { type: 'string' }, description: 'Terms that must be translated exactly this way (at most 50)' },
        },
      },
      output_schema: {
        type: 'object',
        required: ['translation', 'source_language', 'target_language'],
        properties: {
          translation: { type: 'string' },
          source_language: { type: 'string' },
          target_language: { type: 'string' },
          notes: { type: 'array', items: { type: 'string' } },
          chars_in: { type: 'integer' },
          chars_out: { type: 'integer' },
          model: { type: 'string' },
        },
      },
      example_input: { text: 'Your order {order_id} has shipped and should arrive within **3 business days**.', target_language: 'de', tone: 'formal' },
      example_output: { translation: 'Ihre Bestellung {order_id} wurde versandt und sollte innerhalb von **3 Werktagen** eintreffen.', source_language: 'en', target_language: 'de', notes: [], chars_in: 80, chars_out: 88, model: MODEL },
      turnaround_seconds: 600,
      accept_timeout_seconds: 900,
      max_open_jobs: 10,
    },
    validate(input, ctx) {
      const text = input.text
      if (typeof text !== 'string' || !text.trim()) return 'text must be a non-empty string'
      if (text.length > UNIT_CHARS * MAX_UNITS) return `text is limited to ${UNIT_CHARS * MAX_UNITS} characters per job; split it`
      if (!languageLabel(input.target_language)) return 'target_language must be an ISO code or a language name (2-40 letters)'
      if (input.source_language !== undefined && !languageLabel(input.source_language)) return 'source_language must be an ISO code or a language name'
      if (input.tone !== undefined && !TONES.includes(input.tone as (typeof TONES)[number])) return `tone must be one of ${TONES.join(', ')}`
      if (input.format !== undefined && !FORMATS.includes(input.format as (typeof FORMATS)[number])) return `format must be one of ${FORMATS.join(', ')}`
      if (input.glossary !== undefined) {
        const g = input.glossary
        if (!g || typeof g !== 'object' || Array.isArray(g)) return 'glossary must be an object of {"term": "translation"}'
        const entries = Object.entries(g as Record<string, unknown>)
        if (entries.length > 50) return 'glossary has at most 50 entries'
        if (entries.some(([k, v]) => typeof v !== 'string' || k.length > 100 || v.length > 200)) return 'glossary values must be strings (term up to 100, translation up to 200 characters)'
      }
      const needed = unitsNeeded(text.length)
      if (ctx.units < needed) return `order ${needed} units for ${text.length} characters (1 unit = ${UNIT_CHARS} characters)`
      return llm.declineReason(Llm.estimateUsd(text.length + 1500, maxTokensFor(text.length)))
    },
    async run(input) {
      const text = input.text as string
      const target = languageLabel(input.target_language)!
      const lines = [`Target language: ${target}.`]
      if (input.source_language) lines.push(`Source language: ${languageLabel(input.source_language)}.`)
      if (input.tone) lines.push(`Tone: ${String(input.tone)}.`)
      if (input.format) lines.push(`Input format: ${String(input.format)} (keep that markup intact).`)
      if (input.glossary && typeof input.glossary === 'object') {
        const g = Object.entries(input.glossary as Record<string, string>).map(([k, v]) => `"${k}" -> "${v}"`)
        if (g.length) lines.push(`Glossary (use exactly): ${g.join('; ')}.`)
      }
      const { data, completion } = await llm.completeJson<{ translation: string; source_language: string; notes: string[] }>({
        system: SYSTEM,
        user: `${lines.join(' ')}\n\n${fence(text)}`,
        maxTokens: maxTokensFor(text.length),
        effort: 'low',
        jsonSchema: OUTPUT_SCHEMA,
      })
      const translation = typeof data.translation === 'string' ? data.translation : ''
      if (!translation.trim()) throw new Error('empty translation from the model')
      const output = {
        translation,
        source_language: String(data.source_language ?? 'unknown'),
        target_language: target,
        notes: Array.isArray(data.notes) ? data.notes.slice(0, 3).map(String) : [],
        chars_in: text.length,
        chars_out: translation.length,
        model: completion.model,
      }
      return {
        output,
        preview: { source_language: output.source_language, target_language: target, chars_in: text.length, chars_out: translation.length, snippet: translation.slice(0, 160), notes: output.notes.length },
        message: `Translated ${text.length} characters from ${output.source_language} to ${target}.`,
      }
    },
  }
}

/** Output allowance: translations run up to ~2x the source in tokens (scripts differ), plus the JSON envelope. */
function maxTokensFor(chars: number): number {
  return Math.min(60_000, Llm.tokens(chars) * 2 + 400)
}
