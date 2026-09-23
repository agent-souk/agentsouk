import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { cors } from 'hono/cors'
import type { MiddlewareHandler } from 'hono'
import { and, asc, desc, eq, gt, inArray, isNotNull, ne, sql } from 'drizzle-orm'
import type { AppEnv } from '../../app.js'
import { db } from '../../db/client.js'
import { agents, jobEvents, jobs, listings, platformState, type Env } from '../../db/schema.js'
import { config } from '../../config.js'
import { ApiError, errors } from '../../lib/errors.js'
import { errorResponses } from '../../lib/http.js'
import { log } from '../../lib/log.js'
import { canonicalJson } from '../../lib/crypto.js'
import { registerSweep } from '../../lib/scheduler.js'
import { recordX402 } from '../../discovery/hits.js'
import { raiseX402Purchase } from '../../ops/alerts.js'
import { dropPendingBroadcast, noteX402Failure, pendingBroadcastFor, pendingX402Broadcasts, savePendingBroadcast } from './failures.js'
import { bazaarExtension, serviceMetadata } from './bazaar.js'
import { ownershipProofs } from '../../discovery/ownership.js'
import { rateLimit } from '../../middleware/ratelimit.js'
import { createAgent, recoverKeys } from '../agents/service.js'
import { normalizeEvmAddress } from '../payments/address.js'
import { verifyDigestSignature } from '../payments/evm-signature.js'
import { abandonUnsettledPurchase, acceptDelivery, createJob, payJob } from '../jobs/service.js'
import { unitBasisSentence, unitsForInput } from '../listings/units.js'
import { checkAgainstSchema, isSchemaObject } from '../../lib/json-schema.js'
import { assertNotSanctioned } from '../payments/sanctions.js'
import { authorizationUsed, findAuthorizationTransaction, usdcBalance } from '../payments/chain.js'
import { CHAINS, encodePaymentRequiredHeader, formatUsdc, networkFor, paymentRequiredV1, paymentTerms, transferAuthorizationDigest, type PaymentRequiredV2, type RequirementsV2 } from '../payments/x402.js'

/**
 * ADR-48: a paid endpoint in the x402 shape, for OUR OWN services only.
 *
 * Why this exists at all: every channel we have reaches sellers or crawlers. On live, not one order has ever been
 * placed here with Agent Souk on neither side (GET /v1/stats between_outsiders.orders = 0). x402 has the one
 * population we lack - agents built to pay for things - but the standard flow needs the resource server to submit
 * the buyer's signed authorization to a facilitator, and ADR-22 removed exactly that for third-party sellers after
 * a legal review. It cannot move between_outsiders, because we are one of the two parties by construction. It
 * answers the question behind it: does any agent out there pay for anything?
 *
 * Two properties carry the whole design, and both are enforced below rather than promised:
 *
 *  1. FIRST-PARTY ONLY. The endpoint refuses any listing whose seller is not operated by Agent Souk. Submitting a
 *     buyer's authorization for a THIRD party's receivable is, near enough word for word, the PSD2 Art. 4(44)
 *     definition of acquiring ("contracting with a payee to accept and process payment transactions"). Collecting
 *     our own price is not: every relevant definition - acquiring, payment initiation, MiCA transfer, money
 *     remittance - requires acting for someone else. See the 2026-09-10 note in docs/LEGAL-BRIEFING.md.
 *  2. WE SETTLE ONLY AFTER THE WORK EXISTS. The job is created and the seller delivers first; the authorization is
 *     submitted to the facilitator afterwards. If the seller fails or is slow, nothing is submitted and the buyer
 *     keeps its money. An EIP-3009 authorization is fixed to one recipient, one amount, one nonce and a time
 *     window - it cannot be redirected, and holding it for a few seconds gives us no access to anything else.
 */

/** The authorization a buyer signed, as it arrives base64-encoded in the X-PAYMENT header (x402 v2). */
type PaymentPayload = {
  x402Version?: number
  scheme?: string
  network?: string
  payload: { signature: string; authorization: { from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: string } }
}

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/
const HEX_64 = /^0x[0-9a-fA-F]{64}$/

/** Both generations of the payment headers, so a browser-based client can read them across origins. */
const EXPOSED_HEADERS = 'Content-Type,PAYMENT-REQUIRED,PAYMENT-RESPONSE,X-PAYMENT-RESPONSE'

/**
 * ADR-66: how long an authorization must still be valid when a purchase starts (the work comes first), and how much
 * of its window the wait for delivery leaves for submitting it. Clients sign for the 402's maxTimeoutSeconds (900).
 */
export const X402_MIN_VALIDITY_MS = 60_000
export const X402_SETTLE_MARGIN_MS = 10_000
/**
 * ADR-66: the value each wallet's purchases still running here will move, and the authorizations they carry. The API
 * is one process (fly.toml), so memory is the whole truth; a restart ends the requests these entries belong to.
 */
const x402ValueRunning = new Map<string, number>()
const x402AuthorizationsRunning = new Set<string>()
/** How long the endpoint waits for the seller's delivery before it gives up (tests shorten it). */
let deliveryWaitMs = 90_000
export function _setX402DeliveryWaitForTests(ms: number | null) {
  deliveryWaitMs = ms ?? 90_000
}
/** How long a broadcast transfer is retried inside the request before the sweep takes over (tests shorten it). */
let minedWaitMs = 60_000
export function _setX402MinedWaitForTests(ms: number | null) {
  minedWaitMs = ms ?? 60_000
}


export function parsePaymentHeader(header: string): PaymentPayload {
  let text: string
  try {
    text = Buffer.from(header, 'base64').toString('utf8')
  } catch {
    throw errors.validation('X-PAYMENT must be base64 of the x402 payment payload.', 'X-PAYMENT')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw errors.validation('X-PAYMENT decoded to something that is not JSON.', 'X-PAYMENT')
  }
  const p = parsed as PaymentPayload
  const a = p?.payload?.authorization
  if (!a || typeof p.payload.signature !== 'string' || !p.payload.signature.startsWith('0x')) throw errors.validation('X-PAYMENT needs payload.signature and payload.authorization.', 'X-PAYMENT')
  if (!HEX_ADDRESS.test(a.from) || !HEX_ADDRESS.test(a.to)) throw errors.validation('authorization.from and authorization.to must be 0x addresses.', 'X-PAYMENT')
  if (!HEX_64.test(a.nonce)) throw errors.validation('authorization.nonce must be 0x + 64 hex characters.', 'X-PAYMENT')
  if (!/^\d+$/.test(String(a.value))) throw errors.validation('authorization.value must be an integer string in USDC minor units.', 'X-PAYMENT')
  // Unparsed, a missing validBefore became NaN and the purchase a 500 (ADR-80 review): the time window is part of what
  // was signed, so a payload without it is malformed, not a bug of ours.
  for (const k of ['validAfter', 'validBefore'] as const) {
    if (!/^\d{1,12}$/.test(String(a[k]))) throw errors.validation(`authorization.${k} must be an integer string of unix seconds.`, 'X-PAYMENT', 'Sign the EIP-3009 TransferWithAuthorization the 402 describes and send its authorization fields as the x402 exact scheme names them.')
  }
  return p
}

/**
 * The wallet is the identity (ADR-48): a buyer that pays through this endpoint gets a real agent record, so it has
 * receipts, a public counterparty history and every other right a registered agent has - without a registration
 * step it never asked for. The wallet is bound without the usual EIP-191 proof because the authorization in hand
 * IS a signature by that wallet; the proof exists, it just has a different shape.
 */
type BuyerAccount = { agent: Parameters<typeof createJob>[1]; credentials: Record<string, unknown> | null; created: boolean; recovered: boolean }

const X402_ACCOUNT_DESCRIPTION = 'Registered by paying through the x402 endpoint (ADR-48); the wallet is the identity.'

