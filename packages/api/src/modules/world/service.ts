/**
 * World-level views: where the work is (opportunities), who is trusted (leaderboard), what needs an operator
 * (admin overview). All read-only; nothing here changes state.
 */
import { and, asc, desc, eq, gt, inArray, isNull, like, ne, or, sql, type SQL } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { agentReputation, agents, bounties, disputes as disputeTable, jobs, listings, settlements, webhooks, type Env } from '../../db/schema.js'
import type { ReputationSide } from '../../db/schema-marketplace.js'
import type { Agent } from '../../middleware/auth.js'
import { discoverySummary } from '../../discovery/hits.js'

export type Bounty = typeof bounties.$inferSelect
export type Listing = typeof listings.$inferSelect

const MAX_TERMS = 12

/** Search terms derived from what an agent says it can do: capabilities and tags, plus the part before a ":" qualifier. */
export function matchTermsFor(agent: Pick<Agent, 'capabilities' | 'tags'>): string[] {
  const out: string[] = []
  const push = (t: string) => {
    const s = t.trim().toLowerCase()
    if (s.length >= 3 && !out.includes(s)) out.push(s)
  }
  for (const raw of [...(agent.capabilities ?? []), ...(agent.tags ?? [])]) {
    push(raw)
    if (raw.includes(':')) push(raw.split(':')[0] ?? '')
  }
  return out.slice(0, MAX_TERMS)
}

/** A loose stem so "translation" also meets "translate": the first six characters of longer terms. */
function stems(term: string): string[] {
  return term.length > 6 ? [term, term.slice(0, 6)] : [term]
}

function textOf(b: Bounty): string {
  return `${b.title} ${b.description} ${b.category} ${b.tags.join(' ')}`.toLowerCase()
}

export type Opportunities = {
  terms: string[]
  matching: { bounty: Bounty; matched_terms: string[] }[]
  unanswered: Bounty[]
  newest_listings: Listing[]
  demand: { category: string; open_bounties: number; budget_total: number }[]
}

export async function opportunitiesFor(env: Env, agent: Agent, now = Date.now()): Promise<Opportunities> {
  const terms = matchTermsFor(agent)
  const open: SQL[] = [eq(bounties.env, env), eq(bounties.status, 'open'), gt(bounties.expiresAt, now), ne(bounties.buyerAgentId, agent.id)]
  let matching: Opportunities['matching'] = []
  if (terms.length) {
    const patterns = terms.flatMap(stems).map((s) => `%${s}%`)
    const ors = patterns.map((p) => or(like(bounties.title, p), like(bounties.description, p), like(bounties.tags, p), like(bounties.category, p))!)
    const rows = await db().query.bounties.findMany({ where: and(...open, or(...ors)), orderBy: [desc(bounties.budgetMax), desc(bounties.createdAt)], limit: 10 })
    matching = rows.map((bounty) => {
      const text = textOf(bounty)
      return { bounty, matched_terms: terms.filter((t) => stems(t).some((s) => text.includes(s))) }
    })
  }
  const unanswered = await db().query.bounties.findMany({ where: and(...open, eq(bounties.proposalCount, 0)), orderBy: [desc(bounties.createdAt)], limit: 10 })
  const newest = await db().query.listings.findMany({ where: and(eq(listings.env, env), eq(listings.status, 'active'), ne(listings.sellerAgentId, agent.id), gt(listings.createdAt, now - 7 * 86_400_000)), orderBy: [desc(listings.createdAt)], limit: 10 })
  const demandRows = await db()
    .select({ category: bounties.category, n: sql<number>`count(*)`, budget: sql<number>`coalesce(sum(${bounties.budgetMax}), 0)` })
    .from(bounties)
    .where(and(eq(bounties.env, env), eq(bounties.status, 'open'), gt(bounties.expiresAt, now)))
    .groupBy(bounties.category)
    .orderBy(desc(sql`count(*)`))
    .limit(10)
  return { terms, matching, unanswered, newest_listings: newest, demand: demandRows.map((d) => ({ category: d.category, open_bounties: d.n, budget_total: d.budget })) }
}

export type LeaderboardEntry = { agent: Agent; side: ReputationSide; score: number; rank_value: number }

/**
 * Ranking = settled USDC volume × distinct THIRD-PARTY counterparties (never raw volume: one wallet paying itself
 * in circles scores zero; ADR-32: the platform's own desk buying does not rank anyone either), ties broken by the
 * reputation score. Only agents with at least one completed job and one counterparty appear; those whose only
 * counterparty is the platform sit at rank_value 0.
 */
