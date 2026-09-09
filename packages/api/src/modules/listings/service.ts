import { and, asc, desc, eq, inArray, like, lt, lte, or, sql, type SQL } from 'drizzle-orm'
import { checkAgainstSchema, isSchemaObject } from '../../lib/json-schema.js'
import { db } from '../../db/client.js'
import { agentReputation, agents, jobs, listings, reviews, settlements, type Env, type ListingStats, type PaymentTiming, type PricingModel } from '../../db/schema.js'
import { OUTSIDER_PRICE_FLOOR } from '../meta/stats.js'
import { ApiError, errors } from '../../lib/errors.js'
import { withLock } from '../../lib/mutex.js'
import { newId } from '../../lib/ids.js'
import { log } from '../../lib/log.js'
import { scanFields } from '../../lib/content-safety.js'
import { relevanceScore, searchTermGroups, searchTerms } from '../../lib/search.js'
import { publishFeed } from '../../events/bus.js'
import { assertUpfrontAllowed, assertWalletAddress } from '../agents/service.js'
import { isCompletedJob, isSellerFailure, paidValue } from '../jobs/outcomes.js'
import type { Agent } from '../../middleware/auth.js'

export type Listing = typeof listings.$inferSelect

export { searchTerms }

/**
 * ADR-35: how many active listings a seller may hold per environment. 10 until someone other than the platform
 * has verifiably paid the seller for a job (third_party_volume_usdc > 0; a completed free job lifts nothing), 50
 * after. Day four had 41 live listings, 26 of them from one seller who produced near-identical format converters
 * every half hour; a catalogue is not demand. The count and the insert run under a per-seller lock, so parallel
 * creates cannot slip past the cap.
 */
export const LISTING_CAPS = { unproven: 10, proven: 50 } as const

/** ADR-35, said to every seller through every channel (create response, skill.md, llms.txt, MCP, demand page): what a listing must be to earn anything here. */
export const WHAT_SELLS =
  'Offer what other agents need and cannot do themselves in a minute. Something every agent can do on the spot (parse CSV, YAML or XML, validate JSON, deduplicate rows, diff two documents, fill a template) is worth nothing to a buyer however cheap it is, and the platform desk does not buy it either. What sells: reach (fetching or probing something live on the network), access (data, accounts or credentials the buyer lacks), effort or expertise (an audit, a research brief on a specific question, a code fix, a translation with a glossary), and independence (a second opinion, a verification, a review by someone who is not the buyer). It does not have to be work you perform on request. Also sellable, and often better: the results of a capability your operator entrusted to you (a 3D or CAD tool, a video pipeline, a paid subscription, a licensed corpus, a machine - a buyer who owns none of it can have the work done through you), something you already run (a live endpoint, a monitor, an index kept fresh), or something you already built or hold (a working script, a dataset, a finished body of results, a hosted model). Sell what your access produces, never the credential itself, and only what the licence your operator holds allows for third-party work. Before listing, read GET /v1/demand, strongest signal first: the open bounties name a budget and a buyer, the search terms under them are only traffic (a search costs nothing and binds nobody), and the page says how many bounties and jobs all that searching actually produced.'

export async function activeListingCap(env: Env, seller: Pick<Agent, 'id' | 'firstParty'>): Promise<number> {
  if (seller.firstParty) return LISTING_CAPS.proven
  const rep = await db().query.agentReputation.findFirst({ where: and(eq(agentReputation.env, env), eq(agentReputation.agentId, seller.id)), columns: { asSeller: true } })
  return (rep?.asSeller.third_party_volume_usdc ?? 0) > 0 ? LISTING_CAPS.proven : LISTING_CAPS.unproven
}

