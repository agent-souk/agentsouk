import { describe, it, expect } from 'vitest'
import { lineDiff, normalise, snapshotKey, urlDiff, type MemoryStore, type Snapshot } from './url-diff.js'

/* ---------- a store like platform memory, and a fetch we control ---------- */

function fakeStore() {
  const kv = new Map<string, Snapshot>()
  const calls = { get: 0, set: 0, list: 0 }
  const store: MemoryStore = {
    get: async (k) => {
      calls.get++
      return kv.get(k) ?? null
    },
    set: async (k, v) => {
      calls.set++
      kv.set(k, v)
    },
    list: async (prefix) => {
      calls.list++
      return [...kv.keys()].filter((k) => k.startsWith(prefix))
    },
  }
  return { store, kv, calls }
}

const HOST = 'http://93.184.216.34'
const page = (body: string, type = 'text/html') => new Response(body, { status: 200, headers: { 'content-type': type } })
function fakeFetch(bodies: Record<string, string | { body: string; type?: string; status?: number }>) {
  const seen: string[] = []
  const impl: typeof fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    seen.push(url)
    const b = bodies[url.replace(HOST, '')]
    if (b === undefined) return new Response('nope', { status: 500 })
    if (typeof b === 'string') return page(b)
    return new Response(b.body, { status: b.status ?? 200, headers: { 'content-type': b.type ?? 'text/html' } })
  }) as typeof fetch
  return { impl, seen }
}

const html = (price: string, noise = '') => `<html><head><title>Pricing</title></head><body><main><p>Price: ${price} USD / month</p><p>Support included</p>${noise}</main></body></html>`
const ctx = { units: 1, buyer: 'agt_buyer1' }

describe('normalise', () => {
  it('compares readable text, not markup', () => {
    const a = normalise(html('39'), 'text/html')
    expect(a.kind).toBe('html')
    expect(a.content).toContain('Price: 39 USD / month')
    expect(a.content).not.toContain('<p>')
    // the same page with different markup and whitespace is not a change
    const b = normalise('<html><body><main>\n\n  <div>Price: 39 USD / month</div>\n  <div>Support   included</div>\n</main></body></html>', 'text/html')
    expect(b.content).toBe(a.content)
  })

  it('sorts JSON keys, so a reordered response is not a change', () => {
    const a = normalise('{"b":2,"a":{"d":4,"c":3}}', 'application/json')
    const b = normalise('{"a":{"c":3,"d":4},"b":2}', 'application/json')
    expect(a.kind).toBe('json')
    expect(a.content).toBe(b.content)
  })

  it('keeps only the lines a selector names, and removes what ignore matches', () => {
    expect(normalise(html('39'), 'text/html', { selector: 'Price:' }).content).toBe('Price: 39 USD / month')
    const withClock = normalise('Price: 39 USD\nGenerated at 2026-09-16T10:00:00Z', 'text/plain', { ignore: ['Generated at \\S+'] })
    expect(withClock.content).toBe('Price: 39 USD')
  })

  it('caps what it stores and falls back to the raw body when JSON does not parse', () => {
    expect(normalise('x'.repeat(20_000), 'text/plain').content).toHaveLength(8_000)
    expect(normalise('{not json', 'application/json').content).toBe('{not json')
  })
})

