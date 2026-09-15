/**
 * SellerRuntime: one Agent Souk identity selling the services it was given. Ensures the listings exist, registers
 * a webhook, and turns `job.created` events (or an inbox poll) into accept → run → deliver. Declines bad input
 * before accepting; a failure after accepting cancels the job (an honest seller_failed, never a silent stall).
 */
import { AgentSoukError, type AgentSouk, type Listing, type ListingInput } from 'agentsouk'
import { LlmBudgetExceeded } from './llm.js'
import { serviceTag, type ListingSpec, type ServiceDef } from './services/types.js'

export type Env = 'live' | 'test'
export type Logger = (msg: string, extra?: Record<string, unknown>) => void
export type Outcome = 'delivered' | 'declined' | 'cancelled' | 'skipped'

/** The fields of the spec that differ from the listing as the API shows it; null when nothing does. */
export function listingPatch(existing: Listing, spec: ListingSpec & { tags: string[] }): Partial<ListingInput> | null {
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
  const patch: Partial<ListingInput> = {}
  if (existing.title !== spec.title) patch.title = spec.title
  if (existing.description !== spec.description) patch.description = spec.description
  if (existing.category !== spec.category) patch.category = spec.category
  if (!same([...existing.tags].sort(), [...spec.tags].sort())) patch.tags = spec.tags
  if ((existing.pricing.price ?? null) !== spec.price) patch.price = spec.price
  if ((existing.pricing.unit_name ?? null) !== (spec.unit_name ?? null)) patch.unit_name = spec.unit_name ?? null
  if (!same(existing.input_schema, spec.input_schema)) patch.input_schema = spec.input_schema as ListingInput['input_schema']
  if (!same(existing.output_schema, spec.output_schema ?? null)) patch.output_schema = (spec.output_schema ?? null) as ListingInput['output_schema']
  if (!same(existing.example_input, spec.example_input)) patch.example_input = spec.example_input
  if (!same(existing.example_output, spec.example_output)) patch.example_output = spec.example_output
  if (existing.turnaround_seconds !== spec.turnaround_seconds) patch.turnaround_seconds = spec.turnaround_seconds
  if (existing.accept_timeout_seconds !== spec.accept_timeout_seconds) patch.accept_timeout_seconds = spec.accept_timeout_seconds
  if (existing.max_open_jobs !== spec.max_open_jobs) patch.max_open_jobs = spec.max_open_jobs
  return Object.keys(patch).length ? patch : null
}

export class SellerRuntime {
  private readonly byListing = new Map<string, ServiceDef>()
  private readonly inFlight = new Set<string>()
  me: { id: string; handle: string } | null = null

  constructor(
    readonly client: AgentSouk,
    readonly services: ServiceDef[],
    readonly env: Env,
    readonly log: Logger = () => undefined,
  ) {}

  /** Loads the identity and makes sure every service has an active listing. Idempotent. */
  async init(): Promise<void> {
    const me = await this.client.agents.me()
    this.me = { id: me.id, handle: me.handle }
    if (!me.first_party) this.log('warning: this agent is not flagged first_party yet (ADR-23); ask the operator to flag it', { env: this.env, agent: me.handle })
    await this.ensureListings()
  }

  listingIds(): string[] {
    return [...this.byListing.keys()]
  }

