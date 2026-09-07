import { fence, languageLabel, Llm, MODEL, UNTRUSTED_NOTE } from '../llm.js'
import { assertPublicUrl, UnsafeUrlError } from '../ssrf.js'
import { extract, type ExtractOptions } from './extract-web.js'
import type { ServiceDef } from './types.js'

export const UNIT_CHARS = 10_000
export const MAX_UNITS = 10
const STYLES = ['paragraph', 'bullets'] as const
const MIN_WORDS = 20
const MAX_WORDS = 600
const DEFAULT_WORDS = 150

const SYSTEM = `You write faithful, information-dense summaries inside an automated service. ${UNTRUSTED_NOTE}
Summarise only what the input says; never add outside knowledge, opinions or speculation. Keep names, numbers, dates and decisions exact. When the input is a web page, ignore navigation, cookie banners and boilerplate. Respect the word limit and the requested style. Write in the requested output language, or in the language of the input when none is requested.`

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'The summary itself: one paragraph, or bullet lines starting with "- " when bullets were requested' },
    key_points: { type: 'array', items: { type: 'string' }, description: '3 to 7 short, self-contained key points' },
    language: { type: 'string', description: 'Language of the summary as an ISO 639-1 code when one exists' },
  },
  required: ['summary', 'key_points', 'language'],
  additionalProperties: false,
}

export function unitsNeeded(chars: number): number {
  return Math.max(1, Math.ceil(chars / UNIT_CHARS))
}

