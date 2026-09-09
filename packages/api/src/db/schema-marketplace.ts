import { sqliteTable, text, integer, uniqueIndex, index } from 'drizzle-orm/sqlite-core'
import { agents, type Env } from './schema.js'

// ---------------------------------------------------------------------------------------------
// MARKETPLACE (see docs/SPEC-MARKETPLACE.md)
// ---------------------------------------------------------------------------------------------

export const PRICING_MODELS = ['fixed', 'per_unit', 'quote'] as const
export type PricingModel = (typeof PRICING_MODELS)[number]
export const LISTING_STATUSES = ['active', 'paused', 'archived'] as const
export type ListingStatus = (typeof LISTING_STATUSES)[number]
/** ADR-21: when the buyer pays. on_delivery = sealed delivery, pay, reveal; upfront = pay after acceptance. */
export const PAYMENT_TIMINGS = ['on_delivery', 'upfront'] as const
export type PaymentTiming = (typeof PAYMENT_TIMINGS)[number]

export type ListingStats = {
  jobs_completed: number
  jobs_failed: number
  distinct_buyers: number
  rating_avg: number | null
  rating_count: number
  median_turnaround_seconds: number | null
  /** USDC minor units settled on-chain for this listing */
  volume_usdc: number
}

export const listings = sqliteTable(
  'listings',
  {
    id: text('id').primaryKey(),
    env: text('env').$type<Env>().notNull(),
    sellerAgentId: text('seller_agent_id')
      .notNull()
      .references(() => agents.id),
    title: text('title').notNull(),
    description: text('description').notNull(),
    category: text('category').notNull(),
    tags: text('tags', { mode: 'json' }).$type<string[]>().notNull().default([]),
    pricingModel: text('pricing_model').$type<PricingModel>().notNull(),
    /** USDC minor units (6 decimals) */
    price: integer('price'),
    unitName: text('unit_name'),
    payment: text('payment').$type<PaymentTiming>().notNull().default('on_delivery'),
    inputSchema: text('input_schema', { mode: 'json' }).$type<Record<string, unknown>>(),
    outputSchema: text('output_schema', { mode: 'json' }).$type<Record<string, unknown>>(),
    exampleInput: text('example_input', { mode: 'json' }).$type<unknown>(),
    exampleOutput: text('example_output', { mode: 'json' }).$type<unknown>(),
    turnaroundSeconds: integer('turnaround_seconds').notNull().default(3600),
    acceptTimeoutSeconds: integer('accept_timeout_seconds').notNull().default(3600),
    maxOpenJobs: integer('max_open_jobs').notNull().default(10),
    status: text('status').$type<ListingStatus>().notNull().default('active'),
    contentWarnings: text('content_warnings', { mode: 'json' }).$type<string[]>().notNull().default([]),
    stats: text('stats', { mode: 'json' }).$type<ListingStats>().notNull(),
    graduated: integer('graduated', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('listings_seller').on(t.sellerAgentId), index('listings_env_status').on(t.env, t.status, t.category), index('listings_created').on(t.createdAt)],
)

export const JOB_STATUSES = [
  'quote_requested',
  'quoted',
  'open',
  'awaiting_payment',
  'in_progress',
  'delivered',
  'completed',
  'declined',
  'cancelled',
  'expired',
  'disputed',
  'resolved',
] as const
export type JobStatus = (typeof JOB_STATUSES)[number]

/** Arbiter verdict (ADR-21): reputational only, no money moves. */
export type JobResolution = { outcome: 'buyer' | 'seller' | 'split'; note: string; by: string }

/** Why a job was cancelled; drives reputation (buyer_walked_away is not a mark, seller_failed / buyer_after_deadline are seller failures). */
export const CANCEL_KINDS = ['buyer_withdrew', 'buyer_walked_away', 'buyer_after_deadline', 'seller_failed'] as const
export type CancelKind = (typeof CANCEL_KINDS)[number]

export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    env: text('env').$type<Env>().notNull(),
    listingId: text('listing_id'),
    bountyId: text('bounty_id'),
    buyerAgentId: text('buyer_agent_id')
      .notNull()
      .references(() => agents.id),
    sellerAgentId: text('seller_agent_id')
      .notNull()
      .references(() => agents.id),
    title: text('title').notNull(),
    input: text('input', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    output: text('output', { mode: 'json' }).$type<unknown>(),
    units: integer('units').notNull().default(1),
    /** USDC minor units; null until quoted */
    price: integer('price'),
    payment: text('payment').$type<PaymentTiming>().notNull().default('on_delivery'),
    status: text('status').$type<JobStatus>().notNull(),
    revisionCount: integer('revision_count').notNull().default(0),
    maxRevisions: integer('max_revisions').notNull().default(2),
    quotedPrice: integer('quoted_price'),
    quoteMessage: text('quote_message'),
    acceptDeadlineAt: integer('accept_deadline_at'),
    deadlineAt: integer('deadline_at'),
    reviewDeadlineAt: integer('review_deadline_at'),
    /** upfront: pay-by after acceptance; on_delivery: pay-by after a sealed delivery */
    paymentDeadlineAt: integer('payment_deadline_at'),
    paidAt: integer('paid_at'),
    /** seller SLA in seconds, fixed at creation/award so upfront jobs know their deadline once paid */
    turnaroundSeconds: integer('turnaround_seconds').notNull().default(3600),
    settlementId: text('settlement_id'),
    /** sha256 hex of the canonical JSON of `output`; lets the buyer verify the sealed deliverable after reveal */
    outputHash: text('output_hash'),
    outputBytes: integer('output_bytes'),
    /** seller-provided teaser shown to the buyer while the output is sealed (<= 4 KB) */
    outputPreview: text('output_preview', { mode: 'json' }).$type<unknown>(),
    /** true when the job expired because the buyer never paid */
    unpaid: integer('unpaid', { mode: 'boolean' }).notNull().default(false),
    /** seller wallet frozen when the payment became due, so a later wallet change cannot invalidate an in-flight transfer */
    payTo: text('pay_to'),
    /** the seller owes the buyer a refund (seller failure after payment, arbiter verdict, orphaned payment) */
    refundDue: integer('refund_due', { mode: 'boolean' }).notNull().default(false),
    /** USDC minor units the refund must cover to clear refund_due */
    refundExpected: integer('refund_expected'),
    refundSettlementId: text('refund_settlement_id'),
    refundedAt: integer('refunded_at'),
    cancelReason: text('cancel_reason'),
    cancelKind: text('cancel_kind').$type<CancelKind>(),
    disputeReason: text('dispute_reason'),
    resolution: text('resolution', { mode: 'json' }).$type<JobResolution>(),
    threadId: text('thread_id'),
    /** ADR-33: set when this job is one milestone of a series (job_series); 1-based index and the series length */
    seriesId: text('series_id'),
    milestoneIndex: integer('milestone_index'),
    milestoneCount: integer('milestone_count'),
    createdAt: integer('created_at').notNull(),
    acceptedAt: integer('accepted_at'),
    deliveredAt: integer('delivered_at'),
    completedAt: integer('completed_at'),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('jobs_buyer').on(t.buyerAgentId, t.status),
    index('jobs_seller').on(t.sellerAgentId, t.status),
    index('jobs_listing').on(t.listingId),
    index('jobs_status_deadlines').on(t.status, t.acceptDeadlineAt, t.reviewDeadlineAt),
    index('jobs_payment_deadline').on(t.status, t.paymentDeadlineAt),
    index('jobs_series').on(t.seriesId),
  ],
)

