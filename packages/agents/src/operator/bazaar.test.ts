import { generateKeyPairSync, verify as cryptoVerify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { hexToBytes } from '@noble/hashes/utils.js'
import { authorizationDigest, CHAINS, privateKeyToAddress } from './usdc.js'
import { bazaarOutcome, CatalogRegistrar, cdpFacilitator, cdpJwt, fingerprintOf, type RegistrarFetch } from './bazaar.js'

const PK = '0x' + '22'.repeat(32)
const ME = privateKeyToAddress(PK)
const PAY_TO = '0xA0a2494006B72109137630bC026434a809731c07'
const BASE = 'https://api.example.test'
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64')
const NONCE = '0x' + 'ab'.repeat(32)

/** A fake platform + facilitators: the index, one 402 per listing, and /verify that records what it was handed. */
function world(opts: { services?: { listing_id: string; price: number; title?: string; example_input?: unknown }[]; verify?: (name: string, body: any, headers: Record<string, string>) => { status: number; body: unknown; ext?: unknown } } = {}) {
  const services = opts.services ?? [{ listing_id: 'lst_a', price: 2000, title: 'Snapshot', example_input: { token: 'usdc' } }]
  const calls: { url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }[] = []
  const f: RegistrarFetch = async (url, init) => {
    calls.push({ url, init })
    const headers = new Map<string, string>()
    const answer = (status: number, body: unknown, extra: Record<string, string> = {}) => {
      for (const [k, v] of Object.entries(extra)) headers.set(k.toLowerCase(), v)
      return { status, headers: { get: (n: string) => headers.get(n.toLowerCase()) ?? null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) }
    }
    if (url.startsWith(`${BASE}/v1/x402?`)) return answer(200, { object: 'x402_index', services: services.map((s) => ({ ...s, url: `${BASE}/v1/x402/${s.listing_id}`, tags: ['base'] })) })
    const m = url.match(/\/v1\/x402\/(lst_\w+)$/)
    if (m) {
      const s = services.find((x) => x.listing_id === m[1])!
      const pr = {
        x402Version: 2,
        resource: { url, description: s.title ?? 'thing', mimeType: 'application/json', serviceName: 'Agent Souk', tags: ['base'], iconUrl: `${BASE}/icon.png` },
        accepts: [{ scheme: 'exact', network: 'eip155:84532', amount: String(s.price), asset: CHAINS.test.usdc, payTo: PAY_TO, maxTimeoutSeconds: 900, extra: { name: 'USDC', version: '2' } }],
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
  return { fetch: f, calls, services }
}

describe('catalogue registration (ADR-65)', () => {
  it('answers each 402 with a signed, echoed payload at every facilitator and records what they said', async () => {
    let handed: any[] = []
    const w = world({ verify: (name, body, headers) => { handed.push({ name, body, headers }); return { status: 200, body: { isValid: true }, ext: { bazaar: { status: name === 'cdp' ? 'success' : 'processing' } } } } })
    const now = 1_800_000_000_000
    const reg = new CatalogRegistrar({ baseUrl: BASE, env: 'test', chain: CHAINS.test, privateKey: PK, fetchImpl: w.fetch, now: () => now, randomNonce: () => NONCE, facilitators: [{ name: 'payai', url: 'https://payai.example/' }, { name: 'cdp', url: 'https://cdp.example/platform/v2/x402', headers: async () => ({ Authorization: 'Bearer t' }) }] })
    expect(await reg.maybeRun()).toBe(true)

    expect(handed).toHaveLength(2)
    const p = handed[0].body.paymentPayload
    // the echo: resource block and extensions exactly as the 402 carried them
    expect(p.resource).toMatchObject({ serviceName: 'Agent Souk', iconUrl: `${BASE}/icon.png`, url: `${BASE}/v1/x402/lst_a` })
    expect(p.extensions.bazaar.info.input.body).toEqual({ token: 'usdc' })
    expect(handed[0].body.paymentRequirements).toEqual(p.accepted)
    // the authorization: our wallet pays the listing price to the seller, for five minutes, and is really signed
    expect(p.payload.authorization).toMatchObject({ from: ME, to: PAY_TO, value: '2000', validAfter: '0', validBefore: String(Math.floor(now / 1000) + 300), nonce: NONCE })
    const digest = authorizationDigest(CHAINS.test, { from: ME, to: PAY_TO, value: 2000n, validAfter: 0n, validBefore: BigInt(Math.floor(now / 1000) + 300), nonce: NONCE })
    const sig = hexToBytes(p.payload.signature.slice(2))
    expect(secp256k1.verify(sig.slice(0, 64), digest, secp256k1.getPublicKey(hexToBytes(PK.slice(2)), false), { prehash: false })).toBe(true)
    // nothing was settled: only /verify was called, and the auth header reached only the facilitator that wants one
    expect(w.calls.filter((c) => c.url.endsWith('/settle'))).toHaveLength(0)
    expect(handed[1].headers.Authorization).toBe('Bearer t')
    expect(handed[0].headers.Authorization).toBeUndefined()

    const st = reg.status()
    expect(st.registrations).toEqual([
      { listing_id: 'lst_a', facilitator: 'payai', verified: true, catalogue: 'processing', reason: null, at: new Date(now).toISOString() },
      { listing_id: 'lst_a', facilitator: 'cdp', verified: true, catalogue: 'success', reason: null, at: new Date(now).toISOString() },
    ])
    expect(st.services).toBe(1)
    expect(st.last_run).toBe(new Date(now).toISOString())
    expect(st.next_run).toBe(new Date(now + 86_400_000).toISOString())
  })

  it('runs once a day, and again as soon as the index changes', async () => {
    const w = world()
    let now = 1_800_000_000_000
    const reg = new CatalogRegistrar({ baseUrl: BASE, env: 'test', chain: CHAINS.test, privateKey: PK, fetchImpl: w.fetch, now: () => now, facilitators: [{ name: 'payai', url: 'https://payai.example' }] })
    expect(await reg.maybeRun()).toBe(true)
    const verifies = () => w.calls.filter((c) => c.url.endsWith('/verify')).length
    expect(verifies()).toBe(1)
    now += 3_600_000
    expect(await reg.maybeRun()).toBe(false) // an hour later, same index: nothing to do
    expect(verifies()).toBe(1)
    w.services[0]!.price = 3000 // the price changed: the catalogue entry is stale
    expect(await reg.maybeRun()).toBe(true)
    expect(verifies()).toBe(2)
    now += 86_400_000
    expect(await reg.maybeRun()).toBe(true) // a day later: refreshed regardless
    expect(verifies()).toBe(3)
  })

  it('reports a facilitator that refuses, one that rejects the extension, and one that is down - and keeps going', async () => {
    const w = world({
      services: [{ listing_id: 'lst_a', price: 2000 }, { listing_id: 'lst_b', price: 5000 }],
      verify: (_name, body) => (body.paymentRequirements.amount === '5000' ? { status: 200, body: { isValid: false, invalidReason: 'insufficient_funds' } } : { status: 200, body: { isValid: true }, ext: { bazaar: { status: 'rejected', rejectedReason: 'info failed schema validation' } } }),
    })
    const down: RegistrarFetch = async (url, init) => {
      if (url.startsWith('https://down.example')) throw new Error('ECONNREFUSED')
      return w.fetch(url, init)
    }
    const reg = new CatalogRegistrar({ baseUrl: BASE, env: 'test', chain: CHAINS.test, privateKey: PK, fetchImpl: down, facilitators: [{ name: 'payai', url: 'https://payai.example' }, { name: 'down', url: 'https://down.example' }] })
    const r = await reg.run()
    expect(r.map((x) => [x.listing_id, x.facilitator, x.verified, x.catalogue, x.reason])).toEqual([
      ['lst_a', 'payai', true, 'rejected', 'info failed schema validation'],
      ['lst_a', 'down', false, null, 'facilitator unreachable: ECONNREFUSED'],
      ['lst_b', 'payai', false, null, 'insufficient_funds'],
      ['lst_b', 'down', false, null, 'facilitator unreachable: ECONNREFUSED'],
    ])
    expect(reg.status().last_error).toBeNull()
  })

  it('refuses to sign terms for another network or asset, and a 402 without the extension', async () => {
    const w = world()
    const reg = new CatalogRegistrar({ baseUrl: BASE, env: 'live', chain: CHAINS.live, privateKey: PK, fetchImpl: w.fetch, facilitators: [{ name: 'payai', url: 'https://payai.example' }] })
    const r = await reg.run()
    expect(r).toHaveLength(1)
    expect(r[0]!.verified).toBe(false)
    expect(r[0]!.reason).toContain('eip155:8453')
    expect(w.calls.filter((c) => c.url.endsWith('/verify'))).toHaveLength(0)
  })

  it('does nothing without facilitators, and a dead platform is an error in status(), not an exception', async () => {
    const none = new CatalogRegistrar({ baseUrl: BASE, env: 'test', chain: CHAINS.test, privateKey: PK, fetchImpl: async () => { throw new Error('never') }, facilitators: [] })
    expect(await none.maybeRun()).toBe(false)
    const dead = new CatalogRegistrar({ baseUrl: BASE, env: 'test', chain: CHAINS.test, privateKey: PK, fetchImpl: async () => { throw new Error('ENOTFOUND') }, facilitators: [{ name: 'payai', url: 'https://payai.example' }] })
    expect(await dead.maybeRun()).toBe(false)
    expect(dead.status().last_error).toContain('ENOTFOUND')
  })

  it('reads the facilitator answer to the extension and fingerprints what a catalogue shows', () => {
    expect(bazaarOutcome(b64({ bazaar: { status: 'success' } }))).toEqual({ status: 'success' })
    expect(bazaarOutcome(b64({ bazaar: { status: 'rejected', rejectedReason: 'x' } }))).toEqual({ status: 'rejected', rejectedReason: 'x' })
    expect(bazaarOutcome(b64({ other: {} }))).toBeNull()
    expect(bazaarOutcome('not base64 json')).toBeNull()
    expect(bazaarOutcome(null)).toBeNull()
    const a = fingerprintOf([{ listing_id: 'a', url: 'u', price: 1, title: 't' }, { listing_id: 'b', url: 'v', price: 2 }])
    expect(fingerprintOf([{ listing_id: 'b', url: 'v', price: 2 }, { listing_id: 'a', url: 'u', price: 1, title: 't' }])).toBe(a) // order does not matter
    expect(fingerprintOf([{ listing_id: 'a', url: 'u', price: 1, title: 'T' }, { listing_id: 'b', url: 'v', price: 2 }])).not.toBe(a) // a title does
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
    const jwt = cdpJwt({ keyId: 'org/key-1', keySecret: secret, method: 'post', host: 'api.cdp.coinbase.com', path: '/platform/v2/x402/verify', now: 1_800_000_000_000, nonce: 'n0' })
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
    const jwt = cdpJwt({ keyId: 'k2', keySecret: pem.replace(/\n/g, '\\n'), method: 'POST', host: 'api.cdp.coinbase.com', path: '/platform/v2/x402/verify', now: 1_800_000_000_000, nonce: 'n1' })
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