  async ensureListings(): Promise<void> {
    const mine = await this.client.listings.mine({ limit: 100 })
    for (const s of this.services) {
      const tag = serviceTag(s.key)
      let listing = mine.data.find((l) => l.tags.includes(tag) && l.status !== 'archived')
      if (!listing) {
        listing = await this.client.listings.create({ ...s.listing, pricing_model: s.listing.pricing_model ?? 'fixed', payment: 'on_delivery', tags: [...s.listing.tags, tag] })
        this.log('listing created', { env: this.env, service: s.key, listing_id: listing.id })
      } else {
        // The spec in code is the truth. Until 0.2.8 an existing listing kept its first words for ever: the first audit of
        // token-snapshot changed its title, caps and description, and live would have gone on selling the old text (ADR-64).
        const patch = listingPatch(listing, { ...s.listing, tags: [...s.listing.tags, tag] })
        if (patch) {
          listing = await this.client.listings.update(listing.id, patch)
          this.log('listing updated to the current spec', { env: this.env, service: s.key, listing_id: listing.id, fields: Object.keys(patch) })
        }
        if (listing.status === 'paused') {
          listing = await this.client.listings.update(listing.id, { status: 'active' })
          this.log('listing resumed', { env: this.env, service: s.key, listing_id: listing.id })
        }
      }
      this.byListing.set(listing.id, s)
    }
    // A listing whose service is not part of this runtime (e.g. LLM services without model access) is paused, never left to decline jobs.
    const known = new Set(this.services.map((s) => serviceTag(s.key)))
    for (const l of mine.data) {
      if (l.status !== 'active' || !l.tags.some((t) => t.startsWith('souk:') && !known.has(t))) continue
      await this.client.listings.update(l.id, { status: 'paused' })
      this.log('listing paused: service not in this runtime', { env: this.env, listing_id: l.id, tags: l.tags })
    }
  }

  /**
   * Registers a signed webhook for job events at `url` (idempotent by URL). A hook the platform disabled after
   * repeated failures is deleted, not left behind: ten restarts with a dead receiver used to fill MAX_WEBHOOKS and
   * turn the eleventh start into 409 webhook_limit (ADR-61). The replacement exists before the old one goes.
   */
  async ensureWebhook(url: string, secret: string): Promise<string> {
    const hooks = (await this.client.webhooks.list()).data as { id: string; url?: string; status?: string }[]
    const ours = hooks.filter((h) => h.url === url)
    let keep = ours.find((h) => h.status === 'active')
    if (!keep) {
      const created = (await this.client.webhooks.create({ url, event_types: ['job.created'], secret })) as unknown as { id: string }
      keep = { id: created.id, url, status: 'active' }
      this.log('webhook registered', { env: this.env, url, webhook_id: created.id })
    }
    for (const h of ours) {
      if (h.id === keep.id) continue
      await this.client.webhooks.delete(h.id).catch(() => undefined)
      this.log('stale webhook removed', { env: this.env, url, webhook_id: h.id, status: h.status })
    }
    return keep.id
  }

  /** A delivered webhook event (already signature-checked by the caller). */
  async handleEvent(event: { type: string; data?: Record<string, unknown> }): Promise<Outcome | null> {
    if (event.type !== 'job.created') return null
    const jobId = event.data?.job_id
    if (typeof jobId !== 'string') return null
    if (this.me && event.data?.seller_id !== this.me.id) return null
    return this.processJob(jobId)
  }

  /**
   * Inbox poll: every job where we are the seller and the next move is ours - open ones, and ones a previous process
   * accepted and never finished (ADR-67: the host stops when idle and is replaced on every deploy; an accepted job
   * left behind used to sit in_progress until the platform closed it as our failure).
   */
  async catchUp(): Promise<number> {
    if (!this.me) return 0 // init() has not succeeded: nothing here knows the listings yet, so nothing is touched
    const inbox = await this.client.inbox()
    const open = inbox.jobs_awaiting_my_action.filter((j) => j.role === 'seller' && (j.status === 'open' || j.status === 'in_progress'))
    let n = 0
    for (const j of open) {
      const outcome = await this.processJob(j.id)
      if (outcome !== 'skipped') n++
    }
    return n
  }

  /** How many jobs this process is working on right now; the host must not be stopped while it is above 0. */
  get working(): number {
    return this.inFlight.size
  }

