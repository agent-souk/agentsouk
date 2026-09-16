import { asc, desc, inArray, sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db } from '../../db/client.js'
import { platformState, type Env } from '../../db/schema.js'
import { log } from '../../lib/log.js'
import { raiseX402Failure } from '../../ops/alerts.js'

/**
 * Every x402 purchase attempt that carried a payment and did not end in a delivery, with its reason: refused
 * before any work, rejected by the platform's input check, declined or not delivered by the seller, or a bug of
 * ours. Kept in platform_state under a time-ordered key (the newest 300), shown in GET /v1/admin/overview as
 * `x402_failures`, and raised as an operator alert (one line per wallet and hour).
 *
 * Until 0.5.22 a failed attempt was a `+1` in a day counter. On 2026-09-16 a wallet holding 4.76 USDC was turned
 * away at 12:08 UTC after its account had been created: no job exists, the logs were gone by the evening, and the
 * reason is lost. The one kind of customer this platform is waiting for had come and left, and nobody could say why.
 */
export type X402Failure = { at: string; env: Env; listing_id: string; listing_title: string; payer: string | null; job_id: string | null; code: string; status: number; message: string; ua: string | null }

const PREFIX = 'x402/failure/'
const KEPT = 300

export async function noteX402Failure(f: X402Failure): Promise<void> {
  await db().insert(platformState).values({ key: `${PREFIX}${ulid()}`, value: f, createdAt: Date.now() })
  const rows = await db().select({ key: platformState.key }).from(platformState).where(sql`${platformState.key} like ${PREFIX + '%'}`).orderBy(asc(platformState.key))
  if (rows.length > KEPT) await db().delete(platformState).where(inArray(platformState.key, rows.slice(0, rows.length - KEPT).map((r) => r.key)))
  await raiseX402Failure({ env: f.env, payer: f.payer, listingTitle: f.listing_title, code: f.code, status: f.status, message: f.message, jobId: f.job_id }).catch((err) => log.warn({ err }, 'x402: operator alert about a failed purchase failed'))
}

/** The newest failed purchase attempts, for the operator view. */
export async function recentX402Failures(limit = 20): Promise<X402Failure[]> {
  const rows = await db().select({ value: platformState.value }).from(platformState).where(sql`${platformState.key} like ${PREFIX + '%'}`).orderBy(desc(platformState.key)).limit(limit)
  return rows.map((r) => r.value as unknown as X402Failure)
}
