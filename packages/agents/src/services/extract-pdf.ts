/**
 * extract-pdf (ADR-68): fetch a public PDF and hand back its text per page with the document info. Deterministic,
 * no model, no keys - the sibling of extract-web, which was the first thing both outside x402 buyers bought. pdf.js
 * reads the text layer in a thread of its own (pdf-worker.ts); a scanned PDF without a text layer yields empty pages,
 * and this says so instead of guessing.
 *
 * What the audit of the first draft changed (all in the ADR): the parse runs off the main thread with a heap limit and
 * a hard stop, one at a time; validate() fetches the whole file and opens it once, so an encrypted, corrupt, oversized
 * or non-PDF answer is declined before the job is accepted and never a failure on our record; the bytes are kept for
 * run(), which fetches nothing twice; a file that beats the limits after that is delivered with an `error` field,
 * not cancelled; the text is carried once (page offsets instead of a second copy) and the serialised output is kept
 * under the platform's cap.
 */
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { Worker } from 'node:worker_threads'
import { safeFetch, UnsafeUrlError, assertPublicUrl } from '../ssrf.js'
import type { Extraction, Probe, WorkerInput, WorkerOutput } from './pdf-worker.js'
import type { ServiceDef } from './types.js'

// Measured under plain node (probe, 2026-09-16): 83 pages of a 2.9 MB RFC peaked at 185 MB RSS in a bare process.
// One parse at a time in a thread capped at WORKER_HEAP_MB keeps the 512 MB machine safe next to the rest.
export const MAX_BYTES = 6 * 1024 * 1024
export const MAX_PAGES = 100
export const MAX_PAGE_NUMBER = 100_000
const MAX_CHARS_DEFAULT = 50_000
const MAX_CHARS_CAP = 200_000
export const PROBE_TIMEOUT_MS = 20_000
export const PARSE_TIMEOUT_MS = 60_000
export const WORKER_HEAP_MB = 192
/**
 * The heap limit above counts V8 objects only. pdf.js inflates a compressed stream into an ArrayBuffer, which is
 * external memory: a 612 KB file inflating to 600 MB took the whole process down while the worker's own limit said
 * nothing (audit round two). So the process watches its own RSS while a parse runs and stops the thread before the
 * host's limit does. The ceiling is read from the machine (`process.constrainedMemory()`), which is 0 outside a
 * container - then this is off, because there is no limit to stay under.
 */
export const MEMORY_CEILING_RATIO = 0.7
export const MEMORY_CHECK_MS = 100
/** the platform refuses outputs over 512 KB serialised; the text is cut until the whole document fits with room */
export const OUTPUT_BUDGET_BYTES = 450_000
const PENDING_TTL_MS = 3 * 60_000
const PENDING_MAX = 8
const USER_AGENT = 'agentsouk-extract-pdf/1.0 (+https://api.agentsouk.dev)'
const PAGES_SYNTAX = /^\d{1,6}(-\d{1,6})?(,\d{1,6}(-\d{1,6})?)*$/

export type ExtractPdfOptions = { fetchImpl?: typeof fetch; timeoutMs?: number; parseTimeoutMs?: number; probeTimeoutMs?: number; memoryCeilingBytes?: number | null }

/** "1-3,7" -> [1,2,3,7]; null for "all". Throws on nonsense (validate() reports it, run() never sees it). */
export function parsePageSelection(raw: unknown): number[] | null {
  if (raw === undefined || raw === null || raw === '') return null
  if (typeof raw !== 'string' || !PAGES_SYNTAX.test(raw.trim())) throw new Error('pages must look like "1-5" or "1,3,8-10"')
  const out = new Set<number>()
  for (const part of raw.trim().split(',')) {
    const [a, b] = part.split('-').map(Number)
    const from = a!
    const to = b ?? a!
    // bounded before any loop: a 17-digit page number once pinned the machine, because p++ past 2^53 never advances
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to > MAX_PAGE_NUMBER) throw new Error(`pages: page numbers must be between 1 and ${MAX_PAGE_NUMBER}`)
    if (to < from) throw new Error(`pages: "${part}" is not a valid page or range`)
    if (to - from + 1 > MAX_PAGES) throw new Error(`pages: at most ${MAX_PAGES} pages per job`)
    for (let p = from; p <= to; p++) out.add(p)
    if (out.size > MAX_PAGES) throw new Error(`pages: at most ${MAX_PAGES} pages per job`)
  }
  return [...out].sort((x, y) => x - y)
}