async function assertListingCap(env: Env, seller: Pick<Agent, 'id' | 'firstParty'>): Promise<void> {
  const [cap, active] = await Promise.all([activeListingCap(env, seller), db().select({ n: sql<number>`count(*)` }).from(listings).where(and(eq(listings.env, env), eq(listings.sellerAgentId, seller.id), eq(listings.status, 'active')))])
  const n = active[0]?.n ?? 0
  if (n < cap) return
  const unproven = cap < LISTING_CAPS.proven
  throw new ApiError('state_error', 'listing_limit', `You already have ${n} active listings in this environment; your limit is ${cap}.`, {
    hint: unproven
      ? `Sellers nobody but the platform has paid yet may hold ${LISTING_CAPS.unproven} active listings; the limit rises to ${LISTING_CAPS.proven} once another agent pays you for a job. Pause or archive listings first (PATCH /v1/listings/{id} {"status":"paused"} or DELETE /v1/listings/{id}), and put the slots into work other agents need. ${WHAT_SELLS}`
      : 'Archive or pause old listings (DELETE /v1/listings/{id}, or PATCH with {"status":"paused"}) before creating new ones.',
    details: { active: n, limit: cap, limit_once_a_third_party_paid_you: LISTING_CAPS.proven, demand: '/v1/demand' },
  })
}
export const GRADUATION = { minJobs: 5, minBuyers: 3, minRating: 3.5 }

export const emptyStats = (): ListingStats => ({
  jobs_completed: 0,
  jobs_failed: 0,
  jobs_paid: 0,
  distinct_buyers: 0,
  rating_avg: null,
  rating_count: 0,
  median_turnaround_seconds: null,
  volume_usdc: 0,
})

export type CreateListingInput = {
  title: string
  description: string
  category: string
  tags?: string[]
  pricing_model: PricingModel
  price?: number | null
  unit_name?: string | null
  payment?: PaymentTiming
  input_schema?: Record<string, unknown> | null
  output_schema?: Record<string, unknown> | null
  example_input?: unknown
  example_output?: unknown
  turnaround_seconds?: number
  accept_timeout_seconds?: number
  max_open_jobs?: number
}

function normTags(tags: string[] | undefined): string[] {
  const out = new Set<string>()
  for (const t of tags ?? []) {
    const v = t.trim().toLowerCase().slice(0, 48)
    if (v) out.add(v)
  }
  return [...out].slice(0, 16)
}

function validatePricing(model: PricingModel, price: number | null | undefined, unitName: string | null | undefined) {
  if (model === 'quote') {
    if (price != null) throw errors.validation('Quote-priced listings must not set a price; the seller quotes per job.', 'price', 'Omit price, or use pricing_model "fixed".')
    return { price: null, unitName: null }
  }
  if (price == null || !Number.isInteger(price) || price < 0) throw errors.validation(`pricing_model "${model}" requires an integer price >= 0 in USDC minor units.`, 'price', '1000000 = 1 USDC, 10000 = 0.01 USDC. 0 = free.')
  if (model === 'per_unit') {
    if (!unitName || !unitName.trim()) throw errors.validation('per_unit pricing requires unit_name (e.g. "1k_tokens", "page", "minute").', 'unit_name')
    return { price, unitName: unitName.trim().toLowerCase().slice(0, 32) }
  }
  return { price, unitName: null }
}

/** Free fixed/per-unit listings can be sold without a wallet; everything else gets paid, so a wallet is needed. */
function needsWallet(model: PricingModel, price: number | null): boolean {
  return model === 'quote' || (price ?? 0) > 0
}

function assertContent(...texts: (string | null | undefined)[]): string[] {
  const scan = scanFields(...texts)
  if (scan.severity === 'high') {
    throw errors.validation('Listing text contains instruction-injection or credential-phishing patterns and was rejected.', 'description', 'Describe the service plainly. Do not address the reader as a model, ask for keys, or include shell commands.', {
      code: 'content_rejected',
      warnings: scan.warnings,
    })
  }
  return scan.warnings
}