  async processJob(id: string): Promise<Outcome> {
    if (this.inFlight.has(id)) return 'skipped'
    this.inFlight.add(id)
    try {
      const job = await this.client.jobs.get(id)
      if (job.role !== 'seller' || (job.status !== 'open' && job.status !== 'in_progress')) return 'skipped'
      // in_progress: accepted by a process that is gone (nothing this process accepted is ever re-read here, see
      // inFlight), so the work is done now and delivered late rather than never
      const resumed = job.status === 'in_progress'
      const service = job.listing_id ? this.byListing.get(job.listing_id) : undefined
      if (!service) {
        // accepted for a listing this runtime does not serve: left alone, the platform closes it at its deadline and
        // a runtime that serves it again may still deliver; cancelling here would be a failure on our record for
        // nothing (ADR-67 audit: a half-initialised runtime would have cancelled every resumed job)
        if (resumed) {
          this.log('left alone: accepted job of a listing this runtime does not serve', { env: this.env, job_id: id, listing_id: job.listing_id })
          return 'skipped'
        }
        await this.client.jobs.decline(id, 'This listing is not served by the current runtime; please pick another listing.')
        this.log('declined: unknown listing', { env: this.env, job_id: id, listing_id: job.listing_id })
        return 'declined'
      }
      const input = (job.input ?? {}) as Record<string, unknown>
      if (resumed && job.revision_count > 0) {
        // The other producer of in_progress: the buyer sent the delivery back with a message. These services take
        // no free-text instructions, so the answer is the same output with a clear note, not another model call and
        // not silence (a paid job in progress is never swept).
        if (job.output == null) return 'skipped'
        await this.client.jobs.deliver(id, job.output, 'Delivered again unchanged: this service takes no free-text revision instructions. To get a different result, order a new job with the input adjusted (see the listing input_schema).')
        this.log('revision requested: delivered again unchanged', { env: this.env, job_id: id, service: service.key, revision: job.revision_count })
        return 'delivered'
      }
      if (resumed) {
        this.log('resuming a job accepted before a restart', { env: this.env, job_id: id, service: service.key })
      } else {
        const reason = await service.validate(input, { units: job.units })
        if (reason) {
          await this.client.jobs.decline(id, `Invalid input: ${reason}. See the listing input_schema and example_input.`.slice(0, 500))
          this.log('declined: invalid input', { env: this.env, job_id: id, service: service.key, reason })
          return 'declined'
        }
        await this.client.jobs.accept(id)
      }
      const started = Date.now()
      try {
        const r = await service.run(input, { units: job.units })
        try {
          await this.client.jobs.deliver(id, r.output, r.message, r.preview)
        } catch (e) {
          // the job is no longer in progress: the buyer or the platform closed it while we worked (an x402 buyer that
          // stopped waiting, ADR-67) - nothing to cancel, nothing to mark
          if (e instanceof AgentSoukError && e.status === 409) {
            this.log('delivery no longer wanted', { env: this.env, job_id: id, service: service.key, ms: Date.now() - started, error: e.message })
            return 'skipped'
          }
          throw e
        }
        this.log('delivered', { env: this.env, job_id: id, service: service.key, ms: Date.now() - started })
        return 'delivered'
      } catch (e) {
        // a resumed job whose budget could not be checked yet is left for the next poll, not failed: the store is
        // read again there, and the platform's deadline is the limit
        if (resumed && e instanceof LlmBudgetExceeded && e.retryLater) {
          this.log('resume postponed: budget not readable yet', { env: this.env, job_id: id, service: service.key })
          return 'skipped'
        }
        const msg = `Could not complete the job: ${(e as Error).message ?? String(e)}`.slice(0, 500)
        this.log('cancelled after failure', { env: this.env, job_id: id, service: service.key, error: msg })
        await this.client.jobs.cancel(id, msg).catch((err: unknown) => this.log('cancel failed', { env: this.env, job_id: id, error: String(err) }))
        return 'cancelled'
      }
    } finally {
      this.inFlight.delete(id)
    }
  }
}
