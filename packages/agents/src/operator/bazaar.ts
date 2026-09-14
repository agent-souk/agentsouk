/**
 * ADR-65: keeps the first-party x402 services in the public discovery catalogues of the x402 facilitators.
 *
 * A facilitator catalogues a resource from ONE source: the `bazaar` extension inside a PaymentPayload it receives
 * on /verify or /settle (x402 specs/extensions/bazaar.md, "Facilitator Behavior"). Nothing else - not the
 * /.well-known/x402 document, not the OpenAPI, not a registration form - puts a resource into PayAI's or Coinbase's
 * catalogue. Until ADR-65 the platform's own settle call carried no extension, so after a week of paid calls neither
 * catalogue knew the endpoint existed: 28,634 resources at PayAI, 15,380 at Coinbase, none ours.
 *
 * What this does, once a day per environment and whenever the x402 index changes: for each service in
 * GET /v1/x402, fetch the real 402, sign an EIP-3009 authorization for its price with the desk wallet, and hand the
 * signed payload - with the 402's own `extensions` and `resource` block echoed, as a spec client would - to each
 * facilitator's /verify. Verify validates and catalogues; it BROADCASTS NOTHING (the spec: "verify ... does not
 * settle"), and the authorization expires on its own after five minutes. Measured on 2026-09-14: PayAI answered
 * `EXTENSION-RESPONSES {"bazaar":{"status":"processing"}}` and listed the resource eight seconds later.
 *
 * Coinbase's facilitator needs a CDP API key on every call (even /supported answers 401 without one); with
 * CDP_API_KEY_ID/SECRET set it is registered with as well, using the same Bearer JWT the official SDK builds
 * (@coinbase/cdp-sdk generateJwt: EdDSA for an Ed25519 key, ES256 for an EC key, `uris` claim per request).
 */
import { createHash, createPrivateKey, randomBytes, sign as cryptoSign, type KeyObject } from 'node:crypto'
import { privateKeyToAddress, signAuthorization, type Authorization, type Chain } from './usdc.js'

export type Logger = (msg: string, extra?: Record<string, unknown>) => void

export type Facilitator = {
  name: string
  /** base URL; /verify is appended */
  url: string
  /** extra request headers per call (authentication); built fresh each time because a JWT is short-lived */
  headers?: () => Promise<Record<string, string>>
}

export type RegistrarFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>

export type Registration = {
  listing_id: string
  facilitator: string
  /** the facilitator accepted the authorization as payable (signature, balance, terms) */
  verified: boolean
  /** what it said about the bazaar extension: success | processing | rejected | null when it said nothing */
  catalogue: string | null
  reason: string | null
  at: string
}

export type RegistrarStatus = {
  facilitators: string[]
  last_run: string | null
  next_run: string | null
  services: number | null
  registrations: Registration[]
  last_error: string | null
}

type Service = { listing_id: string; url: string; example_input?: unknown; price?: number; title?: string; description?: string; tags?: unknown }
type PaymentRequired = { x402Version?: number; resource?: Record<string, unknown>; accepts?: { network?: string; asset?: string; payTo?: string; amount?: string; maxTimeoutSeconds?: number }[]; extensions?: Record<string, unknown> }

const DAY_MS = 86_400_000

export class CatalogRegistrar {
  private lastRun = 0
  private fingerprint: string | null = null
  private services: number | null = null
  private registrations: Registration[] = []
  private lastError: string | null = null
  private running = false
  readonly address: string

  constructor(
    private readonly opts: {
      baseUrl: string
      env: 'live' | 'test'
      chain: Chain
      privateKey: string
      facilitators: Facilitator[]
      fetchImpl?: RegistrarFetch
      log?: Logger
      /** re-register at least this often (default 24 h): a catalogue lists newest first, and an entry that is not refreshed sinks */
      intervalMs?: number
      now?: () => number
      randomNonce?: () => string
    },
  ) {
    this.address = privateKeyToAddress(opts.privateKey)
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }

  private get fetch(): RegistrarFetch {
    return this.opts.fetchImpl ?? ((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(30_000) }))
  }

  /** Runs when it never ran, when the interval has elapsed, or when the index changed. Never throws; the outcome is in status(). */
  async maybeRun(): Promise<boolean> {
    if (!this.opts.facilitators.length || this.running) return false
    const due = this.lastRun === 0 || this.now() - this.lastRun >= (this.opts.intervalMs ?? DAY_MS)
    try {
      const services = await this.index()
      const fingerprint = fingerprintOf(services)
      if (!due && fingerprint === this.fingerprint) return false
      await this.register(services, fingerprint)
      return true
    } catch (e) {
      this.lastError = `${new Date(this.now()).toISOString()} ${String((e as Error).message ?? e)}`.slice(0, 500)
      this.opts.log?.('catalogue registration failed', { env: this.opts.env, error: this.lastError })
      return false
    }
  }

  /** One pass over every service, unconditionally. */
  async run(): Promise<Registration[]> {
    const services = await this.index()
    await this.register(services, fingerprintOf(services))
    return this.registrations
  }

  status(): RegistrarStatus {
    return {
      facilitators: this.opts.facilitators.map((f) => f.name),
      last_run: this.lastRun ? new Date(this.lastRun).toISOString() : null,
      next_run: this.lastRun ? new Date(this.lastRun + (this.opts.intervalMs ?? DAY_MS)).toISOString() : null,
      services: this.services,
      registrations: this.registrations,
      last_error: this.lastError,
    }
  }

  private async index(): Promise<Service[]> {
    const res = await this.fetch(`${this.opts.baseUrl.replace(/\/$/, '')}/v1/x402?env=${this.opts.env}`, { headers: { accept: 'application/json' } })
    const text = await res.text()
    if (res.status !== 200) throw new Error(`GET /v1/x402 answered HTTP ${res.status}`)
    const body = JSON.parse(text) as { services?: Service[] }
    return (body.services ?? []).filter((s) => typeof s.listing_id === 'string' && typeof s.url === 'string')
  }

  private async register(services: Service[], fingerprint: string): Promise<void> {
    this.running = true
    try {
      const out: Registration[] = []
      for (const s of services) {
        const at = new Date(this.now()).toISOString()
        let body: Record<string, unknown>
        try {
          body = await this.payloadFor(s)
        } catch (e) {
          for (const f of this.opts.facilitators) out.push({ listing_id: s.listing_id, facilitator: f.name, verified: false, catalogue: null, reason: String((e as Error).message ?? e).slice(0, 300), at })
          continue
        }
        for (const f of this.opts.facilitators) out.push(await this.verifyAt(f, s.listing_id, body, at))
      }
      this.registrations = out
      this.services = services.length
      this.fingerprint = fingerprint
      this.lastRun = this.now()
      this.lastError = null
      const catalogued = out.filter((r) => r.catalogue === 'success' || r.catalogue === 'processing').length
      this.opts.log?.('catalogue registration done', { env: this.opts.env, services: services.length, facilitators: this.opts.facilitators.length, verified: out.filter((r) => r.verified).length, catalogued, rejected: out.filter((r) => r.catalogue === 'rejected').length })
    } finally {
      this.running = false
    }
  }

  /** The 402 of one service, answered the way a spec client answers it: the signed authorization plus the echoed `resource` and `extensions`. */
  private async payloadFor(s: Service): Promise<Record<string, unknown>> {
    const res = await this.fetch(s.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(s.example_input && typeof s.example_input === 'object' ? s.example_input : {}) })
    await res.text().catch(() => '')
    if (res.status !== 402) throw new Error(`expected 402 from ${s.url}, got HTTP ${res.status}`)
    const header = res.headers.get('payment-required')
    if (!header) throw new Error('the 402 carried no PAYMENT-REQUIRED header')
    const pr = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as PaymentRequired
    const req = pr.accepts?.[0]
    if (pr.x402Version !== 2 || !req || !pr.resource) throw new Error('PAYMENT-REQUIRED is not an x402 v2 PaymentRequired')
    if (req.network !== `eip155:${this.opts.chain.chainId}` || String(req.asset).toLowerCase() !== this.opts.chain.usdc.toLowerCase()) throw new Error(`terms are for ${req.network}/${req.asset}, this wallet signs for eip155:${this.opts.chain.chainId}/${this.opts.chain.usdc}`)
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(req.payTo)) || !/^\d+$/.test(String(req.amount))) throw new Error('terms have no plain payTo/amount')
    if (!pr.extensions || typeof pr.extensions !== 'object' || !('bazaar' in pr.extensions)) throw new Error('the 402 carries no bazaar extension: nothing to catalogue')
    const nowSec = Math.floor(this.now() / 1000)
    const auth: Authorization = { from: this.address, to: String(req.payTo), value: BigInt(String(req.amount)), validAfter: 0n, validBefore: BigInt(nowSec + 300), nonce: (this.opts.randomNonce ?? (() => '0x' + randomBytes(32).toString('hex')))() }
    const signature = signAuthorization(this.opts.chain, auth, this.opts.privateKey)
    const authorization = { from: auth.from, to: auth.to, value: auth.value.toString(), validAfter: '0', validBefore: auth.validBefore.toString(), nonce: auth.nonce }
    return {
      x402Version: 2,
      paymentPayload: { x402Version: 2, resource: pr.resource, accepted: req, payload: { signature, authorization }, extensions: pr.extensions },
      paymentRequirements: req,
    }
  }

  private async verifyAt(f: Facilitator, listingId: string, body: Record<string, unknown>, at: string): Promise<Registration> {
    const base = { listing_id: listingId, facilitator: f.name, at }
    try {
      const headers = { 'content-type': 'application/json', accept: 'application/json', ...((await f.headers?.()) ?? {}) }
      const res = await this.fetch(`${f.url.replace(/\/$/, '')}/verify`, { method: 'POST', headers, body: JSON.stringify(body) })
      const text = await res.text()
      let json: { isValid?: unknown; invalidReason?: unknown; error?: unknown } = {}
      try {
        json = JSON.parse(text) as typeof json
      } catch {
        /* a non-JSON answer is reported below */
      }
      const catalogue = bazaarOutcome(res.headers.get('extension-responses'))
      const verified = res.status === 200 && json.isValid === true
      const reason = verified ? (catalogue?.rejectedReason ?? null) : String(json.invalidReason ?? json.error ?? `HTTP ${res.status} ${text.slice(0, 120)}`).slice(0, 300)
      return { ...base, verified, catalogue: catalogue?.status ?? null, reason }
    } catch (e) {
      return { ...base, verified: false, catalogue: null, reason: `facilitator unreachable: ${String((e as Error).message ?? e)}`.slice(0, 300) }
    }
  }
}