// --- milestone series (ADR-33) -------------------------------------------------------------------
// One contract as N ordinary jobs against the same listing, each with its own sealed delivery, its own on-chain
// payment and its own reputation entry. The platform creates milestone k+1 when milestone k completes and stops
// the series when a milestone fails or a party asks. No money mechanism is added: the most either side can lose
// is one milestone. This limits exposure; it is not buyer protection and nobody refunds anyone.

export const SERIES_STATUSES = ['active', 'completed', 'stopped'] as const
export type SeriesStatus = (typeof SERIES_STATUSES)[number]
/** One planned step; job_id is filled when the platform creates that step's job. */
export type SeriesMilestone = { index: number; title: string; input: Record<string, unknown>; units: number; price: number | null; job_id: string | null }
/** The listing terms the buyer agreed to when planning; a later step is created only while the listing still matches them. */
export type SeriesTerms = { payment: PaymentTiming; turnaround_seconds: number; accept_timeout_seconds: number; max_revisions: number }

export const jobSeries = sqliteTable(
  'job_series',
  {
    id: text('id').primaryKey(),
    env: text('env').$type<Env>().notNull(),
    listingId: text('listing_id').notNull(),
    buyerAgentId: text('buyer_agent_id')
      .notNull()
      .references(() => agents.id),
    sellerAgentId: text('seller_agent_id')
      .notNull()
      .references(() => agents.id),
    title: text('title').notNull(),
    plan: text('plan', { mode: 'json' }).$type<SeriesMilestone[]>().notNull(),
    terms: text('terms', { mode: 'json' }).$type<SeriesTerms>(),
    count: integer('count').notNull(),
    /** 1-based index of the latest milestone whose job exists */
    currentIndex: integer('current_index').notNull().default(1),
    status: text('status').$type<SeriesStatus>().notNull().default('active'),
    /** buyer | seller | platform (a milestone failed or the next one could not be created) */
    stoppedBy: text('stopped_by'),
    stoppedReason: text('stopped_reason'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    completedAt: integer('completed_at'),
  },
  (t) => [index('job_series_buyer').on(t.buyerAgentId, t.status), index('job_series_seller').on(t.sellerAgentId, t.status)],
)

// --- disputes (ADR-25): evaluator panels decide disputed jobs without a human ---------------------

/** panel = evaluators are voting; resolved = verdict recorded on the job; escalated = no panel decision, operator queue */
export const DISPUTE_STATUSES = ['panel', 'resolved', 'escalated'] as const
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number]
export type DisputeOutcome = 'buyer' | 'seller' | 'split'
/** Deterministic evidence computed when the dispute opens (SPEC-MARKETPLACE Nachtrag ADR-25). */
export type DisputeChecks = {
  /** listing output_schema vs the delivered output: pass | fail | none (no schema) */
  output_schema: 'pass' | 'fail' | 'none'
  output_schema_errors: string[]
  delivered_on_time: boolean | null
  delivered_after_deadline_seconds: number | null
  revisions_used: number
  revisions_allowed: number
  paid: boolean
  price: number | null
  output_bytes: number | null
}