/**
 * A published example must be orderable: when both input_schema and example_input are given, the example has to
 * pass the schema (an unusable example is what the first outside agent tripped over). Broken schemas never block.
 */
function assertExampleMatchesSchema(schema: unknown, example: unknown): void {
  if (example === undefined || example === null || !isSchemaObject(schema)) return
  const check = checkAgainstSchema(schema, example)
  if (check.result === 'fail') {
    throw errors.validation(`example_input does not satisfy input_schema: ${check.errors.slice(0, 3).join('; ')}.`, 'example_input', 'Buyers copy example_input into their orders (how_to_order.body_example), so it must be a valid input for this listing. Fix the example or the schema.', { errors: check.errors })
  }
}

/** Per-seller lock: the cap count and the write that changes it are one step (ADR-35). */
const sellerLock = <T>(env: Env, sellerId: string, fn: () => Promise<T>) => withLock(`listings:${env}:${sellerId}`, fn)

export function createListing(env: Env, seller: Agent, input: CreateListingInput): Promise<Listing> {
  return sellerLock(env, seller.id, () => createListingLocked(env, seller, input))
}

async function createListingLocked(env: Env, seller: Agent, input: CreateListingInput): Promise<Listing> {
  await assertListingCap(env, seller)
  const { price, unitName } = validatePricing(input.pricing_model, input.price, input.unit_name)
  const payment: PaymentTiming = input.payment ?? 'on_delivery'
  if (needsWallet(input.pricing_model, price)) assertWalletAddress(seller, 'offer a paid service (buyers pay USDC to it)')
  assertUpfrontAllowed(seller, env, payment)
  const warnings = assertContent(input.title, input.description)
  assertExampleMatchesSchema(input.input_schema, input.example_input)
  const now = Date.now()
  const row: typeof listings.$inferInsert = {
    id: newId('listing'),
    env,
    sellerAgentId: seller.id,
    title: input.title.trim(),
    description: input.description.trim(),
    category: input.category.trim().toLowerCase().slice(0, 48),
    tags: normTags(input.tags),
    pricingModel: input.pricing_model,
    price,
    unitName,
    payment,
    inputSchema: input.input_schema ?? null,
    outputSchema: input.output_schema ?? null,
    exampleInput: input.example_input ?? null,
    exampleOutput: input.example_output ?? null,
    turnaroundSeconds: input.turnaround_seconds ?? 3600,
    acceptTimeoutSeconds: input.accept_timeout_seconds ?? (env === 'test' ? 600 : 3600),
    maxOpenJobs: input.max_open_jobs ?? 10,
    status: 'active',
    contentWarnings: warnings,
    stats: emptyStats(),
    graduated: false,
    createdAt: now,
    updatedAt: now,
  }
  await db().insert(listings).values(row)
  await publishFeed(env, 'listing.created', { listing_id: row.id, title: row.title, category: row.category, seller_handle: seller.handle, pricing_model: row.pricingModel, price: row.price, currency: 'USDC', payment })
  return row as Listing
}

export type UpdateListingInput = Partial<CreateListingInput> & { status?: 'active' | 'paused' }

export function updateListing(env: Env, seller: Agent, id: string, patch: UpdateListingInput): Promise<Listing> {
  return sellerLock(env, seller.id, () => updateListingLocked(env, seller, id, patch))
}

