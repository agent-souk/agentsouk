import { generateKeyPairSync, verify as cryptoVerify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { hexToBytes } from '@noble/hashes/utils.js'
import { authorizationDigest, CHAINS, privateKeyToAddress } from './usdc.js'
import { bazaarOutcome, CatalogRegistrar, cdpFacilitator, cdpJwt, fingerprintOf, platformMemoryStore, type PersistedRun, type RegistrarFetch, type RegistrarStore } from './bazaar.js'

const PK = '0x' + '22'.repeat(32)
const ME = privateKeyToAddress(PK)
const PAY_TO = '0xA0a2494006B72109137630bC026434a809731c07'
const BASE = 'https://api.example.test'
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64')
const NONCE = '0x' + 'ab'.repeat(32)
const T0 = 1_800_000_000_000

type Svc = { listing_id: string; price: number; pay_to?: string; title?: string; example_input?: unknown; input_schema?: unknown; amount402?: number; payTo402?: string }

/** A fake platform + facilitators: the index, one 402 per listing, and /verify that records what it was handed. */
function world(opts: { services?: Svc[]; verify?: (name: string, body: any, headers: Record<string, string>) => { status: number; body: unknown; ext?: unknown } } = {}) {
  const services = opts.services ?? [{ listing_id: 'lst_a', price: 2000, title: 'Snapshot', example_input: { token: 'usdc' } }]
  const calls: { url: string; init?: { method?: string; headers?: Record<string, string>; body?: string; redirect?: string } }[] = []
  const f: RegistrarFetch = async (url, init) => {
    calls.push({ url, init })
    const headers = new Map<string, string>()
    const answer = (status: number, body: unknown, extra: Record<string, string> = {}) => {
      for (const [k, v] of Object.entries(extra)) headers.set(k.toLowerCase(), v)
      return { status, headers: { get: (n: string) => headers.get(n.toLowerCase()) ?? null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) }
    }
    if (url.startsWith(`${BASE}/v1/x402?`)) return answer(200, { object: 'x402_index', services: services.map((s) => ({ listing_id: s.listing_id, price: s.price, pay_to: s.pay_to ?? PAY_TO, title: s.title, example_input: s.example_input, input_schema: s.input_schema, url: `${BASE}/v1/x402/${s.listing_id}`, tags: ['base'] })) })
    const m = url.match(/\/v1\/x402\/(lst_\w+)$/)
    if (m) {
      const s = services.find((x) => x.listing_id === m[1])!
      const pr = {
        x402Version: 2,
        resource: { url, description: s.title ?? 'thing', mimeType: 'application/json', serviceName: 'Agent Souk', tags: ['base'], iconUrl: `${BASE}/icon.png` },
        accepts: [{ scheme: 'exact', network: 'eip155:84532', amount: String(s.amount402 ?? s.price), asset: CHAINS.test.usdc, payTo: s.payTo402 ?? PAY_TO, maxTimeoutSeconds: 900, extra: { name: 'USDC', version: '2' } }],
        error: 'pay',
        extensions: { bazaar: { info: { input: { type: 'http', method: 'POST', bodyType: 'json', body: s.example_input ?? {} }, output: { type: 'json' } }, schema: { type: 'object' } } },
      }
      return answer(402, { x402Version: 1, accepts: [] }, { 'PAYMENT-REQUIRED': b64(pr) })
    }
    const v = url.match(/^(.*)\/verify$/)
    if (v) {
      const name = v[1]!.includes('cdp') ? 'cdp' : 'payai'
      const r = opts.verify ? opts.verify(name, JSON.parse(init?.body ?? '{}'), init?.headers ?? {}) : { status: 200, body: { isValid: true, payer: ME }, ext: { bazaar: { status: 'processing' } } }
      return answer(r.status, r.body, r.ext ? { 'EXTENSION-RESPONSES': b64(r.ext) } : {})
    }
    return answer(404, 'no')
  }
  return { fetch: f, calls, services, verifies: () => calls.filter((c) => c.url.endsWith('/verify')).length, indexReads: () => calls.filter((c) => c.url.startsWith(`${BASE}/v1/x402?`)).length }
}

function memoryStore(initial: PersistedRun | null = null): RegistrarStore & { saved: PersistedRun[] } {
  let current = initial
  const saved: PersistedRun[] = []
  return { saved, load: async () => current, save: async (run) => { current = run; saved.push(run) } }
}

const PAYAI = { name: 'payai', url: 'https://payai.example' }

describe('catalogue registration (ADR-65)', () => {
  it('answers each 402 with a signed, echoed payload at every facilitator, under our own user agent, and records what they said', async () => {
    let handed: any[] = []
    const w = world({ verify: (name, body, headers) => { handed.push({ name, body, headers }); return { status: 200, body: { isValid: true }, ext: { bazaar: { status: name === 'cdp' ? 'success' : 'processing' } } } } })
    const reg = new CatalogRegistrar({ baseUrl: BASE, env: 'test', chain: CHAINS.test, privateKey: PK, fetchImpl: w.fetch, now: () => T0, randomNonce: () => NONCE, userAgent: 'agentsouk-agents/test', facilitators: [{ ...PAYAI, url: 'https://payai.example/' }, { name: 'cdp', url: 'https://cdp.example/platform/v2/x402', headers: async () => ({ Authorization: 'Bearer t' }) }] })
    expect(await reg.maybeRun()).toBe(true)

    expect(handed).toHaveLength(2)
    const p = handed[0].body.paymentPayload
    // the echo: resource block and extensions exactly as the 402 carried them
    expect(p.resource).toMatchObject({ serviceName: 'Agent Souk', iconUrl: `${BASE}/icon.png`, url: `${BASE}/v1/x402/lst_a` })
    expect(p.extensions.bazaar.info.input.body).toEqual({ token: 'usdc' })
    expect(handed[0].body.paymentRequirements).toEqual(p.accepted)
    // the authorization: our wallet pays the listing price to the seller, for five minutes, and is really signed
    expect(p.payload.authorization).toMatchObject({ from: ME, to: PAY_TO, value: '2000', validAfter: '0', validBefore: String(Math.floor(T0 / 1000) + 300), nonce: NONCE })
    const digest = authorizationDigest(CHAINS.test, { from: ME, to: PAY_TO, value: 2000n, validAfter: 0n, validBefore: BigInt(Math.floor(T0 / 1000) + 300), nonce: NONCE })
    const sig = hexToBytes(p.payload.signature.slice(2))
    expect(secp256k1.verify(sig.slice(0, 64), digest, secp256k1.getPublicKey(hexToBytes(PK.slice(2)), false), { prehash: false })).toBe(true)
    // nothing was settled: only /verify was called, and the auth header reached only the facilitator that wants one
    expect(w.calls.filter((c) => c.url.endsWith('/settle'))).toHaveLength(0)
    expect(handed[1].headers.Authorization).toBe('Bearer t')
    expect(handed[0].headers.Authorization).toBeUndefined()
    // every request - index, 402, verify - names us, so the platform's discovery statistic counts it as ours
    expect(w.calls.every((c) => c.init?.headers?.['user-agent'] === 'agentsouk-agents/test')).toBe(true)

    const st = reg.status()
    expect(st.registrations).toEqual([
      { listing_id: 'lst_a', facilitator: 'payai', verified: true, catalogue: 'processing', reason: null, at: new Date(T0).toISOString() },
      { listing_id: 'lst_a', facilitator: 'cdp', verified: true, catalogue: 'success', reason: null, at: new Date(T0).toISOString() },
    ])
    expect(st.services).toBe(1)
    expect(st.last_run).toBe(new Date(T0).toISOString())
    expect(st.next_run).toBe(new Date(T0 + 86_400_000).toISOString())
  })

  it('runs once a day, checks the index at most hourly in between, and runs again as soon as what a catalogue shows changes', async () => {
    const w = world()
    let now = T0
    const reg = new CatalogRegistrar({ baseUrl: BASE, env: 'test', chain: CHAINS.test, privateKey: PK, fetchImpl: w.fetch, now: () => now, facilitators: [PAYAI] })
    expect(await reg.maybeRun()).toBe(true)
    expect(w.verifies()).toBe(1)
    expect(w.indexReads()).toBe(1)
    now += 600_000
    expect(await reg.maybeRun()).toBe(false) // ten minutes later: not even the index is read again
    expect(w.indexReads()).toBe(1)
    now += 3_600_000
    expect(await reg.maybeRun()).toBe(false) // an hour later, same index: read, nothing to do
    expect(w.indexReads()).toBe(2)
    expect(w.verifies()).toBe(1)
    w.services[0]!.example_input = { token: 'weth' } // the example is what the catalogue shows as the input: stale entry
    now += 3_600_000
    expect(await reg.maybeRun()).toBe(true)
    expect(w.verifies()).toBe(2)
    now += 86_400_000
    expect(await reg.maybeRun()).toBe(true) // a day later: refreshed regardless
    expect(w.verifies()).toBe(3)
  })

  it('remembers the last run in platform memory, so a fresh process after a machine restart does not register again', async () => {
    const w = world()
    const store = memoryStore()
    let now = T0
    const first = new CatalogRegistrar({ baseUrl: BASE, env: 'test', chain: CHAINS.test, privateKey: PK, fetchImpl: w.fetch, now: () => now, facilitators: [PAYAI], store })
    expect(await first.maybeRun()).toBe(true)
    expect(store.saved).toHaveLength(1)
    expect(store.saved[0]).toMatchObject({ last_run: new Date(T0).toISOString(), all_ok: true })
    expect(store.saved[0]!.registrations).toHaveLength(1)

    // the machine slept and was started fresh eight minutes later (what the first audit saw on Fly)
    now += 8 * 60_000
    const fresh = new CatalogRegistrar({ baseUrl: BASE, env: 'test', chain: CHAINS.test, privateKey: PK, fetchImpl: w.fetch, now: () => now, facilitators: [PAYAI], store })
    expect(await fresh.maybeRun()).toBe(false)
    expect(w.verifies()).toBe(1)
    expect(w.indexReads()).toBe(1) // not even the index: the last run is minutes old
    const st = fresh.status()
    expect(st.last_run).toBe(new Date(T0).toISOString())
    expect(st.next_run).toBe(new Date(T0 + 86_400_000).toISOString())
    expect(st.registrations).toHaveLength(1) // shown from memory, so /health is not blank after a restart

    expect(st.services).toBe(1)

    // two hours later another fresh process reads the index once (nothing changed) and remembers that it did,
    // so the process after it, woken half an hour later, does not read it again (the second audit: every wake did)
    now = T0 + 2 * 3_600_000
    const later = new CatalogRegistrar({ baseUrl: BASE, env: 'test', chain: CHAINS.test, privateKey: PK, fetchImpl: w.fetch, now: () => now, facilitators: [PAYAI], store })
    expect(await later.maybeRun()).toBe(false)
    expect(w.indexReads()).toBe(2)
    now += 30 * 60_000
    const next = new CatalogRegistrar({ baseUrl: BASE, env: 'test', chain: CHAINS.test, privateKey: PK, fetchImpl: w.fetch, now: () => now, facilitators: [PAYAI], store })
    expect(await next.maybeRun()).toBe(false)
    expect(w.indexReads()).toBe(2)

    // a day later the fresh process registers
    now = T0 + 86_400_000 + 1
    expect(await fresh.maybeRun()).toBe(true)
    expect(w.verifies()).toBe(2)
  })

  it('does not register while platform memory cannot be read, then retries the read, and registers without it only after the retry delay', async () => {
    const w = world()
    let now = T0
    let down = true
    const saved: PersistedRun[] = []
    const record: PersistedRun = { last_run: new Date(T0 - 10 * 60_000).toISOString(), fingerprint: 'unknown', all_ok: true, registrations: [] }
    const store: RegistrarStore = { load: async () => { if (down) throw new Error('memory down'); return record }, save: async (r) => { saved.push(r) } }
    const reg = new CatalogRegistrar({ baseUrl: BASE, env: 'test', chain: CHAINS.test, privateKey: PK, fetchImpl: w.fetch, now: () => now, facilitators: [PAYAI], store })
    expect(await reg.maybeRun()).toBe(false) // the API restarts: no registration on a guess
    expect(w.indexReads()).toBe(0)
    now += 10 * 60_000
    down = false
    expect(await reg.maybeRun()).toBe(false) // readable again: the run 20 minutes ago counts, nothing is repeated
    expect(w.verifies()).toBe(0)

    const stuck = new CatalogRegistrar({ baseUrl: BASE, env: 'test', chain: CHAINS.test, privateKey: PK, fetchImpl: w.fetch, now: () => now, facilitators: [PAYAI], store: { load: async () => { throw new Error('memory down') }, save: async () => undefined } })
    expect(await stuck.maybeRun()).toBe(false)
    now += 3_600_000
    expect(await stuck.maybeRun()).toBe(true) // unreadable for an hour: a late run, not never
  })

  it('backs off after failed runs and retries only the pairs that did not go through, so one broken facilitator does not re-sign the healthy ones', async () => {
    const w = world({ services: [{ listing_id: 'lst_a', price: 2000 }, { listing_id: 'lst_b', price: 2000 }], verify: (name) => (name === 'cdp' ? { status: 401, body: { error: 'unauthorized' } } : { status: 200, body: { isValid: true }, ext: { bazaar: { status: 'processing' } } }) })
    const byFacilitator = () => ({ payai: w.calls.filter((c) => c.url === 'https://payai.example/verify').length, cdp: w.calls.filter((c) => c.url.startsWith('https://cdp.example')).length })
    const store = memoryStore()
    let now = T0
    const runs: number[] = []
    // a day and a half of wakes every 30 minutes, each a fresh process, CDP refusing throughout
    for (let t = 0; t <= 36 * 60; t += 30) {
      now = T0 + t * 60_000
      const reg = new CatalogRegistrar({ baseUrl: BASE, env: 'test', chain: CHAINS.test, privateKey: PK, fetchImpl: w.fetch, now: () => now, facilitators: [PAYAI, { name: 'cdp', url: 'https://cdp.example' }], store })
      if (await reg.maybeRun()) runs.push(t / 60)
    }
    // 0, then 1, 2, 4, 8, 16 hours after the previous run (1, 3, 7, 15, 31), not every hour
    expect(runs).toEqual([0, 1, 3, 7, 15, 31])
    // PayAI accepted both at hour 0 and signs again only once they are a day old (hour 31); CDP is tried each run
    expect(byFacilitator()).toEqual({ payai: 4, cdp: 12 })
    const last = store.saved.at(-1)!
    expect(last.failures).toBe(6)
    expect(last.all_ok).toBe(false)
    expect(last.registrations!.map((r) => [r.listing_id, r.facilitator, r.verified])).toEqual([['lst_a', 'payai', true], ['lst_a', 'cdp', false], ['lst_b', 'payai', true], ['lst_b', 'cdp', false]])
  })

  it('keeps the run in the platform memory key: never written is "never ran", other read errors surface', async () => {
    const kv = new Map<string, unknown>()
    const notFound = Object.assign(new Error('not found'), { status: 404 })
    const memory = { get: async <T>(k: string) => { if (!kv.has(k)) throw notFound; return { value: kv.get(k) as T } }, set: async (k: string, v: unknown) => kv.set(k, v) }
    const store = platformMemoryStore(memory, 'operator/live/catalogues')
    expect(await store.load()).toBeNull()
    const run: PersistedRun = { last_run: new Date(T0).toISOString(), fingerprint: 'f', all_ok: true, registrations: [] }
    await store.save(run)
    expect(kv.get('operator/live/catalogues')).toEqual(run)
    expect(await store.load()).toEqual(run)
    const down = platformMemoryStore({ get: async () => { throw Object.assign(new Error('bad gateway'), { status: 502 }) }, set: async () => undefined }, 'k')
    await expect(down.load()).rejects.toThrow('bad gateway')
  })

  it('reports a facilitator that refuses, one that rejects the extension, and one that is down - keeps going, and tries again within the hour', async () => {
    const w = world({
      services: [{ listing_id: 'lst_a', price: 2000 }, { listing_id: 'lst_b', price: 5000 }],
      verify: (_name, body) => (body.paymentRequirements.amount === '5000' ? { status: 200, body: { isValid: false, invalidReason: 'insufficient_funds' } } : { status: 200, body: { isValid: true }, ext: { bazaar: { status: 'rejected', rejectedReason: 'info failed schema validation' } } }),
    })
    const down: RegistrarFetch = async (url, init) => {
      if (url.startsWith('https://down.example')) throw new Error('ECONNREFUSED')
      return w.fetch(url, init)
    }
    let now = T0
    const store = memoryStore()
    const reg = new CatalogRegistrar({ baseUrl: BASE, env: 'test', chain: CHAINS.test, privateKey: PK, fetchImpl: down, now: () => now, facilitators: [PAYAI, { name: 'down', url: 'https://down.example' }], store })
    const r = await reg.run()
    expect(r.map((x) => [x.listing_id, x.facilitator, x.verified, x.catalogue, x.reason])).toEqual([
      ['lst_a', 'payai', true, 'rejected', 'info failed schema validation'],
      ['lst_a', 'down', false, null, 'facilitator unreachable: ECONNREFUSED'],
      ['lst_b', 'payai', false, null, 'insufficient_funds'],
      ['lst_b', 'down', false, null, 'facilitator unreachable: ECONNREFUSED'],
    ])
    expect(reg.status().last_error).toBeNull()
    expect(reg.status().next_run).toBe(new Date(T0 + 3_600_000).toISOString()) // not a day: something did not go through
    expect(store.saved[0]!.all_ok).toBe(false)
    now += 3_600_000
    expect(await reg.maybeRun()).toBe(true)
  })

  it('signs only the index price of the listing, under the cap, to the wallet the index names', async () => {
    const w = world({
      services: [
        { listing_id: 'lst_more', price: 2000, amount402: 4000 }, // the 402 asks for more than the index lists
        { listing_id: 'lst_big', price: 5_000_000 }, // 5 USDC: over the registrar cap
        { listing_id: 'lst_other', price: 2000, payTo402: '0x' + '9'.repeat(40) }, // a different payee than the index
        { listing_id: 'lst_ok', price: 40_000 },
      ],
    })
    const reg = new CatalogRegistrar({ baseUrl: BASE, env: 'test', chain: CHAINS.test, privateKey: PK, fetchImpl: w.fetch, facilitators: [PAYAI] })
    const r = await reg.run()
    expect(r.map((x) => [x.listing_id, x.verified])).toEqual([['lst_more', false], ['lst_big', false], ['lst_other', false], ['lst_ok', true]])
    expect(r[0]!.reason).toContain('the 402 asks 4000, the index lists 2000')
    expect(r[1]!.reason).toContain('over the registrar cap')
    expect(r[2]!.reason).toContain('the index names')
    expect(w.verifies()).toBe(1) // three refusals never reached a facilitator
    expect(reg.status().next_run).toBe(new Date(Date.parse(reg.status().last_run!) + 3_600_000).toISOString()) // a refusal is retried within the hour
  })

  it('stops at the run deadline and reports what it did not get to', async () => {
    let now = T0
    const w = world({ services: [{ listing_id: 'lst_a', price: 2000 }, { listing_id: 'lst_b', price: 2000 }, { listing_id: 'lst_c', price: 2000 }] })
    const slow: RegistrarFetch = async (url, init) => {
      if (url.endsWith('/verify')) now += 70_000 // each facilitator answer takes 70 s
      return w.fetch(url, init)
    }
    const reg = new CatalogRegistrar({ baseUrl: BASE, env: 'test', chain: CHAINS.test, privateKey: PK, fetchImpl: slow, now: () => now, facilitators: [PAYAI], deadlineMs: 120_000 })
    const r = await reg.run()
    expect(r.map((x) => [x.listing_id, x.verified])).toEqual([['lst_a', true], ['lst_b', true], ['lst_c', false]])
    expect(r[2]!.reason).toContain('run deadline of 120 s')
    expect(w.verifies()).toBe(2)
    // the next run starts with the listing it did not get to, and keeps the two that went through
    now += 3_600_000
    const again = await reg.run()
    expect(again.map((x) => [x.listing_id, x.verified])).toEqual([['lst_a', true], ['lst_b', true], ['lst_c', true]])
    expect(w.verifies()).toBe(3)
  })

  it('refuses a service off the platform origin, a 402 describing another resource, more than the run total, and more listings than the cap; follows no redirect', async () => {
    const w = world({
      services: [
        { listing_id: 'lst_a', price: 300_000 },
        { listing_id: 'lst_b', price: 300_000 }, // 0.3 + 0.3 > 0.5 USDC run total
        { listing_id: 'lst_c', price: 1000 },
        { listing_id: 'lst_d', price: 1000 }, // over maxServices 3
      ],
    })
    const inner = w.fetch
    let foreign = false
    const f: RegistrarFetch = async (url, init) => {
      if (url.endsWith('/v1/x402?env=test') && foreign) {
        const res = await inner(url, init)
        const body = JSON.parse(await res.text())
        body.services[2].url = 'https://evil.example/v1/x402/lst_c'
        return { status: 200, headers: res.headers, text: async () => JSON.stringify(body) }
      }
      return inner(url, init)
    }
    const reg = new CatalogRegistrar({ baseUrl: BASE, env: 'test', chain: CHAINS.test, privateKey: PK, fetchImpl: f, facilitators: [PAYAI], maxServices: 3 })
    const r = await reg.run()
    expect(r.map((x) => [x.listing_id, x.verified])).toEqual([['lst_a', true], ['lst_b', false], ['lst_c', true], ['lst_d', false]])
    expect(r[1]!.reason).toContain('over its total of 500000')
    expect(r[3]!.reason).toContain('at most 3 in one run')
    expect(w.calls.every((c) => c.init?.redirect === 'error')).toBe(true)

    foreign = true
    const off = await new CatalogRegistrar({ baseUrl: BASE, env: 'test', chain: CHAINS.test, privateKey: PK, fetchImpl: f, facilitators: [PAYAI] }).run()
    expect(off[2]!.reason).toContain('is not on the platform origin')
    expect(w.calls.some((c) => c.url.startsWith('https://evil.example'))).toBe(false) // not even asked for its 402
  })

  it('refuses a 402 whose resource is not the listing the index names', async () => {
    const w = world()
    const f: RegistrarFetch = async (url, init) => {
      const res = await w.fetch(url, init)
      if (res.status !== 402) return res
      const pr = JSON.parse(Buffer.from(res.headers.get('payment-required')!, 'base64').toString())
      pr.resource.url = `${BASE}/v1/x402/lst_other`
      return { status: 402, headers: { get: (n: string) => (n.toLowerCase() === 'payment-required' ? b64(pr) : null) }, text: async () => '' }
    }
    const r = await new CatalogRegistrar({ baseUrl: BASE, env: 'test', chain: CHAINS.test, privateKey: PK, fetchImpl: f, facilitators: [PAYAI] }).run()
    expect(r[0]!.verified).toBe(false)
    expect(r[0]!.reason).toContain('the 402 describes')
    expect(w.verifies()).toBe(0)
  })

  it('refuses to sign terms for another network or asset, and a 402 without the extension', async () => {
    const w = world()
    const reg = new CatalogRegistrar({ baseUrl: BASE, env: 'live', chain: CHAINS.live, privateKey: PK, fetchImpl: w.fetch, facilitators: [PAYAI] })
    const r = await reg.run()
    expect(r).toHaveLength(1)
    expect(r[0]!.verified).toBe(false)
    expect(r[0]!.reason).toContain('eip155:8453')
    expect(w.verifies()).toBe(0)
  })

  it('does nothing without facilitators, and a dead platform is an error in status(), not an exception', async () => {
    const none = new CatalogRegistrar({ baseUrl: BASE, env: 'test', chain: CHAINS.test, privateKey: PK, fetchImpl: async () => { throw new Error('never') }, facilitators: [] })
    expect(await none.maybeRun()).toBe(false)
    const dead = new CatalogRegistrar({ baseUrl: BASE, env: 'test', chain: CHAINS.test, privateKey: PK, fetchImpl: async () => { throw new Error('ENOTFOUND') }, facilitators: [PAYAI] })
    expect(await dead.maybeRun()).toBe(false)
    expect(dead.status().last_error).toContain('ENOTFOUND')
  })

  it('reads the facilitator answer to the extension and fingerprints what a catalogue shows', () => {
    expect(bazaarOutcome(b64({ bazaar: { status: 'success' } }))).toEqual({ status: 'success' })
    expect(bazaarOutcome(b64({ bazaar: { status: 'rejected', rejectedReason: 'x' } }))).toEqual({ status: 'rejected', rejectedReason: 'x' })
    expect(bazaarOutcome(b64({ other: {} }))).toBeNull()
    expect(bazaarOutcome('not base64 json')).toBeNull()
    expect(bazaarOutcome(null)).toBeNull()
    const a = fingerprintOf([{ listing_id: 'a', url: 'u', price: 1, title: 't', example_input: { x: 1 } }, { listing_id: 'b', url: 'v', price: 2 }])
    expect(fingerprintOf([{ listing_id: 'b', url: 'v', price: 2 }, { listing_id: 'a', url: 'u', price: 1, title: 't', example_input: { x: 1 } }])).toBe(a) // order does not matter
    expect(fingerprintOf([{ listing_id: 'a', url: 'u', price: 1, title: 'T', example_input: { x: 1 } }, { listing_id: 'b', url: 'v', price: 2 }])).not.toBe(a) // a title does
    expect(fingerprintOf([{ listing_id: 'a', url: 'u', price: 1, title: 't', example_input: { x: 2 } }, { listing_id: 'b', url: 'v', price: 2 }])).not.toBe(a) // so does the example
    expect(fingerprintOf([{ listing_id: 'a', url: 'u', price: 1, title: 't', example_input: { x: 1 }, input_schema: { type: 'object' } }, { listing_id: 'b', url: 'v', price: 2 }])).not.toBe(a) // and the schema
  })
})

describe('the CDP bearer JWT (ADR-65)', () => {
  const decode = (jwt: string) => {
    const [h, c, s] = jwt.split('.')
    return { header: JSON.parse(Buffer.from(h!, 'base64url').toString()), claims: JSON.parse(Buffer.from(c!, 'base64url').toString()), signature: Buffer.from(s!, 'base64url'), signingInput: `${h}.${c}` }
  }

  it('signs EdDSA with a base64 Ed25519 key (seed || public key), with the claims the CDP SDK sets', () => {
    const kp = generateKeyPairSync('ed25519')
    const seed = kp.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32)
    const pub = kp.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
    const secret = Buffer.concat([seed, pub]).toString('base64')
    const jwt = cdpJwt({ keyId: 'org/key-1', keySecret: secret, method: 'post', host: 'api.cdp.coinbase.com', path: '/platform/v2/x402/verify', now: T0, nonce: 'n0' })
    const { header, claims, signature, signingInput } = decode(jwt)
    expect(header).toEqual({ alg: 'EdDSA', kid: 'org/key-1', typ: 'JWT', nonce: 'n0' })
    expect(claims).toEqual({ sub: 'org/key-1', iss: 'cdp', uris: ['POST api.cdp.coinbase.com/platform/v2/x402/verify'], iat: 1_800_000_000, nbf: 1_800_000_000, exp: 1_800_000_120 })
    expect(cryptoVerify(null, Buffer.from(signingInput), kp.publicKey, signature)).toBe(true)
    // the secret as it arrives from an env var, with literal \n sequences, works the same
    expect(() => cdpJwt({ keyId: 'k', keySecret: secret + '\\n', method: 'POST', host: 'h', path: '/p' })).not.toThrow()
  })

  it('signs ES256 with a PEM EC key, raw r||s', () => {
    const kp = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const pem = kp.privateKey.export({ format: 'pem', type: 'sec1' }).toString()
    const jwt = cdpJwt({ keyId: 'k2', keySecret: pem.replace(/\n/g, '\\n'), method: 'POST', host: 'api.cdp.coinbase.com', path: '/platform/v2/x402/verify', now: T0, nonce: 'n1' })
    const { header, signature, signingInput } = decode(jwt)
    expect(header.alg).toBe('ES256')
    expect(signature).toHaveLength(64)
    expect(cryptoVerify('sha256', Buffer.from(signingInput), { key: kp.publicKey, dsaEncoding: 'ieee-p1363' }, signature)).toBe(true)
  })

  it('rejects a secret that is neither, and the facilitator target names the verify URI', async () => {
    expect(() => cdpJwt({ keyId: 'k', keySecret: 'nope', method: 'POST', host: 'h', path: '/p' })).toThrow(/neither/)
    const kp = generateKeyPairSync('ed25519')
    const secret = Buffer.concat([kp.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32), kp.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)]).toString('base64')
    const f = cdpFacilitator('k', secret)
    expect(f.url).toBe('https://api.cdp.coinbase.com/platform/v2/x402')
    const auth = (await f.headers!()).Authorization!
    expect(auth.startsWith('Bearer ')).toBe(true)
    expect(decode(auth.slice(7)).claims.uris).toEqual(['POST api.cdp.coinbase.com/platform/v2/x402/verify'])
  })
})
