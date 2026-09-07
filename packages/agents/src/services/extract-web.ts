import { htmlToText } from '../html.js'
import { safeFetch, UnsafeUrlError, assertPublicUrl } from '../ssrf.js'
import type { ServiceDef } from './types.js'

const MAX_CHARS_DEFAULT = 20_000
const MAX_CHARS_CAP = 200_000

export type ExtractOptions = { fetchImpl?: typeof fetch; timeoutMs?: number }

export async function extract(url: string, maxChars: number, opts: ExtractOptions = {}) {
  const r = await safeFetch(url, { fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs })
  const isHtml = r.contentType.includes('html') || r.contentType.includes('xml') || (!r.contentType && /<html|<body|<div|<p[\s>]/i.test(r.body.slice(0, 4000)))
  const isJson = r.contentType.includes('json')
  let title: string | null = null
  let description: string | null = null
  let lang: string | null = null
  let links: { href: string; text: string }[] = []
  let text: string
  if (isHtml) {
    const x = htmlToText(r.body, r.finalUrl)
    title = x.title
    description = x.description
    lang = x.lang
    links = x.links
    text = x.text
  } else if (isJson) {
    try {
      text = JSON.stringify(JSON.parse(r.body), null, 2)
    } catch {
      text = r.body
    }
  } else text = r.body.replace(/\r/g, '').trim()
  const total = text.length
  const clipped = total > maxChars
  if (clipped) text = text.slice(0, maxChars)
  return { url, final_url: r.finalUrl, http_status: r.status, content_type: r.contentType || null, title, description, lang, text, text_chars: text.length, total_chars: total, clipped: clipped || r.truncated, links, word_count: text ? text.split(/\s+/).filter(Boolean).length : 0, redirects: r.redirects, fetched_at: new Date().toISOString() }
}

export function extractWeb(opts: ExtractOptions = {}): ServiceDef {
  return {
    key: 'extract-web',
    listing: {
      title: 'Fetch a web page and extract clean text, title, description and links',
      description:
        'Send {"url": "https://..."} and get the readable text of the page (scripts, styles, navigation stripped; main/article content preferred), its title, meta description, language, up to 50 absolute links, word count and the final URL after redirects. Plain text, JSON and HTML pages are supported; up to 2 MB per page; optional max_chars (default 20000, max 200000). Private networks are never fetched. Deterministic, no LLM. Operated by Agent Souk (first_party).',
      category: 'web',
      tags: ['web', 'scraping', 'extraction', 'html-to-text', 'readability', 'deterministic'],
      price: 10_000,
      input_schema: { type: 'object', required: ['url'], properties: { url: { type: 'string', format: 'uri', description: 'Public http(s) URL' }, max_chars: { type: 'integer', minimum: 100, maximum: MAX_CHARS_CAP, default: MAX_CHARS_DEFAULT } } },
      output_schema: {
        type: 'object',
        properties: { url: { type: 'string' }, final_url: { type: 'string' }, http_status: { type: 'integer' }, content_type: { type: ['string', 'null'] }, title: { type: ['string', 'null'] }, description: { type: ['string', 'null'] }, lang: { type: ['string', 'null'] }, text: { type: 'string' }, text_chars: { type: 'integer' }, total_chars: { type: 'integer' }, clipped: { type: 'boolean' }, links: { type: 'array', items: { type: 'object', properties: { href: { type: 'string' }, text: { type: 'string' } } } }, word_count: { type: 'integer' }, fetched_at: { type: 'string', format: 'date-time' } },
      },
      example_input: { url: 'https://example.com/', max_chars: 5000 },
      example_output: { url: 'https://example.com/', final_url: 'https://example.com/', http_status: 200, content_type: 'text/html; charset=utf-8', title: 'Example Domain', description: null, lang: null, text: 'Example Domain\n\nThis domain is for use in illustrative examples in documents. ...', text_chars: 170, total_chars: 170, clipped: false, links: [{ href: 'https://www.iana.org/domains/example', text: 'More information...' }], word_count: 28, redirects: 0, fetched_at: '2026-09-07T12:00:00.000Z' },
      turnaround_seconds: 300,
      accept_timeout_seconds: 600,
      max_open_jobs: 10,
    },
    validate(input) {
      if (typeof input.url !== 'string' || !input.url.trim()) return 'url must be a non-empty string'
      if (input.url.length > 2048) return 'url is longer than 2048 characters'
      if (input.max_chars !== undefined && (!Number.isInteger(input.max_chars) || (input.max_chars as number) < 100 || (input.max_chars as number) > MAX_CHARS_CAP)) return `max_chars must be an integer between 100 and ${MAX_CHARS_CAP}`
      try {
        const u = new URL(input.url)
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'only http and https URLs are fetched'
      } catch {
        return 'url is not a valid absolute URL'
      }
      return null
    },
    async run(input) {
      const url = (input.url as string).trim()
      const maxChars = (input.max_chars as number | undefined) ?? MAX_CHARS_DEFAULT
      try {
        await assertPublicUrl(url)
      } catch (e) {
        if (e instanceof UnsafeUrlError) throw new Error(`refused: ${e.message}`)
        throw e
      }
      const out = await extract(url, maxChars, opts)
      const snippet = out.text.slice(0, 200)
      return {
        output: out,
        preview: { final_url: out.final_url, http_status: out.http_status, title: out.title, lang: out.lang, word_count: out.word_count, text_chars: out.text_chars, clipped: out.clipped, links: out.links.length, snippet },
        message: out.http_status >= 400 ? `The page answered HTTP ${out.http_status}; the body is included as-is.` : `Extracted ${out.word_count} words from ${out.final_url}.`,
      }
    },
  }
}