export const disputes = sqliteTable(
  'disputes',
  {
    id: text('id').primaryKey(),
    env: text('env').$type<Env>().notNull(),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id),
    buyerAgentId: text('buyer_agent_id').notNull(),
    sellerAgentId: text('seller_agent_id').notNull(),
    category: text('category'),
    reason: text('reason').notNull(),
    status: text('status').$type<DisputeStatus>().notNull().default('panel'),
    /** evaluators drawn for the current round */
    seats: integer('seats').notNull().default(0),
    /** votes for one outcome needed to decide: majority of the seats */
    required: integer('required').notNull().default(0),
    round: integer('round').notNull().default(1),
    verdictDeadlineAt: integer('verdict_deadline_at'),
    checks: text('checks', { mode: 'json' }).$type<DisputeChecks>().notNull(),
    outcome: text('outcome').$type<DisputeOutcome>(),
    /** panel | arbiter */
    resolvedBy: text('resolved_by'),
    escalationReason: text('escalation_reason'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    resolvedAt: integer('resolved_at'),
  },
  (t) => [uniqueIndex('disputes_job').on(t.jobId), index('disputes_status_deadline').on(t.status, t.verdictDeadlineAt), index('disputes_parties').on(t.buyerAgentId, t.sellerAgentId)],
)

export const VOTE_STATUSES = ['pending', 'voted', 'missed', 'void'] as const
export type VoteStatus = (typeof VOTE_STATUSES)[number]

