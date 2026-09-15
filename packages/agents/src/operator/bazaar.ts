/**
 * ADR-65: keeps the first-party x402 services in the public discovery catalogues of the x402 facilitators.
 *
 * A facilitator catalogues a resource from ONE source: the `bazaar` extension inside a PaymentPayload it receives
 * on /verify or /settle (x402 specs/extensions/bazaar.md, "Facilitator Behavior"). Nothing else - not the
 * /.well-known/x402 document, not the OpenAPI, not a registration form - puts a resource into PayAI's or Coinbase's
 * catalogue. Until ADR-65 the platform's own settle call carried no extension, so after the one paid call of that
 * week (our own smoke test, settled through PayAI) neither catalogue knew the endpoint existed: 28,634 resources at
 * PayAI, 15,380 at Coinbase, none ours.
 *
 * What this does: for each service in GET /v1/x402, fetch the real 402, sign an EIP-3009 authorization for its
 * price with the desk wallet, and hand the signed payload - with the 402's own `extensions` and `resource` block
 * echoed, as a spec client would - to each facilitator's /verify. Verify validates and catalogues; it BROADCASTS
 * NOTHING (x402 v2 spec 7.1: "Verifies a payment authorization without executing the transaction on the
 * blockchain"), and the authorization expires on its own after five minutes. Measured on 2026-09-14: PayAI answered
 * `EXTENSION-RESPONSES {"bazaar":{"status":"processing"}}` and listed the resource eight seconds later.
 *
 * When: once a day per (listing, facilitator) pair, and as soon as what a catalogue shows changes (id, URL, price,
 * title, description, tags, example, schemas - the fingerprint of the index, checked at most hourly). A pair that did
 * not go through is retried after 1 h, then 2, 4, 8, 16, and from then on daily; a retry re-does only the pairs that
 * failed or are older than a day, never the ones a facilitator accepted a few hours ago (the second audit: one broken
 * CDP key would otherwise have re-signed all seven services at PayAI every hour, 168 a day). The desk machine sleeps
 * when idle and is started fresh by every webhook, so the schedule - including when the index was last checked - lives
 * in platform memory, not in the process: the first audit found a fresh process re-registering all seven services
 * eight minutes after the previous run. A memory read that fails skips registration for up to the retry delay rather
 * than treating the schedule as empty. Every request carries our own user agent, so the platform's discovery
 * statistic counts these reads as ours and not as outside interest (x402:terms is a figure ADR-64/65 read as reach).
 *
 * Money rules, enforced here (the desk wallet's other signers have caps; this one is no exception): the amount
 * signed must be exactly the index price of that listing and at most `maxAmount` (default 1 USDC), the payee must be
 * the wallet the index names, the service URL and the 402's resource URL must both be on the platform's own origin,
 * and one run signs at most `maxRunAmount` in total (default 0.5 USDC; the seven live services sum to 0.132) over at
 * most `maxServices` listings. Anything else is recorded as a refusal, not signed. No request follows a redirect: a
 * 307 from a facilitator's /verify to someone's /settle would otherwise hand them a payable authorization.
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

export type RegistrarFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; redirect?: 'error' }) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>

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

/**
 * What survives a process restart: when the last run was, what it registered, whether every entry went through, how
 * many runs in a row did not (the retry backoff), how many services the index listed, and when the index was last read.
 */
export type PersistedRun = { last_run: string; fingerprint: string; all_ok: boolean; failures?: number; services?: number; index_checked_at?: string; registrations?: Registration[] }
export type RegistrarStore = { load(): Promise<PersistedRun | null>; save(run: PersistedRun): Promise<void> }

type MemoryApi = { get<T>(key: string): Promise<{ value: T }>; set(key: string, value: unknown): Promise<unknown> }

/** The run record in the desk's platform memory under `key`; a key that was never written is "never ran", any other read error throws. */
export function platformMemoryStore(memory: MemoryApi, key: string): RegistrarStore {
  return {
    load: async () => {
      try {
        return (await memory.get<PersistedRun>(key)).value ?? null
      } catch (e) {
        if (typeof e === 'object' && e != null && (e as { status?: unknown }).status === 404) return null
        throw e
      }
    },
    save: async (run) => {
      await memory.set(key, run)
    },
  }
}

export type RegistrarStatus = {
  facilitators: string[]
  last_run: string | null
  next_run: string | null
  services: number | null
  registrations: Registration[]
  last_error: string | null
}

