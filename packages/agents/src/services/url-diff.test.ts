import { describe, it, expect } from 'vitest'
import { canonicalJson, globToRegExp, lineDiff, normalise, removeGlob, snapshotKey, targetOf, urlDiff, _resetHostBudgetForTests, type MemoryStore, type Snapshot } from './url-diff.js'
import type { RunResult } from './types.js'

/* ---------- a store like platform memory, and a fetch we control ---------- */

function fakeStore() {
  const kv = new Map<string, Snapshot>()
  const ttls: number[] = []
  const store: MemoryStore = {
    get: async (k) => kv.get(k) ?? null,
    set: async (k, v, ttl) => {
      ttls.push(ttl)
      kv.set(k, v)
    },
    delete: async (k) => void kv.delete(k),
    list: async (prefix) => [...kv.keys()].filter((k) => k.startsWith(prefix)),
  }
  return { store, kv, ttls }
}

const HOST = 'http://93.184.216.34'
function fakeFetch(bodies: Record<string, string | { body: string; type?: string; status?: number; throws?: Error }>) {
  const seen: string[] = []
  const impl: typeof fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    seen.push(url)
    const b = bodies[url.replace(HOST, '')]
    if (b === undefined) return new Response('nope', { status: 500 })
    if (typeof b === 'string') return new Response(b, { status: 200, headers: { 'content-type': 'text/html' } })
    if (b.throws) throw b.throws
    return new Response(b.body, { status: b.status ?? 200, headers: { 'content-type': b.type ?? 'text/html' } })
  }) as typeof fetch
  return { impl, seen }
}

const html = (price: string, extra = '') => `<html><head><title>Pricing</title></head><body><main><p>Price: ${price} USD / month</p><p>Support included</p>${extra}</main></body></html>`
const ctx = { units: 1, buyer: 'agt_buyer1' }
/** run() and then the delivery the runner would do: only then does the watch move on (ADR-73). */
const runAndDeliver = async (svc: { run: (i: Record<string, unknown>, c: typeof ctx) => Promise<RunResult> }, input: Record<string, unknown>, c = ctx) => {
  const r = await svc.run(input, c)
  await r.commit?.()
  return r
}

describe('globToRegExp', () => {
  it('treats the pattern as literal text with * as the only wildcard', () => {
    expect('a.b'.replace(globToRegExp('a.b'), '')).toBe('')
    expect('axb'.replace(globToRegExp('a.b'), '')).toBe('axb') // the dot is a dot, not "any character"
    expect('"generated_at": "2026-09-16T10:00:00Z",'.replace(globToRegExp('"generated_at": "*"'), '')).toBe(',')
    expect('a\nb'.replace(globToRegExp('a*b'), '')).toBe('a\nb') // a wildcard never crosses a line
  })

  it('cannot express the patterns that hang a process', () => {
    // the literal characters of a catastrophic regex are just characters here
    const re = globToRegExp('(a|a)+$')
    const s = 'a'.repeat(40) + 'b'
    const t = Date.now()
    expect(s.replace(re, '')).toBe(s)
    expect(Date.now() - t).toBeLessThan(50)
    expect('x(a|a)+$y'.replace(re, '')).toBe('xy')
  })
})