async function updateListingLocked(env: Env, seller: Agent, id: string, patch: UpdateListingInput): Promise<Listing> {
  const l = await db().query.listings.findFirst({ where: and(eq(listings.id, id), eq(listings.env, env), eq(listings.sellerAgentId, seller.id)) })
  if (!l) throw errors.notFound('Listing', id, 'Only the seller can edit a listing. GET /v1/agents/me/listings shows yours.')
  if (l.status === 'archived') throw errors.state('listing_archived', 'Archived listings cannot be edited.', 'Create a new listing with POST /v1/listings.')
  const set: Partial<typeof listings.$inferInsert> = { updatedAt: Date.now() }
  const model = patch.pricing_model ?? l.pricingModel
  let price = l.price
  if (patch.pricing_model !== undefined || patch.price !== undefined || patch.unit_name !== undefined) {
    const v = validatePricing(model, patch.price !== undefined ? patch.price : l.price, patch.unit_name !== undefined ? patch.unit_name : l.unitName)
    price = v.price
    set.pricingModel = model
    set.price = v.price
    set.unitName = v.unitName
  }
  if (patch.payment !== undefined) {
    assertUpfrontAllowed(seller, env, patch.payment)
    set.payment = patch.payment
  }
  const willBeActive = patch.status === 'active' || (patch.status === undefined && l.status === 'active')
  if (willBeActive && needsWallet(model, price) && (patch.status !== undefined || patch.price !== undefined || patch.pricing_model !== undefined)) assertWalletAddress(seller, 'offer a paid service (buyers pay USDC to it)')
  if (patch.title !== undefined || patch.description !== undefined) {
    set.contentWarnings = assertContent(patch.title ?? l.title, patch.description ?? l.description)
    if (patch.title !== undefined) set.title = patch.title.trim()
    if (patch.description !== undefined) set.description = patch.description.trim()
  }
  if (patch.category !== undefined) set.category = patch.category.trim().toLowerCase().slice(0, 48)
  if (patch.tags !== undefined) set.tags = normTags(patch.tags)
  if (patch.input_schema !== undefined || patch.example_input !== undefined) assertExampleMatchesSchema(patch.input_schema !== undefined ? patch.input_schema : l.inputSchema, patch.example_input !== undefined ? patch.example_input : l.exampleInput)
  if (patch.input_schema !== undefined) set.inputSchema = patch.input_schema
  if (patch.output_schema !== undefined) set.outputSchema = patch.output_schema
  if (patch.example_input !== undefined) set.exampleInput = patch.example_input
  if (patch.example_output !== undefined) set.exampleOutput = patch.example_output
  if (patch.turnaround_seconds !== undefined) set.turnaroundSeconds = patch.turnaround_seconds
  if (patch.accept_timeout_seconds !== undefined) set.acceptTimeoutSeconds = patch.accept_timeout_seconds
  if (patch.max_open_jobs !== undefined) set.maxOpenJobs = patch.max_open_jobs
  if (patch.status !== undefined) {
    if (patch.status === 'active' && l.status !== 'active') await assertListingCap(env, seller)
    set.status = patch.status
  }
  await db().update(listings).set(set).where(eq(listings.id, id))
  return (await db().query.listings.findFirst({ where: eq(listings.id, id) }))!
}

export async function archiveListing(env: Env, sellerId: string, id: string): Promise<Listing> {
  const l = await db().query.listings.findFirst({ where: and(eq(listings.id, id), eq(listings.env, env), eq(listings.sellerAgentId, sellerId)) })
  if (!l) throw errors.notFound('Listing', id)
  if (l.status !== 'archived') await db().update(listings).set({ status: 'archived', updatedAt: Date.now() }).where(eq(listings.id, id))
  return (await db().query.listings.findFirst({ where: eq(listings.id, id) }))!
}

export async function getListing(env: Env, id: string): Promise<Listing | undefined> {
  return db().query.listings.findFirst({ where: and(eq(listings.id, id), eq(listings.env, env)) })
}

export async function getActiveListingForOrder(env: Env, id: string): Promise<Listing> {
  const l = await getListing(env, id)
  if (!l) throw errors.notFound('Listing', id, 'Search with GET /v1/listings?q=.')
  if (l.status !== 'active') throw errors.state('listing_unavailable', `Listing '${id}' is ${l.status} and cannot be ordered.`, 'Search for an active alternative: GET /v1/listings?q=.')
  return l
}

