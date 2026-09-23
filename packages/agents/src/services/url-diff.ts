import { createHash } from 'node:crypto'
import { RE2JS } from 're2js'
import { htmlToText } from '../html.js'
import { assertPublicUrl, safeFetch, UnsafeUrlError } from '../ssrf.js'
import type { JobContext, RunResult, ServiceDef } from './types.js'

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
 *
 * Three rules this service is built on, each of them learned the hard way in its adversarial run:
 *  - a foreign site that is down is not our failure: it is delivered as `fetch_ok: false`, never thrown;
 *  - what the buyer has not received has not happened: the snapshot moves forward in `commit()`, after delivery;
 *  - nothing the buyer sends is executed here - `ignore` is a glob, not a regular expression.
 */

const MAX_SNAPSHOT_CHARS = 8_000
const MAX_FETCH_BYTES = 512_000
/** Per buyer and environment. */
const MAX_WATCHES_PER_BUYER = 25
/**
 * Across all buyers and both environments. The seller identity may hold 1,000 memory keys in total and needs them
 * for everything else it does - the LLM day counter above all, which fails closed when it cannot be written. Twenty
 * sandbox identities with faucet money would otherwise have filled the live identity's memory for 30 days.
 */
const MAX_WATCHES_TOTAL = 600
const SNAPSHOT_TTL_SECONDS = 30 * 86_400
const MAX_SELECTOR = 200
const MAX_IGNORE = 5
const MAX_IGNORE_WILDCARDS = 3
const MAX_DIFF_LINES = 40
const FETCH_TIMEOUT_MS = 20_000

export type Snapshot = {
  /** sha256 of the FULL normalised text, not of the capped copy below: a change past the cap is still a change */
  hash: string
  /** the normalised content, capped: without it there is no diff, only "something changed" */
  content: string
  /** how the body was read the first time; frozen, so a content sniffer cannot flip the mode between checks */
  kind: 'html' | 'json' | 'text'
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
  delete(key: string): Promise<void>
  /** the keys under a prefix; the platform's listing carries no timestamps, and counting is all this needs */
  list(prefix: string): Promise<string[]>
}

export type UrlDiffOptions = { fetchImpl?: typeof fetch; store: MemoryStore; env: string; now?: () => number; hostFetchesPerMinute?: number }

/** The platform's own memory as this service's store: one key per buyer and target, with a TTL (ADR-73). */
type MemoryApi = {
  get<T>(key: string): Promise<{ value: T }>
  set(key: string, value: unknown, ttlSeconds?: number): Promise<unknown>
  delete(key: string): Promise<unknown>
  list(params: { prefix?: string; limit?: number; cursor?: string }): Promise<{ data: { key: string }[]; has_more?: boolean; next_cursor?: string | null }>
}

export function platformSnapshotStore(memory: MemoryApi): MemoryStore {
  const missing = (e: unknown) => typeof e === 'object' && e != null && (e as { status?: unknown }).status === 404
  return {
    get: async (key) => {
      try {
        return (await memory.get<Snapshot>(key)).value ?? null
      } catch (e) {
        if (missing(e)) return null
        throw e
      }
    },
    set: async (key, value, ttlSeconds) => {
      await memory.set(key, value, ttlSeconds)
    },
    delete: async (key) => {
      try {
        await memory.delete(key)
      } catch (e) {
        if (!missing(e)) throw e
      }
    },
    list: async (prefix) => {
      const keys: string[] = []
      let cursor: string | undefined
      for (let page = 0; page < 10; page++) {
        const r = await memory.list({ prefix, limit: 100, cursor })
        keys.push(...r.data.map((d) => d.key))
        if (!r.has_more || !r.next_cursor) break
        cursor = r.next_cursor
      }
      return keys
    },
  }
}

/* ---------- what the buyer may ask us to ignore ---------- */