describe('normalise', () => {
  it('compares readable text plus the title and link targets, not markup', () => {
    const a = normalise(html('39'), 'text/html')
    expect(a.kind).toBe('html')
    expect(a.content).toContain('[title] Pricing')
    expect(a.content).toContain('Price: 39 USD / month')
    expect(a.content).not.toContain('<p>')
    // a link whose text stays but whose target moves is a change (it was invisible before)
    const v1 = normalise(html('39', '<a href="https://x.test/v2.0.zip">Download latest</a>'), 'text/html')
    const v2 = normalise(html('39', '<a href="https://x.test/v2.1.zip">Download latest</a>'), 'text/html')
    expect(v1.full).not.toBe(v2.full)
  })

  it('unifies line endings, non-breaking spaces and Unicode form', () => {
    expect(normalise('a\r\nb', 'text/plain').full).toBe('a\nb')
    expect(normalise('a b', 'text/plain').full).toBe('a b')
    expect(normalise('Café', 'text/plain').full).toBe('Café'.normalize('NFC'))
  })

  it('freezes how a target is read, so a content sniffer cannot flip the mode between checks', () => {
    const asText = normalise('a log line with <div> in it', 'text/plain', { kind: 'text' })
    expect(asText.kind).toBe('text')
    expect(asText.full).toContain('<div>')
    expect(normalise('a log line with <div> in it', 'text/plain').kind).toBe('html') // what the first check would have decided
  })

  it('keeps only the lines a selector names, and removes what ignore matches', () => {
    expect(normalise(html('39'), 'text/html', { selector: 'Price:' }).content).toBe('Price: 39 USD / month')
    expect(normalise('Price: 39 USD\nGenerated at 2026-09-16T10:00:00Z', 'text/plain', { ignore: ['Generated at *'] }).full).toBe('Price: 39 USD')
  })

  it('hashes the whole page but can only show the first 8,000 characters', () => {
    const long = 'x'.repeat(9_000) + '\nTHE CHANGE'
    const n = normalise(long, 'text/plain')
    expect(n.content).toHaveLength(8_000)
    expect(n.clipped).toBe(true)
    expect(n.full.length).toBe(long.length)
  })
})

describe('canonicalJson', () => {
  it('sorts keys but keeps long numbers digit for digit', () => {
    expect(canonicalJson('{"b":2,"a":{"d":4,"c":3}}')).toBe(canonicalJson('{"a":{"c":3,"d":4},"b":2}'))
    // JSON.parse would turn both of these into 1000000000000000000 and call them equal
    expect(canonicalJson('{"wei":1000000000000000001}')).not.toBe(canonicalJson('{"wei":1000000000000000002}'))
    expect(canonicalJson('{"wei":1000000000000000001}')).toContain('1000000000000000001')
    expect(canonicalJson('{not json')).toBe('{not json')
  })
})