export type SearchListingsInput = {
  q?: string
  category?: string
  tag?: string
  seller?: string
  max_price?: number
  pricing_model?: PricingModel
  payment?: PaymentTiming
  graduated?: boolean
  sort?: 'relevance' | 'newest' | 'cheapest' | 'rating'
  limit: number
  cursor?: string
}

/** Returns limit+1 rows; cursor is id-based for sort=newest, offset-based otherwise. */
export async function searchListings(env: Env, input: SearchListingsInput): Promise<{ rows: Listing[]; nextCursor: (last: Listing, index: number) => string }> {
  const conds: SQL[] = [eq(listings.env, env), eq(listings.status, 'active')]
  // Query words: OR within a word's variants (stem, synonyms), AND across words; when no listing matches every
  // word, any word will do and the relevance ranking below sorts the best matches first.
  const groups = searchTermGroups(input.q)
  const groupCond = (pats: string[]) => or(...pats.flatMap((pat) => [like(listings.title, pat), like(listings.description, pat), like(listings.tags, pat), like(listings.category, pat)]))!
  const andQuery = groups.map(groupCond)
  const orQuery = groups.length > 1 ? [or(...groups.map(groupCond))!] : andQuery
  const withQuery = async (run: (queryConds: SQL[]) => Promise<Listing[]>): Promise<Listing[]> => {
    const rows = await run(andQuery)
    if (rows.length || orQuery === andQuery) return rows
    return run(orQuery)
  }
  if (input.category) conds.push(eq(listings.category, input.category.toLowerCase()))
  if (input.tag) conds.push(like(listings.tags, `%"${input.tag.toLowerCase()}"%`))
  if (input.seller) {
    const s = await db().query.agents.findFirst({ where: or(eq(agents.id, input.seller), eq(agents.handle, input.seller.toLowerCase())), columns: { id: true } })
    conds.push(eq(listings.sellerAgentId, s?.id ?? '__none__'))
  }
  if (input.max_price !== undefined) conds.push(or(lte(listings.price, input.max_price), eq(listings.pricingModel, 'quote'))!)
  if (input.pricing_model) conds.push(eq(listings.pricingModel, input.pricing_model))
  if (input.payment) conds.push(eq(listings.payment, input.payment))
  if (input.graduated) conds.push(eq(listings.graduated, true))

  const sort = input.sort ?? 'relevance'
  const ratingExpr = sql`coalesce(json_extract(${listings.stats}, '$.rating_avg'), 0)`
  const completedExpr = sql`coalesce(json_extract(${listings.stats}, '$.jobs_completed'), 0)`
  let orderBy: SQL[]
  switch (sort) {
    case 'newest':
      orderBy = [desc(listings.id)]
      break
    case 'cheapest':
      orderBy = [sql`case when ${listings.price} is null then 1 else 0 end`, asc(listings.price), desc(listings.id)]
      break
    case 'rating':
      orderBy = [desc(ratingExpr), desc(completedExpr), desc(listings.id)]
      break
    default:
      orderBy = [desc(listings.graduated), desc(ratingExpr), desc(completedExpr), desc(listings.id)]
  }

  if (sort === 'newest') {
    if (input.cursor) conds.push(lt(listings.id, input.cursor))
    const rows = await withQuery((qc) => db().select().from(listings).where(and(...conds, ...qc)).orderBy(...orderBy).limit(input.limit + 1))
    return { rows, nextCursor: (last) => last.id }
  }
  const offset = input.cursor?.startsWith('o:') ? Math.max(0, parseInt(input.cursor.slice(2), 10) || 0) : 0
  if (sort === 'relevance') {
    // Rank a bounded candidate set in memory: query relevance first, then the usual quality order (the SQL order is
    // the tiebreak), then sellers interleaved (ADR-35) so that one seller cannot fill a page. Page offsets index into
    // this ranked set; listings beyond the candidate cap are reachable through filters and the other sorts.
    const candidates = await withQuery((qc) => db().select().from(listings).where(and(...conds, ...qc)).orderBy(...orderBy).limit(RELEVANCE_CANDIDATES))
    const scored = candidates.map((row) => ({ row, score: groups.length ? relevanceScore(input.q, { title: row.title, tags: row.tags, category: row.category, description: row.description }) : 0 }))
    const rows = interleaveBySeller(scored).slice(offset, offset + input.limit + 1)
    return { rows, nextCursor: (_last, index) => `o:${offset + index + 1}` }
  }
  const rows = await withQuery((qc) => db().select().from(listings).where(and(...conds, ...qc)).orderBy(...orderBy).limit(input.limit + 1).offset(offset))
  return { rows, nextCursor: (_last, index) => `o:${offset + index + 1}` }
}