/**
 * `ignore` is a GLOB, not a regular expression, and that is a security decision, not a convenience one. A buyer's
 * regular expression runs in our process, on our single core, over text the buyer also controls: `(a|a)+$` against
 * 26 characters took 2.7 s in this repo, 30 characters take minutes, and the nested-quantifier check the first
 * version had does not see it (measured in the adversarial run). x402 settles only after delivery, so a job that
 * never finishes costs the attacker nothing and costs us every other job on the machine.
 *
 * So the buyer writes literal text with `*` for "any run of characters on this line", and we build the expression:
 * everything is escaped, `*` becomes `[^\n]*`. One star, one character class, no alternation, no nesting - the
 * class of input that blows up cannot be expressed. `"generated_at": "*"` still does what it has to do.
 */
export function globToRegExp(pattern: string): RegExp {
  return new RegExp(globSource(pattern), 'g')
}
function globSource(pattern: string): string {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return escaped.replace(/\\\*/g, '[^\\n]*')
}

/**
 * ADR-80: the glob above still hung the process - not exponentially, but polynomially. Every `*` is a `[^\n]*` that
 * V8 backtracks through, so k stars over a line of n characters cost about n^(k+1): three stars over 2,000
 * characters of a page the buyer controls took 54 s, 5,000 characters about 35 minutes (review 2026-09-23, S-DOS-1).
 * The same expression, run by RE2, matches the same text in one linear pass. So the glob is still built here, and
 * applied by the engine that cannot backtrack.
 */
export function removeGlob(text: string, pattern: string): string {
  return RE2JS.compile(globSource(pattern)).matcher(text).replaceAll('')
}


/* ---------- protecting the target, and ourselves ---------- */

/**
 * At most 20 fetches a minute per target host, across all buyers (ADR-73). Twenty-five watches at a minute's
 * interval are 36,000 requests a day against someone else's site, sent from our one Fly address with our name in
 * the user agent: the abuse report would come to us, and a block would hit extract-web, extract-pdf and
 * extract-image with it. A buyer that asks faster gets an honest answer instead of a queue.
 */
const HOST_WINDOW_MS = 60_000
export const HOST_FETCHES_PER_MINUTE = 20
const hostHits = new Map<string, number[]>()
/** Free capacity for this host right now, counting only the last minute. Exported so the limit can be tested. */
export function hostBudgetLeft(host: string, now: number, perMinute = HOST_FETCHES_PER_MINUTE): boolean {
  const hits = (hostHits.get(host) ?? []).filter((t) => now - t < HOST_WINDOW_MS)
  hostHits.set(host, hits)
  if (hostHits.size > 500) for (const [k, v] of hostHits) if (!v.length) hostHits.delete(k)
  return hits.length < perMinute
}
function noteHostFetch(host: string, now: number): void {
  hostHits.set(host, [...(hostHits.get(host) ?? []), now])
}
/** The budget is process-wide on purpose - it protects the target site, not one buyer - so a test has to clear it. */
export function _resetHostBudgetForTests(): void {
  hostHits.clear()
}

/**
 * Two checks of the SAME watch must not overlap: both would read the same snapshot, and the later write would
 * bury the earlier change - the buyer would then be told about it twice, or never. Same machine, same process, so
 * a promise chain per key is enough; a second machine would need the platform for this.
 */
const inFlight = new Map<string, Promise<unknown>>()
function serialised<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = inFlight.get(key) ?? Promise.resolve()
  const mine = previous.then(work, work)
  inFlight.set(
    key,
    mine.catch(() => undefined),
  )
  void mine.finally(() => {
    if (inFlight.get(key) === undefined) inFlight.delete(key)
  })
  return mine
}

/* ---------- normalising, so that "changed" means changed ---------- */

export type Normalised = { content: string; full: string; kind: 'html' | 'json' | 'text'; clipped: boolean; matched: number | null }

/**
 * What is compared. A page that carries a clock, a session id or a rotating advert changes on every single check,
 * which would make the answer useless and the buyer's alerts worthless. So: HTML becomes readable text plus its
 * title and link targets (a "Download latest" link that now points at v2.1 IS a change, and the visible text alone
 * would miss it), JSON is re-serialised with sorted keys, whitespace is collapsed, line endings and non-breaking
 * spaces are unified, and the buyer's own `ignore` patterns are removed before hashing.
 */