export function summarize(llm: Llm, opts: ExtractOptions = {}): ServiceDef {
  return {
    key: 'summarize',
    listing: {
      title: 'Summarize a text or a web page (LLM, word limit, key points)',
      description:
        'Send {"text": "..."} or {"url": "https://..."} with optional max_words (20-600, default 150), style: paragraph|bullets, focus (a question or aspect to concentrate on) and language (output language, ISO code or name). You get a faithful summary, 3-7 key points and the detected language; a URL is fetched and read like the extract-web service (public pages only). Priced per 10,000 source characters: order units = ceil(characters / 10000), at most 10 units; a URL is read up to units × 10,000 characters. Powered by Claude (' +
        MODEL +
        '); the input is handled as data, never as instructions. Operated by Agent Souk (first_party).',
      category: 'language',
      tags: ['summary', 'summarization', 'tldr', 'reading', 'web', 'llm'],
      price: 40_000,
      pricing_model: 'per_unit',
      unit_name: '10,000 characters',
      input_schema: {
        type: 'object',
        properties: {
          text: { type: 'string', minLength: 1, maxLength: UNIT_CHARS * MAX_UNITS, description: 'The text to summarise (send text or url, not both)' },
          url: { type: 'string', format: 'uri', description: 'Public http(s) page to fetch and summarise' },
          max_words: { type: 'integer', minimum: MIN_WORDS, maximum: MAX_WORDS, default: DEFAULT_WORDS },
          style: { type: 'string', enum: [...STYLES], default: 'paragraph' },
          focus: { type: 'string', maxLength: 300, description: 'Optional question or aspect the summary should concentrate on' },
          language: { type: 'string', description: 'Output language (ISO code or name); default: language of the input' },
        },
      },
      output_schema: {
        type: 'object',
        required: ['summary', 'key_points', 'language', 'source'],
        properties: {
          summary: { type: 'string' },
          key_points: { type: 'array', items: { type: 'string' } },
          language: { type: 'string' },
          words: { type: 'integer' },
          source: { type: 'object', properties: { kind: { type: 'string', enum: ['text', 'url'] }, chars: { type: 'integer' }, url: { type: ['string', 'null'] }, final_url: { type: ['string', 'null'] }, title: { type: ['string', 'null'] }, clipped: { type: 'boolean' } } },
          model: { type: 'string' },
        },
      },
      example_input: { url: 'https://example.com/', max_words: 40, style: 'bullets' },
      example_output: { summary: '- example.com is a reserved domain for use in documentation.\n- It may be used in examples without prior permission.', key_points: ['Reserved domain for documentation examples', 'No permission needed'], language: 'en', words: 21, source: { kind: 'url', chars: 129, url: 'https://example.com/', final_url: 'https://example.com/', title: 'Example Domain', clipped: false }, model: MODEL },
      turnaround_seconds: 600,
      accept_timeout_seconds: 900,
      max_open_jobs: 10,
    },
    async validate(input, ctx) {
      const hasText = input.text !== undefined
      const hasUrl = input.url !== undefined
      if (hasText === hasUrl) return 'send exactly one of text or url'
      let chars: number
      if (hasText) {
        if (typeof input.text !== 'string' || !input.text.trim()) return 'text must be a non-empty string'
        if (input.text.length > UNIT_CHARS * MAX_UNITS) return `text is limited to ${UNIT_CHARS * MAX_UNITS} characters per job`
        chars = input.text.length
        const needed = unitsNeeded(chars)
        if (ctx.units < needed) return `order ${needed} units for ${chars} characters (1 unit = ${UNIT_CHARS} characters)`
      } else {
        if (typeof input.url !== 'string') return 'url must be a string'
        try {
          await assertPublicUrl(input.url)
        } catch (e) {
          return e instanceof UnsafeUrlError ? e.message : 'url is not a public http(s) address'
        }
        if (ctx.units > MAX_UNITS) return `at most ${MAX_UNITS} units per job`
        chars = ctx.units * UNIT_CHARS
      }
      const w = input.max_words
      if (w !== undefined && (!Number.isInteger(w) || (w as number) < MIN_WORDS || (w as number) > MAX_WORDS)) return `max_words must be an integer between ${MIN_WORDS} and ${MAX_WORDS}`
      if (input.style !== undefined && !STYLES.includes(input.style as (typeof STYLES)[number])) return `style must be one of ${STYLES.join(', ')}`
      if (input.focus !== undefined && (typeof input.focus !== 'string' || input.focus.length > 300)) return 'focus must be a string of at most 300 characters'
      if (input.language !== undefined && !languageLabel(input.language)) return 'language must be an ISO code or a language name'
      return llm.declineReason(Llm.estimateUsd(chars + 1500, maxTokensFor(Number(w ?? DEFAULT_WORDS))))
    },
    async run(input, ctx) {
      const maxWords = Number(input.max_words ?? DEFAULT_WORDS)
      const style = (input.style as (typeof STYLES)[number] | undefined) ?? 'paragraph'
      let source: { kind: 'text' | 'url'; chars: number; url: string | null; final_url: string | null; title: string | null; clipped: boolean }
      let text: string
      if (typeof input.text === 'string') {
        text = input.text
        source = { kind: 'text', chars: text.length, url: null, final_url: null, title: null, clipped: false }
      } else {
        const page = await extract(String(input.url), Math.min(MAX_UNITS, Math.max(1, ctx.units)) * UNIT_CHARS, opts)
        if (!page.text.trim()) throw new Error(`the page has no readable text (HTTP ${page.http_status}, ${page.content_type ?? 'unknown content type'})`)
        text = page.title ? `Title: ${page.title}\n\n${page.text}` : page.text
        source = { kind: 'url', chars: page.text_chars, url: String(input.url), final_url: page.final_url, title: page.title, clipped: page.clipped }
      }
      const lines = [`Summarise the input in at most ${maxWords} words, as ${style === 'bullets' ? 'bullet points (each line starting with "- ")' : 'one flowing paragraph'}.`]
      if (input.focus) lines.push(`Focus on: ${String(input.focus)}.`)
      if (input.language) lines.push(`Write the summary in ${languageLabel(input.language)}.`)
      const { data, completion } = await llm.completeJson<{ summary: string; key_points: string[]; language: string }>({
        system: SYSTEM,
        user: `${lines.join(' ')}\n\n${fence(text)}`,
        maxTokens: maxTokensFor(maxWords),
        effort: 'medium',
        jsonSchema: OUTPUT_SCHEMA,
      })
      const summary = typeof data.summary === 'string' ? data.summary.trim() : ''
      if (!summary) throw new Error('empty summary from the model')
      const words = summary.split(/\s+/).filter(Boolean).length
      const output = { summary, key_points: Array.isArray(data.key_points) ? data.key_points.slice(0, 7).map(String) : [], language: String(data.language ?? 'unknown'), words, source, model: completion.model }
      return {
        output,
        preview: { words, key_points: output.key_points.length, language: output.language, source, snippet: summary.slice(0, 120) },
        message: `Summarised ${source.chars} characters${source.title ? ` of "${source.title}"` : ''} in ${words} words.`,
      }
    },
  }
}

/** Output allowance: the summary plus key points and the JSON envelope. */
function maxTokensFor(maxWords: number): number {
  return Math.min(6000, maxWords * 3 + 700)
}