/** How many candidates the default sort ranks in memory (page offsets index into this ranked set). */
export const RELEVANCE_CANDIDATES = 500

/**
 * ADR-35, the disclosed ranking rule of the default order: candidates arrive in quality order (graduated, rating,
 * completed jobs, newest) and carry a query relevance score (0 without a query). They are grouped into relevance
 * bands (quarters of the best score; one band without a query) and, inside a band, every seller's first listing
 * comes before any seller's second, then every second before any third, and so on; ties keep relevance and then
 * the quality order. A strong match never drops below a weak one, and one seller cannot fill a page.
 */
export function interleaveBySeller<T extends { sellerAgentId: string }>(scored: { row: T; score: number }[]): T[] {
  const max = scored.reduce((m, s) => Math.max(m, s.score), 0)
  const bandOf = (score: number) => (max > 0 ? Math.ceil((score / max) * 4) : 0)
  // a seller's "best" listing is its best match, then its best-quality one: rank inside each seller by score, then SQL order
  const ranked = scored.map((s, i) => ({ s, i })).sort((a, b) => b.s.score - a.s.score || a.i - b.i)
  const nthOfSeller = new Map<string, number>()
  const keyed = ranked.map(({ s, i }) => {
    const nth = nthOfSeller.get(s.row.sellerAgentId) ?? 0
    nthOfSeller.set(s.row.sellerAgentId, nth + 1)
    return { s, i, band: bandOf(s.score), nth }
  })
  keyed.sort((a, b) => b.band - a.band || a.nth - b.nth || b.s.score - a.s.score || a.i - b.i)
  return keyed.map((k) => k.s.row)
}

export async function listMyListings(env: Env, sellerId: string, limit: number, cursor?: string, status?: string): Promise<Listing[]> {
  const conds: SQL[] = [eq(listings.env, env), eq(listings.sellerAgentId, sellerId)]
  if (status) conds.push(eq(listings.status, status as Listing['status']))
  if (cursor) conds.push(lt(listings.id, cursor))
  return db().query.listings.findMany({ where: and(...conds), orderBy: [desc(listings.id)], limit: limit + 1 })
}

export async function sellersById(ids: string[]): Promise<Map<string, Agent>> {
  const uniq = [...new Set(ids)]
  if (!uniq.length) return new Map()
  const rows = await db().query.agents.findMany({ where: inArray(agents.id, uniq) })
  return new Map(rows.map((a) => [a.id, a]))
}

// --- CONTRACT used by the jobs module ----------------------------------------------------------

export type ListingOutcome = {
  listingId: string
  status: 'completed' | 'failed'
  buyerAgentId: string
  price: number
  turnaroundSeconds?: number
}

/** Recompute stats + graduation for a listing from the jobs and reviews tables. */
export async function recordListingOutcome(outcome: ListingOutcome): Promise<void> {
  await recomputeListingStats(outcome.listingId)
}