type Service = { listing_id: string; url: string; example_input?: unknown; input_schema?: unknown; output_schema?: unknown; price?: number; pay_to?: string; title?: string; description?: string; tags?: unknown }
type PaymentRequired = { x402Version?: number; resource?: Record<string, unknown>; accepts?: { network?: string; asset?: string; payTo?: string; amount?: string; maxTimeoutSeconds?: number }[]; extensions?: Record<string, unknown> }

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000

export class CatalogRegistrar {
  private lastRun = 0
  private allOk = true
  /** runs in a row in which some pair did not go through: the retry backoff */
  private failures = 0
  private fingerprint: string | null = null
  private lastIndexCheck = 0
  private loaded = false
  private loadFailedSince = 0
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
      /** platform memory: the schedule survives a restart of the sleeping desk machine */
      store?: RegistrarStore
      /** sent on every request, so the platform counts these reads as ours */
      userAgent?: string
      fetchImpl?: RegistrarFetch
      log?: Logger
      /** re-register each pair at least this often (default 24 h): a catalogue lists newest first, and an entry that is not refreshed sinks */
      intervalMs?: number
      /** first retry this soon after a run in which some pair did not go through (default 1 h), doubling per failed run up to intervalMs */
      retryMs?: number
      /** the whole run must finish within this (default 120 s); what is left is reported and retried */
      deadlineMs?: number
      /** per request (default 15 s) */
      fetchTimeoutMs?: number
      /** the largest amount this registrar signs for one listing, USDC minor units (default 1 USDC) */
      maxAmount?: bigint
      /** the most it signs in one run, all listings together (default 0.5 USDC) */
      maxRunAmount?: bigint
      /** the most listings it signs for in one run (default 20) */
      maxServices?: number
      now?: () => number
      randomNonce?: () => string
    },
  ) {
    this.address = privateKeyToAddress(opts.privateKey)
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }

  private get interval(): number {
    return this.opts.intervalMs ?? DAY_MS
  }

  private get retry(): number {
    return this.opts.retryMs ?? HOUR_MS
  }

  /** every request names us and follows no redirect: a signed payload goes only to the URL it was built for */
  private get fetch(): RegistrarFetch {
    const ua = this.opts.userAgent
    const timeout = this.opts.fetchTimeoutMs ?? 15_000
    const raw: RegistrarFetch = this.opts.fetchImpl ?? ((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(timeout) }))
    return (url, init) => raw(url, { ...init, redirect: 'error', headers: { ...(ua ? { 'user-agent': ua } : {}), ...(init?.headers ?? {}) } })
  }

  private nextRunAt(): number {
    if (!this.lastRun) return 0
    if (!this.allOk) return this.lastRun + Math.min(this.interval, this.retry * 2 ** Math.min(20, Math.max(0, this.failures - 1)))
    // every pair went through; the oldest of them is the next one to refresh
    const oldest = this.registrations.reduce((min, r) => Math.min(min, Date.parse(r.at) || this.lastRun), this.lastRun)
    return oldest + this.interval
  }

  /** false while the platform memory cannot be read (for at most the retry delay): better a late run than a duplicate */
  private async load(): Promise<boolean> {
    if (this.loaded) return true
    if (!this.opts.store) return (this.loaded = true)
    try {
      const run = await this.opts.store.load()
      this.loaded = true
      this.loadFailedSince = 0
      const at = run && typeof run.last_run === 'string' && typeof run.fingerprint === 'string' ? Date.parse(run.last_run) : Number.NaN
      if (run && Number.isFinite(at)) {
        this.lastRun = at
        this.fingerprint = run.fingerprint
        this.allOk = run.all_ok !== false
        this.failures = Number.isInteger(run.failures) && (run.failures as number) >= 0 ? (run.failures as number) : this.allOk ? 0 : 1
        if (Array.isArray(run.registrations)) this.registrations = run.registrations
        this.services = Number.isInteger(run.services) ? (run.services as number) : new Set(this.registrations.map((r) => r.listing_id)).size
        const checked = typeof run.index_checked_at === 'string' ? Date.parse(run.index_checked_at) : Number.NaN
        this.lastIndexCheck = Number.isFinite(checked) ? Math.max(at, checked) : at // that run read the index
      }
      return true
    } catch (e) {
      const now = this.now()
      if (!this.loadFailedSince) {
        this.loadFailedSince = now
        this.opts.log?.('catalogue registration: could not read the last run, not registering until it can be read', { env: this.opts.env, error: String((e as Error).message ?? e) })
      }
      if (now - this.loadFailedSince < this.retry) return false
      this.loaded = true
      this.opts.log?.('catalogue registration: the last run is still unreadable, registering without it', { env: this.opts.env, since: new Date(this.loadFailedSince).toISOString() })
      return true
    }
  }

  /**
   * Runs when it never ran (as far as platform memory knows), when a pair is due - a day after it went through, or
   * after the backoff when it did not - or when the index changed (checked at most hourly, across restarts). Never
   * throws; the outcome is in status().
   */
  async maybeRun(): Promise<boolean> {
    if (!this.opts.facilitators.length || this.running) return false
    this.running = true
    try {
      if (!(await this.load())) return false
      const now = this.now()
      const due = this.lastRun === 0 || now >= this.nextRunAt()
      if (!due && now - this.lastIndexCheck < HOUR_MS) return false
      const services = await this.index()
      this.lastIndexCheck = now
      const fingerprint = fingerprintOf(services)
      if (!due && fingerprint === this.fingerprint) {
        await this.persist() // remembers the index check, so the next fresh process does not read it again within the hour
        return false
      }
      await this.register(services, fingerprint)
      return true
    } catch (e) {
      this.lastError = `${new Date(this.now()).toISOString()} ${String((e as Error).message ?? e)}`.slice(0, 500)
      this.opts.log?.('catalogue registration failed', { env: this.opts.env, error: this.lastError })
      return false
    } finally {
      this.running = false
    }
  }

  /** One pass over every service (pairs a facilitator accepted within the interval under the same index are kept). */
  async run(): Promise<Registration[]> {
    await this.load()
    const services = await this.index()
    await this.register(services, fingerprintOf(services))
    return this.registrations
  }

  status(): RegistrarStatus {
    return {
      facilitators: this.opts.facilitators.map((f) => f.name),
      last_run: this.lastRun ? new Date(this.lastRun).toISOString() : null,
      next_run: this.lastRun ? new Date(this.nextRunAt()).toISOString() : null,
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

  private async persist(): Promise<void> {
    if (!this.opts.store || !this.lastRun || this.fingerprint === null) return
    const run: PersistedRun = { last_run: new Date(this.lastRun).toISOString(), fingerprint: this.fingerprint, all_ok: this.allOk, failures: this.failures, services: this.services ?? 0, index_checked_at: new Date(this.lastIndexCheck || this.lastRun).toISOString(), registrations: this.registrations }
    await this.opts.store.save(run).catch((e: unknown) => this.opts.log?.('catalogue registration: could not save the run', { env: this.opts.env, error: String((e as Error).message ?? e) }))
  }

  private async register(services: Service[], fingerprint: string): Promise<void> {
    const started = this.now()
    const deadline = this.opts.deadlineMs ?? 120_000
    const maxServices = this.opts.maxServices ?? 20
    const runCap = this.opts.maxRunAmount ?? 500_000n
    const key = (listingId: string, facilitator: string) => `${listingId} ${facilitator}`
    // a pair a facilitator accepted less than an interval ago, under the same index, is kept - not signed and sent again
    const kept = new Map<string, Registration>()
    if (fingerprint === this.fingerprint) for (const r of this.registrations) if (isOk(r) && started - Date.parse(r.at) < this.interval) kept.set(key(r.listing_id, r.facilitator), r)
    // what did not go through last time goes first, so a run that keeps hitting the deadline does not always drop the same tail
    const failedBefore = new Set(this.registrations.filter((r) => !isOk(r)).map((r) => r.listing_id))
    const ordered = [...services].sort((a, b) => Number(failedBefore.has(b.listing_id)) - Number(failedBefore.has(a.listing_id)))
    const out: Registration[] = []
    let signed = 0n
    let attempted = 0
    for (const s of ordered) {
      const at = new Date(this.now()).toISOString()
      const todo = this.opts.facilitators.filter((f) => {
        const k = kept.get(key(s.listing_id, f.name))
        if (k) out.push(k)
        return !k
      })
      if (!todo.length) continue
      const refuse = (reason: string) => {
        for (const f of todo) out.push({ listing_id: s.listing_id, facilitator: f.name, verified: false, catalogue: null, reason: reason.slice(0, 300), at })
      }
      if (++attempted > maxServices) {
        refuse(`the index lists ${services.length} services; this registrar signs for at most ${maxServices} in one run`)
        continue
      }
      if (this.now() - started > deadline) {
        refuse(`run deadline of ${deadline / 1000} s reached before this listing; retried with the next run`)
        continue
      }
      let signedPayload: { body: Record<string, unknown>; amount: bigint }
      try {
        signedPayload = await this.payloadFor(s, runCap - signed, runCap)
      } catch (e) {
        refuse(String((e as Error).message ?? e))
        continue
      }
      signed += signedPayload.amount
      for (const f of todo) out.push(await this.verifyAt(f, s.listing_id, signedPayload.body, at))
    }
    // shown in index order, facilitators in configured order
    const pos = new Map(services.map((s, i) => [s.listing_id, i]))
    const fpos = new Map(this.opts.facilitators.map((f, i) => [f.name, i]))
    out.sort((a, b) => (pos.get(a.listing_id)! - pos.get(b.listing_id)!) || (fpos.get(a.facilitator)! - fpos.get(b.facilitator)!))
    this.registrations = out
    this.services = services.length
    this.fingerprint = fingerprint
    this.lastRun = this.now()
    this.lastIndexCheck = this.lastRun
    this.allOk = out.every(isOk)
    this.failures = this.allOk ? 0 : this.failures + 1
    this.lastError = null
    const catalogued = out.filter((r) => r.catalogue === 'success' || r.catalogue === 'processing').length
    this.opts.log?.('catalogue registration done', { env: this.opts.env, services: services.length, facilitators: this.opts.facilitators.length, kept: kept.size, verified: out.filter((r) => r.verified).length, catalogued, rejected: out.filter((r) => r.catalogue === 'rejected').length, signed_minor_units: signed.toString(), next_run: new Date(this.nextRunAt()).toISOString() })
    await this.persist()
  }

  /** The 402 of one service, answered the way a spec client answers it: the signed authorization plus the echoed `resource` and `extensions`. */
  private async payloadFor(s: Service, budgetLeft: bigint, runCap: bigint): Promise<{ body: Record<string, unknown>; amount: bigint }> {
    const origin = new URL(this.opts.baseUrl).origin
    let target: URL
    try {
      target = new URL(s.url)
    } catch {
      throw new Error(`refusing to sign: the index lists ${String(s.url).slice(0, 120)} as the URL, which is not one`)
    }
    if (target.origin !== origin) throw new Error(`refusing to sign: ${s.url} is not on the platform origin ${origin}`)
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
    // the money rules: exactly the index price of this listing, under the cap, to the wallet the index names
    const amount = BigInt(String(req.amount))
    const maxAmount = this.opts.maxAmount ?? 1_000_000n
    if (!Number.isInteger(s.price) || amount !== BigInt(s.price as number)) throw new Error(`refusing to sign: the 402 asks ${String(req.amount)}, the index lists ${String(s.price)} for this listing`)
    if (amount <= 0n || amount > maxAmount) throw new Error(`refusing to sign: ${String(req.amount)} is over the registrar cap of ${maxAmount.toString()} minor units`)
    if (typeof s.pay_to !== 'string' || String(req.payTo).toLowerCase() !== s.pay_to.toLowerCase()) throw new Error(`refusing to sign: the 402 pays ${String(req.payTo)}, the index names ${String(s.pay_to)}`)
    if (pr.resource.url !== s.url) throw new Error(`refusing to sign: the 402 describes ${String(pr.resource.url).slice(0, 120)}, the index lists ${s.url}`)
    if (amount > budgetLeft) throw new Error(`refusing to sign: ${amount.toString()} would take this run over its total of ${runCap.toString()} minor units`)
    const nowSec = Math.floor(this.now() / 1000)
    const auth: Authorization = { from: this.address, to: String(req.payTo), value: amount, validAfter: 0n, validBefore: BigInt(nowSec + 300), nonce: (this.opts.randomNonce ?? (() => '0x' + randomBytes(32).toString('hex')))() }
    const signature = signAuthorization(this.opts.chain, auth, this.opts.privateKey)
    const authorization = { from: auth.from, to: auth.to, value: auth.value.toString(), validAfter: '0', validBefore: auth.validBefore.toString(), nonce: auth.nonce }
    return {
      amount,
      body: {
        x402Version: 2,
        paymentPayload: { x402Version: 2, resource: pr.resource, accepted: req, payload: { signature, authorization }, extensions: pr.extensions },
        paymentRequirements: req,
      },
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

/** A pair went through: the facilitator accepted the authorization and did not reject the extension. */
function isOk(r: Registration): boolean {
  return r.verified && r.catalogue !== 'rejected'
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

/**
 * What a catalogue would show, and what the bazaar `info`/`schema` are built from: ids, URLs, prices, payees,
 * titles, descriptions, tags, the example input and both schemas. A change here means the entries need refreshing.
 */
export function fingerprintOf(services: Service[]): string {
  const h = createHash('sha256')
  for (const s of [...services].sort((a, b) => a.listing_id.localeCompare(b.listing_id))) {
    h.update(JSON.stringify([s.listing_id, s.url, s.price ?? null, s.pay_to ?? null, s.title ?? null, s.description ?? null, s.tags ?? null, s.example_input ?? null, s.input_schema ?? null, s.output_schema ?? null]))
  }
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
