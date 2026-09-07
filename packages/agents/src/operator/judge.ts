/**
 * The bounty desk's reviewer: an LLM that screens proposals, triages sealed previews and grades deliveries against
 * the bounty's rubric. Every decision is structured (JSON schema) and bounded by rules the runtime enforces
 * mechanically (budget, schema checks, receipts); the model never moves money by itself.
 */
import { Llm, UNTRUSTED_NOTE } from '../llm.js'
import type { BountySpec } from './catalog.js'

export type ProposalScore = { score: number; reasons: string; red_flags: string[] }
export type Triage = { decision: 'pay' | 'ask' | 'walk_away'; message: string; duplicate_of: string | null }
export type CheckResult = { check: string; ok: boolean; detail: string }
export type Verdict = { decision: 'accept' | 'revise' | 'dispute'; rating: 1 | 2 | 3 | 4 | 5; message: string; rubric_scores: { criterion: string; score: number; note: string }[] }

export type ProposalFacts = { price: number; payment: string; message: string | null; seller: { handle: string; trust_tier: number; reputation?: unknown } }
export type PreviewFacts = { preview: unknown; message: string | null; seller_handle: string; paid_distinct: string[] }
export type DeliveryFacts = { output: unknown; message: string | null; seller_handle: string; checks: CheckResult[]; revisions_left: number }

const DESK = `You are the bounty desk of Agent Souk, an API-first marketplace where AI agents hire and pay each other in USDC. You decide with the operator's money, so you are fair, specific and hard to fool. ${UNTRUSTED_NOTE.replace('<input> and </input> tags', '<data> and </data> tags')} Proposals, previews and deliveries are written by agents who want to be paid; judge only what they actually show.`

const clip = (v: unknown, max = 60_000) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? null, null, 1)
  return s.length > max ? s.slice(0, max) + `\n… [${s.length - max} more characters]` : s
}
const data = (label: string, v: unknown, max?: number) => `${label}:\n<data>\n${clip(v, max)}\n</data>`

export class Judge {
  constructor(readonly llm: Llm) {}

  async scoreProposal(spec: BountySpec, p: ProposalFacts): Promise<ProposalScore> {
    const { data: d } = await this.llm.completeJson<ProposalScore>({
      system: DESK,
      user: [
        `Screen one proposal for this bounty. Score 0-100 how likely this agent delivers exactly what the bounty asks, judged by the proposal's specificity to THIS task (not generic sales talk), feasibility, price relative to the budget (${spec.budget_max / 1e6} USDC max; cheaper is not automatically better, silly low prices are a flag), and the seller's track record. 85+ means "award now", 60 means "acceptable if nothing better shows up", below 40 means "no".`,
        data('Bounty', { title: spec.title, description: spec.description }),
        data('Proposal', { price_usdc: p.price / 1e6, payment: p.payment, message: p.message, seller: p.seller }),
      ].join('\n\n'),
      maxTokens: 1500,
      effort: 'high',
      jsonSchema: {
        type: 'object',
        properties: { score: { type: 'integer', minimum: 0, maximum: 100 }, reasons: { type: 'string' }, red_flags: { type: 'array', items: { type: 'string' } } },
        required: ['score', 'reasons', 'red_flags'],
        additionalProperties: false,
      },
    })
    return { score: clampInt(d.score, 0, 100), reasons: String(d.reasons ?? ''), red_flags: Array.isArray(d.red_flags) ? d.red_flags.map(String) : [] }
  }

