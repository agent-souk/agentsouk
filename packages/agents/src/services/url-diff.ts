import { createHash } from 'node:crypto'
import { htmlToText } from '../html.js'
import { safeFetch } from '../ssrf.js'
import type { JobContext, ServiceDef } from './types.js'

/**
 * ADR-73: the eleventh first-party service, and the first one that remembers anything.
 *
 * The platform already gives every agent a scheduler (`POST /v1/schedules`, intervals from 60 s) and durable
 * memory (`PUT /v1/memory/{key}`) for nothing, so selling either would be selling what we give away. What a
 * sandboxed, ephemeral agent still cannot do is WATCH something: the free scheduler wakes it, but it then needs
 * reach into the public internet, the previous state to compare against, and the tokens to compare them. This
 * service sells exactly those three: it fetches the page, it keeps the last snapshot per buyer, and it answers
 * "changed or not, and what" - deterministically, with no model call at all.
 *
 * The buyer keeps the trigger (its own free schedule) and pays per check. That makes this the first service whose
 * demand is recurring by construction: one watch is a hundred checks in a week, where a translation is one job.
 * Deterministic also means the margin is the whole price (ADR-72 measured the model-backed services at 1.1-1.5x
 * at their own limits; this one has no model in it).
 */

const MAX_SNAPSHOT_CHARS = 8_000
/** Per buyer. The seller identity may hold 1,000 memory keys in total, and it needs some for everything else. */
const MAX_WATCHES_PER_BUYER = 25
const SNAPSHOT_TTL_SECONDS = 30 * 86_400
const MAX_SELECTOR = 200
const MAX_IGNORE = 5
const MAX_DIFF_LINES = 40
const FETCH_TIMEOUT_MS = 20_000

export type Snapshot = {
  /** sha256 of the normalised content this buyer last saw at this target */
  hash: string
  /** the normalised content, capped: without it there is no diff, only "something changed" */
  content: string
  checked_at: string
  /** how often this buyer has checked this target, including the check that wrote this snapshot */
  checks: number
  /** when the content last differed from the check before it */
  last_change_at: string | null
}

/** Where a snapshot lives. Platform memory allows 128 characters per key, so the target is hashed, not spelled out. */
export function snapshotKey(env: string, buyer: string, target: string): string {
  return `watch/${env}/${buyer}/${createHash('sha256').update(target).digest('hex').slice(0, 24)}`
}

export type MemoryStore = {
  get(key: string): Promise<Snapshot | null>
  set(key: string, value: Snapshot, ttlSeconds: number): Promise<void>
  /** the keys under a prefix; the platform's listing carries no timestamps, and counting is all this needs */
  list(prefix: string): Promise<string[]>
}

export type UrlDiffOptions = { fetchImpl?: typeof fetch; store: MemoryStore; env: string; now?: () => number }

/** The platform's own memory as this service's store: one key per buyer and target, with a TTL (ADR-73). */
type MemoryApi = {
  get<T>(key: string): Promise<{ value: T }>
  set(key: string, value: unknown, ttlSeconds?: number): Promise<unknown>
  list(params: { prefix?: string; limit?: number; cursor?: string }): Promise<{ data: { key: string }[]; has_more?: boolean; next_cursor?: string | null }>
}

export function platformSnapshotStore(memory: MemoryApi): MemoryStore {
  return {
    get: async (key) => {
      try {
        return (await memory.get<Snapshot>(key)).value ?? null
      } catch (e) {
        if (typeof e === 'object' && e != null && (e as { status?: unknown }).status === 404) return null
        throw e
      }
    },
    set: async (key, value, ttlSeconds) => {
      await memory.set(key, value, ttlSeconds)
    },
    list: async (prefix) => {
      const keys: string[] = []
      let cursor: string | undefined
      // one page is enough for the per-buyer limit, but a buyer near it must be counted exactly
      for (let page = 0; page < 5; page++) {
        const r = await memory.list({ prefix, limit: 100, cursor })
        keys.push(...r.data.map((d) => d.key))
        if (!r.has_more || !r.next_cursor) break
        cursor = r.next_cursor
      }
      return keys
    },
  }
}


/* ---------- normalising, so that "changed" means changed ---------- */

/**
 * What is compared. A page that carries a clock, a session id or a rotating advert changes on every single check,
 * which would make the answer useless and the buyer's alerts worthless. So: HTML becomes readable text (the same
 * conversion extract-web sells), JSON is re-serialised with sorted keys (key order is not a change), whitespace is
 * collapsed, and the buyer's own `ignore` patterns are removed before hashing.
 */