export function normalise(body: string, contentType: string, opts: { selector?: string; ignore?: string[]; kind?: 'html' | 'json' | 'text' } = {}): Normalised {
  const kind = opts.kind ?? sniff(body, contentType)
  let content: string
  if (kind === 'json') {
    content = canonicalJson(body)
  } else if (kind === 'html') {
    const x = htmlToText(body, 'https://example.invalid/')
    const links = x.links.map((l) => `[link] ${l.text} -> ${l.href}`).join('\n')
    content = [x.title ? `[title] ${x.title}` : '', x.text, links].filter(Boolean).join('\n')
  } else {
    content = body
  }
  let matched: number | null = null
  if (opts.selector) {
    const needle = opts.selector.toLowerCase()
    const lines = content.split('\n').filter((l) => l.toLowerCase().includes(needle))
    content = lines.join('\n')
    matched = lines.length
  }
  for (const pattern of opts.ignore ?? []) content = removeGlob(content, pattern)
  // \r, U+00A0 and unnormalised Unicode are three separate ways for the same page to look different to a hash
  const full = content
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, ' ')
    .normalize('NFC')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  // Clipping matters to the buyer, not only to us: the diff cannot show what it never held. The HASH is taken over
  // the full text, so a change past the cap is still reported - it just cannot be spelled out.
  return { content: full.slice(0, MAX_SNAPSHOT_CHARS), full, kind, clipped: full.length > MAX_SNAPSHOT_CHARS, matched }
}

function sniff(body: string, contentType: string): 'html' | 'json' | 'text' {
  if (contentType.includes('json')) return 'json'
  if (contentType.includes('html') || contentType.includes('xml')) return 'html'
  return /<html|<body|<div|<p[\s>]/i.test(body.slice(0, 4000)) ? 'html' : 'text'
}

/**
 * JSON with its keys in a stable order - a service that reorders its keys has not changed anything - but with its
 * NUMBERS untouched. `JSON.parse` turns 1000000000000000001 into 1000000000000000000, so two different wei amounts
 * hash the same and the answer is a confident "unchanged"; for a buyer watching a balance that is the worst
 * possible wrong answer. Long number literals are quoted before parsing, which keeps every digit. This text is only
 * ever hashed and diffed, never handed back as data, so quoting is free.
 */
export function canonicalJson(body: string): string {
  const safe = body.replace(/(:\s*)(-?\d{16,}(?:\.\d+)?)(\s*[,}\]])/g, '$1"$2"$3')
  try {
    return JSON.stringify(sortKeys(JSON.parse(safe)), null, 1)
  } catch {
    return body
  }
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (!v || typeof v !== 'object') return v
  return Object.fromEntries(
    Object.entries(v as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, val]) => [k, sortKeys(val)]),
  )
}

/**
 * Added and removed lines, counted with their multiplicity: a set-based diff answered "changed: true" with an empty
 * diff when a duplicated line disappeared or two lines swapped places, which is an alarm with nothing in it.
 * `reordered` says exactly that case out loud instead.
 */
export function lineDiff(before: string, after: string): { added: string[]; removed: string[]; reordered: boolean; truncated: boolean } {
  const count = (s: string) => {
    const m = new Map<string, number>()
    for (const line of s.split('\n')) if (line.trim()) m.set(line, (m.get(line) ?? 0) + 1)
    return m
  }
  const b = count(before)
  const a = count(after)
  const added: string[] = []
  const removed: string[] = []
  for (const [line, n] of a) for (let i = 0; i < n - (b.get(line) ?? 0); i++) added.push(line)
  for (const [line, n] of b) for (let i = 0; i < n - (a.get(line) ?? 0); i++) removed.push(line)
  return { added: added.slice(0, MAX_DIFF_LINES), removed: removed.slice(0, MAX_DIFF_LINES), reordered: added.length === 0 && removed.length === 0, truncated: added.length > MAX_DIFF_LINES || removed.length > MAX_DIFF_LINES }
}

/* ---------- input ---------- */

const INPUT_KEYS = ['url', 'selector', 'ignore', 'label', 'reset']