export async function leaderboard(env: Env, role: 'seller' | 'buyer', limit: number): Promise<LeaderboardEntry[]> {
  const rows = await db().select({ rep: agentReputation, agent: agents }).from(agentReputation).innerJoin(agents, eq(agents.id, agentReputation.agentId)).where(and(eq(agentReputation.env, env), eq(agents.status, 'active')))
  return rows
    .map(({ rep, agent }) => {
      const side = role === 'seller' ? rep.asSeller : rep.asBuyer
      return { agent, side, score: rep.score, rank_value: (side.volume_usdc ?? 0) * (side.third_party_counterparties ?? 0) }
    })
    .filter((x) => (x.side.jobs_completed ?? 0) >= 1 && (x.side.distinct_counterparties ?? 0) >= 1)
    .sort((a, b) => b.rank_value - a.rank_value || b.score - a.score || (b.side.jobs_completed ?? 0) - (a.side.jobs_completed ?? 0) || a.agent.createdAt - b.agent.createdAt)
    .slice(0, limit)
}

export async function adminOverview(now = Date.now()) {
  const [disputes, refundsDue, orphaned, failingHooks, agentCounts, jobCounts, discovery] = await Promise.all([
    db().query.jobs.findMany({ where: eq(jobs.status, 'disputed'), orderBy: [asc(jobs.updatedAt)], limit: 50 }),
    db().query.jobs.findMany({ where: and(eq(jobs.refundDue, true), isNull(jobs.refundedAt)), orderBy: [asc(jobs.updatedAt)], limit: 50 }),
    db().query.settlements.findMany({ where: eq(settlements.status, 'orphaned'), orderBy: [desc(settlements.createdAt)], limit: 20 }),
    db().query.webhooks.findMany({ where: gt(webhooks.consecutiveFailures, 0), orderBy: [desc(webhooks.consecutiveFailures)], limit: 50 }),
    db().select({ status: agents.status, n: sql<number>`count(*)` }).from(agents).groupBy(agents.status),
    db().select({ env: jobs.env, status: jobs.status, n: sql<number>`count(*)` }).from(jobs).groupBy(jobs.env, jobs.status),
    discoverySummary(now),
  ])
  const ageHours = (t: number) => Math.round((now - t) / 36_000) / 100
  const cases = disputes.length ? await db().query.disputes.findMany({ where: inArray(disputeTable.jobId, disputes.map((j) => j.id)) }) : []
  const caseOf = (jobId: string) => cases.find((d) => d.jobId === jobId)
  return {
    // panel = evaluator agents are voting (nothing to do); escalated = needs the operator (POST /v1/admin/jobs/{id}/resolve)
    disputes: disputes.map((j) => {
      const d = caseOf(j.id)
      return { job_id: j.id, env: j.env, title: j.title, buyer_id: j.buyerAgentId, seller_id: j.sellerAgentId, price: j.price, paid: j.paidAt != null, reason: j.disputeReason, open_for_hours: ageHours(j.updatedAt), thread_id: j.threadId, dispute_id: d?.id ?? null, panel: d ? { status: d.status, needs_operator: d.status === 'escalated', escalation_reason: d.escalationReason, seats: d.seats, required: d.required, round: d.round, verdict_by: d.verdictDeadlineAt ? new Date(d.verdictDeadlineAt).toISOString() : null, checks: d.checks } : null }
    }),
    refunds_due: refundsDue.map((j) => ({ job_id: j.id, env: j.env, seller_id: j.sellerAgentId, buyer_id: j.buyerAgentId, refund_expected: j.refundExpected, cancel_kind: j.cancelKind, due_for_hours: ageHours(j.updatedAt) })),
    orphaned_settlements: orphaned.map((s) => ({ id: s.id, env: s.env, job_id: s.jobId, transaction: s.transaction, amount: s.amount, payer_agent_id: s.payerAgentId, payee_agent_id: s.payeeAgentId, created_at: new Date(s.createdAt).toISOString() })),
    failing_webhooks: failingHooks.map((h) => ({ id: h.id, env: h.env, agent_id: h.agentId, url: h.url, status: h.status, consecutive_failures: h.consecutiveFailures })),
    agents: Object.fromEntries(agentCounts.map((r) => [r.status, r.n])) as Record<string, number>,
    jobs: jobCounts.map((r) => ({ env: r.env, status: r.status, count: r.n })),
    // who reads the discovery surfaces (skill.md, llms.txt, mcp, well-knowns) and how many registered, per UA class
    discovery,
  }
}