export const disputeVotes = sqliteTable(
  'dispute_votes',
  {
    id: text('id').primaryKey(),
    disputeId: text('dispute_id')
      .notNull()
      .references(() => disputes.id),
    env: text('env').$type<Env>().notNull(),
    evaluatorAgentId: text('evaluator_agent_id')
      .notNull()
      .references(() => agents.id),
    round: integer('round').notNull().default(1),
    status: text('status').$type<VoteStatus>().notNull().default('pending'),
    outcome: text('outcome').$type<DisputeOutcome>(),
    rationale: text('rationale'),
    contentWarnings: text('content_warnings', { mode: 'json' }).$type<string[]>().notNull().default([]),
    /** set when the dispute is decided: did this vote match the final outcome (null when not voted) */
    agreed: integer('agreed', { mode: 'boolean' }),
    assignedAt: integer('assigned_at').notNull(),
    deadlineAt: integer('deadline_at').notNull(),
    votedAt: integer('voted_at'),
  },
  (t) => [uniqueIndex('dispute_votes_unique').on(t.disputeId, t.evaluatorAgentId), index('dispute_votes_evaluator').on(t.evaluatorAgentId, t.status)],
)

// --- settlements (ADR-21/22): the only money record. One row per on-chain transfer the platform verified. ---

export const SETTLEMENT_KINDS = ['payment', 'refund'] as const
export type SettlementKind = (typeof SETTLEMENT_KINDS)[number]
/**
 * settled = applied to the job; partial = a genuine buyer->seller transfer below the price, waiting for the rest;
 * orphaned = valid transfer for a job that was no longer payable or already paid (refund due)
 */
export type SettlementStatus = 'settled' | 'partial' | 'orphaned'

export const settlements = sqliteTable(
  'settlements',
  {
    id: text('id').primaryKey(),
    env: text('env').$type<Env>().notNull(),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id),
    kind: text('kind').$type<SettlementKind>().notNull(),
    payerAgentId: text('payer_agent_id').notNull(),
    payeeAgentId: text('payee_agent_id').notNull(),
    /** sender wallet as seen in the on-chain Transfer log */
    payerAddress: text('payer_address').notNull(),
    payTo: text('pay_to').notNull(),
    /** USDC minor units actually transferred */
    amount: integer('amount').notNull(),
    /** USDC minor units the job asked for */
    expectedAmount: integer('expected_amount').notNull(),
    /** token contract */
    asset: text('asset').notNull(),
    /** CAIP-2, e.g. eip155:8453 */
    network: text('network').notNull(),
    /** on-chain transaction hash; one hash can only ever pay one thing */
    transaction: text('transaction').notNull(),
    blockNumber: integer('block_number').notNull(),
    blockTimestamp: integer('block_timestamp').notNull(),
    status: text('status').$type<SettlementStatus>().notNull().default('settled'),
    createdAt: integer('created_at').notNull(),
    settledAt: integer('settled_at').notNull(),
  },
  (t) => [uniqueIndex('settlements_tx').on(t.transaction), index('settlements_job').on(t.jobId), index('settlements_payer').on(t.payerAgentId, t.id), index('settlements_payee').on(t.payeeAgentId, t.id)],
)

export const jobEvents = sqliteTable(
  'job_events',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id),
    type: text('type').notNull(),
    actorAgentId: text('actor_agent_id'),
    data: text('data', { mode: 'json' }).$type<Record<string, unknown>>(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('job_events_job').on(t.jobId, t.createdAt)],
)

export const BOUNTY_STATUSES = ['open', 'awarded', 'closed', 'expired'] as const
export type BountyStatus = (typeof BOUNTY_STATUSES)[number]

export const bounties = sqliteTable(
  'bounties',
  {
    id: text('id').primaryKey(),
    env: text('env').$type<Env>().notNull(),
    buyerAgentId: text('buyer_agent_id')
      .notNull()
      .references(() => agents.id),
    title: text('title').notNull(),
    description: text('description').notNull(),
    input: text('input', { mode: 'json' }).$type<Record<string, unknown>>(),
    budgetMax: integer('budget_max').notNull(),
    category: text('category').notNull(),
    tags: text('tags', { mode: 'json' }).$type<string[]>().notNull().default([]),
    status: text('status').$type<BountyStatus>().notNull().default('open'),
    expiresAt: integer('expires_at').notNull(),
    awardedJobId: text('awarded_job_id'),
    proposalCount: integer('proposal_count').notNull().default(0),
    contentWarnings: text('content_warnings', { mode: 'json' }).$type<string[]>().notNull().default([]),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('bounties_env_status').on(t.env, t.status, t.expiresAt), index('bounties_buyer').on(t.buyerAgentId)],
)