function checkInput(input: Record<string, unknown>): string | null {
  const unknown = Object.keys(input).filter((k) => !INPUT_KEYS.includes(k))
  if (unknown.length) return `unknown field(s): ${unknown.slice(0, 5).join(', ')}. This service takes only ${INPUT_KEYS.join(', ')}`
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
  if (input.reset !== undefined && typeof input.reset !== 'boolean') return 'reset must be true or false'
  if (input.ignore !== undefined) {
    if (!Array.isArray(input.ignore) || input.ignore.length > MAX_IGNORE) return `ignore must be an array of at most ${MAX_IGNORE} patterns`
    for (const pattern of input.ignore) {
      if (typeof pattern !== 'string' || !pattern || pattern.length > 200) return 'each ignore pattern must be a string of at most 200 characters'
      const stars = (pattern.match(/\*/g) ?? []).length
      if (stars > MAX_IGNORE_WILDCARDS) return `ignore pattern ${JSON.stringify(pattern)} has ${stars} wildcards; at most ${MAX_IGNORE_WILDCARDS} are allowed`
    }
  }
  return null
}

/**
 * The target a snapshot belongs to. Normalised first, or a buyer whose client builds its input from a Set gets a
 * NEW watch on every call: 25 paid baselines, no change ever reported, and a limit it cannot clear for 30 days.
 * The host is lower-cased (it is case-insensitive by definition), the fragment dropped (it never reaches a server),
 * and the ignore list sorted.
 */
export function targetOf(input: Record<string, unknown>): string {
  const u = new URL(String(input.url).trim())
  u.hash = ''
  u.hostname = u.hostname.toLowerCase()
  u.protocol = u.protocol.toLowerCase()
  const ignore = Array.isArray(input.ignore) ? [...(input.ignore as string[])].sort() : null
  return JSON.stringify([u.toString(), input.selector ?? null, ignore])
}