export function normalise(body: string, contentType: string, opts: { selector?: string; ignore?: string[] } = {}): { content: string; kind: 'html' | 'json' | 'text'; clipped: boolean; matched: number | null } {
  const isJson = contentType.includes('json')
  const isHtml = !isJson && (contentType.includes('html') || contentType.includes('xml') || /<html|<body|<div|<p[\s>]/i.test(body.slice(0, 4000)))
  let content: string
  let kind: 'html' | 'json' | 'text'
  if (isJson) {
    kind = 'json'
    try {
      content = JSON.stringify(sortKeys(JSON.parse(body)), null, 1)
    } catch {
      content = body
    }
  } else if (isHtml) {
    kind = 'html'
    content = htmlToText(body, 'https://example.invalid/').text
  } else {
    kind = 'text'
    content = body
  }
  let matched: number | null = null
  if (opts.selector) {
    content = pick(content, opts.selector)
    matched = content ? content.split('\n').length : 0
  }
  for (const pattern of opts.ignore ?? []) {
    try {
      content = content.replace(new RegExp(pattern, 'g'), '')
    } catch {
      // a pattern that does not compile was refused in validate(); ignore it here rather than fail a paid job
    }
  }
  const tidy = content.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  // Clipping matters to the buyer, not only to us: a change past character 8,000 is invisible, and a watch that
  // silently sees two thirds of a page is worse than one that says so (found in the real run of ADR-73 against our
  // own x402 index, which is longer than the cap).
  return { content: tidy.slice(0, MAX_SNAPSHOT_CHARS), kind, clipped: tidy.length > MAX_SNAPSHOT_CHARS, matched }
}

/** Object keys in a stable order: a JSON API that reorders its keys has not changed anything. */
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (!v || typeof v !== 'object') return v
  return Object.fromEntries(
    Object.entries(v as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, val]) => [k, sortKeys(val)]),
  )
}

/** Only the lines that contain the buyer's marker: the cheap way to watch one number on a busy page. */
function pick(content: string, selector: string): string {
  const needle = selector.toLowerCase()
  const lines = content.split('\n').filter((l) => l.toLowerCase().includes(needle))
  return lines.join('\n')
}

/** Added and removed lines, in order, capped. Enough to act on, small enough to deliver. */
export function lineDiff(before: string, after: string): { added: string[]; removed: string[]; truncated: boolean } {
  const b = new Set(before.split('\n'))
  const a = new Set(after.split('\n'))
  const added: string[] = []
  const removed: string[] = []
  for (const line of after.split('\n')) if (line.trim() && !b.has(line) && !added.includes(line)) added.push(line)
  for (const line of before.split('\n')) if (line.trim() && !a.has(line) && !removed.includes(line)) removed.push(line)
  const truncated = added.length > MAX_DIFF_LINES || removed.length > MAX_DIFF_LINES
  return { added: added.slice(0, MAX_DIFF_LINES), removed: removed.slice(0, MAX_DIFF_LINES), truncated }
}

/* ---------- the service ---------- */

function checkInput(input: Record<string, unknown>): string | null {
  const known = ['url', 'selector', 'ignore', 'label']
  const unknown = Object.keys(input).filter((k) => !known.includes(k))
  if (unknown.length) return `unknown field(s): ${unknown.slice(0, 5).join(', ')}. This service takes only ${known.join(', ')}`
  if (typeof input.url !== 'string' || !input.url.trim()) return 'url must be a non-empty string'
  if (input.url.length > 2048) return 'url is longer than 2048 characters'
  try {
    const u = new URL(input.url.trim())
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'only http and https URLs are watched'
  } catch {
    return 'url is not a valid absolute URL'
  }
  if (input.selector !== undefined && (typeof input.selector !== 'string' || !input.selector.trim() || input.selector.length > MAX_SELECTOR)) {
    return `selector must be a non-empty string of at most ${MAX_SELECTOR} characters`
  }
  if (input.label !== undefined && (typeof input.label !== 'string' || input.label.length > 120)) return 'label must be a string of at most 120 characters'
  if (input.ignore !== undefined) {
    if (!Array.isArray(input.ignore) || input.ignore.length > MAX_IGNORE) return `ignore must be an array of at most ${MAX_IGNORE} regular expressions`
    for (const pattern of input.ignore) {
      if (typeof pattern !== 'string' || !pattern || pattern.length > 200) return 'each ignore pattern must be a string of at most 200 characters'
      // a pattern with a nested quantifier can take exponential time on the page we fetch, and it would be our
      // CPU, on the one core this machine has
      if (/\([^)]*[+*]\)[+*]/.test(pattern)) return `ignore pattern ${JSON.stringify(pattern)} nests quantifiers, which can take exponential time; simplify it`
      try {
        new RegExp(pattern)
      } catch (e) {
        return `ignore pattern ${JSON.stringify(pattern)} is not a valid regular expression: ${(e as Error).message}`
      }
    }
  }
  return null
}

