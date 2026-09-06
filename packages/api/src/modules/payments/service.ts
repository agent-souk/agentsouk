import { and, desc, eq, lt, or } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { settlements, type Env, type SettlementKind, type SettlementStatus } from '../../db/schema.js'
import { newId } from '../../lib/ids.js'
import { iso } from '../../lib/http.js'
import type { VerifiedTransfer } from './chain.js'
import { CURRENCY, explorerTxUrl, formatUsdc } from './x402.js'

/**
 * Settlements (ADR-22 §7): the only money record the platform keeps. A row is written only after the transfer
 * was verified on-chain; the unique index on `transaction` guarantees one hash pays one thing.
 */

export type Settlement = typeof settlements.$inferSelect

export type SettlementRowInput = {
  env: Env
  jobId: string
  kind: SettlementKind
  payerAgentId: string
  payeeAgentId: string
  verified: VerifiedTransfer
  expectedAmount: number
  status: SettlementStatus
  now?: number
}

/** Builds the insert row; the jobs service inserts it inside its own transaction together with the job update. */
export function settlementRow(input: SettlementRowInput): typeof settlements.$inferInsert {
  const now = input.now ?? Date.now()
  return {
    id: newId('settlement'),
    env: input.env,
    jobId: input.jobId,
    kind: input.kind,
    payerAgentId: input.payerAgentId,
    payeeAgentId: input.payeeAgentId,
    payerAddress: input.verified.from,
    payTo: input.verified.to,
    amount: input.verified.amount,
    expectedAmount: input.expectedAmount,
    asset: input.verified.asset,
    network: input.verified.network,
    transaction: input.verified.transaction,
    blockNumber: input.verified.blockNumber,
    blockTimestamp: input.verified.blockTimestamp,
    status: input.status,
    createdAt: now,
    settledAt: now,
  }
}

/** SQLite unique-constraint detection (libsql surfaces the SQLITE_CONSTRAINT code or message). */
export function isUniqueViolation(e: unknown): boolean {
  const msg = String((e as { message?: string })?.message ?? e)
  const code = String((e as { code?: string })?.code ?? '')
  return code.includes('SQLITE_CONSTRAINT') || /UNIQUE constraint failed/i.test(msg)
}

export async function findSettlementByTransaction(tx: string): Promise<Settlement | undefined> {
  return db().query.settlements.findFirst({ where: eq(settlements.transaction, tx.toLowerCase()) })
}

export async function getSettlement(id: string): Promise<Settlement | undefined> {
  return db().query.settlements.findFirst({ where: eq(settlements.id, id) })
}

export async function listSettlementsForJob(jobId: string): Promise<Settlement[]> {
  return db().query.settlements.findMany({ where: eq(settlements.jobId, jobId), orderBy: [desc(settlements.id)] })
}

export async function listMySettlements(env: Env, agentId: string, limit: number, cursor?: string): Promise<Settlement[]> {
  const conds = [eq(settlements.env, env), or(eq(settlements.payerAgentId, agentId), eq(settlements.payeeAgentId, agentId))!]
  if (cursor) conds.push(lt(settlements.id, cursor))
  return db().query.settlements.findMany({ where: and(...conds), orderBy: [desc(settlements.id)], limit: limit + 1 })
}

export type SettlementView = {
  object: 'settlement'
  id: string
  job_id: string
  kind: SettlementKind
  status: SettlementStatus
  direction: 'in' | 'out' | null
  payer_agent_id: string
  payee_agent_id: string
  payer_address: string
  pay_to: string
  amount: number
  expected_amount: number
  currency: 'USDC'
  display: string
  network: string
  asset: string
  transaction: string
  explorer_url: string | null
  block_number: number
  block_time: string
  settled_at: string
  created_at: string
}

export function toSettlementView(s: Settlement, viewerId?: string): SettlementView {
  return {
    object: 'settlement',
    id: s.id,
    job_id: s.jobId,
    kind: s.kind,
    status: s.status,
    direction: viewerId ? (s.payeeAgentId === viewerId ? 'in' : s.payerAgentId === viewerId ? 'out' : null) : null,
    payer_agent_id: s.payerAgentId,
    payee_agent_id: s.payeeAgentId,
    payer_address: s.payerAddress,
    pay_to: s.payTo,
    amount: s.amount,
    expected_amount: s.expectedAmount,
    currency: CURRENCY,
    display: formatUsdc(s.amount),
    network: s.network,
    asset: s.asset,
    transaction: s.transaction,
    explorer_url: explorerTxUrl(s.network, s.transaction),
    block_number: s.blockNumber,
    block_time: iso(s.blockTimestamp)!,
    settled_at: iso(s.settledAt)!,
    created_at: iso(s.createdAt)!,
  }
}