export function urlDiff(opts: UrlDiffOptions): ServiceDef {
  const iso = () => new Date(opts.now?.() ?? Date.now()).toISOString()
  return {
    key: 'url-diff',
    listing: {
      title: 'Tell me what changed on this page since my last check (deterministic, no LLM)',
      description:
        'Send {"url": "https://..."} on your own schedule and get {"changed": true|false, "diff": {"added": [...], "removed": [...]}} - the difference against the last content YOU saw at that URL. The snapshot (up to 8,000 characters of the page text, per buyer) is kept in our storage and expires 30 days after your last check of that target - every check renews it - so your agent needs no storage of its own and no second call to compare: the platform\'s free scheduler (POST /v1/schedules, intervals from 60 s) wakes you, this answers what moved. HTML is compared as its readable text plus the page title and link targets; JSON with its keys sorted (reordered keys are not a change, reordered array items are) and its long numbers kept digit for digit; line endings, non-breaking spaces and Unicode form unified. Optional selector keeps only the lines containing a marker (e.g. "Price:") - if it matches nothing you are told, because a watch over nothing can never report a change. Optional ignore takes up to 5 glob patterns (literal text, * for any run of characters on a line, e.g. \'"generated_at": "*"\') for clocks, session ids and rotating adverts; these are globs, not regular expressions, and nothing you send is executed here. Optional reset: true forgets the stored snapshot and starts a fresh baseline. The first check of a target answers first_check: true, never changed: true, and stores the baseline - it costs the full price like any other check, and a different selector or ignore list is a different target with its own new baseline. Independently of the 30-day snapshot, every check is a job: its input and output stay in the job record, readable by the operator, with no stated retention period (GET /v1/commitments). If you would rather we did not keep a record of what you watch, do not use this service. A target that is unreachable, times out or answers 4xx/5xx is delivered as fetch_ok: false with the previous snapshot untouched - your alerting sees the outage instead of nothing. Up to 25 watches per buyer and 512 KB fetched per check; a single target host is fetched at most 20 times a minute across all buyers, so a watch is a watch and not a load generator. No model is used, so the same bytes give the same answer. Private and link-local addresses are refused before the job is accepted and on every redirect hop. Note for x402 buyers: POST /v1/x402/{id} allows 30 requests an hour per IP, so a minute-by-minute watch needs the ordinary job path. Operated by Agent Souk (first_party).',
      category: 'web',
      tags: ['monitoring', 'diff', 'watch', 'change-detection', 'web', 'deterministic'],
      // 0.01, not the 0.002 this started at: the platform's own OUTSIDER_PRICE_FLOOR is 10_000, and a purchase
      // below it is excluded from `between_outsiders` - the one number this project measures itself by. A service
      // built to produce more purchases than any other would have produced statistical silence. The marginal cost
      // of a check is about 1e-6 USD, so the price is still covered some ten thousand times over (ADR-73).
      price: 10_000,
      input_schema: {
        type: 'object',
        required: ['url'],
        additionalProperties: false,
        properties: {
          url: { type: 'string', format: 'uri', maxLength: 2048, description: 'Public http(s) URL to watch' },
          selector: { type: 'string', maxLength: MAX_SELECTOR, description: 'Keep only lines containing this text, e.g. "Price:" - watch one number instead of a whole page' },
          ignore: { type: 'array', maxItems: MAX_IGNORE, items: { type: 'string', maxLength: 200 }, description: 'Glob patterns removed before comparing (* = any run of characters on a line), e.g. "\\"generated_at\\": \\"*\\""' },
          label: { type: 'string', maxLength: 120, description: 'Your own name for this watch; echoed back, not part of its identity' },
          reset: { type: 'boolean', default: false, description: 'Forget the stored snapshot for this target and start a fresh baseline' },
        },
      },
      output_schema: {
        type: 'object',
        required: ['changed', 'first_check', 'fetch_ok'],
        properties: {
          url: { type: 'string' },
          final_url: { type: ['string', 'null'] },
          label: { type: ['string', 'null'] },
          fetch_ok: { type: 'boolean', description: 'false when the target could not be read; the stored snapshot is then left as it was' },
          error: { type: ['string', 'null'], description: 'why the target could not be read' },
          http_status: { type: ['integer', 'null'] },
          content_kind: { type: ['string', 'null'], enum: ['html', 'json', 'text', null], description: 'how the body is normalised; frozen at the first check of a target' },
          changed: { type: 'boolean', description: 'false on the first check of a target and whenever the target could not be read' },
          first_check: { type: 'boolean' },
          hash: { type: ['string', 'null'], description: 'sha256 of the whole normalised content, including what the diff had to leave out' },
          previous_hash: { type: ['string', 'null'] },
          previous_checked_at: { type: ['string', 'null'], format: 'date-time' },
          last_change_at: { type: ['string', 'null'], format: 'date-time', description: 'when this target last differed, as far as your own checks have seen' },
          checks: { type: 'integer', description: 'how often you have checked this target' },
          diff: {
            type: ['object', 'null'],
            description: 'null when nothing changed or nothing could be read',
            properties: { added: { type: 'array', items: { type: 'string' } }, removed: { type: 'array', items: { type: 'string' } }, reordered: { type: 'boolean', description: 'the same lines in a different order or multiplicity: changed, but nothing to list' }, truncated: { type: 'boolean' } },
          },
          content_chars: { type: 'integer' },
          clipped: { type: 'boolean', description: 'the page was longer than the 8,000 characters the diff can show; the hash still covers all of it' },
          selector_matched: { type: ['integer', 'null'], description: 'lines your selector kept; 0 means the watch is comparing nothing' },
          content_empty: { type: 'boolean', description: 'nothing was left to compare - a maintenance page, or a selector that missed. The baseline is kept rather than replaced by emptiness' },
          snippet: { type: 'string' },
          checked_at: { type: 'string', format: 'date-time' },
        },
      },
      example_input: { url: 'https://example.com/pricing', selector: 'Price:', ignore: ['"generated_at": "*"'], label: 'competitor pricing' },
      example_output: {
        url: 'https://example.com/pricing',
        final_url: 'https://example.com/pricing',
        label: 'competitor pricing',
        fetch_ok: true,
        error: null,
        http_status: 200,
        content_kind: 'html',
        changed: true,
        first_check: false,
        hash: '82b3b492701ab51d18916f30e3e9402b3ce39785961d4c38bb421f4d5f863ab1', // the real sha256 of the content below: the one line in this listing a buyer can check, and it has to check out
        previous_hash: '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b',
        previous_checked_at: '2026-09-16T09:00:00.000Z',
        last_change_at: '2026-09-16T10:00:00.000Z',
        checks: 14,
        diff: { added: ['Price: 49 USD / month'], removed: ['Price: 39 USD / month'], reordered: false, truncated: false },
        content_chars: 21,
        clipped: false,
        selector_matched: 1,
        content_empty: false,
        snippet: 'Price: 49 USD / month',
        checked_at: '2026-09-16T10:00:00.000Z',
      },
      turnaround_seconds: 120,
      accept_timeout_seconds: 600,
      // per listing across ALL buyers (assertSellerCapacity): at 10, one buyer running 25 watches would lock
      // every other buyer out with 409 seller_busy
      max_open_jobs: 60,
    },

    async validate(input, ctx: JobContext) {
      const shape = checkInput(input)
      if (shape) return shape
      if (!ctx.buyer) return 'this service needs to know which buyer is asking; order it as a normal job or over x402'
      // the address is checked BEFORE accepting, as the listing says: a private target is a decline, not a job we
      // take and then fail. Every redirect hop is checked again during the fetch (ssrf.ts).
      try {
        await assertPublicUrl(String(input.url).trim())
      } catch (e) {
        if (e instanceof UnsafeUrlError) return e.message
        // a name that does not resolve is the buyer's problem, but it is not worth refusing a watch over: the
        // target may exist again tomorrow, and run() delivers the failure instead of throwing it
      }
      const key = snapshotKey(opts.env, ctx.buyer, targetOf(input))
      const mine = await opts.store.list(`watch/${opts.env}/${ctx.buyer}/`)
      if (mine.length >= MAX_WATCHES_PER_BUYER && !mine.includes(key)) {
        return `you are already watching ${mine.length} targets, which is the limit; send reset: true on one you no longer need, or let it expire 30 days after its last check`
      }
      if (!mine.includes(key)) {
        const all = await opts.store.list('watch/')
        if (all.length >= MAX_WATCHES_TOTAL) return 'this service is at its storage limit right now; try again later'
      }
      return null
    },

    async run(input, ctx: JobContext): Promise<RunResult> {
      if (!ctx.buyer) throw new Error('no buyer on this job')
      const url = String(input.url).trim()
      const key = snapshotKey(opts.env, ctx.buyer, targetOf(input))
      return serialised(key, () => check(input, url, key))
    },
  }

  async function check(input: Record<string, unknown>, url: string, key: string): Promise<RunResult> {
    {
      if (input.reset === true) await opts.store.delete(key)
      const previous = input.reset === true ? null : await opts.store.get(key)
      const checkedAt = iso()
      const base = { url, label: (input.label as string | undefined) ?? null, checks: (previous?.checks ?? 0) + 1, previous_hash: previous?.hash ?? null, previous_checked_at: previous?.checked_at ?? null, checked_at: checkedAt }

      /** A target we cannot read is news, not a failure: it is delivered, and the snapshot stays where it was. */
      const unreadable = (error: string, status: number | null): RunResult => ({
        output: { ...base, final_url: null, fetch_ok: false, error, http_status: status, content_kind: previous?.kind ?? null, changed: false, first_check: previous == null, hash: null, last_change_at: previous?.last_change_at ?? null, diff: null, content_chars: 0, clipped: false, selector_matched: null, content_empty: false, snippet: '' },
        preview: { fetch_ok: false, error, http_status: status, changed: false, checks: base.checks, checked_at: checkedAt },
        message: `could not read the target: ${error}. The stored snapshot is unchanged, so the next readable check still compares against what you last saw.`,
      })

      const host = new URL(url).host
      const perMinute = opts.hostFetchesPerMinute ?? HOST_FETCHES_PER_MINUTE
      if (!hostBudgetLeft(host, Date.now(), perMinute)) {
        return unreadable(`this service fetches ${host} at most ${perMinute} times a minute across all buyers, and that budget is used up right now; the stored snapshot is unchanged`, null)
      }
      let res
      try {
        noteHostFetch(host, Date.now())
        res = await safeFetch(url, { fetchImpl: opts.fetchImpl, timeoutMs: FETCH_TIMEOUT_MS, maxBytes: MAX_FETCH_BYTES, userAgent: 'agentsouk-url-diff/1.0 (+https://api.agentsouk.dev)' })
      } catch (e) {
        return unreadable((e as Error).message, null)
      }
      if (res.status >= 400) return unreadable(`the target answered HTTP ${res.status}`, res.status)

      const { content, full, kind, clipped, matched } = normalise(res.body, res.contentType, { selector: input.selector as string | undefined, ignore: input.ignore as string[] | undefined, kind: previous?.kind })
      const hash = createHash('sha256').update(full).digest('hex')
      const changed = previous != null && previous.hash !== hash
      const empty = full.length === 0

      // A page that briefly serves nothing - maintenance, a JS shell, a selector that missed - would otherwise
      // become the new baseline, and the buyer gets two alarms: "everything gone" and then "everything back".
      const keepBaseline = empty && previous != null && previous.content.length > 0
      const snapshot: Snapshot = keepBaseline
        ? { ...previous, checks: base.checks, checked_at: checkedAt }
        : { hash, content, kind, checked_at: checkedAt, checks: base.checks, last_change_at: changed ? checkedAt : (previous?.last_change_at ?? null) }

      const diff = changed && !keepBaseline ? lineDiff(previous!.content, content) : null
      const output = {
        ...base,
        final_url: res.finalUrl,
        fetch_ok: true,
        error: null,
        http_status: res.status,
        content_kind: kind,
        changed: changed && !keepBaseline,
        first_check: previous == null,
        hash,
        last_change_at: snapshot.last_change_at,
        diff,
        content_chars: content.length,
        clipped,
        selector_matched: matched,
        content_empty: empty,
        snippet: content.slice(0, 200),
      }
      // every warning that applies, not the first one: a selector that misses on a maintenance page is both a miss
      // and a kept baseline, and the buyer needs to hear both
      // several of these can be true at once, and each one is the reason a watch would otherwise be useless
      const warnings: string[] = []
      if (keepBaseline) warnings.push('WARNING: the target returned nothing to compare (maintenance page, or a selector/ignore that removed everything), so the previous snapshot was kept rather than replaced by emptiness.')
      else if (empty) warnings.push(`WARNING: after selector and ignore there is nothing left to compare, so this watch can never report a change${matched === 0 ? `; the selector ${JSON.stringify(input.selector)} matched no line` : ''}.`)
      if (matched === 0 && !empty) warnings.push(`WARNING: the selector ${JSON.stringify(input.selector)} matched no line.`)
      if (clipped) warnings.push(`NOTE: the page is longer than the ${MAX_SNAPSHOT_CHARS} characters the diff can show; a change beyond them is still reported, it just cannot be listed.`)
      const warning = warnings.length ? warnings.join(' ') + ' ' : ''
      return {
        output,
        preview: { fetch_ok: true, changed: output.changed, first_check: previous == null, checks: base.checks, content_kind: kind, clipped, selector_matched: matched, added: diff?.added.length ?? 0, removed: diff?.removed.length ?? 0, snippet: content.slice(0, 120), checked_at: checkedAt },
        message:
          warning +
          (previous == null
            ? `first check of this target: baseline stored (${content.length} characters of ${kind}).`
            : output.changed
              ? diff!.reordered
                ? `changed: the same lines in a different order or number (check ${base.checks}).`
                : `changed: ${diff!.added.length} line(s) added, ${diff!.removed.length} removed (check ${base.checks}).`
              : `unchanged since ${previous.checked_at} (check ${base.checks}).`),
        // only once the buyer HAS this answer does the watch move on (ADR-73)
        commit: () => opts.store.set(key, snapshot, SNAPSHOT_TTL_SECONDS),
      }
    }
  }
}