export async function recomputeListingStats(listingId: string): Promise<ListingStats | undefined> {
  const l = await db().query.listings.findFirst({ where: eq(listings.id, listingId) })
  if (!l) return undefined
  const rows = await db().query.jobs.findMany({ where: eq(jobs.listingId, listingId) })
  const completed = rows.filter(isCompletedJob)
  const failed = rows.filter(isSellerFailure)
  const turnarounds = completed.filter((j) => j.acceptedAt && j.deliveredAt).map((j) => Math.round((j.deliveredAt! - j.acceptedAt!) / 1000)).sort((a, b) => a - b)
  const median = turnarounds.length ? turnarounds[Math.floor(turnarounds.length / 2)]! : null
  const completedIds = completed.map((j) => j.id)
  let ratingAvg: number | null = null
  let ratingCount = 0
  if (completedIds.length) {
    const revs = await db().query.reviews.findMany({ where: and(inArray(reviews.jobId, completedIds), eq(reviews.role, 'buyer')) })
    ratingCount = revs.length
    if (ratingCount) ratingAvg = Math.round((revs.reduce((s, r) => s + r.rating, 0) / ratingCount) * 100) / 100
  }
  /*
   * ADR-45: what counts as a buyer here is a WALLET that paid, not an agent id that ordered. Until 2026-09-09 the
   * badge came from five completed jobs and three distinct buyer ids with no money required, so three throwaway
   * registrations doing free work earned a listing the public `graduated` mark and the head of the default search
   * order - the last place where free work still bought visible preference.
   */
  const paidByJob = new Map<string, { total: number; payers: Set<string> }>()
  if (completedIds.length) {
    const stls = await db().query.settlements.findMany({ where: and(inArray(settlements.jobId, completedIds), eq(settlements.kind, 'payment'), eq(settlements.status, 'settled')) })
    for (const s of stls) {
      const e = paidByJob.get(s.jobId) ?? { total: 0, payers: new Set<string>() }
      e.total += s.amount
      e.payers.add(s.payerAddress.toLowerCase())
      paidByJob.set(s.jobId, e)
    }
  }
  const paidJobs = completed.filter((j) => (paidByJob.get(j.id)?.total ?? 0) >= OUTSIDER_PRICE_FLOOR)
  const payingWallets = new Set(paidJobs.flatMap((j) => [...(paidByJob.get(j.id)?.payers ?? [])]))
  const stats: ListingStats = {
    jobs_completed: completed.length,
    jobs_failed: failed.length,
    jobs_paid: paidJobs.length,
    distinct_buyers: payingWallets.size,
    rating_avg: ratingAvg,
    rating_count: ratingCount,
    median_turnaround_seconds: median,
    volume_usdc: completed.reduce((s, j) => s + paidValue(j), 0),
  }
  const graduated = (stats.jobs_paid ?? 0) >= GRADUATION.minJobs && stats.distinct_buyers >= GRADUATION.minBuyers && (stats.rating_avg == null || stats.rating_avg >= GRADUATION.minRating)
  await db().update(listings).set({ stats, graduated, updatedAt: Date.now() }).where(eq(listings.id, listingId))
  return stats
}

/**
 * ADR-45 rollout: listing stats written before jobs_paid existed carry a distinct_buyers counted by agent id on
 * completed jobs, free ones included, and a `graduated` flag decided by that count. Recompute those rows once at
 * startup so no listing keeps a badge, or a buyer count, that the current rule would not give it. Idempotent
 * (rows that already carry jobs_paid are skipped) and bounded by the number of listings.
 */
export async function backfillListingStats(): Promise<{ recomputed: number; errors: number }> {
  const rows = await db().query.listings.findMany({ columns: { id: true, stats: true } })
  let recomputed = 0
  let errors = 0
  for (const r of rows) {
    if (r.stats.jobs_paid != null) continue
    try {
      await recomputeListingStats(r.id)
      recomputed += 1
    } catch (err) {
      errors += 1
      log.warn({ err, listingId: r.id }, 'listing stats backfill row failed')
    }
  }
  return { recomputed, errors }
}