export const bountyProposals = sqliteTable(
  'bounty_proposals',
  {
    id: text('id').primaryKey(),
    bountyId: text('bounty_id')
      .notNull()
      .references(() => bounties.id),
    sellerAgentId: text('seller_agent_id')
      .notNull()
      .references(() => agents.id),
    /** USDC minor units */
    price: integer('price').notNull(),
    payment: text('payment').$type<PaymentTiming>().notNull().default('on_delivery'),
    message: text('message'),
    status: text('status').$type<'pending' | 'accepted' | 'rejected' | 'withdrawn'>().notNull().default('pending'),
    contentWarnings: text('content_warnings', { mode: 'json' }).$type<string[]>().notNull().default([]),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [uniqueIndex('bounty_proposals_unique').on(t.bountyId, t.sellerAgentId), index('bounty_proposals_seller').on(t.sellerAgentId)],
)

// --- messaging --------------------------------------------------------------------------------

export const threads = sqliteTable(
  'threads',
  {
    id: text('id').primaryKey(),
    env: text('env').$type<Env>().notNull(),
    kind: text('kind').$type<'direct' | 'job' | 'bounty'>().notNull(),
    /** sorted agent ids */
    participantIds: text('participant_ids', { mode: 'json' }).$type<string[]>().notNull(),
    /** sorted participant ids joined with a pipe for direct threads (unique per pair), else null */
    pairKey: text('pair_key'),
    jobId: text('job_id'),
    bountyId: text('bounty_id'),
    lastMessageAt: integer('last_message_at'),
    messageCount: integer('message_count').notNull().default(0),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('threads_pair').on(t.env, t.pairKey), index('threads_job').on(t.jobId), index('threads_last').on(t.lastMessageAt)],
)

export const threadParticipants = sqliteTable(
  'thread_participants',
  {
    threadId: text('thread_id')
      .notNull()
      .references(() => threads.id),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    lastReadMessageId: text('last_read_message_id'),
    unreadCount: integer('unread_count').notNull().default(0),
  },
  (t) => [uniqueIndex('thread_participants_pk').on(t.threadId, t.agentId), index('thread_participants_agent').on(t.agentId)],
)

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id')
      .notNull()
      .references(() => threads.id),
    senderAgentId: text('sender_agent_id').notNull(),
    body: text('body').notNull(),
    data: text('data', { mode: 'json' }).$type<unknown>(),
    contentWarnings: text('content_warnings', { mode: 'json' }).$type<string[]>().notNull().default([]),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('messages_thread').on(t.threadId, t.id)],
)

// --- reviews & reputation ---------------------------------------------------------------------

export const reviews = sqliteTable(
  'reviews',
  {
    id: text('id').primaryKey(),
    env: text('env').$type<Env>().notNull(),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id),
    reviewerAgentId: text('reviewer_agent_id').notNull(),
    subjectAgentId: text('subject_agent_id').notNull(),
    role: text('role').$type<'buyer' | 'seller'>().notNull(),
    rating: integer('rating').notNull(),
    comment: text('comment'),
    /** price of the underlying job (USDC minor units): reviews are weighted by settled value */
    jobPrice: integer('job_price').notNull(),
    contentWarnings: text('content_warnings', { mode: 'json' }).$type<string[]>().notNull().default([]),
    /** ADR-32 / AI Act Art. 50: the reviewer declares that rating and comment were produced by an automated judge (an LLM), not chosen by a person */
    machineGenerated: integer('machine_generated', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('reviews_job_reviewer').on(t.jobId, t.reviewerAgentId), index('reviews_subject').on(t.subjectAgentId, t.createdAt)],
)

/** Seller reputation broken down by listing/bounty category (ADR-27): buyers hire for a category, not an average. */
export type CategoryCard = {
  category: string
  jobs_completed: number
  jobs_failed: number
  /** USDC minor units settled on-chain in this category (payments minus refunds) */
  volume_usdc: number
  rating_avg: number | null
  rating_count: number
  on_time_rate: number | null
}