/** Why a parse did not produce text: the buyer's file (password, invalid) or this service's limits (time, memory). */
export class PdfParseError extends Error {
  constructor(message: string, readonly kind: 'password' | 'invalid' | 'limit' | 'service') {
    super(message)
    this.name = 'PdfParseError'
  }
}

// pdf.js needs its CMaps and standard fonts on disk for non-embedded CID fonts (East-Asian documents); without them
// such a page reads as empty. Forward slashes and the trailing slash are what pdf.js expects.
const pdfjsDir = (() => {
  try {
    return dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')).replace(/\\/g, '/')
  } catch {
    return null
  }
})()
const workerUrl = new URL(import.meta.url.endsWith('.ts') ? './pdf-worker.ts' : './pdf-worker.js', import.meta.url)

let queue: Promise<unknown> = Promise.resolve()

/** How much RSS one parse may take the process to, or null when the machine imposes no limit (a dev box). */
export function memoryCeilingBytes(constrained = process.constrainedMemory?.() ?? 0): number | null {
  return constrained > 0 ? Math.round(constrained * MEMORY_CEILING_RATIO) : null
}

/** One parse at a time (the machine is sized for one), each in a thread with its own heap and a hard stop. */
export function parseInWorker(input: WorkerInput, timeoutMs: number, ceilingBytes?: number | null): Promise<Probe | Extraction> {
  const run = queue.then(
    () =>
      new Promise<Probe | Extraction>((resolve, reject) => {
        // execArgv reset: the thread must not inherit flags of whatever started this process (a test runner, node -e)
        const worker = new Worker(workerUrl, { workerData: input, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB, maxYoungGenerationSizeMb: 32 } })
        let done = false
        const ceiling = ceilingBytes === undefined ? memoryCeilingBytes() : ceilingBytes
        const watchdog = ceiling
          ? setInterval(() => {
              if (process.memoryUsage.rss() > ceiling) finish(() => reject(new PdfParseError(`the PDF needs more memory than this service allows (${Math.round(ceiling / (1024 * 1024))} MB)`, 'limit')))
            }, MEMORY_CHECK_MS)
          : null
        watchdog?.unref?.()
        const finish = (fn: () => void) => {
          if (done) return
          done = true
          clearTimeout(timer)
          if (watchdog) clearInterval(watchdog)
          fn()
          void worker.terminate().catch(() => undefined)
        }
        const timer = setTimeout(() => finish(() => reject(new PdfParseError(`the PDF could not be parsed within ${Math.max(1, Math.round(timeoutMs / 1000))} s`, 'limit'))), timeoutMs)
        timer.unref?.()
        worker.once('message', (m: WorkerOutput) =>
          finish(() => {
            if (m.ok) resolve(m.result)
            else if (m.name === 'PasswordException') reject(new PdfParseError('the PDF is encrypted; this service does not open protected files', 'password'))
            else reject(new PdfParseError(`the PDF could not be read: ${m.message}`.slice(0, 300), 'invalid'))
          }),
        )
        worker.once('error', (e: Error & { code?: string }) =>
          finish(() => {
            if (e.code === 'ERR_WORKER_OUT_OF_MEMORY') reject(new PdfParseError(`the PDF needs more memory than this service allows (${WORKER_HEAP_MB} MB)`, 'limit'))
            // the thread could not even start (a missing file in the image, a package that no longer resolves): our
            // fault, never the buyer's - it must not be reported to a stranger as a broken PDF
            else if (e.code && /^(MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|ERR_WORKER_|ERR_UNSUPPORTED_)/.test(e.code)) reject(new PdfParseError(`the PDF service is temporarily unavailable (${e.code})`, 'service'))
            else reject(new PdfParseError(`the PDF could not be read: ${e.message}`.slice(0, 300), 'invalid'))
          }),
        )
        worker.once('exit', (code) => finish(() => reject(new PdfParseError(`the parser stopped before it answered (exit ${code})`, 'limit'))))
      }),
  )
  queue = run.catch(() => undefined)
  return run
}