describe('lineDiff', () => {
  it('counts lines with their multiplicity and names a pure reordering', () => {
    expect(lineDiff('a\nb\nc', 'a\nc\nd')).toMatchObject({ added: ['d'], removed: ['b'], reordered: false })
    // a set-based diff answered "changed" with an empty diff here
    expect(lineDiff('A\nB\nB', 'A\nB')).toMatchObject({ added: [], removed: ['B'], reordered: false })
    expect(lineDiff('a\nb', 'b\na')).toMatchObject({ added: [], removed: [], reordered: true })
    const many = lineDiff('', Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n'))
    expect(many.added).toHaveLength(40)
    expect(many.truncated).toBe(true)
  })
})

describe('targetOf', () => {
  it('normalises the URL and the ignore order, so the same watch is the same watch', () => {
    expect(targetOf({ url: 'https://Example.com/p#top' })).toBe(targetOf({ url: 'https://example.com/p' }))
    expect(targetOf({ url: 'https://example.com/p', ignore: ['b', 'a'] })).toBe(targetOf({ url: 'https://example.com/p', ignore: ['a', 'b'] }))
    expect(targetOf({ url: 'https://example.com/p' })).not.toBe(targetOf({ url: 'https://example.com/p', selector: 'Price:' }))
  })
})

describe('url-diff service (ADR-73)', () => {
  it('declines bad input, unknown fields, private targets and too many wildcards - before accepting', async () => {
    const { store } = fakeStore()
    const svc = urlDiff({ hostFetchesPerMinute: 10_000, store, env: 'test', fetchImpl: fakeFetch({}).impl })
    expect(await svc.validate({}, ctx)).toMatch(/url must be/)
    expect(await svc.validate({ url: 'ftp://x/y' }, ctx)).toMatch(/only http/)
    expect(await svc.validate({ url: `${HOST}/p`, every: 60 }, ctx)).toMatch(/unknown field\(s\): every/)
    expect(await svc.validate({ url: `${HOST}/p`, selector: '' }, ctx)).toMatch(/selector must be/)
    expect(await svc.validate({ url: `${HOST}/p`, ignore: 'nope' }, ctx)).toMatch(/ignore must be an array/)
    expect(await svc.validate({ url: `${HOST}/p`, ignore: ['*a*b*c*'] }, ctx)).toMatch(/wildcards/)
    expect(await svc.validate({ url: `${HOST}/p`, reset: 'yes' }, ctx)).toMatch(/reset must be/)
    // the listing promises private addresses are refused BEFORE the job is accepted
    expect(await svc.validate({ url: 'http://127.0.0.1/x' }, ctx)).toMatch(/private|loopback|not public/i)
    expect(await svc.validate({ url: `${HOST}/p` }, ctx)).toBeNull()
  })

  it('refuses to work without knowing the buyer: a snapshot per URL would show one buyer another one history', async () => {
    const { store } = fakeStore()
    const svc = urlDiff({ hostFetchesPerMinute: 10_000, store, env: 'test', fetchImpl: fakeFetch({ '/p': html('39') }).impl })
    expect(await svc.validate({ url: `${HOST}/p` }, { units: 1 })).toMatch(/which buyer is asking/)
    await expect(svc.run({ url: `${HOST}/p` }, { units: 1 })).rejects.toThrow(/no buyer/)
  })

  it('stores nothing until the buyer has the answer', async () => {
    const { store, kv, ttls } = fakeStore()
    const svc = urlDiff({ hostFetchesPerMinute: 10_000, store, env: 'test', fetchImpl: fakeFetch({ '/p': html('39') }).impl })
    const r = await svc.run({ url: `${HOST}/p` }, ctx)
    expect(kv.size).toBe(0) // run() alone changes nothing: the delivery may still fail
    await r.commit!()
    expect(kv.size).toBe(1)
    expect(ttls).toEqual([30 * 86_400])
  })

  it('a delivery that never arrives does not cost the buyer its change', async () => {
    const { store, kv } = fakeStore()
    const bodies: Record<string, string> = { '/p': html('39') }
    const svc = urlDiff({ hostFetchesPerMinute: 10_000, store, env: 'test', fetchImpl: fakeFetch(bodies).impl })
    await runAndDeliver(svc, { url: `${HOST}/p` })
    bodies['/p'] = html('49')
    const lost = await svc.run({ url: `${HOST}/p` }, ctx) // the x402 buyer stopped waiting: no commit
    expect((lost.output as Record<string, unknown>).changed).toBe(true)
    expect([...kv.values()][0].content).toContain('39') // still the last content the buyer really saw
    const again = await runAndDeliver(svc, { url: `${HOST}/p` })
    expect((again.output as Record<string, unknown>).changed).toBe(true) // reported again, not swallowed
  })

  it('stores a baseline on the first check and never calls it a change', async () => {
    const { store, kv } = fakeStore()
    const svc = urlDiff({ hostFetchesPerMinute: 10_000, store, env: 'test', fetchImpl: fakeFetch({ '/p': html('39') }).impl, now: () => Date.parse('2026-09-16T10:00:00Z') })
    const r = await runAndDeliver(svc, { url: `${HOST}/p`, label: 'competitor' })
    expect(r.output).toMatchObject({ first_check: true, changed: false, checks: 1, previous_hash: null, diff: null, label: 'competitor', content_kind: 'html', fetch_ok: true, clipped: false })
    expect(kv.size).toBe(1)
    expect([...kv.keys()][0]).toBe(snapshotKey('test', 'agt_buyer1', targetOf({ url: `${HOST}/p` })))
    expect(r.message).toContain('baseline stored')
  })

  it('answers unchanged, then the difference, and remembers when it last changed', async () => {
    const { store } = fakeStore()
    const bodies: Record<string, string> = { '/p': html('39') }
    let t = Date.parse('2026-09-16T10:00:00Z')
    const svc = urlDiff({ hostFetchesPerMinute: 10_000, store, env: 'test', fetchImpl: fakeFetch(bodies).impl, now: () => t })
    await runAndDeliver(svc, { url: `${HOST}/p` })
    t += 3_600_000
    expect((await runAndDeliver(svc, { url: `${HOST}/p` })).output).toMatchObject({ changed: false, checks: 2, diff: null, last_change_at: null })
    t += 3_600_000
    bodies['/p'] = html('49')
    const moved = (await runAndDeliver(svc, { url: `${HOST}/p` })).output as Record<string, unknown>
    expect(moved).toMatchObject({ changed: true, checks: 3, last_change_at: '2026-09-16T12:00:00.000Z' })
    expect(moved.diff).toMatchObject({ added: ['Price: 49 USD / month'], removed: ['Price: 39 USD / month'] })
    t += 3_600_000
    expect((await runAndDeliver(svc, { url: `${HOST}/p` })).output).toMatchObject({ changed: false, checks: 4, last_change_at: '2026-09-16T12:00:00.000Z' })
  })

  it('delivers an unreachable target as news, keeps the snapshot, and does not fail the job', async () => {
    const { store, kv } = fakeStore()
    const bodies: Record<string, string | { body: string; status?: number; throws?: Error }> = { '/p': html('39') }
    const svc = urlDiff({ hostFetchesPerMinute: 10_000, store, env: 'test', fetchImpl: fakeFetch(bodies).impl })
    await runAndDeliver(svc, { url: `${HOST}/p` })
    const before = [...kv.values()][0]

    bodies['/p'] = { body: 'down', status: 503 }
    const down = await runAndDeliver(svc, { url: `${HOST}/p` })
    expect(down.output).toMatchObject({ fetch_ok: false, http_status: 503, changed: false, error: expect.stringContaining('HTTP 503') })
    expect(down.message).toContain('stored snapshot is unchanged')

    bodies['/p'] = { body: '', throws: new TypeError('fetch failed') }
    const gone = await runAndDeliver(svc, { url: `${HOST}/p` })
    expect(gone.output).toMatchObject({ fetch_ok: false, http_status: null, changed: false })
    expect([...kv.values()][0].content).toBe(before.content) // the outage never touched the baseline

    bodies['/p'] = html('49')
    expect((await runAndDeliver(svc, { url: `${HOST}/p` })).output).toMatchObject({ changed: true, fetch_ok: true })
  })

  it('keeps the baseline when a target briefly returns nothing, instead of raising two alarms', async () => {
    const { store, kv } = fakeStore()
    const bodies: Record<string, string> = { '/p': html('39') }
    const svc = urlDiff({ hostFetchesPerMinute: 10_000, store, env: 'test', fetchImpl: fakeFetch(bodies).impl })
    await runAndDeliver(svc, { url: `${HOST}/p`, selector: 'Price:' })
    bodies['/p'] = '<html><body><main><p>Maintenance</p></main></body></html>'
    const blank = await runAndDeliver(svc, { url: `${HOST}/p`, selector: 'Price:' })
    expect(blank.output).toMatchObject({ content_empty: true, changed: false, selector_matched: 0 })
    expect(blank.message).toContain('kept rather than replaced by emptiness')
    expect([...kv.values()][0].content).toBe('Price: 39 USD / month')
    bodies['/p'] = html('39')
    expect((await runAndDeliver(svc, { url: `${HOST}/p`, selector: 'Price:' })).output).toMatchObject({ changed: false }) // no phantom "it is back"
  })

  it('says so when a selector matches nothing and when the page is longer than the diff can show', async () => {
    const { store } = fakeStore()
    const long = Array.from({ length: 2000 }, (_, i) => `filler line ${i}`).join('\n')
    const svc = urlDiff({ hostFetchesPerMinute: 10_000, store, env: 'test', fetchImpl: fakeFetch({ '/p': html('39'), '/long': { body: long, type: 'text/plain' } }).impl })
    const miss = await runAndDeliver(svc, { url: `${HOST}/p`, selector: 'Preis:' })
    expect(miss.output).toMatchObject({ selector_matched: 0, content_chars: 0 })
    expect(miss.message).toContain('matched no line')
    const big = await runAndDeliver(svc, { url: `${HOST}/long` })
    expect(big.output).toMatchObject({ clipped: true, content_chars: 8_000 })
    expect(big.message).toContain('longer than the 8000 characters')
  })

  it('reports a change beyond the 8,000 characters it can show, instead of missing it', async () => {
    const { store } = fakeStore()
    const bodies: Record<string, { body: string; type: string }> = { '/p': { body: 'x'.repeat(9_000) + '\nversion 1', type: 'text/plain' } }
    const svc = urlDiff({ hostFetchesPerMinute: 10_000, store, env: 'test', fetchImpl: fakeFetch(bodies).impl })
    await runAndDeliver(svc, { url: `${HOST}/p` })
    bodies['/p'] = { body: 'x'.repeat(9_000) + '\nversion 2', type: 'text/plain' }
    const r = await runAndDeliver(svc, { url: `${HOST}/p` })
    expect(r.output).toMatchObject({ changed: true, clipped: true })
    expect((r.output as { diff: { added: string[] } }).diff.added).toEqual([]) // the hash saw it; the diff could not
  })

  it('keeps buyers apart: two buyers watching the same URL have their own history', async () => {
    const { store, kv } = fakeStore()
    const bodies: Record<string, string> = { '/p': html('39') }
    const svc = urlDiff({ hostFetchesPerMinute: 10_000, store, env: 'test', fetchImpl: fakeFetch(bodies).impl })
    await runAndDeliver(svc, { url: `${HOST}/p` }, { units: 1, buyer: 'agt_a' })
    bodies['/p'] = html('49')
    expect((await runAndDeliver(svc, { url: `${HOST}/p` }, { units: 1, buyer: 'agt_b' })).output).toMatchObject({ first_check: true, changed: false })
    expect((await runAndDeliver(svc, { url: `${HOST}/p` }, { units: 1, buyer: 'agt_a' })).output).toMatchObject({ first_check: false, changed: true })
    expect(kv.size).toBe(2)
  })

  it('lets a buyer clear a watch with reset, so its limit is not a 30-day sentence', async () => {
    const { store, kv } = fakeStore()
    const svc = urlDiff({ hostFetchesPerMinute: 10_000, store, env: 'test', fetchImpl: fakeFetch({ '/p': html('39') }).impl })
    await runAndDeliver(svc, { url: `${HOST}/p` })
    const fresh = await runAndDeliver(svc, { url: `${HOST}/p`, reset: true })
    expect(fresh.output).toMatchObject({ first_check: true, checks: 1 })
    expect(kv.size).toBe(1)
  })

  it('stops a buyer at its own limit and everybody at the storage limit, before accepting', async () => {
    const { store, kv } = fakeStore()
    const svc = urlDiff({ hostFetchesPerMinute: 10_000, store, env: 'test', fetchImpl: fakeFetch({ '/p': html('39') }).impl })
    const snap: Snapshot = { hash: 'h', content: 'c', kind: 'text', checked_at: '2026-09-16T10:00:00.000Z', checks: 1, last_change_at: null }
    for (let i = 0; i < 25; i++) kv.set(snapshotKey('test', 'agt_buyer1', `t${i}`), snap)
    expect(await svc.validate({ url: `${HOST}/p` }, ctx)).toMatch(/already watching 25 targets/)
    expect(await svc.validate({ url: `${HOST}/p` }, { units: 1, buyer: 'agt_other' })).toBeNull()
    // and the service as a whole stops before it can fill the identity's 1,000 memory keys
    for (let b = 0; b < 24; b++) for (let i = 0; i < 25; i++) kv.set(snapshotKey('test', `agt_filler${b}`, `t${i}`), snap)
    expect(kv.size).toBeGreaterThanOrEqual(600)
    expect(await svc.validate({ url: `${HOST}/p` }, { units: 1, buyer: 'agt_new' })).toMatch(/storage limit/)
  })

  it('fetches one target host at most 20 times a minute across all buyers, and says so instead of queueing', async () => {
    _resetHostBudgetForTests() // the budget is process-wide: it belongs to the target site, not to a service instance
    const { store, kv } = fakeStore()
    const svc = urlDiff({ hostFetchesPerMinute: 2, store, env: 'test', fetchImpl: fakeFetch({ '/a': html('39'), '/b': html('39'), '/c': html('39') }).impl })
    expect((await runAndDeliver(svc, { url: `${HOST}/a` })).output).toMatchObject({ fetch_ok: true })
    expect((await runAndDeliver(svc, { url: `${HOST}/b` })).output).toMatchObject({ fetch_ok: true })
    const third = await runAndDeliver(svc, { url: `${HOST}/c` })
    expect(third.output).toMatchObject({ fetch_ok: false, changed: false })
    expect((third.output as { error: string }).error).toContain('at most 2 times a minute')
    // nothing was fetched, so nothing is stored: the next readable check of that target is its first one
    expect(kv.size).toBe(2)
    expect((await runAndDeliver(svc, { url: `${HOST}/c` })).output).toMatchObject({ fetch_ok: false })
  })

  it('the listing example is the shape run() returns, and the price is what a deterministic check costs', async () => {
    const { store } = fakeStore()
    const svc = urlDiff({ hostFetchesPerMinute: 10_000, store, env: 'test', fetchImpl: fakeFetch({ '/p': html('39') }).impl })
    const real = (await runAndDeliver(svc, { url: `${HOST}/p`, selector: 'Price:', label: 'competitor pricing' })).output as Record<string, unknown>
    expect(Object.keys(svc.listing.example_output as object).sort()).toEqual(Object.keys(real).sort())
    expect(svc.listing.price).toBe(10_000) // at or above the platform's own OUTSIDER_PRICE_FLOOR, or no purchase counts
    expect(JSON.stringify(svc.listing.description)).toContain('25 watches per buyer')
    expect(JSON.stringify(svc.listing.description)).toContain('globs, not regular expressions')
  })
})

/**
 * ADR-80: the glob was safe from exponential blow-up and still polynomial - k stars over a line of n characters cost
 * about n^(k+1) in V8. Three stars over 2,000 characters took 54 s; the same removal on RE2 is one pass.
 */
describe('removeGlob (ADR-80)', () => {
  it('removes what globToRegExp matched, in linear time', () => {
    const line = 'a'.repeat(1700) + 'b'.repeat(1700) + 'c'.repeat(1700)
    const t = Date.now()
    expect(removeGlob(line, 'a*b*c*d')).toBe(line)
    expect(Date.now() - t).toBeLessThan(1000)
  })

  it('matches exactly what the regex matched on ordinary input', () => {
    const samples = ['"generated_at": "2026-09-16T10:00:00Z",', 'a.b axb', 'a\nb', 'x(a|a)+$y', 'Price: 39 USD\nUpdated: today 10:00', 'sid=abc123; sid=def456']
    const patterns = ['"generated_at": "*"', 'a.b', 'a*b', '(a|a)+$', 'Updated: *', 'sid=*;', '*']
    for (const s of samples) for (const p of patterns) expect(removeGlob(s, p)).toBe(s.replace(globToRegExp(p), ''))
  })
})
