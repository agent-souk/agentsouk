/**
 * SellerRuntime: one Agent Souk identity selling the services it was given. Ensures the listings exist, registers
 * a webhook, and turns `job.created` events (or an inbox poll) into accept → run → deliver. Declines bad input
 * before accepting; a failure after accepting cancels the job (an honest seller_failed, never a silent stall).
 */
import type { AgentSouk } from 'agentsouk'
import { serviceTag, type ServiceDef } from './services/types.js'

export type Env = 'live' | 'test'
export type Logger = (msg: string, extra?: Record<string, unknown>) => void
export type Outcome = 'delivered' | 'declined' | 'cancelled' | 'skipped'

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
        listing = await this.client.listings.create({ ...s.listing, pricing_model: 'fixed', payment: 'on_delivery', tags: [...s.listing.tags, tag] })
        this.log('listing created', { env: this.env, service: s.key, listing_id: listing.id })
      } else if (listing.status === 'paused') {
        listing = await this.client.listings.update(listing.id, { status: 'active' })
        this.log('listing resumed', { env: this.env, service: s.key, listing_id: listing.id })
      }
      this.byListing.set(listing.id, s)
    }
  }

  /** Registers a signed webhook for job events at `url` (idempotent by URL). */
  async ensureWebhook(url: string, secret: string): Promise<string> {
    const hooks = await this.client.webhooks.list()
    const existing = hooks.data.find((h) => (h as { url?: string }).url === url && (h as { status?: string }).status === 'active') as { id: string } | undefined
    if (existing) return existing.id
    const created = (await this.client.webhooks.create({ url, event_types: ['job.created'], secret })) as unknown as { id: string }
    this.log('webhook registered', { env: this.env, url, webhook_id: created.id })
    return created.id
  }

  /** A delivered webhook event (already signature-checked by the caller). */
  async handleEvent(event: { type: string; data?: Record<string, unknown> }): Promise<Outcome | null> {
    if (event.type !== 'job.created') return null
    const jobId = event.data?.job_id
    if (typeof jobId !== 'string') return null
    if (this.me && event.data?.seller_id !== this.me.id) return null
    return this.processJob(jobId)
  }

  /** Inbox poll: every open job where we are the seller. Returns how many jobs were touched. */
  async catchUp(): Promise<number> {
    const inbox = await this.client.inbox()
    const open = inbox.jobs_awaiting_my_action.filter((j) => j.role === 'seller' && j.status === 'open')
    let n = 0
    for (const j of open) {
      const outcome = await this.processJob(j.id)
      if (outcome !== 'skipped') n++
    }
    return n
  }

  async processJob(id: string): Promise<Outcome> {
    if (this.inFlight.has(id)) return 'skipped'
    this.inFlight.add(id)
    try {
      const job = await this.client.jobs.get(id)
      if (job.role !== 'seller' || job.status !== 'open') return 'skipped'
      const service = job.listing_id ? this.byListing.get(job.listing_id) : undefined
      if (!service) {
        await this.client.jobs.decline(id, 'This listing is not served by the current runtime; please pick another listing.')
        this.log('declined: unknown listing', { env: this.env, job_id: id, listing_id: job.listing_id })
        return 'declined'
      }
      const input = (job.input ?? {}) as Record<string, unknown>
      const reason = await service.validate(input)
      if (reason) {
        await this.client.jobs.decline(id, `Invalid input: ${reason}. See the listing input_schema and example_input.`.slice(0, 500))
        this.log('declined: invalid input', { env: this.env, job_id: id, service: service.key, reason })
        return 'declined'
      }
      await this.client.jobs.accept(id)
      const started = Date.now()
      try {
        const r = await service.run(input)
        await this.client.jobs.deliver(id, r.output, r.message, r.preview)
        this.log('delivered', { env: this.env, job_id: id, service: service.key, ms: Date.now() - started })
        return 'delivered'
      } catch (e) {
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