/** The preview is capped at 4 KB by the platform, and a buyer's URL can be kilobytes long once percent-encoded. */
const short = (url: string) => (url.length > 300 ? `${url.slice(0, 297)}...` : url)
const isPdf = (bytes: Uint8Array) => bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d // %PDF-
const mediaType = (contentType: string) => contentType.split(';')[0]!.trim() || null

/** What validate() fetched and opened, kept for the run() that follows so nothing is fetched or opened twice. */
type Pending = { bytes: Uint8Array; finalUrl: string; status: number; contentType: string; probe: Probe; at: number }
const pending = new Map<string, Pending>()
function remember(url: string, p: Pending) {
  const now = Date.now()
  for (const [k, v] of pending) if (now - v.at > PENDING_TTL_MS) pending.delete(k)
  while (pending.size >= PENDING_MAX) pending.delete(pending.keys().next().value!)
  pending.set(url, p)
}
function take(url: string): Pending | null {
  const p = pending.get(url)
  pending.delete(url)
  return p && Date.now() - p.at <= PENDING_TTL_MS ? p : null
}

type Fetched = Omit<Pending, 'probe' | 'at'>
/** The file, or the reason to decline. */
async function fetchPdf(url: string, opts: ExtractPdfOptions): Promise<{ ok: true; file: Fetched } | { ok: false; reason: string }> {
  let r
  try {
    r = await safeFetch(url, { fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs ?? 30_000, maxBytes: MAX_BYTES, binary: true, accept: 'application/pdf,*/*;q=0.5', userAgent: USER_AGENT })
  } catch (e) {
    return { ok: false, reason: e instanceof UnsafeUrlError ? `refused: ${e.message}` : `the URL could not be fetched: ${(e as Error).message ?? String(e)}`.slice(0, 300) }
  }
  if (r.status >= 400) return { ok: false, reason: `the URL answered HTTP ${r.status}` }
  if (r.truncated) return { ok: false, reason: `the file is larger than ${MAX_BYTES / (1024 * 1024)} MB` }
  const bytes = r.bytes ?? new Uint8Array()
  if (!isPdf(bytes)) return { ok: false, reason: `the URL does not serve a PDF (content-type ${mediaType(r.contentType) ?? 'unknown'}, the file does not start with %PDF-)` }
  return { ok: true, file: { bytes, finalUrl: r.finalUrl, status: r.status, contentType: r.contentType } }
}

export type PdfOutput = {
  url: string
  final_url: string
  http_status: number
  content_type: string | null
  bytes: number
  pages_total: number
  pages_read: number
  pages: { page: number; start: number; chars: number }[]
  text: string
  text_chars: number
  total_chars: number | null
  clipped: boolean
  text_layer: boolean | null
  info: Probe['info']
  word_count: number
  error: string | null
  fetched_at: string
}

/** Cuts the text until the serialised document fits the platform's output cap; page offsets follow the cut. */
export function fitOutput(out: PdfOutput, budget = OUTPUT_BUDGET_BYTES): PdfOutput {
  let o = out
  for (let i = 0; i < 12 && JSON.stringify(o).length > budget && o.text.length > 100; i++) {
    const keep = Math.floor(o.text.length * 0.8)
    const text = o.text.slice(0, keep)
    const pages = o.pages.filter((p) => p.start < keep).map((p) => ({ ...p, chars: Math.min(p.chars, keep - p.start) }))
    o = { ...o, text, text_chars: text.length, pages, pages_read: pages.length, clipped: true, word_count: text.split(/\s+/).filter(Boolean).length }
  }
  return o
}