/** The facilitator's answer to the bazaar extension, from the EXTENSION-RESPONSES header (base64 JSON keyed by extension). */
export function bazaarOutcome(header: string | null | undefined): { status: string; rejectedReason?: string } | null {
  if (!header) return null
  try {
    const parsed = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as { bazaar?: { status?: unknown; rejectedReason?: unknown } }
    const b = parsed?.bazaar
    if (!b || typeof b.status !== 'string') return null
    return { status: b.status.slice(0, 32), ...(typeof b.rejectedReason === 'string' ? { rejectedReason: b.rejectedReason.slice(0, 300) } : {}) }
  } catch {
    return null
  }
}

/** What a catalogue would show: ids, prices, titles, descriptions, tags. A change here means the entries need refreshing. */
export function fingerprintOf(services: Service[]): string {
  const h = createHash('sha256')
  for (const s of [...services].sort((a, b) => a.listing_id.localeCompare(b.listing_id))) h.update(JSON.stringify([s.listing_id, s.url, s.price ?? null, s.title ?? null, s.description ?? null, s.tags ?? null]))
  return h.digest('hex')
}

// --- Coinbase Developer Platform facilitator ----------------------------------------------------------------

export const CDP_FACILITATOR_URL = 'https://api.cdp.coinbase.com/platform/v2/x402'

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url')

/**
 * The Bearer JWT Coinbase's REST APIs take, built the way @coinbase/cdp-sdk builds it: header {alg, kid, typ, nonce},
 * claims {sub: key id, iss: "cdp", uris: ["<METHOD> <host><path>"], iat, nbf, exp = +120 s}. An Ed25519 key is the
 * base64 of seed||public key (64 bytes), signed EdDSA; an EC key is a PEM, signed ES256 with a raw r||s signature.
 */
export function cdpJwt(input: { keyId: string; keySecret: string; method: string; host: string; path: string; now?: number; nonce?: string }): string {
  const now = Math.floor((input.now ?? Date.now()) / 1000)
  const secret = input.keySecret.replace(/\\n/g, '\n').trim()
  const { key, alg } = cdpKey(secret)
  const header = { alg, kid: input.keyId, typ: 'JWT', nonce: input.nonce ?? randomBytes(16).toString('hex') }
  const claims = { sub: input.keyId, iss: 'cdp', uris: [`${input.method.toUpperCase()} ${input.host}${input.path}`], iat: now, nbf: now, exp: now + 120 }
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`
  const signature = alg === 'EdDSA' ? cryptoSign(null, Buffer.from(signingInput), key) : cryptoSign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' })
  return `${signingInput}.${b64url(signature)}`
}

function cdpKey(secret: string): { key: KeyObject; alg: 'EdDSA' | 'ES256' } {
  if (secret.includes('-----BEGIN')) return { key: createPrivateKey(secret), alg: 'ES256' }
  const raw = Buffer.from(secret, 'base64')
  if (raw.length !== 64) throw new Error('CDP_API_KEY_SECRET is neither a PEM EC key nor a base64 Ed25519 key (64 bytes)')
  // PKCS#8 DER for an Ed25519 private key: fixed 16-byte prefix (OID 1.3.101.112) followed by the 32-byte seed
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), raw.subarray(0, 32)])
  return { key: createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }), alg: 'EdDSA' }
}

/** Coinbase's facilitator as a registration target, when the desk has a CDP API key. */
export function cdpFacilitator(keyId: string, keySecret: string, url = CDP_FACILITATOR_URL): Facilitator {
  const u = new URL(url)
  return {
    name: 'cdp',
    url,
    headers: async () => ({ Authorization: `Bearer ${cdpJwt({ keyId, keySecret, method: 'POST', host: u.host, path: `${u.pathname.replace(/\/$/, '')}/verify` })}` }),
  }
}