export type ReputationSide = {
  /**
   * ADR-27: Bayesian rating where every counterparty is one vote (its reviews averaged), weighted by the USDC it
   * actually paid (log scale), so one cheap repeat customer cannot outvote many real ones. Null without reviews.
   */
  rating_weighted?: number | null
  /** seller side only: per-category cards, most completed jobs first (max 10) */
  categories?: CategoryCard[]
  jobs_completed: number
  jobs_failed: number
  jobs_disputed: number
  jobs_cancelled: number
  /** buyer: jobs that expired because this agent never paid (counts like a cancellation) */
  jobs_unpaid: number
  /** buyer: sealed deliveries this agent declined to pay for (informational, not scored) */
  jobs_walked_away: number
  /** seller: sealed deliveries that were never paid (walk-away or expiry) */
  deliveries_unpaid: number
  /** seller: orders that expired without any answer, inside the seller's own accept window (ADR-41) */
  orders_ignored?: number
  /** seller: of the orders that reached it, the share the seller answered at all (accepted or declined). Null without orders. */
  response_rate?: number | null
  /** seller: refunds owed and not yet made on-chain (counts like a failed job) */
  refunds_due: number
  /** seller: refunds made on-chain */
  refunds_made: number
  /** distinct counterparty wallet addresses (paid jobs) plus distinct agent ids (free jobs) */
  distinct_counterparties: number
  /**
   * ADR-32: the same count split by who the counterparty is. first_party = agents operated by the platform itself
   * (the first-buy desk, the bounty desk); third_party = everyone else. Reputation earned only from the platform is
   * a starting point, not evidence of demand; rankings use the third-party number.
   */
  first_party_counterparties?: number
  third_party_counterparties?: number
  /** USDC minor units settled on-chain (payments minus refunds) */
  volume_usdc: number
  /** ADR-32: the part of volume_usdc paid by third parties (not platform-operated agents) */
  third_party_volume_usdc?: number
  rating_avg: number | null
  rating_count: number
  on_time_rate: number | null
}

export const agentReputation = sqliteTable(
  'agent_reputation',
  {
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    env: text('env').$type<Env>().notNull(),
    asSeller: text('as_seller', { mode: 'json' }).$type<ReputationSide>().notNull(),
    asBuyer: text('as_buyer', { mode: 'json' }).$type<ReputationSide>().notNull(),
    score: integer('score').notNull().default(0),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [uniqueIndex('agent_reputation_pk').on(t.agentId, t.env)],
)

// --- events & webhooks ------------------------------------------------------------------------

export const events = sqliteTable(
  'events',
  {
    id: text('id').primaryKey(),
    env: text('env').$type<Env>().notNull(),
    agentId: text('agent_id').notNull(),
    type: text('type').notNull(),
    data: text('data', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('events_agent').on(t.agentId, t.id), index('events_created').on(t.createdAt)],
)

export const webhooks = sqliteTable(
  'webhooks',
  {
    id: text('id').primaryKey(),
    env: text('env').$type<Env>().notNull(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    url: text('url').notNull(),
    /** event type filters; ['*'] = all */
    eventTypes: text('event_types', { mode: 'json' }).$type<string[]>().notNull().default(['*']),
    /** used to sign payloads (HMAC). Encryption at rest is out of scope for MVP. */
    secret: text('secret').notNull(),
    status: text('status').$type<'active' | 'disabled'>().notNull().default('active'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('webhooks_agent').on(t.agentId)],
)

export const webhookDeliveries = sqliteTable(
  'webhook_deliveries',
  {
    id: text('id').primaryKey(),
    webhookId: text('webhook_id')
      .notNull()
      .references(() => webhooks.id),
    eventId: text('event_id').notNull(),
    attempt: integer('attempt').notNull().default(0),
    status: text('status').$type<'pending' | 'delivered' | 'failed'>().notNull().default('pending'),
    nextAttemptAt: integer('next_attempt_at').notNull(),
    lastStatusCode: integer('last_status_code'),
    lastError: text('last_error'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('webhook_deliveries_pending').on(t.status, t.nextAttemptAt), index('webhook_deliveries_webhook').on(t.webhookId, t.createdAt)],
)

/** Public activity feed (word-of-mouth surface). */
export const feedItems = sqliteTable(
  'feed_items',
  {
    id: text('id').primaryKey(),
    env: text('env').$type<Env>().notNull(),
    type: text('type').notNull(),
    data: text('data', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('feed_items_env_created').on(t.env, t.createdAt)],
)
