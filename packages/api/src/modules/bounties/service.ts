import { and, desc, eq, gt, gte, like, lt, or, sql, type SQL } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { agents, bounties, bountyProposals, type Env } from '../../db/schema.js'
import { errors } from '../../lib/errors.js'
import { newId } from '../../lib/ids.js'
import { scanFields, scanJson } from '../../lib/content-safety.js'
import { emit, publishFeed } from '../../events/bus.js'
import { registerSweep } from '../../lib/scheduler.js'
import { createJobFromBountyAward, type Job } from '../jobs/service.js'
import { searchTerms } from '../listings/service.js'
import type { Agent } from '../../middleware/auth.js'

/** Bounties: the reverse marketplace (SPEC §3). Buyer posts a need; sellers propose; award creates an escrowed job. */

export type Bounty = typeof bounties.$inferSelect
export type Proposal = typeof bountyProposals.$inferSelect
export const DEFAULT_EXPIRY_SECONDS = 7 * 86400
export const MAX_OPEN_BOUNTIES = 20

function rejectHigh(scan: { severity: string; warnings: string[] }, param: string) {
  if (scan.severity === 'high') throw errors.validation('Text contains instruction-injection or credential-phishing patterns and was rejected.', param, 'Describe the task plainly; do not address the reader as a model or ask for secrets.', { code: 'content_rejected', warnings: scan.warnings })
}

export type CreateBountyInput = { title: string; description: string; input?: Record<string, unknown> | null; budget_max: number; category: string; tags?: string[]; expires_in_seconds?: number; turnaround_seconds?: number }

export async function createBounty(env: Env, buyer: Agent, input: CreateBountyInput): Promise<Bounty> {
  const open = await db().select({ n: sql<number>`count(*)` }).from(bounties).where(and(eq(bounties.env, env), eq(bounties.buyerAgentId, buyer.id), eq(bounties.status, 'open')))
  if ((open[0]?.n ?? 0) >= MAX_OPEN_BOUNTIES) throw errors.state('bounty_limit', `You already have ${MAX_OPEN_BOUNTIES} open bounties.`, 'Close some with POST /v1/bounties/{id}/close.')
  const scan = scanFields(input.title, input.description)
  rejectHigh(scan, 'description')
  if (input.input) rejectHigh(scanJson(input.input), 'input')
  const now = Date.now()
  const row: typeof bounties.$inferInsert = {
    id: newId('bounty'),
    env,
    buyerAgentId: buyer.id,
    title: input.title.trim(),
    description: input.description.trim(),
    input: input.input ?? null,
    budgetMax: input.budget_max,
    category: input.category.trim().toLowerCase().slice(0, 48),
    tags: [...new Set((input.tags ?? []).map((t) => t.trim().toLowerCase().slice(0, 48)).filter(Boolean))].slice(0, 16),
    status: 'open',
    expiresAt: now + (input.expires_in_seconds ?? DEFAULT_EXPIRY_SECONDS) * 1000,
    awardedJobId: null,
    proposalCount: 0,
    contentWarnings: scan.warnings,
    createdAt: now,
    updatedAt: now,
  }
  await db().insert(bounties).values(row)
  await publishFeed(env, 'bounty.created', { bounty_id: row.id, title: row.title, category: row.category, budget_max: row.budgetMax, buyer_handle: buyer.handle })
  return row as Bounty
}

export type SearchBountiesInput = { q?: string; category?: string; tag?: string; min_budget?: number; limit: number; cursor?: string }

export async function searchBounties(env: Env, input: SearchBountiesInput, now = Date.now()): Promise<Bounty[]> {
  const conds: SQL[] = [eq(bounties.env, env), eq(bounties.status, 'open'), gt(bounties.expiresAt, now)]
  for (const pat of searchTerms(input.q)) {
    conds.push(or(like(bounties.title, pat), like(bounties.description, pat), like(bounties.tags, pat), like(bounties.category, pat))!)
  }
  if (input.category) conds.push(eq(bounties.category, input.category.toLowerCase()))
  if (input.tag) conds.push(like(bounties.tags, `%"${input.tag.toLowerCase()}"%`))
  if (input.min_budget !== undefined) conds.push(gte(bounties.budgetMax, input.min_budget))
  if (input.cursor) conds.push(lt(bounties.id, input.cursor))
  return db().query.bounties.findMany({ where: and(...conds), orderBy: [desc(bounties.id)], limit: input.limit + 1 })
}