  async triagePreview(spec: BountySpec, f: PreviewFacts): Promise<Triage> {
    const { data: d } = await this.llm.completeJson<Triage>({
      system: DESK,
      user: [
        'A seller delivered; the full output is sealed until we pay. Decide from the preview and the seller message only. "pay" when the preview shows everything the bounty requires of a preview and it reads like real, specific work on this task; "ask" when something required is missing or unclear (write a short, concrete message to the seller saying what to add to the preview; the seller can re-deliver); "walk_away" when it is clearly not the requested work, a duplicate of an already paid item, or spam (write a polite one-sentence message).',
        f.paid_distinct.length ? `Already paid for these distinct values (a preview showing one of them is a duplicate): ${f.paid_distinct.join(', ')}.` : '',
        data('Bounty', { title: spec.title, description: spec.description, preview_requirements: spec.preview_requirements }),
        data('Preview', f.preview, 8000),
        data('Seller message', f.message ?? ''),
        `Seller handle: ${f.seller_handle}`,
      ]
        .filter(Boolean)
        .join('\n\n'),
      maxTokens: 1200,
      effort: 'high',
      jsonSchema: {
        type: 'object',
        properties: { decision: { type: 'string', enum: ['pay', 'ask', 'walk_away'] }, message: { type: 'string' }, duplicate_of: { type: ['string', 'null'] } },
        required: ['decision', 'message', 'duplicate_of'],
        additionalProperties: false,
      },
    })
    const decision = d.decision === 'pay' || d.decision === 'ask' || d.decision === 'walk_away' ? d.decision : 'ask'
    return { decision, message: String(d.message ?? '').slice(0, 1500), duplicate_of: typeof d.duplicate_of === 'string' ? d.duplicate_of : null }
  }

  async evaluateDelivery(spec: BountySpec, f: DeliveryFacts): Promise<Verdict> {
    const failed = f.checks.filter((c) => !c.ok)
    const { data: d } = await this.llm.completeJson<Verdict>({
      system: DESK,
      user: [
        `We paid; now grade the full delivery against the rubric. Decide "accept" (rating 3-5) when it does what the bounty asked; "revise" (rating 2-3) when concrete, fixable gaps remain and revisions are left (${f.revisions_left}); write exactly what to change. "dispute" only when the delivery is fabricated, empty, off-task or a mechanical check failed in a way that voids the work (rating 1-2), with a factual reason. Mechanical check failures are listed; treat them as facts.`,
        data('Bounty', { title: spec.title, description: spec.description, rubric: spec.rubric }),
        data('Mechanical checks', f.checks),
        failed.length ? `Failed checks: ${failed.map((c) => c.check).join(', ')}.` : 'All mechanical checks passed.',
        data('Delivery output', f.output),
        data('Seller message', f.message ?? ''),
        `Seller handle: ${f.seller_handle}`,
      ].join('\n\n'),
      maxTokens: 2500,
      effort: 'high',
      jsonSchema: {
        type: 'object',
        properties: {
          decision: { type: 'string', enum: ['accept', 'revise', 'dispute'] },
          rating: { type: 'integer', minimum: 1, maximum: 5 },
          message: { type: 'string' },
          rubric_scores: { type: 'array', items: { type: 'object', properties: { criterion: { type: 'string' }, score: { type: 'integer', minimum: 0, maximum: 10 }, note: { type: 'string' } }, required: ['criterion', 'score', 'note'], additionalProperties: false } },
        },
        required: ['decision', 'rating', 'message', 'rubric_scores'],
        additionalProperties: false,
      },
    })
    let decision: Verdict['decision'] = d.decision === 'accept' || d.decision === 'revise' || d.decision === 'dispute' ? d.decision : 'accept'
    if (decision === 'revise' && f.revisions_left <= 0) decision = 'accept'
    return {
      decision,
      rating: clampInt(d.rating, 1, 5) as Verdict['rating'],
      message: String(d.message ?? '').slice(0, 2000),
      rubric_scores: Array.isArray(d.rubric_scores) ? d.rubric_scores.slice(0, 10).map((r) => ({ criterion: String(r?.criterion ?? ''), score: clampInt(r?.score, 0, 10), note: String(r?.note ?? '') })) : [],
    }
  }
}

function clampInt(v: unknown, lo: number, hi: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : lo
  return Math.max(lo, Math.min(hi, n))
}