describe('lineDiff', () => {
  it('reports added and removed lines and flags a diff that had to be cut', () => {
    expect(lineDiff('a\nb\nc', 'a\nc\nd')).toEqual({ added: ['d'], removed: ['b'], truncated: false })
    expect(lineDiff('', 'a')).toEqual({ added: ['a'], removed: [], truncated: false })
    const many = lineDiff('', Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n'))
    expect(many.added).toHaveLength(40)
    expect(many.truncated).toBe(true)
  })
})

describe('url-diff service (ADR-73)', () => {
  it('declines bad input, unknown fields, private hosts and a pattern that could hang the machine', async () => {
    const { store } = fakeStore()
    const svc = urlDiff({ store, env: 'test', fetchImpl: fakeFetch({}).impl })
    expect(await svc.validate({}, ctx)).toMatch(/url must be/)
    expect(await svc.validate({ url: 'ftp://x/y' }, ctx)).toMatch(/only http/)
    expect(await svc.validate({ url: `${HOST}/p`, every: 60 }, ctx)).toMatch(/unknown field\(s\): every/)
    expect(await svc.validate({ url: `${HOST}/p`, selector: '' }, ctx)).toMatch(/selector must be/)
    expect(await svc.validate({ url: `${HOST}/p`, ignore: 'nope' }, ctx)).toMatch(/ignore must be an array/)
    expect(await svc.validate({ url: `${HOST}/p`, ignore: ['(a+)+$'] }, ctx)).toMatch(/nests quantifiers/)
    expect(await svc.validate({ url: `${HOST}/p`, ignore: ['[unclosed'] }, ctx)).toMatch(/not a valid regular expression/)
    expect(await svc.validate({ url: `${HOST}/p` }, ctx)).toBeNull()
  })

  it('refuses to work without knowing the buyer: a snapshot per URL would answer one buyer with another one history', async () => {
    const { store } = fakeStore()
    const svc = urlDiff({ store, env: 'test', fetchImpl: fakeFetch({ '/p': html('39') }).impl })
    expect(await svc.validate({ url: `${HOST}/p` }, { units: 1 })).toMatch(/which buyer is asking/)
    await expect(svc.run({ url: `${HOST}/p` }, { units: 1 })).rejects.toThrow(/no buyer/)
  })

  it('stores a baseline on the first check and never calls it a change', async () => {
    const { store, kv } = fakeStore()
    const f = fakeFetch({ '/p': html('39') })
    const svc = urlDiff({ store, env: 'test', fetchImpl: f.impl, now: () => Date.parse('2026-09-16T10:00:00Z') })
    const r = await svc.run({ url: `${HOST}/p`, label: 'competitor' }, ctx)
    const o = r.output as Record<string, unknown>
    expect(o).toMatchObject({ first_check: true, changed: false, checks: 1, previous_hash: null, previous_checked_at: null, last_change_at: null, diff: null, label: 'competitor', content_kind: 'html' })
    expect(o.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(String(o.snippet)).toContain('Price: 39')
    expect(kv.size).toBe(1)
    expect([...kv.keys()][0]).toBe(snapshotKey('test', 'agt_buyer1', JSON.stringify([`${HOST}/p`, null, null])))
    expect(r.message).toContain('baseline stored')
  })

  it('answers unchanged, then the difference, and remembers when it last changed', async () => {
    const { store } = fakeStore()
    const bodies: Record<string, string> = { '/p': html('39') }
    const f = fakeFetch(bodies)
    let t = Date.parse('2026-09-16T10:00:00Z')
    const svc = urlDiff({ store, env: 'test', fetchImpl: f.impl, now: () => t })
    await svc.run({ url: `${HOST}/p` }, ctx) // baseline

    t += 3_600_000
    const same = (await svc.run({ url: `${HOST}/p` }, ctx)).output as Record<string, unknown>
    expect(same).toMatchObject({ changed: false, first_check: false, checks: 2, diff: null, last_change_at: null })
    expect(same.previous_checked_at).toBe('2026-09-16T10:00:00.000Z')

    t += 3_600_000
    bodies['/p'] = html('49')
    const moved = (await svc.run({ url: `${HOST}/p` }, ctx)).output as Record<string, unknown>
    expect(moved).toMatchObject({ changed: true, checks: 3, last_change_at: '2026-09-16T12:00:00.000Z' })
    expect(moved.diff).toEqual({ added: ['Price: 49 USD / month'], removed: ['Price: 39 USD / month'], truncated: false })

    // and the new content becomes the baseline, so the next identical check is quiet again
    t += 3_600_000
    const quiet = (await svc.run({ url: `${HOST}/p` }, ctx)).output as Record<string, unknown>
    expect(quiet).toMatchObject({ changed: false, checks: 4, last_change_at: '2026-09-16T12:00:00.000Z' })
  })

  it('keeps buyers apart: two buyers watching the same URL have their own history', async () => {
    const { store, kv } = fakeStore()
    const bodies: Record<string, string> = { '/p': html('39') }
    const svc = urlDiff({ store, env: 'test', fetchImpl: fakeFetch(bodies).impl })
    await svc.run({ url: `${HOST}/p` }, { units: 1, buyer: 'agt_a' })
    bodies['/p'] = html('49')
    // the second buyer has never seen this target: its first check is a baseline, not a change
    const b = (await svc.run({ url: `${HOST}/p` }, { units: 1, buyer: 'agt_b' })).output as Record<string, unknown>
    expect(b).toMatchObject({ first_check: true, changed: false })
    // and the first buyer still sees its own move
    const a = (await svc.run({ url: `${HOST}/p` }, { units: 1, buyer: 'agt_a' })).output as Record<string, unknown>
    expect(a).toMatchObject({ first_check: false, changed: true })
    expect(kv.size).toBe(2)
  })

  it('treats a different selector or ignore list as a different watch', async () => {
    const { store, kv } = fakeStore()
    const svc = urlDiff({ store, env: 'test', fetchImpl: fakeFetch({ '/p': html('39') }).impl })
    await svc.run({ url: `${HOST}/p` }, ctx)
    await svc.run({ url: `${HOST}/p`, selector: 'Price:' }, ctx)
    await svc.run({ url: `${HOST}/p`, ignore: ['Support'] }, ctx)
    expect(kv.size).toBe(3)
  })

  it('stops a buyer at its watch limit but lets it keep checking the watches it has', async () => {
    const { store, kv } = fakeStore()
    const svc = urlDiff({ store, env: 'test', fetchImpl: fakeFetch({ '/p': html('39') }).impl })
    for (let i = 0; i < 25; i++) kv.set(snapshotKey('test', 'agt_buyer1', `t${i}`), { hash: 'h', content: 'c', checked_at: '2026-09-16T10:00:00.000Z', checks: 1, last_change_at: null })
    expect(await svc.validate({ url: `${HOST}/p` }, ctx)).toMatch(/already watching 25 targets/)
    // another buyer is unaffected, and an existing target of this buyer is still allowed
    expect(await svc.validate({ url: `${HOST}/p` }, { units: 1, buyer: 'agt_other' })).toBeNull()
    kv.set(snapshotKey('test', 'agt_buyer1', JSON.stringify([`${HOST}/p`, null, null])), { hash: 'h', content: 'c', checked_at: '2026-09-16T10:00:00.000Z', checks: 1, last_change_at: null })
    expect(await svc.validate({ url: `${HOST}/p` }, ctx)).toBeNull()
  })

  it('does not overwrite the snapshot when the target is down, so the next good check still compares', async () => {
    const { store, kv } = fakeStore()
    const bodies: Record<string, string | { body: string; status?: number }> = { '/p': html('39') }
    const svc = urlDiff({ store, env: 'test', fetchImpl: fakeFetch(bodies).impl })
    await svc.run({ url: `${HOST}/p` }, ctx)
    const before = [...kv.values()][0]
    bodies['/p'] = { body: 'error', status: 503 }
    await expect(svc.run({ url: `${HOST}/p` }, ctx)).rejects.toThrow(/HTTP 503/)
    expect([...kv.values()][0]).toEqual(before)
    bodies['/p'] = html('49')
    const after = (await svc.run({ url: `${HOST}/p` }, ctx)).output as Record<string, unknown>
    expect(after).toMatchObject({ changed: true, checks: 2 })
  })

  it('says so when a selector matches nothing: a silent empty watch would never report a change', async () => {
    const { store } = fakeStore()
    const svc = urlDiff({ store, env: 'test', fetchImpl: fakeFetch({ '/p': html('39') }).impl })
    const r = await svc.run({ url: `${HOST}/p`, selector: 'Preis:' }, ctx)
    const o = r.output as Record<string, unknown>
    expect(o).toMatchObject({ selector_matched: 0, content_chars: 0, changed: false })
    expect(r.message).toContain('matched no line')
    expect(r.preview).toMatchObject({ selector_matched: 0 })
    // a selector that hits reports how many lines it kept
    const hit = (await svc.run({ url: `${HOST}/p`, selector: 'Price:' }, ctx)).output as Record<string, unknown>
    expect(hit).toMatchObject({ selector_matched: 1, clipped: false })
  })

  it('says so when the page is longer than what is compared, instead of watching a third of it quietly', async () => {
    const { store } = fakeStore()
    const long = 'line one\n' + Array.from({ length: 2000 }, (_, i) => `filler line ${i}`).join('\n')
    const svc = urlDiff({ store, env: 'test', fetchImpl: fakeFetch({ '/p': { body: long, type: 'text/plain' } }).impl })
    const r = await svc.run({ url: `${HOST}/p` }, ctx)
    expect(r.output).toMatchObject({ clipped: true, content_chars: 8_000 })
    expect(r.message).toContain('only the first 8000 characters')
  })

  it('the listing example is the shape run() returns, and the price is what a deterministic check costs', async () => {
    const { store } = fakeStore()
    const svc = urlDiff({ store, env: 'test', fetchImpl: fakeFetch({ '/p': html('39') }).impl })
    const real = (await svc.run({ url: `${HOST}/p`, selector: 'Price:', label: 'competitor pricing' }, ctx)).output as Record<string, unknown>
    expect(Object.keys(svc.listing.example_output as object).sort()).toEqual(Object.keys(real).sort())
    expect(svc.listing.price).toBe(2_000)
    expect(svc.listing.pricing_model ?? 'fixed').toBe('fixed')
    expect(JSON.stringify(svc.listing.description)).toContain('25 watches per buyer')
  })
})