/**
 * Where this endpoint keeps what it knows about the accounts it created: platform_state, keyed by agent id. Not a
 * profile field the agent can edit (0.5.7 compared the description text) and not the agent's own memory the agent
 * can delete or fill to its limit (0.5.7 kept the "shown" marker there) - a fact about the account's origin
 * belongs to the platform (ADR-58). Accounts created before 0.5.8 have no row and are never rotated.
 */
type X402Account = { created_at: string; shown_at: string | null; job_id?: string }
const accountKey = (agentId: string) => `x402/account/${agentId}`
async function x402Account(agentId: string): Promise<X402Account | null> {
  const row = await db().query.platformState.findFirst({ where: eq(platformState.key, accountKey(agentId)) })
  return (row?.value as X402Account | undefined) ?? null
}
async function saveX402Account(agentId: string, value: X402Account): Promise<void> {
  await db().insert(platformState).values({ key: accountKey(agentId), value, createdAt: Date.now() }).onConflictDoUpdate({ target: platformState.key, set: { value } })
}

/**
 * ADR-80: which job an authorization is paying for. Written when the job exists, read when the same authorization
 * arrives again - a client that timed out and retried used to hear "Nothing was charged ... sign a new
 * authorization" for an authorization that HAD paid, and paid a second time. The answer never hands out the result:
 * the signed payload lies in the calldata of the transfer for anyone to read, so it proves nothing about who asks.
 */
type AuthorizationUse = { job_id: string; listing_id: string; at: string; transaction?: string }
const authUseKey = (env: Env, from: string, nonce: string) => `x402/auth/${env}:${from.toLowerCase()}:${nonce.toLowerCase()}`
async function authorizationUse(env: Env, from: string, nonce: string): Promise<AuthorizationUse | null> {
  const row = await db().query.platformState.findFirst({ where: eq(platformState.key, authUseKey(env, from, nonce)) })
  return (row?.value as AuthorizationUse | undefined) ?? null
}
async function saveAuthorizationUse(env: Env, from: string, nonce: string, value: AuthorizationUse): Promise<void> {
  const key = authUseKey(env, from, nonce)
  // a use that names a transaction is the record of money that moved: it is never replaced by a later attempt
  const known = await authorizationUse(env, from, nonce)
  if (known?.transaction && known.transaction !== value.transaction) return
  await db().insert(platformState).values({ key, value, createdAt: Date.now() }).onConflictDoUpdate({ target: platformState.key, set: { value } })
}

/**
 * ADR-80: how long a buyer's client must be willing to wait for the answer: the endpoint waits up to 90 s for the
 * delivery, the facilitator up to 60 s for the settlement, and the platform up to 60 s more for the block, plus
 * margin. Named where a buyer reads BEFORE paying (the 402, GET /v1/x402, skill.md) - the Python x402 client's default
 * of 5 s used to give up after the work had started, and until 0.5.25 the payment was taken anyway.
 */
export const X402_ANSWER_WITHIN_SECONDS = 240

/** A purchase still inside its own request gets this long before the sweep touches its transfer (payUntilMined waits 60 s). */
export const X402_RECONCILE_AFTER_MS = 180_000
const RETRYABLE = new Set(['transaction_pending', 'transaction_not_found', 'chain_unavailable'])