export function extractPdf(opts: ExtractPdfOptions = {}): ServiceDef {
  const probeTimeout = opts.probeTimeoutMs ?? PROBE_TIMEOUT_MS
  const parseTimeout = opts.parseTimeoutMs ?? PARSE_TIMEOUT_MS
  return {
    key: 'extract-pdf',
    listing: {
      title: 'Fetch a PDF and extract its text per page, with the document info',
      description:
        'Send {"url": "https://.../file.pdf"} and get the text of the pages (reading order as stored in the file, line breaks kept, pages separated by blank lines and located by offset), the page count, the document info (title, author, subject, creator, producer, creation and modification dates) and the final URL after redirects. Optional pages ("1-5" or "1,3,8-10") selects pages; optional max_chars (default 50000, max 200000) clips the text. Up to 6 MB and 100 pages per job (a longer document is read up to page 100 and marked clipped; use pages for the rest). Reads the text layer only: a scanned PDF without one returns empty pages, marked text_layer false (no OCR). Encrypted, corrupt, oversized and non-PDF files are declined before the job is accepted; a file that beats the parse limits after that (60 s, 192 MB) is delivered with an error field. Private networks are never fetched. Deterministic, no LLM. Operated by Agent Souk (first_party).',
      category: 'documents',
      tags: ['pdf', 'documents', 'extraction', 'text-extraction', 'parsing', 'deterministic'],
      price: 10_000,
      input_schema: {
        type: 'object',
        required: ['url'],
        properties: {
          url: { type: 'string', format: 'uri', description: 'Public http(s) URL of a PDF' },
          pages: { type: 'string', pattern: PAGES_SYNTAX.source, description: `Pages to extract, e.g. "1-5" or "1,3,8-10" (at most ${MAX_PAGES}); the first ${MAX_PAGES} by default` },
          max_chars: { type: 'integer', minimum: 100, maximum: MAX_CHARS_CAP, default: MAX_CHARS_DEFAULT },
        },
      },
      output_schema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          final_url: { type: 'string' },
          http_status: { type: 'integer' },
          content_type: { type: ['string', 'null'], description: 'media type as served, parameters dropped' },
          bytes: { type: 'integer' },
          pages_total: { type: 'integer' },
          pages_read: { type: 'integer' },
          pages: { type: 'array', description: 'where each read page sits in text', items: { type: 'object', properties: { page: { type: 'integer' }, start: { type: 'integer' }, chars: { type: 'integer' } } } },
          text: { type: 'string', description: 'the read pages, separated by blank lines' },
          text_chars: { type: 'integer' },
          total_chars: { type: ['integer', 'null'], description: 'characters of the pages the parser read (it stops one page after the text budget is spent), before clipping and without separators; null when nothing was parsed' },
          clipped: { type: 'boolean', description: 'true when max_chars, the 100-page cap or the output size cut something' },
          text_layer: { type: ['boolean', 'null'], description: 'false when no read page carried any text (a scan); null when the parse failed' },
          info: { type: 'object', properties: { title: { type: ['string', 'null'] }, author: { type: ['string', 'null'] }, subject: { type: ['string', 'null'] }, creator: { type: ['string', 'null'] }, producer: { type: ['string', 'null'] }, created_at: { type: ['string', 'null'], format: 'date-time' }, modified_at: { type: ['string', 'null'], format: 'date-time' } } },
          word_count: { type: 'integer' },
          error: { type: ['string', 'null'], description: 'set when the file beat the parse limits after it had been accepted' },
          fetched_at: { type: 'string', format: 'date-time' },
        },
      },
      example_input: { url: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf' },
      example_output: { url: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf', final_url: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf', http_status: 200, content_type: 'application/pdf', bytes: 13264, pages_total: 1, pages_read: 1, pages: [{ page: 1, start: 0, chars: 14 }], text: 'Dummy PDF file', text_chars: 14, total_chars: 14, clipped: false, text_layer: true, info: { title: null, author: 'Evangelos Vlachogiannis', subject: null, creator: 'Writer', producer: 'OpenOffice.org 2.1', created_at: '2007-02-23T15:56:37.000Z', modified_at: null }, word_count: 3, error: null, fetched_at: '2026-09-16T00:00:00.000Z' },
      turnaround_seconds: 300,
      accept_timeout_seconds: 600,
      max_open_jobs: 5,
    },
    async validate(input) {
      if (typeof input.url !== 'string' || !input.url.trim()) return 'url must be a non-empty string'
      if (input.url.length > 2048) return 'url is longer than 2048 characters'
      if (input.max_chars !== undefined && (!Number.isInteger(input.max_chars) || (input.max_chars as number) < 100 || (input.max_chars as number) > MAX_CHARS_CAP)) return `max_chars must be an integer between 100 and ${MAX_CHARS_CAP}`
      let select: number[] | null
      try {
        select = parsePageSelection(input.pages)
      } catch (e) {
        return (e as Error).message
      }
      const url = input.url.trim()
      try {
        const u = new URL(url)
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'only http and https URLs are fetched'
      } catch {
        return 'url is not a valid absolute URL'
      }
      try {
        await assertPublicUrl(url)
      } catch (e) {
        return e instanceof UnsafeUrlError ? `refused: ${e.message}` : 'url could not be checked'
      }
      // The whole file, opened once, BEFORE accepting (ADR-64: ordering is free, a failure after accepting is our
      // mark): a wrong URL, an error page, a login wall, an oversized, encrypted or corrupt file is the buyer's input
      // and is declined here. The bytes and the page count wait for run().
      const fetched = await fetchPdf(url, opts)
      if (!fetched.ok) return fetched.reason
      let probe: Probe
      try {
        // the probe opens the document AND touches every page run() will read (cheap next to the text pass), so a
        // dangling page in the middle is the buyer's file being declined, not a paid delivery with an error field
        probe = (await parseInWorker({ mode: 'probe', bytes: fetched.file.bytes, select, maxChars: 0, maxPages: MAX_PAGES, pdfjsDir }, probeTimeout, opts.memoryCeilingBytes)) as Probe
      } catch (e) {
        if (e instanceof PdfParseError) {
          if (e.kind === 'service') return e.message
          return e.kind === 'limit' ? `the PDF could not be opened within the limits of this service (${e.message})` : e.kind === 'password' ? e.message : `the PDF could not be opened: ${e.message}`
        }
        throw e
      }
      if (select && !select.some((p) => p <= probe.pages_total)) return `none of the requested pages exist: the document has ${probe.pages_total} page${probe.pages_total === 1 ? '' : 's'}`
      remember(url, { ...fetched.file, probe, at: Date.now() })
      return null
    },
    async run(input) {
      const url = (input.url as string).trim()
      const maxChars = (input.max_chars as number | undefined) ?? MAX_CHARS_DEFAULT
      const select = parsePageSelection(input.pages)
      try {
        await assertPublicUrl(url)
      } catch (e) {
        if (e instanceof UnsafeUrlError) throw new Error(`refused: ${e.message}`)
        throw e
      }
      // normally what validate() left behind; fetched again only if that is gone (a restart between the two)
      let file: Fetched
      let probe: Probe | null
      const kept = take(url)
      if (kept) {
        file = kept
        probe = kept.probe
      } else {
        const fetched = await fetchPdf(url, opts)
        if (!fetched.ok) throw new Error(fetched.reason)
        file = fetched.file
        probe = null
      }
      const common = { url, final_url: file.finalUrl, http_status: file.status, content_type: mediaType(file.contentType), bytes: file.bytes.byteLength, fetched_at: new Date().toISOString() }
      let x: Extraction
      try {
        x = (await parseInWorker({ mode: 'extract', bytes: file.bytes, select, maxChars, maxPages: MAX_PAGES, pdfjsDir }, parseTimeout, opts.memoryCeilingBytes)) as Extraction
      } catch (e) {
        if (!(e instanceof PdfParseError)) throw e
        if (e.kind === 'service') throw new Error(e.message) // our side is broken: cancel honestly, do not charge for it
        // the file opened in validate() and beats the limits now: an honest result, not a failure on our record
        const out: PdfOutput = { ...common, pages_total: probe?.pages_total ?? 0, pages_read: 0, pages: [], text: '', text_chars: 0, total_chars: null, clipped: false, text_layer: null, info: probe?.info ?? { title: null, author: null, subject: null, creator: null, producer: null, created_at: null, modified_at: null }, word_count: 0, error: e.message }
        return { output: out, preview: { final_url: short(out.final_url), pages_total: out.pages_total, pages_extracted: 0, error: e.message }, message: `Could not extract the text: ${e.message}.` }
      }
      const textLayer = x.pages.some((p) => p.chars > 0)
      const out = fitOutput({ ...common, ...x, text_layer: textLayer, error: null })
      return {
        output: out,
        preview: { final_url: short(out.final_url), pages_total: out.pages_total, pages_extracted: out.pages_read, text_chars: out.text_chars, clipped: out.clipped, text_layer: textLayer, title: out.info.title?.slice(0, 120) ?? null, author: out.info.author?.slice(0, 120) ?? null, snippet: out.text.slice(0, 200) },
        message: textLayer
          ? `Extracted ${out.word_count} words from ${out.pages_read} of ${out.pages_total} pages${out.clipped ? ' (clipped)' : ''}.`
          : `The PDF has ${out.pages_total} pages but no text layer on the read ones (a scan?); nothing to extract without OCR.`,
      }
    },
  }
}
