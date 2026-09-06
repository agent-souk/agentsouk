import { and, desc, eq, lt, or } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { settlements, type Env, type SettlementKind } from '../../db/schema.js'
import { newId } from '../../lib/ids.js'
import { iso } from '../../lib/http.js'
import { CURRENCY, explorerTxUrl, formatUsdc, type BuiltRequirements, type SettleResponse } from './x402.js'

/**
 * Settlements (ADR-21 §7): the only money record the platform keeps. A row is created BEFORE the facilitator
 * is asked to settle, so a crash between on-chain settlement and our bookkeeping leaves a `pending` row an
 * operator can reconcile against the chain.
 */

export type Settlement = typeof settlements.$inferSelect

export type PendingSettlementInput = {
  env: Env
  jobId: string
  kind: SettlementKind
  payerAgentId: string
  payeeAgentId: string
  built: BuiltRequirements
  version: 1 | 2
  facilitator: string
}

export async function createPendingSettlement(input: PendingSettlementInput): Promise<Settlement> {
  const row: typeof settlements.$inferInsert = {
    id: newId('settlement'),
    env: input.env,
    jobId: input.jobId,
    kind: input.kind,
    payerAgentId: input.payerAgentId,
    payeeAgentId: input.payeeAgentId,
    payerAddress: null,
    payTo: input.built.payTo,
    amount: Number(input.built.amount),
    asset: input.built.asset,
    network: input.built.network,
    scheme: 'exact',
    x402Version: input.version,
    facilitator: input.facilitator,
    transaction: null,
    status: 'pending',
    error: null,
    createdAt: Date.now(),
    settledAt: null,
  }
  await db().insert(settlements).values(row)
  return row as Settlement
}

export async function markSettlementFailed(id: string, error: string): Promise<void> {
  await db().update(settlements).set({ status: 'failed', error: error.slice(0, 500) }).where(eq(settlements.id, id))
}

/** Values to write when the facilitator reports success (the jobs service applies them inside its own transaction). */
export function settledPatch(result: SettleResponse, now = Date.now()): Partial<typeof settlements.$inferInsert> {
  return { status: 'settled', transaction: result.transaction ?? null, payerAddress: result.payer ?? null, network: result.network ?? undefined, settledAt: now, error: null }
}

export async function getSettlement(id: string): Promise<Settlement | undefined> {
  return db().query.settlements.findFirst({ where: eq(settlements.id, id) })
}

export async function listMySettlements(env: Env, agentId: string, limit: number, cursor?: string): Promise<Settlement[]> {
  const conds = [eq(settlements.env, env), or(eq(settlements.payerAgentId, agentId), eq(settlements.payeeAgentId, agentId))!, eq(settlements.status, 'settled')]
  if (cursor) conds.push(lt(settlements.id, cursor))
  return db().query.settlements.findMany({ where: and(...conds), orderBy: [desc(settlements.id)], limit: limit + 1 })
}

export type SettlementView = {
  object: 'settlement'
  id: string
  job_id: string
  kind: SettlementKind
  direction: 'in' | 'out' | null
  payer_agent_id: string
  payee_agent_id: string
  payer_address: string | null
  pay_to: string
  amount: number
  currency: 'USDC'
  display: string
  network: string
  asset: string
  transaction: string | null
  explorer_url: string | null
  status: string
  settled_at: string | null
  created_at: string
}

export function toSettlementView(s: Settlement, viewerId?: string): SettlementView {
  return {
    object: 'settlement',
    id: s.id,
    job_id: s.jobId,
    kind: s.kind,
    direction: viewerId ? (s.payeeAgentId === viewerId ? 'in' : s.payerAgentId === viewerId ? 'out' : null) : null,
    payer_agent_id: s.payerAgentId,
    payee_agent_id: s.payeeAgentId,
    payer_address: s.payerAddress,
    pay_to: s.payTo,
    amount: s.amount,
    currency: CURRENCY,
    display: formatUsdc(s.amount),
    network: s.network,
    asset: s.asset,
    transaction: s.transaction,
    explorer_url: explorerTxUrl(s.network, s.transaction),
    status: s.status,
    settled_at: iso(s.settledAt),
    created_at: iso(s.createdAt)!,
  }
}