export async function listMyBounties(env: Env, buyerId: string, limit: number, cursor?: string): Promise<Bounty[]> {
  const conds: SQL[] = [eq(bounties.env, env), eq(bounties.buyerAgentId, buyerId)]
  if (cursor) conds.push(lt(bounties.id, cursor))
  return db().query.bounties.findMany({ where: and(...conds), orderBy: [desc(bounties.id)], limit: limit + 1 })
}

export async function getBounty(env: Env, id: string): Promise<Bounty> {
  const b = await db().query.bounties.findFirst({ where: and(eq(bounties.id, id), eq(bounties.env, env)) })
  if (!b) throw errors.notFound('Bounty', id, 'Search with GET /v1/bounties?q=.')
  return b
}

function assertOpen(b: Bounty, now = Date.now()) {
  if (b.status !== 'open' || b.expiresAt <= now) throw errors.state('bounty_closed', `Bounty '${b.id}' is ${b.status === 'open' ? 'expired' : b.status}.`, 'Find open bounties with GET /v1/bounties.')
}

export async function createProposal(env: Env, seller: Agent, bountyId: string, price: number, message?: string): Promise<{ proposal: Proposal; updated: boolean }> {
  const b = await getBounty(env, bountyId)
  assertOpen(b)
  if (b.buyerAgentId === seller.id) throw errors.validation('You cannot propose on your own bounty.', 'bounty_id')
  if (price > b.budgetMax) throw errors.validation(`price exceeds the bounty budget (max ${b.budgetMax} CRD).`, 'price', 'Propose at or below budget_max, or message the buyer to discuss scope.')
  const scan = scanFields(message)
  rejectHigh(scan, 'message')
  const now = Date.now()
  const existing = await db().query.bountyProposals.findFirst({ where: and(eq(bountyProposals.bountyId, b.id), eq(bountyProposals.sellerAgentId, seller.id)) })
  if (existing) {
    if (existing.status !== 'pending' && existing.status !== 'withdrawn') throw errors.state('proposal_final', `Your proposal is already ${existing.status}.`)
    await db().update(bountyProposals).set({ price, message: message?.trim().slice(0, 2000) ?? null, status: 'pending', contentWarnings: scan.warnings, updatedAt: now }).where(eq(bountyProposals.id, existing.id))
    if (existing.status === 'withdrawn') await db().update(bounties).set({ proposalCount: sql`${bounties.proposalCount} + 1`, updatedAt: now }).where(eq(bounties.id, b.id))
    const proposal = (await db().query.bountyProposals.findFirst({ where: eq(bountyProposals.id, existing.id) }))!
    await emit(env, b.buyerAgentId, 'bounty.proposal_received', { bounty_id: b.id, proposal_id: proposal.id, seller_id: seller.id, seller_handle: seller.handle, price, updated: true })
    return { proposal, updated: true }
  }
  const row: typeof bountyProposals.$inferInsert = { id: newId('request'), bountyId: b.id, sellerAgentId: seller.id, price, message: message?.trim().slice(0, 2000) ?? null, status: 'pending', contentWarnings: scan.warnings, createdAt: now, updatedAt: now }
  await db().insert(bountyProposals).values(row)
  await db().update(bounties).set({ proposalCount: sql`${bounties.proposalCount} + 1`, updatedAt: now }).where(eq(bounties.id, b.id))
  await emit(env, b.buyerAgentId, 'bounty.proposal_received', { bounty_id: b.id, proposal_id: row.id, seller_id: seller.id, seller_handle: seller.handle, price, message: row.message, content_warnings: scan.warnings, updated: false })
  return { proposal: row as Proposal, updated: false }
}

export async function listProposals(env: Env, viewerId: string, bountyId: string): Promise<Proposal[]> {
  const b = await getBounty(env, bountyId)
  if (b.buyerAgentId === viewerId) return db().query.bountyProposals.findMany({ where: eq(bountyProposals.bountyId, b.id), orderBy: [desc(bountyProposals.createdAt)] })
  return db().query.bountyProposals.findMany({ where: and(eq(bountyProposals.bountyId, b.id), eq(bountyProposals.sellerAgentId, viewerId)) })
}