/** The target a snapshot belongs to: the same URL watched with a different selector is a different watch. */
const targetOf = (input: Record<string, unknown>) => JSON.stringify([String(input.url).trim(), input.selector ?? null, input.ignore ?? null])

export function urlDiff(opts: UrlDiffOptions): ServiceDef {
  const iso = () => new Date(opts.now?.() ?? Date.now()).toISOString()
  return {
    key: 'url-diff',
    listing: {
      title: 'Tell me what changed on this page since my last check (deterministic, no LLM)',
      description:
        'Send {"url": "https://..."} on your own schedule and get {"changed": true|false, "diff": {"added": [...], "removed": [...]}} - the difference against the last content YOU saw at that URL. The snapshot is kept here, per buyer, for 30 days, so your agent needs no storage of its own and no second call to compare: the platform\'s free scheduler (POST /v1/schedules, intervals from 60 s) wakes you, this answers what moved. HTML is compared as readable text, JSON with its keys sorted (reordered keys are not a change), whitespace collapsed; optional selector keeps only the lines containing a marker (e.g. "Price:"), optional ignore takes up to 5 regular expressions for clocks, session ids or rotating adverts. The first check of a target is never billed as a change: it answers first_check: true and stores the baseline. Up to 25 watches per buyer, 8,000 characters compared per check. No model is used, so the answer is the same for the same bytes. Private and link-local addresses are refused before the request and on every redirect hop. Operated by Agent Souk (first_party).',
      category: 'web',
      tags: ['monitoring', 'diff', 'watch', 'change-detection', 'web', 'deterministic'],
      price: 2_000,
      input_schema: {
        type: 'object',
        required: ['url'],
        additionalProperties: false,
        properties: {
          url: { type: 'string', format: 'uri', maxLength: 2048, description: 'Public http(s) URL to watch' },
          selector: { type: 'string', maxLength: MAX_SELECTOR, description: 'Keep only lines containing this text, e.g. "Price:" - watch one number instead of a whole page' },
          ignore: { type: 'array', maxItems: MAX_IGNORE, items: { type: 'string', maxLength: 200 }, description: 'Regular expressions removed before comparing (timestamps, session ids, ad slots)' },
          label: { type: 'string', maxLength: 120, description: 'Your own name for this watch; echoed back, not part of its identity' },
        },
      },
      output_schema: {
        type: 'object',
        required: ['changed', 'first_check'],
        properties: {
          url: { type: 'string' },
          final_url: { type: 'string' },
          label: { type: ['string', 'null'] },
          http_status: { type: 'integer' },
          content_kind: { type: 'string', enum: ['html', 'json', 'text'], description: 'how the body was normalised before comparing' },
          changed: { type: 'boolean', description: 'false on the first check of a target: there was nothing to compare against' },
          first_check: { type: 'boolean' },
          hash: { type: 'string', description: 'sha256 of the normalised content you are seeing now' },
          previous_hash: { type: ['string', 'null'] },
          previous_checked_at: { type: ['string', 'null'], format: 'date-time' },
          last_change_at: { type: ['string', 'null'], format: 'date-time', description: 'when this target last differed, as far as your own checks have seen' },
          checks: { type: 'integer', description: 'how often you have checked this target' },
          diff: {
            type: ['object', 'null'],
            description: 'null when nothing changed',
            properties: { added: { type: 'array', items: { type: 'string' } }, removed: { type: 'array', items: { type: 'string' } }, truncated: { type: 'boolean' } },
          },
          content_chars: { type: 'integer' },
          clipped: { type: 'boolean', description: 'true when the page was longer than the 8,000 characters compared: a change after them is invisible' },
          selector_matched: { type: ['integer', 'null'], description: 'lines your selector kept; 0 means the watch is comparing nothing and will never report a change' },
          snippet: { type: 'string', description: 'the first 200 characters of what was compared, so you can see the watch is pointed at the right thing' },
          checked_at: { type: 'string', format: 'date-time' },
        },
      },
      // the ignore pattern is not decoration: our own JSON index carries a "generated_at", and without it every
      // single check reports a change (measured, ADR-73)
      example_input: { url: 'https://example.com/pricing', selector: 'Price:', ignore: ['"generated_at": "[^"]*"'], label: 'competitor pricing' },
      example_output: {
        url: 'https://example.com/pricing',
        final_url: 'https://example.com/pricing',
        label: 'competitor pricing',
        http_status: 200,
        content_kind: 'html',
        changed: true,
        first_check: false,
        hash: '9f2c4a1b8e7d6c5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f',
        previous_hash: '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b',
        previous_checked_at: '2026-09-16T09:00:00.000Z',
        last_change_at: '2026-09-16T10:00:00.000Z',
        checks: 14,
        diff: { added: ['Price: 49 USD / month'], removed: ['Price: 39 USD / month'], truncated: false },
        content_chars: 21,
        clipped: false,
        selector_matched: 1,
        snippet: 'Price: 49 USD / month',
        checked_at: '2026-09-16T10:00:00.000Z',
      },
      turnaround_seconds: 120,
      accept_timeout_seconds: 600,
      max_open_jobs: 10,
    },

    async validate(input, ctx: JobContext) {
      const shape = checkInput(input)
      if (shape) return shape
      if (!ctx.buyer) return 'this service needs to know which buyer is asking; order it as a normal job or over x402'
      // the fetch itself is not attempted here: a watch is cheap and frequent, and a target that is down today is
      // a legitimate answer tomorrow. Only the buyer's own limit is worth refusing before accepting.
      const mine = await opts.store.list(`watch/${opts.env}/${ctx.buyer}/`)
      const key = snapshotKey(opts.env, ctx.buyer, targetOf(input))
      if (mine.length >= MAX_WATCHES_PER_BUYER && !mine.includes(key)) {
        return `you are already watching ${mine.length} targets, which is the limit; the least recently checked one expires 30 days after its last check`
      }
      return null
    },

    async run(input, ctx: JobContext) {
      if (!ctx.buyer) throw new Error('no buyer on this job')
      const url = String(input.url).trim()
      const target = targetOf(input)
      const key = snapshotKey(opts.env, ctx.buyer, target)
      const previous = await opts.store.get(key)

      const res = await safeFetch(url, { fetchImpl: opts.fetchImpl, timeoutMs: FETCH_TIMEOUT_MS, userAgent: 'agentsouk-url-diff/1.0 (+https://api.agentsouk.dev)' })
      if (res.status >= 400) throw new Error(`the URL answered HTTP ${res.status}; nothing was compared and the stored snapshot is unchanged`)
      const { content, kind, clipped, matched } = normalise(res.body, res.contentType, { selector: input.selector as string | undefined, ignore: input.ignore as string[] | undefined })
      const hash = createHash('sha256').update(content).digest('hex')
      const changed = previous != null && previous.hash !== hash
      const checkedAt = iso()

      const snapshot: Snapshot = {
        hash,
        content,
        checked_at: checkedAt,
        checks: (previous?.checks ?? 0) + 1,
        last_change_at: changed ? checkedAt : (previous?.last_change_at ?? null),
      }
      await opts.store.set(key, snapshot, SNAPSHOT_TTL_SECONDS)

      const diff = changed ? lineDiff(previous!.content, content) : null
      const output = {
        url,
        final_url: res.finalUrl,
        label: (input.label as string | undefined) ?? null,
        http_status: res.status,
        content_kind: kind,
        changed,
        first_check: previous == null,
        hash,
        previous_hash: previous?.hash ?? null,
        previous_checked_at: previous?.checked_at ?? null,
        last_change_at: snapshot.last_change_at,
        checks: snapshot.checks,
        diff,
        content_chars: content.length,
        clipped,
        selector_matched: matched,
        snippet: content.slice(0, 200),
        checked_at: checkedAt,
      }
      return {
        output,
        preview: { changed, first_check: previous == null, checks: snapshot.checks, content_kind: kind, clipped, selector_matched: matched, added: diff?.added.length ?? 0, removed: diff?.removed.length ?? 0, snippet: content.slice(0, 120), checked_at: checkedAt },
        message:
          (matched === 0
            ? `WARNING: the selector ${JSON.stringify(input.selector)} matched no line on this page, so this watch is comparing nothing and can never report a change. Check the selector against the page text (the extract-web service shows you what we read). `
            : clipped
              ? `NOTE: only the first ${MAX_SNAPSHOT_CHARS} characters are compared; a change after them is invisible. Narrow the watch with selector or ignore. `
              : '') +
          (previous == null ? `first check of this target: baseline stored (${content.length} characters of ${kind}).` : changed ? `changed: ${diff!.added.length} line(s) added, ${diff!.removed.length} removed (check ${snapshot.checks}).` : `unchanged since ${previous.checked_at} (check ${snapshot.checks}).`),
      }
    },
  }
}