/** The sweep: record every broadcast transfer on its job, as the buyer's own POST /pay would, and close the job. */
export async function reconcileX402Broadcasts(now = Date.now()): Promise<void> {
  for (const b of await pendingX402Broadcasts()) {
    if (now - Date.parse(b.at) < X402_RECONCILE_AFTER_MS) continue
    if (!b.transaction) {
      // The facilitator's answer never arrived, so whether it broadcast is unknown. Once the authorization's window
      // has closed, the chain says which: unused means no money moved and the sealed delivery is closed with no mark;
      // used means money moved under a hash we do not have, which the operator has to look up (logged once).
      if (now < b.valid_before * 1000 + 60_000) continue
      const used = await authorizationUsed(b.env, b.payer, b.nonce)
      if (used === false) {
        await abandonUnsettledPurchase(b.job_id, "platform: the facilitator's answer was lost and the buyer's authorization expired unused; nothing was charged", ['delivered'])
        await dropPendingBroadcast(b.job_id)
        continue
      }
      if (used !== true) continue // the node did not answer: ask again on the next sweep
      // Used. If the same authorization paid another purchase here (a retry), this job was never paid and is closed.
      const use = await authorizationUse(b.env, b.payer, b.nonce)
      if (use?.transaction && use.job_id !== b.job_id) {
        await abandonUnsettledPurchase(b.job_id, `platform: the buyer's authorization paid job ${use.job_id} instead; this job was never paid`, ['delivered'])
        await dropPendingBroadcast(b.job_id)
        continue
      }
      // Otherwise it paid THIS job under a hash we never heard: the chain's own log names it, and the entry becomes an
      // ordinary broadcast that the branch below records on the next sweep.
      const found = await findAuthorizationTransaction(b.env, b.payer, b.nonce, Math.min(200_000, Math.ceil((now - Date.parse(b.at)) / 2_000) + 5_000))
      if (found) {
        await savePendingBroadcast({ ...b, transaction: found, attempts: b.attempts + 1, last_error: undefined })
        await saveAuthorizationUse(b.env, b.payer, b.nonce, { job_id: b.job_id, listing_id: b.listing_id, at: b.at, transaction: found })
        continue
      }
      if (b.attempts === 0) log.error({ broadcast: b }, 'x402: an authorization was used on-chain, and its AuthorizationUsed log was not found; left for the operator')
      await savePendingBroadcast({ ...b, attempts: b.attempts + 1, last_error: 'authorization used on-chain; transaction not found in the logs yet' })
      continue
    }
    const buyer = await db().query.agents.findFirst({ where: eq(agents.id, b.buyer_agent_id) })
    if (!buyer) {
      log.error({ broadcast: b }, 'x402: the buyer of a broadcast transfer no longer exists; left for the operator')
      continue
    }
    try {
      const paid = await payJob(b.env, buyer, b.job_id, b.transaction)
      if (paid.job.status === 'delivered') await acceptDelivery(b.env, buyer, b.job_id).catch((err) => log.warn({ err, job: b.job_id }, 'x402: could not close a late-recorded job'))
      await dropPendingBroadcast(b.job_id)
      recordX402('recorded_late', null)
      log.info({ job: b.job_id, transaction: b.transaction, attempts: b.attempts }, 'x402: broadcast transfer recorded by the sweep')
    } catch (e) {
      const code = e instanceof ApiError ? e.code : 'internal'
      if (code === 'job_not_payable') {
        // payJob has recorded the transfer as an orphaned settlement with refund_due on the job: the money is on the
        // record as owed back, which is where it belongs. Nothing further for the sweep to do.
        await dropPendingBroadcast(b.job_id)
        log.warn({ job: b.job_id, transaction: b.transaction }, 'x402: broadcast transfer recorded as a refund the seller owes')
        continue
      }
      await savePendingBroadcast({ ...b, attempts: b.attempts + 1, last_error: `${code}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300) })
      if (!RETRYABLE.has(code)) log.error({ err: e, broadcast: b }, 'x402: a broadcast transfer could not be recorded; kept for the operator')
    }
  }
}
registerSweep('x402-broadcasts', (now) => reconcileX402Broadcasts(now))

/**
 * Only reached with a VERIFIED authorization (the handler recovers the signer first, ADR-58), so everything this
 * function does happens on behalf of the wallet's owner.
 */
async function buyerForWallet(rawAddress: string): Promise<BuyerAccount> {
  // Case-insensitive, and stored checksummed like every other wallet binding (ADR-57): the signed authorization's
  // `from` arrives in whatever case the client used, and an exact match against a checksummed binding created a
  // second account for the same wallet on the first lowercase call.
  const address = normalizeEvmAddress(rawAddress) ?? rawAddress
  const known = await db().query.agents.findFirst({ where: sql`lower(${agents.walletAddress}) = ${address.toLowerCase()}` })
  if (known) {
    if (known.status !== 'active') throw errors.state('buyer_not_active', 'The agent bound to this wallet is not active.')
    // An account this endpoint created whose credentials never reached the buyer - the purchase failed after the
    // account existed: a slow seller, a facilitator refusal - is not "an account whose credentials were shown
    // once". Its keys are replaced and handed over now, once; the marker is written when a response carries them.
    // Any other existing account keeps its secret: the wallet's owner may not be the account's owner.
    const origin = await x402Account(known.id)
    if (origin && origin.shown_at == null) {
      const keys = await recoverKeys(known, true)
      return { agent: known, created: false, recovered: true, credentials: { agent_id: known.id, handle: known.handle, api_keys: keys, keypair: null, keypair_note: 'The Ed25519 keypair was generated when this account was created by an earlier, failed purchase and cannot be recovered; rotate it with POST /v1/agents/me/key if you need one.' } }
    }
    return { agent: known, created: false, recovered: false, credentials: null }
  }
  const created = await createAgent({ name: `x402 buyer ${address.slice(0, 6)}${address.slice(-4)}`, description: X402_ACCOUNT_DESCRIPTION })
  await db().update(agents).set({ walletAddress: address, updatedAt: Date.now() }).where(eq(agents.id, created.agent.id))
  await saveX402Account(created.agent.id, { created_at: new Date().toISOString(), shown_at: null })
  const agent = (await db().query.agents.findFirst({ where: eq(agents.id, created.agent.id) }))!
  return { agent, created: true, recovered: false, credentials: { agent_id: agent.id, handle: agent.handle, api_keys: created.apiKeys, keypair: created.keypair ?? null } }
}

/** Polls the job row until the seller has delivered. Returns null on timeout; nothing is settled in that case. */
async function waitForDelivery(jobId: string, timeoutMs: number, intervalMs = 700): Promise<'delivered' | 'gone' | null> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const row = await db().query.jobs.findFirst({ where: eq(jobs.id, jobId), columns: { status: true } })
    if (!row) return 'gone'
    if (row.status === 'delivered') return 'delivered'
    if (['declined', 'cancelled', 'expired'].includes(row.status)) return 'gone'
    if (Date.now() >= until) return null
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

type SettleFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string>; headers?: { get(name: string): string | null } }>
/** How long the facilitator gets to settle (it waits for the transfer to be mined before it answers). */
const SETTLE_TIMEOUT_MS = 60_000
let settleFetch: SettleFetch = (url, init) => fetch(url, init) as unknown as ReturnType<SettleFetch>
/** Tests only: replace the call to the public facilitator. */
export function _setSettleFetchForTests(f: SettleFetch | null) {
  settleFetch = f ?? ((url, init) => fetch(url, init) as unknown as ReturnType<SettleFetch>)
}

/**
 * ADR-65: what the facilitator says about the `bazaar` extension it was handed, from the EXTENSION-RESPONSES header
 * of its answer (base64 JSON keyed by extension). `success` and `processing` both mean the resource is, or is about
 * to be, in that facilitator's public catalogue; `rejected` carries the reason. Absent when the facilitator does
 * not implement discovery. Never throws: a header we cannot read is no header.
 */
export function bazaarOutcome(header: string | null | undefined): { status: string; rejectedReason?: string } | null {
  if (!header) return null
  try {
    const parsed = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as { bazaar?: { status?: unknown; rejectedReason?: unknown } }
    const b = parsed?.bazaar
    if (!b || typeof b.status !== 'string') return null
    return { status: b.status.slice(0, 32), ...(typeof b.rejectedReason === 'string' ? { rejectedReason: b.rejectedReason.slice(0, 300) } : {}) }
  } catch {
    return null
  }
}

/**
 * ADR-65: the payload carries the `bazaar` extension of OUR 402 and our own `resource` block - not whatever the
 * buyer echoed. The spec has the client echo them so the facilitator can catalogue the resource; here the server is
 * the one talking to the facilitator, so it sends the description it is the authority for. Until 0.5.19 the payload
 * had no extensions at all, and in seven days of paid calls not one facilitator had learned that this endpoint
 * exists: 28,634 resources in PayAI's catalogue, 15,380 in Coinbase's, none of them ours.
 */
async function settleAtFacilitator(env: Env, requirements: RequirementsV2, resource: PaymentRequiredV2['resource'], payment: PaymentPayload, extensions: Record<string, unknown>, ua: string | undefined): Promise<string> {
  const chain = CHAINS[networkFor(env)]
  const url = `${chain.facilitator.replace(/\/$/, '')}/settle`
  const body = JSON.stringify({
    x402Version: 2,
    paymentPayload: { x402Version: 2, resource, accepted: requirements, payload: payment.payload, extensions },
    paymentRequirements: requirements,
  })
  // ADR-80: a request that dies on the way (timeout, reset) is NOT a refusal - the facilitator may have broadcast.
  // It gets its own code so the caller keeps the sealed job instead of closing it, and says "unknown", not "nothing".
  let res: Awaited<ReturnType<SettleFetch>>
  let text: string
  try {
    res = await settleFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(SETTLE_TIMEOUT_MS) })
    text = await res.text()
  } catch (e) {
    log.error({ err: e, facilitator: chain.facilitator, resource: resource.url }, 'x402 settle: no answer from the facilitator')
    throw new ApiError('payment_error', 'x402_settle_unknown', 'The facilitator did not answer, so it is not known whether your payment was submitted.', {
      status: 502,
      hint: SETTLE_UNKNOWN_HINT,
    })
  }
  const catalogued = bazaarOutcome(res.headers?.get('extension-responses'))
  if (catalogued) {
    recordX402(catalogued.status === 'rejected' ? 'catalog_rejected' : 'catalogued', ua)
    log.info({ facilitator: chain.facilitator, resource: resource.url, ...catalogued }, 'x402: facilitator answered the bazaar extension')
  }
  let parsed: { success?: boolean; transaction?: string; errorReason?: string } = {}
  try {
    parsed = JSON.parse(text) as typeof parsed
  } catch {
    /* fall through to the error below */
  }
  if (res.ok && parsed.success && typeof parsed.transaction === 'string' && parsed.transaction) return parsed.transaction
  // ADR-80 review: an answer that names a transaction was broadcast, whatever else it says (the reference facilitator
  // answers `success: false, errorReason: "settlement_pending"` WITH the hash when only its wait for the receipt failed)
  if (typeof parsed.transaction === 'string' && /^0x[0-9a-fA-F]{64}$/.test(parsed.transaction)) {
    log.warn({ status: res.status, reason: parsed.errorReason, transaction: parsed.transaction }, 'x402 settle: broadcast, but not confirmed by the facilitator')
    return parsed.transaction
  }
  // Only a refusal from the checks BEFORE a broadcast means that nothing moved. A 5xx, an answer we cannot read, or a
  // failure without a known pre-broadcast reason may have come after it: those are "unknown", never "nothing was charged".
  const reason = typeof parsed.errorReason === 'string' ? parsed.errorReason : ''
  const refusedBeforeBroadcast = res.status < 500 && parsed.success === false && /^(invalid_|insufficient_funds|expired|not_yet_valid|nonce)/i.test(reason)
  if (!refusedBeforeBroadcast) {
    log.error({ status: res.status, reason, body: text.slice(0, 300) }, 'x402 settle: outcome unknown')
    throw new ApiError('payment_error', 'x402_settle_unknown', `The facilitator's answer does not say whether your payment was submitted (${reason || `HTTP ${res.status}`}).`, { status: 502, hint: SETTLE_UNKNOWN_HINT })
  }
  log.warn({ status: res.status, reason, body: text.slice(0, 300) }, 'x402 settle refused')
  throw errors.state('x402_settle_failed', `The facilitator refused the payment before submitting it: ${reason}.`, 'Nothing was charged. Check the wallet holds enough USDC and that the authorization has not expired, then request fresh terms and try again.')
}

const SETTLE_UNKNOWN_HINT = `Do not sign a new authorization for this order: it could pay a second time. If your authorization is still unused on-chain when it expires, nothing was charged and the job is closed with no mark. If it was used, the platform finds the transfer on-chain and records it on the job, and the result is yours - read it with this wallet's account key.`

/**
 * The facilitator has broadcast the transfer, but a block still has to arrive before the platform's own on-chain
 * check will accept it. That wait belongs here: the buyer is holding an open HTTP request and has already paid,
 * and asking it to retry a purchase it cannot repeat (the nonce is spent) would be the wrong answer.
 */
async function payUntilMined(env: Env, buyer: Parameters<typeof createJob>[1], jobId: string, transaction: string, timeoutMs = minedWaitMs) {
  const until = Date.now() + timeoutMs
  for (;;) {
    try {
      return await payJob(env, buyer, jobId, transaction)
    } catch (err) {
      // ADR-80: an unreachable node is as temporary as a missing block - the transfer has already happened
      const pending = err instanceof ApiError && RETRYABLE.has(err.code)
      if (!pending || Date.now() >= until) throw err
      await new Promise((r) => setTimeout(r, Math.min(2500, Math.max(50, until - Date.now()))))
    }
  }
}

const ResultView = z
  .object({
    object: z.literal('x402_result'),
    job_id: z.string(),
    listing_id: z.string(),
    output: z.unknown(),
    paid: z.object({ amount: z.number().int(), display: z.string(), transaction: z.string(), network: z.string(), payer: z.string(), pay_to: z.string() }),
    receipt_url: z.string().openapi({ description: 'The signed receipt of this job. It is the buyer own receipt rather than a public one, so it needs the key from account.' }),
    account: z.record(z.string(), z.unknown()).openapi({ description: 'The account bound to the paying wallet. On the first purchase from a wallet it carries the API keys and keypair, once and never again.' }),
  })
  .openapi('X402Result')

/**
 * ADR-50: everything that can actually be bought through this endpoint, in one document.
 *
 * The guards are the same ones the endpoint itself applies, read from the same tables: platform-operated seller,
 * active, a real price, a wallet to be paid into. A list that advertised something the endpoint would then refuse
 * would be worse than no list.
 */
export async function sellableListings(env: Env) {
  const rows = await db()
    .select({ listing: listings, seller: agents })
    .from(listings)
    .innerJoin(agents, eq(agents.id, listings.sellerAgentId))
    .where(
      and(
        eq(listings.env, env),
        eq(listings.status, 'active'),
        eq(agents.firstParty, true),
        ne(listings.pricingModel, 'quote'),
        gt(listings.price, 0),
        isNotNull(agents.walletAddress),
        // An upfront listing waits for the buyer to pay before it delivers, and this endpoint waits for the
        // delivery before it submits the payment. Advertising one would hang the buyer for 90 seconds and then
        // fail: the endpoint refuses it below, so the list must not offer it.
        ne(listings.payment, 'upfront'),
      ),
    )
    .orderBy(asc(listings.price))
  return rows.filter((r) => r.seller.status === 'active')
}

/** The public index of what one x402 payment buys here. Shape is ours; it exists to be read by crawlers and agents. */
export async function x402Index(base: string, env: Env) {
  const rows = await sellableListings(env)
  const chain = CHAINS[networkFor(env)]
  // ADR-65: one URL per listing in both environments. The id names the environment (a listing exists in exactly
  // one), and a facilitator catalogues the URL without its query string - a sandbox entry with ?env=test would
  // have been catalogued as a live URL that answers 404.
  const url = (id: string) => `${base}/v1/x402/${id}`
  const proofs = env === 'live' ? ownershipProofs() : []
  return {
    object: 'x402_index' as const,
    // ADR-62: the compatibility shape x402scan reads from /.well-known/x402 when an origin has no usable OpenAPI:
    // `version`, `resources` (one URL per payable endpoint) and the ownership proof; the rest is ours.
    version: 1 as const,
    resources: rows.map(({ listing }) => url(listing.id)),
    ...(proofs.length ? { ownershipProofs: proofs } : {}),
    env,
    protocol: { x402_version: 2, transport: 'HTTP: the PaymentRequired object arrives base64 in the PAYMENT-REQUIRED response header; send the signed authorization back in PAYMENT-SIGNATURE (X-PAYMENT is accepted too).', scheme: 'exact', network: chain.v1, network_caip2: networkFor(env), asset: chain.usdc, asset_name: chain.name },
    what_this_is: 'Services operated by Agent Souk itself, each buyable with a single x402 payment and no account. Paying binds an agent record to your wallet, so you keep the receipt and the public record of the purchase.',
    limit: 'Only listings Agent Souk operates can be bought this way. For any other seller the platform never touches the payment (ADR-22): order it with POST /v1/jobs and pay the seller directly.',
    services: rows.map(({ listing, seller }) => ({
      listing_id: listing.id,
      // The method belongs next to the url: a GET on it is a 404, and a discovery document that omits how to
      // call what it advertises has told you where to go and not how to arrive.
      method: 'POST' as const,
      content_type: 'application/json',
      url: url(listing.id),
      title: listing.title,
      description: listing.description,
      tags: listing.tags,
      price: listing.price,
      price_display: formatUsdc(listing.price),
      pricing_model: listing.pricingModel,
      // ADR-61: a per-unit price without its unit told a wallet-only buyer a number and not what it buys.
      // ADR-77: and a unit without its counting rule told it a number it could not apply to its own input.
      ...(listing.pricingModel === 'per_unit'
        ? {
            unit_name: listing.unitName,
            unit_basis: listing.unitBasis ?? null,
            price_note: listing.unitBasis
              ? `${formatUsdc(listing.price)} per ${listing.unitName}. Just POST your input: the 402 counts the units it needs (${unitBasisSentence(listing.unitBasis, listing.unitName)}) and names the total. ?units=N still works as a floor.`
              : `${formatUsdc(listing.price)} per ${listing.unitName}; pass ?units=N on the POST, the 402 states the total for N units (default 1).`,
          }
        : {}),
      pay_to: seller.walletAddress,
      seller: seller.handle,
      input_schema: listing.inputSchema ?? null,
      output_schema: listing.outputSchema ?? null,
      example_input: listing.exampleInput ?? null,
      turnaround_seconds: listing.turnaroundSeconds,
      // ADR-80: how long the paid request may stay open; a client that gives up sooner is not charged and gets nothing
      answer_within_seconds: X402_ANSWER_WITHIN_SECONDS,
    })),
    generated_at: new Date().toISOString(),
  }
}

/** The field names a buyer must send, as the listing's own published schema names them (ADR-79). */
function requiredFields(listing: { inputSchema?: Record<string, unknown> | null }): string[] {
  const req = (listing.inputSchema as { required?: unknown } | null | undefined)?.required
  return Array.isArray(req) ? req.filter((k): k is string => typeof k === 'string').slice(0, 8) : []
}

/**
 * ADR-79: does this body satisfy the listing's own published contract? The x402 endpoint sells only listings
 * Agent Souk operates itself (x402_first_party_only), so the schema checked here is always one we maintain - no
 * third-party seller's tolerance is narrowed by this. The answer costs the buyer nothing: no job, no charge, and
 * the error carries the example body it should have sent.
 */
function assertOrderableInput(input: Record<string, unknown>, listing: { inputSchema?: Record<string, unknown> | null; exampleInput?: unknown }): void {
  const schema = listing.inputSchema
  if (!isSchemaObject(schema)) return
  const check = checkAgainstSchema(schema, input)
  if (check.result !== 'fail') return
  throw errors.validation(
    `input does not match this listing's input_schema: ${check.errors.slice(0, 3).join('; ')}.`,
    'input',
    `Nothing was charged and no job was created. The listing's input_schema and example_input are in GET ${config().PUBLIC_BASE_URL.replace(/\/$/, '')}/v1/x402 (and in the bazaar extension of the 402 you just read); send the example shape.`,
    { errors: check.errors, ...(listing.exampleInput ? { example_input: listing.exampleInput } : {}) },
  )
}

/**
 * ADR-80: the two refusals that happen before the handler runs - our own rate limit and the media-type gate of the
 * route validator - were counted nowhere, so "nobody tried to buy" could not be told apart from "somebody was turned
 * away at the door". Runs first, sees the final status whether the refusal was answered below it or thrown through it.
 */
const countRefusalsAtTheDoor: MiddlewareHandler<AppEnv> = async (c, next) => {
  let status: number | undefined
  try {
    await next()
    status = c.res.status
  } catch (e) {
    status = (e as { status?: unknown })?.status as number | undefined
    throw e
  } finally {
    if (status === 429) recordX402('rate_limited', c.req.header('user-agent'))
    else if (status === 415) recordX402('unsupported_media', c.req.header('user-agent'))
  }
}

export function x402Routes() {
  const r = new OpenAPIHono<AppEnv>()
  const base = () => config().PUBLIC_BASE_URL.replace(/\/$/, '')

  /**
   * Without this, a browser-based x402 client cannot buy anything here: its preflight for PAYMENT-SIGNATURE got a
   * 404 and the POST was never sent. `/.well-known/x402` was already open (discovery serves it with a wildcard),
   * so the discovery document was reachable and the thing it advertises was not - the worst of both. Everything
   * under /v1/x402 is public by design: no cookies, no credentials, the API key is irrelevant here.
   */
  const allowAnyOrigin = cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    // ADR-80: @x402/fetch, x402-fetch and x402-axios set Access-Control-Expose-Headers as a REQUEST header on the paid
    // call; not allowed here, the browser's preflight failed and the payment never left the page.
    allowHeaders: ['content-type', 'payment-signature', 'x-payment', 'access-control-expose-headers'],
    exposeHeaders: EXPOSED_HEADERS.split(','),
    maxAge: 86_400,
  })
  r.use('/v1/x402', allowAnyOrigin)
  r.use('/v1/x402/*', allowAnyOrigin)

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/x402',
      tags: ['payments', 'listings'],
      summary: 'Every service Agent Souk sells for a single x402 payment, with price and input schema (ADR-50)',
      description: 'No auth. One document an x402 client or a crawler can read to find what is buyable here without an account, and what to POST to each URL. Add ?env=test for the sandbox on Base Sepolia (the listing URLs it returns need no query: the id names the environment).',
      request: { query: z.object({ env: z.enum(['live', 'test']).optional() }) },
      responses: { 200: { description: 'What one x402 payment buys', content: { 'application/json': { schema: z.object({ object: z.literal('x402_index') }).passthrough().openapi('X402Index') } } }, ...errorResponses },
    }),
    async (c) => c.json(await x402Index(base(), c.req.valid('query').env ?? 'live'), 200),
  )

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/x402/{listing_id}',
      tags: ['payments', 'listings'],
      summary: 'Buy one job from a platform-operated listing with an x402 payment, without an account (ADR-48)',
      description:
        'Send the listing input as JSON. Without a payment header the answer is 402 with the x402 v2 PaymentRequired object base64 in the PAYMENT-REQUIRED response header (the same terms are in the body in v1 form): sign the EIP-3009 authorization it describes and retry with PAYMENT-SIGNATURE set to the base64 payment payload (X-PAYMENT is accepted for v1 clients). The work is done FIRST and the authorization is submitted to a public facilitator only once the delivery exists, so a seller that fails costs you nothing. Paying registers an agent bound to your wallet, so you get the same receipts and public record as any other buyer; the wallet is the identity, there is no signup. Only listings operated by Agent Souk itself can be bought this way - for anyone else\'s listing the platform never touches the payment (ADR-22), so order it normally with POST /v1/jobs.',
      middleware: [countRefusalsAtTheDoor, rateLimit({ name: 'x402', limit: 30, windowSec: 3600 })],
      request: {
        params: z.object({ listing_id: z.string() }),
        query: z.object({ env: z.enum(['live', 'test']).optional(), units: z.coerce.number().int().min(1).optional() }),
        body: { content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } }, description: 'The listing input.' },
      },
      responses: {
        200: { description: 'Paid and delivered', content: { 'application/json': { schema: ResultView } } },
        402: { description: 'Payment required (x402 v2 requirements)', content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const requestedEnv = c.req.valid('query').env
      const { listing_id } = c.req.valid('param')
      const requestedUnits = c.req.valid('query').units
      const input = (c.req.valid('json') ?? {}) as Record<string, unknown>

      // ADR-65: the listing id names the environment (ids are unique across both), so the URL a catalogue holds
      // needs no query string; ?env= is still honoured and a mismatch is the same 404 as an unknown id.
      const listing = await db().query.listings.findFirst({ where: requestedEnv ? and(eq(listings.id, listing_id), eq(listings.env, requestedEnv)) : eq(listings.id, listing_id) })
      if (!listing || listing.status !== 'active') throw errors.notFound('Listing', listing_id, 'GET /v1/x402 lists what can be bought here (add ?env=test for the sandbox).')
      const env: Env = listing.env as Env
      const seller = await db().query.agents.findFirst({ where: eq(agents.id, listing.sellerAgentId) })
      // The legal boundary of this endpoint, as code (ADR-48): we may collect our own price, never someone else's.
      if (!seller?.firstParty) {
        recordX402('refused', c.req.header('user-agent'))
        throw errors.state(
          'x402_first_party_only',
          'This endpoint only sells listings operated by Agent Souk itself.',
          `Submitting a payment for another seller's receivable would make us an acquirer of payments for a payee, which we are not and do not want to be (ADR-22). Order this listing the ordinary way: POST ${base()}/v1/jobs, then pay the seller directly.`,
        )
      }
      if (listing.pricingModel === 'quote') throw errors.state('x402_needs_a_price', 'Quote-priced listings have no price to put in a 402.', 'Order it the ordinary way with POST /v1/jobs and ask for a quote.')
      // Refused immediately rather than after a 90-second wait: an upfront listing does not deliver until it has
      // been paid, and this endpoint does not pay until it has been delivered. The two cannot both go first.
      if (listing.payment === 'upfront') {
        throw errors.state(
          'x402_upfront_not_supported',
          'This listing is paid upfront, and this endpoint pays only after the work exists.',
          `Order it the ordinary way: POST ${base()}/v1/jobs, then pay when the seller accepts. GET ${base()}/v1/x402 lists what can be bought here in one call.`,
        )
      }
      // ADR-79: an input this endpoint already knows the seller will refuse must not be answered with a price.
      // Until now the body was first validated inside createJob - AFTER the 402, after the buyer had signed an
      // authorization and sent it. Three wallets paid that way for nothing on 17./19./20.09. ("input is missing
      // required field(s): token"), and a sandbox agent working through the catalogue lost four more orders to
      // the same wall ("unknown field(s): chain", "situation must be a string of at least 40 characters") - all
      // of it already written in the published input_schema. An empty body still gets its 402: that is how
      // catalogue crawlers ask for terms, and losing them would cost more than this fixes.
      // ADR-80: with a payment attached the same check runs inside the try below, so the refused attempt is on the
      // failure record (ADR-74 promised that for every signed attempt; this check used to throw before the record).
      const header = c.req.header('payment-signature') ?? c.req.header('x-payment')
      if (!header && Object.keys(input).length > 0) {
        try {
          assertOrderableInput(input, listing)
        } catch (e) {
          recordX402('rejected_input', c.req.header('user-agent'), Date.now(), env)
          throw e
        }
      }

      // ADR-77: how many units this input costs, from the rule the seller publishes on the listing - not the
      // flat 1 this endpoint assumed until now. `?units=` still works and is a floor, never a discount: a
      // client that asks for fewer units than its own input needs used to be quoted the cheap price, pay it,
      // and then be declined by the seller ("order 2 units for 1316 characters"), which is what happened to
      // every purchase the only paying stranger made on 2026-09-17. The 402 is a quote the buyer signs or
      // walks away from, so naming the true total here takes nothing from anyone.
      const needed = listing.pricingModel === 'per_unit' ? unitsForInput(listing.unitBasis, input) : null
      // `exact` sellers decline an over-ordered job as firmly as an under-ordered one (exploit-chain, ADR-75),
      // so for them the rule is the whole answer; otherwise it is a floor under what the buyer asked for.
      const units = needed == null ? (requestedUnits ?? 1) : listing.unitBasis?.mode === 'exact' ? needed : Math.max(requestedUnits ?? 1, needed)
      /** true when the published rule, not the buyer's parameter, decided how many units this costs */
      const unitsFromRule = needed != null && units !== (requestedUnits ?? 1)
      const price = (listing.price ?? 0) * (listing.pricingModel === 'per_unit' ? units : 1)
      if (price <= 0) throw errors.state('x402_needs_a_price', 'This listing is free; there is nothing to pay.', 'Order it the ordinary way with POST /v1/jobs.')
      const payTo = seller.walletAddress
      if (!payTo) throw errors.state('seller_has_no_wallet_address', 'The seller has no wallet address, so it cannot be paid.')

      const resourceUrl = `${base()}/v1/x402/${listing.id}`
      // the 402 names what the amount buys: for a per-unit listing the unit and how many of it (ADR-61); the
      // resource block also names the service, its topics and an icon for the catalogues (ADR-65)
      const unitsNote = unitsFromRule ? ` - ${units} because ${unitBasisSentence(listing.unitBasis, listing.unitName)?.replace(/;.*$/, '') ?? 'your input needs them'}` : ''
      const terms = paymentTerms({ env, amount: price, payTo, resourceUrl, service: serviceMetadata(base(), listing.tags), description: listing.pricingModel === 'per_unit' ? `${listing.title} (${units} × ${listing.unitName ?? 'unit'} at ${formatUsdc(listing.price ?? 0)} each${unitsNote})` : listing.title })
      // ADR-50: v2 clients send the signed authorization in PAYMENT-SIGNATURE, v1 clients in X-PAYMENT. The
      // payload inside is the same shape, so one reader serves both generations (read above, before the input check).
      if (!header) {
        recordX402('terms', c.req.header('user-agent'))
        // ADR-80: the one reading of this counter that says anything about demand. An empty body is a catalogue
        // asking for terms, the listing's own example is a crawler or a monitor replaying it; a body of the caller's
        // own is somebody with work in hand asking what it costs.
        if (Object.keys(input).length > 0 && canonicalJson(input) !== canonicalJson(listing.exampleInput ?? null)) recordX402('terms_own_input', c.req.header('user-agent'), Date.now(), env)
        const error =
          `Pay ${formatUsdc(price)} and retry with the PAYMENT-SIGNATURE header (x402 v2; X-PAYMENT is accepted for v1). The work is done before the payment is submitted, so a failed delivery costs you nothing - and keep the paid request open: use a read timeout of at least ${X402_ANSWER_WITHIN_SECONDS} s. A client that hangs up first is not charged, and gets nothing.` +
          // ADR-77: a price that is higher than the listing's headline number has to say why in the same breath.
          (unitsFromRule ? ` This amount is for ${units} × ${listing.unitName ?? 'unit'}, counted from the input you sent (${unitBasisSentence(listing.unitBasis, listing.unitName)}). Sending a smaller input costs less; ordering fewer units than it needs would only be declined by the seller.` : '') +
          // ADR-79: a terms request with no body is how a catalogue asks, and it still gets its 402 - but a buyer
          // that reads this and then sends nothing pays for a refusal. Name the fields here, where it is free.
          (Object.keys(input).length === 0 ? ` Send the listing input in the body of the paid request${requiredFields(listing).length ? `: required field(s) ${requiredFields(listing).join(', ')}` : ''}; the input_schema and a ready example are in GET ${base()}/v1/x402.` : '')
        // The whole object goes in the PAYMENT-REQUIRED header, because that is where a v2 client looks; the body
        // carries the SAME terms in the v1 shape, because that is where the older generation looks. Emitting the
        // v2 object into the body alone - which is what this endpoint did until ADR-50 - is the one combination
        // neither reads: v2 clients only fall back to a body when it says x402Version 1, and v1 clients reject a
        // v2 requirement outright. See ADR-50 for the executed proof.
        c.header('PAYMENT-REQUIRED', encodePaymentRequiredHeader({ ...terms.x402, error, extensions: bazaarExtension(listing) }))
        c.header('Access-Control-Expose-Headers', EXPOSED_HEADERS)
        return c.json(paymentRequiredV1(terms, error), 402)
      }

      // From here on a wallet is trying to pay. Whatever stops it - a refused authorization, an input the platform
      // or the seller will not take, a seller that does not deliver, a bug of ours - is recorded with its reason
      // and raised, then answered as before. The buyer's answer never waits for the record.
      let payer: string | null = null
      let jobId: string | null = null
      let transaction: string | null = null
      const ua = c.req.header('user-agent')
      /**
       * ADR-80: true once the buyer's connection closed before its answer was written. Two witnesses: the request's
       * abort signal (node-server aborts it on a premature close; any middleware that rebuilds the request must pass it
       * on - tolerateNulls once did not) and the Node response itself, which no middleware can replace.
       */
      const outgoing = (c.env as { outgoing?: { destroyed?: boolean; writableFinished?: boolean } } | undefined)?.outgoing
      const hungUp = () => c.req.raw.signal?.aborted === true || (outgoing?.destroyed === true && outgoing.writableFinished !== true)
      try {
      assertOrderableInput(input, listing)
      const payment = parsePaymentHeader(header)
      const auth = payment.payload.authorization
      const requirements = terms.x402.accepts[0]!
      if (auth.to.toLowerCase() !== payTo.toLowerCase()) throw errors.validation(`authorization.to must be the seller wallet ${payTo}.`, 'X-PAYMENT', 'Sign the authorization for the payTo address the 402 names.')
      // ADR-80: exactly the price. The reference facilitator refuses any other value, so a larger authorization used
      // to pass every check here, buy the work, and fail at the facilitator afterwards - and a facilitator that did
      // accept it would have moved the whole signed value for a job priced lower.
      if (BigInt(auth.value) !== BigInt(price)) {
        throw errors.validation(
          `authorization.value must be exactly ${price} (${formatUsdc(price)}) for this input${listing.pricingModel === 'per_unit' ? ` (${units} × ${listing.unitName ?? 'unit'})` : ''}; it is ${auth.value}.`,
          'X-PAYMENT',
          'Request terms with the exact body you will send, and sign the amount that 402 names. Nothing was charged and no job was created.',
        )
      }
      if (Number(auth.validBefore) * 1000 <= Date.now()) throw errors.validation('The authorization has already expired; request fresh terms.', 'X-PAYMENT', 'Request fresh terms and sign a new authorization. Nothing was charged.')
      // The signature is checked HERE, before an account is looked up, created or touched (ADR-58) - not ninety
      // seconds later by the facilitator, after a seller has worked and (since 0.5.7) after a key rotation.
      if (!(await verifyDigestSignature(env, auth.from, transferAuthorizationDigest(env, auth), payment.payload.signature))) {
        throw errors.validation('payload.signature was not made by authorization.from over these terms.', 'PAYMENT-SIGNATURE', 'Sign the EIP-712 TransferWithAuthorization the 402 describes (USDC domain of this network) with the wallet named in authorization.from; a smart-contract wallet must answer EIP-1271 isValidSignature for the digest.')
      }
      // Only now is the wallet known to be the one asking; before this line a failure record named whatever `from`
      // the payload claimed, so anyone could write failed attempts under any wallet's name (ADR-80 review).
      payer = auth.from
      assertNotSanctioned(auth.from, 'The paying wallet address')
      assertNotSanctioned(payTo, 'The seller wallet address')
      // ADR-66: the work runs before the authorization is submitted, so an authorization that cannot settle bought
      // model time on our account for free, every time, until the daily budget closed the paid services for everyone.
      // Before any work: it must be valid now and long enough for the work, unused on-chain, not already paying for a
      // purchase still running here, and covered by what the wallet holds minus what its running purchases will take.
      // Read fresh, not from the minute-long cache. A node that does not answer is not the buyer's fault: then those
      // two readings are skipped, as before.
      const nowMs = Date.now()
      const value = Number(auth.value)
      if (Number(auth.validAfter) * 1000 > nowMs) throw errors.validation('authorization.validAfter is in the future; the authorization must be valid when the work is done.', 'X-PAYMENT', 'Sign with validAfter at or before now.')
      if (Number(auth.validBefore) * 1000 < nowMs + X402_MIN_VALIDITY_MS) {
        throw errors.validation(`authorization.validBefore must be at least ${X402_MIN_VALIDITY_MS / 1000} seconds ahead: the work is done before the authorization is submitted (the 402 allows ${requirements.maxTimeoutSeconds}).`, 'X-PAYMENT', `Sign with validBefore at least ${requirements.maxTimeoutSeconds} seconds ahead, as the 402 says.`)
      }
      const payerKey = `${env}:${auth.from.toLowerCase()}`
      const authKey = `${payerKey}:${auth.nonce.toLowerCase()}`
      if (x402AuthorizationsRunning.has(authKey)) {
        const use = await authorizationUse(env, auth.from, auth.nonce)
        throw errors.state(
          'x402_authorization_in_use',
          `This authorization is already paying for a purchase that is still running${use ? ` (job ${use.job_id})` : ''}.`,
          `If you are still holding that first request, its answer carries the result. If you gave up on it, it is not charged; send this same authorization again once it has ended, with a read timeout of at least ${X402_ANSWER_WITHIN_SECONDS} s. Do not sign a new one for the same order: it would pay a second time.`,
        )
      }
      // ADR-80 review: claimed BEFORE the first await. Checked before the chain reads and set after them, two copies
      // of one authorization sent at once both got through, both bought the work, and only one could ever settle.
      x402AuthorizationsRunning.add(authKey)
      let reserved = false
      try {
        // ADR-80 review: what we know about this authorization is read BEFORE the chain. When the node lagged or failed,
        // a retry of an authorization that had already paid used to be treated as a new purchase: the work ran twice,
        // the facilitator refused, and the buyer heard "nothing was charged" - the very answer the change was for.
        const known = await authorizationUse(env, auth.from, auth.nonce)
        const knownPending = known ? await pendingBroadcastFor(known.job_id) : null
        if (known?.transaction) {
          throw new ApiError('state_error', 'x402_authorization_used', `This authorization has already paid for job ${known.job_id} (transaction ${known.transaction}). This request charged nothing more.`, {
            hint: `Do not sign a new authorization for the same order: it would pay a second time. The result belongs to the account of the paying wallet; read it with that account's key at GET ${base()}/v1/jobs/${known.job_id}. If the answer that carried the key never reached you, the key is issued again with this wallet's next purchase here.`,
            details: { job_id: known.job_id, transaction: known.transaction },
          })
        }
        if (knownPending) {
          throw new ApiError('state_error', 'x402_authorization_pending', `The settlement of this authorization for job ${known!.job_id} has an unknown outcome and is being resolved.`, {
            hint: SETTLE_UNKNOWN_HINT,
            details: { job_id: known!.job_id },
          })
        }
        const [held, used] = await Promise.all([usdcBalance(env, auth.from, nowMs, 0), authorizationUsed(env, auth.from, auth.nonce)])
        if (used) {
          // A use recorded here was answered above, before the chain was asked (ADR-80). Used on-chain without one:
          // it paid something that is not a purchase here.
          throw errors.state('x402_authorization_used', 'This authorization has already been used on-chain, and not for a purchase here.', 'This request charged nothing. Sign a new authorization with a fresh nonce.')
        }
        const committed = x402ValueRunning.get(payerKey) ?? 0
        if (held != null && held - committed < value) {
          throw errors.state(
            'x402_insufficient_funds',
            `${auth.from} holds ${formatUsdc(held)} on ${networkFor(env)}${committed ? `, ${formatUsdc(committed)} of it committed to purchases still running here` : ''}; this authorization moves ${formatUsdc(value)}.`,
            'Nothing was charged and no job was created. Fund the wallet with USDC on that network, or wait for the running purchases, and retry with a fresh authorization.',
          )
        }
        x402ValueRunning.set(payerKey, committed + value)
        reserved = true

        const { agent: buyer, credentials, created, recovered } = await buyerForWallet(auth.from)
        const job = await createJob(env, buyer, { listing_id: listing.id, input, units })
        jobId = job.id
        await saveAuthorizationUse(env, auth.from, auth.nonce, { job_id: job.id, listing_id: listing.id, at: new Date().toISOString() })
        // never wait past the point where the authorization could still be submitted
        const waitMs = Math.min(deliveryWaitMs, Number(auth.validBefore) * 1000 - Date.now() - X402_SETTLE_MARGIN_MS)
        let state = await waitForDelivery(job.id, waitMs)
        if (state === null) {
          // ADR-67: a job this endpoint stops waiting for is closed now, with no mark on either party. Left open, the
          // seller delivered it minutes later into a sealed delivery the wallet-only buyer could never pay, which then
          // expired as the BUYER's unpaid mark. A delivery landing in this very instant wins and is settled below.
          const closed = await abandonUnsettledPurchase(job.id, `platform: the x402 buyer stopped waiting after ${Math.round(waitMs / 1000)} seconds; its authorization was never submitted`)
          if (!closed) state = await waitForDelivery(job.id, 0)
        }
        if (state !== 'delivered') {
          // The seller's own words, if it gave any (ADR-61): a wallet-only buyer has no key to read the thread, and
          // this response is the only thing it sees. decline() keeps the reason in the job's event log.
          // decline() flips the status one statement before it logs the reason; the poller can land in between, so a
          // declined job without its row yet is read again, briefly.
          let declined = null
          for (let look = 0; state === 'gone' && look < 4 && !declined; look++) {
            // a seller that accepted and then could not do the work cancels; its reason is worth the same (ADR-64 audit)
            declined = (await db().query.jobEvents.findFirst({ where: and(eq(jobEvents.jobId, job.id), inArray(jobEvents.type, ['declined', 'cancelled'])), orderBy: [desc(jobEvents.id)] })) ?? null
            if (!declined) {
              const now = await db().query.jobs.findFirst({ where: eq(jobs.id, job.id), columns: { status: true } })
              if (now?.status !== 'declined' && now?.status !== 'cancelled') break
              await new Promise((r) => setTimeout(r, 250))
            }
          }
          const reason = typeof (declined?.data as { reason?: unknown } | null)?.reason === 'string' ? (declined!.data as { reason: string }).reason.trim().slice(0, 300) : ''
          throw errors.state(
            state === 'gone' ? 'x402_not_delivered' : 'x402_timeout',
            state === 'gone' ? `The seller did not deliver this job${declined ? ` and ${declined.type === 'cancelled' ? 'cancelled' : 'declined'} it${reason ? `: "${reason}"` : ''}` : ''}.` : `The seller had not delivered within ${Math.round(waitMs / 1000)} seconds.`,
            state === 'gone'
              ? `Nothing was charged: your authorization was never submitted, and it expires on its own. The job is ${job.id}.`
              : `Nothing was charged: your authorization was never submitted, and it expires on its own. The job (${job.id}) was closed with no mark on either side; order again with a fresh authorization.`,
          )
        }

        // ADR-80: a buyer that has hung up is not charged. The Python x402 client gives up after httpx's default 5 s
        // while the work here takes 9-47 s; until 0.5.25 the endpoint settled anyway and the buyer paid for an answer
        // it never received. The work is lost to us, which is the right side for that loss to fall on.
        if (hungUp()) {
          await abandonUnsettledPurchase(job.id, 'platform: the x402 buyer closed its connection before the payment was submitted; its authorization was never used', ['delivered'])
          recordX402('client_gone', ua, Date.now(), env)
          throw errors.state('x402_client_gone', 'The buyer closed its connection before the payment was submitted.', `Nothing was charged: your authorization was never submitted. The work runs before the payment, so use a read timeout of at least ${X402_ANSWER_WITHIN_SECONDS} s, then send the same authorization again (it is unused) or a fresh one.`)
        }

        try {
          transaction = await settleAtFacilitator(env, requirements, terms.x402.resource, payment, bazaarExtension(listing), ua)
        } catch (e) {
          if (e instanceof ApiError && e.code === 'x402_settle_unknown') {
            // Whether it broadcast is unknown: the sealed delivery stays, and the sweep asks the chain once the
            // authorization's window has closed (reconcileX402Broadcasts).
            await savePendingBroadcast({ env, job_id: job.id, buyer_agent_id: buyer.id, transaction: null, amount: price, payer: auth.from, nonce: auth.nonce, valid_before: Number(auth.validBefore), listing_id: listing.id, at: new Date().toISOString(), attempts: 0 })
            // the sealed delivery must still be there when the chain has answered: in the sandbox a job expires unpaid
            // after 15 minutes, which is as long as the authorization's own window (ADR-80 review)
            const keepUntil = Number(auth.validBefore) * 1000 + 30 * 60_000
            await db().update(jobs).set({ paymentDeadlineAt: keepUntil, updatedAt: Date.now() }).where(and(eq(jobs.id, job.id), eq(jobs.status, 'delivered'), sql`${jobs.paymentDeadlineAt} < ${keepUntil}`))
          } else {
            // Refused, so never broadcast: this delivery can never be paid for. Closed now with no mark on either side
            // instead of expiring 72 h later as the buyer's unpaid mark (ADR-80 review).
            await abandonUnsettledPurchase(job.id, `platform: the facilitator refused the buyer's authorization (${e instanceof ApiError ? e.code : 'error'}); nothing was charged`, ['delivered']).catch((err) => log.warn({ err, job: job.id }, 'x402: could not close a job whose settle was refused'))
          }
          throw e
        }
        // The money has moved. From this line the transaction is written down before anything else can fail.
        await savePendingBroadcast({ env, job_id: job.id, buyer_agent_id: buyer.id, transaction, amount: price, payer: auth.from, nonce: auth.nonce, valid_before: Number(auth.validBefore), listing_id: listing.id, at: new Date().toISOString(), attempts: 0 })
        await saveAuthorizationUse(env, auth.from, auth.nonce, { job_id: job.id, listing_id: listing.id, at: new Date().toISOString(), transaction })
        let output: unknown
        let recorded = true
        try {
          const paid = await payUntilMined(env, buyer, job.id, transaction)
          // tidying must not turn a paid and recorded purchase into an error (ADR-80 review); the sweep drops it too
          await dropPendingBroadcast(job.id).catch((err) => log.warn({ err, job: job.id }, 'x402: could not drop the pending broadcast'))
          output = paid.job.output
          // The buyer is holding the result in this very response, so leaving the job open for a review window it
          // will never come back for would only make the seller wait. Accepting closes it and writes both records.
          await acceptDelivery(env, buyer, job.id).catch((err) => log.warn({ err, job: job.id }, 'x402: could not close the job after payment'))
        } catch (e) {
          const code = e instanceof ApiError ? e.code : 'internal'
          if (!RETRYABLE.has(code)) {
            throw new ApiError('payment_error', 'x402_payment_not_recorded', `Your payment was broadcast (transaction ${transaction}) but could not be recorded on job ${job.id}: ${e instanceof Error ? e.message : String(e)}`, {
              status: 502,
              hint: 'Do not pay again. The transfer and the job are on the operator record; if the platform cannot record the payment on the job, it is recorded as owed back to you.',
              details: { transaction, job_id: job.id, network: terms.network },
            })
          }
          // The facilitator reported the transfer and only our chain reader is behind or down: the buyer gets the work
          // it paid for now, and the sweep records the transfer once the node sees it (ADR-80).
          recorded = false
          log.warn({ err: e, job: job.id, transaction }, 'x402: delivered on the facilitator answer; the sweep records the transfer')
          output = (await db().query.jobs.findFirst({ where: eq(jobs.id, job.id), columns: { output: true } }))?.output
        }
        recordX402('paid', ua)
        // ADR-49: this is the event the operator cannot usefully read about later. A failure to alert must never
        // cost the buyer the answer it has already paid for, so it is best-effort and never in the way.
        await raiseX402Purchase({ env, jobId: job.id, listingTitle: listing.title, amount: price, payer: auth.from, transaction, firstBuy: created }).catch((err) => log.warn({ err, job: job.id }, 'x402: operator alert failed'))
        // The marker that makes "shown once" true: written only for a response that carries the credentials AND can
        // still reach the buyer. A buyer that hung up after the payment gets its keys again with its next purchase.
        if (credentials && !hungUp()) await saveX402Account(buyer.id, { ...((await x402Account(buyer.id)) ?? { created_at: new Date().toISOString(), shown_at: null }), shown_at: new Date().toISOString(), job_id: job.id }).catch((err) => log.warn({ err, job: job.id }, 'x402: could not mark the credentials as shown'))
        return c.json(
          {
            object: 'x402_result' as const,
            job_id: job.id,
            listing_id: listing.id,
            output,
            paid: { amount: price, display: formatUsdc(price), transaction, network: terms.network, payer: auth.from, pay_to: payTo },
            ...(recorded ? {} : { payment_recorded: false, payment_note: 'The facilitator reported this transfer; the platform records it on the job as soon as its chain reader sees the block. Nothing more is due from you.' }),
            receipt_url: `${base()}/v1/jobs/${job.id}/receipt`,
            account: recovered
              ? { note: `This wallet's account (${buyer.handle}) existed from an earlier purchase whose answer never reached you, so its keys had never reached you either. They have been replaced and are shown here once: keep them and you own the record of this purchase, its signed receipt, and everything you buy here from now on.`, ...credentials }
              : credentials
              ? { note: 'Paying created an account bound to your wallet (ADR-48). These credentials are shown once and never again: keep them and you own the record of this purchase, its signed receipt, and everything you buy here from now on. Lose them and the account still exists, but nothing proves it is yours.', ...credentials }
              : { note: `This wallet already has an account here (${buyer.handle}); its credentials were shown when it was created and are never shown again. Use the key you were given to fetch receipt_url.`, agent_id: buyer.id, handle: buyer.handle },
          },
          200,
          {
            // v2 names it PAYMENT-RESPONSE, v1 named it X-PAYMENT-RESPONSE; both carry the same base64 receipt.
            'PAYMENT-RESPONSE': Buffer.from(JSON.stringify({ success: true, transaction, network: terms.network })).toString('base64'),
            'X-PAYMENT-RESPONSE': Buffer.from(JSON.stringify({ success: true, transaction, network: terms.network })).toString('base64'),
            'Access-Control-Expose-Headers': EXPOSED_HEADERS,
          },
        )
      } finally {
        if (reserved) {
          const left = (x402ValueRunning.get(payerKey) ?? value) - value
          if (left > 0) x402ValueRunning.set(payerKey, left)
          else x402ValueRunning.delete(payerKey)
        }
        x402AuthorizationsRunning.delete(authKey)
      }
      } catch (e) {
        recordX402('refused', ua)
        const known = e instanceof ApiError
        await noteX402Failure({
          at: new Date().toISOString(),
          env,
          listing_id: listing.id,
          listing_title: listing.title,
          payer,
          job_id: jobId,
          transaction,
          code: known ? e.code : 'internal',
          status: known ? e.status : 500,
          message: (e instanceof Error ? e.message : String(e)).slice(0, 500),
          ua: ua?.slice(0, 200) ?? null,
        }).catch((err) => log.warn({ err, listing: listing.id }, 'x402: could not record the failed purchase'))
        throw e
      }
    },
  )

  return r
}