export async function withdrawProposal(env: Env, sellerId: string, bountyId: string): Promise<Proposal> {
  const b = await getBounty(env, bountyId)
  const p = await db().query.bountyProposals.findFirst({ where: and(eq(bountyProposals.bountyId, b.id), eq(bountyProposals.sellerAgentId, sellerId)) })
  if (!p) throw errors.notFound('Proposal')
  if (p.status === 'withdrawn') return p
  if (p.status !== 'pending') throw errors.state('proposal_final', `Your proposal is already ${p.status}.`)
  await db().update(bountyProposals).set({ status: 'withdrawn', updatedAt: Date.now() }).where(eq(bountyProposals.id, p.id))
  await db().update(bounties).set({ proposalCount: sql`max(0, ${bounties.proposalCount} - 1)` }).where(eq(bounties.id, b.id))
  return (await db().query.bountyProposals.findFirst({ where: eq(bountyProposals.id, p.id) }))!
}

export async function awardBounty(env: Env, buyer: Agent, bountyId: string, proposalId: string, turnaroundSeconds?: number): Promise<{ bounty: Bounty; job: Job }> {
  const b = await db().query.bounties.findFirst({ where: and(eq(bounties.id, bountyId), eq(bounties.env, env), eq(bounties.buyerAgentId, buyer.id)) })
  if (!b) throw errors.notFound('Bounty', bountyId, 'Only the bounty owner can award it. GET /v1/agents/me/bounties lists yours.')
  if (b.status === 'awarded' && b.awardedJobId) {
    const job = (await db().query.jobs.findFirst({ where: eq(sql`id`, b.awardedJobId) })) as Job | undefined
    if (job) return { bounty: b, job }
  }
  assertOpen(b)
  const p = await db().query.bountyProposals.findFirst({ where: and(eq(bountyProposals.id, proposalId), eq(bountyProposals.bountyId, b.id)) })
  if (!p) throw errors.notFound('Proposal', proposalId, 'GET /v1/bounties/{id}/proposals lists them.')
  if (p.status !== 'pending') throw errors.state('proposal_not_pending', `Proposal is ${p.status}.`)
  const seller = await db().query.agents.findFirst({ where: eq(agents.id, p.sellerAgentId) })
  if (!seller || seller.status !== 'active') throw errors.state('seller_unavailable', 'The proposing agent is no longer active.')
  const job = await createJobFromBountyAward({ env, bountyId: b.id, buyerAgentId: buyer.id, sellerAgentId: p.sellerAgentId, title: b.title, input: { ...(b.input ?? {}), bounty_description: b.description }, price: p.price, turnaroundSeconds })
  const now = Date.now()
  await db().update(bountyProposals).set({ status: 'accepted', updatedAt: now }).where(eq(bountyProposals.id, p.id))
  await db().update(bountyProposals).set({ status: 'rejected', updatedAt: now }).where(and(eq(bountyProposals.bountyId, b.id), eq(bountyProposals.status, 'pending')))
  await db().update(bounties).set({ status: 'awarded', awardedJobId: job.id, updatedAt: now }).where(eq(bounties.id, b.id))
  await emit(env, p.sellerAgentId, 'bounty.awarded', { bounty_id: b.id, proposal_id: p.id, job_id: job.id, price: p.price, buyer_id: buyer.id })
  return { bounty: (await db().query.bounties.findFirst({ where: eq(bounties.id, b.id) }))!, job }
}

export async function closeBounty(env: Env, buyerId: string, bountyId: string): Promise<Bounty> {
  const b = await db().query.bounties.findFirst({ where: and(eq(bounties.id, bountyId), eq(bounties.env, env), eq(bounties.buyerAgentId, buyerId)) })
  if (!b) throw errors.notFound('Bounty', bountyId)
  if (b.status === 'closed') return b
  if (b.status !== 'open') throw errors.state('bounty_not_open', `Bounty is ${b.status}.`)
  const now = Date.now()
  await db().update(bountyProposals).set({ status: 'rejected', updatedAt: now }).where(and(eq(bountyProposals.bountyId, b.id), eq(bountyProposals.status, 'pending')))
  await db().update(bounties).set({ status: 'closed', updatedAt: now }).where(eq(bounties.id, b.id))
  return (await db().query.bounties.findFirst({ where: eq(bounties.id, b.id) }))!
}

export async function expireBounties(now = Date.now()): Promise<number> {
  const rows = await db().query.bounties.findMany({ where: and(eq(bounties.status, 'open'), lt(bounties.expiresAt, now)), limit: 200 })
  for (const b of rows) {
    await db().update(bountyProposals).set({ status: 'rejected', updatedAt: now }).where(and(eq(bountyProposals.bountyId, b.id), eq(bountyProposals.status, 'pending')))
    await db().update(bounties).set({ status: 'expired', updatedAt: now }).where(eq(bounties.id, b.id))
  }
  return rows.length
}

registerSweep('bounties', async (now) => {
  await expireBounties(now)
})
