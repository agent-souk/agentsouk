import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { cors } from 'hono/cors'
import { and, asc, eq, gt, isNotNull, ne, sql } from 'drizzle-orm'
import type { AppEnv } from '../../app.js'
import { db } from '../../db/client.js'
import { agents, jobs, listings, type Env } from '../../db/schema.js'
import { config } from '../../config.js'
import { ApiError, errors } from '../../lib/errors.js'
import { errorResponses } from '../../lib/http.js'
import { log } from '../../lib/log.js'
import { recordX402 } from '../../discovery/hits.js'
import { raiseX402Purchase } from '../../ops/alerts.js'
import { bazaarExtension } from './bazaar.js'
import { rateLimit } from '../../middleware/ratelimit.js'
import { createAgent, recoverKeys } from '../agents/service.js'
import { getMemory, putMemory } from '../memory/service.js'
import { normalizeEvmAddress } from '../payments/address.js'
import { acceptDelivery, createJob, payJob } from '../jobs/service.js'
import { assertNotSanctioned } from '../payments/sanctions.js'
import { CHAINS, encodePaymentRequiredHeader, formatUsdc, networkFor, paymentRequiredV1, paymentTerms, type RequirementsV2 } from '../payments/x402.js'

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
  return p
}

/**
 * The wallet is the identity (ADR-48): a buyer that pays through this endpoint gets a real agent record, so it has
 * receipts, a public counterparty history and every other right a registered agent has - without a registration
 * step it never asked for. The wallet is bound without the usual EIP-191 proof because the authorization in hand
 * IS a signature by that wallet; the proof exists, it just has a different shape.
 */
type BuyerAccount = { agent: Parameters<typeof createJob>[1]; credentials: Record<string, unknown> | null }

const X402_ACCOUNT_DESCRIPTION = 'Registered by paying through the x402 endpoint (ADR-48); the wallet is the identity.'
/** Memory key written on the account the moment a response actually carried its credentials. */
const CREDENTIALS_SHOWN_KEY = 'x402/credentials_shown'

async function credentialsShown(agentId: string): Promise<boolean> {
  return getMemory(agentId, CREDENTIALS_SHOWN_KEY).then(() => true, () => false)
}

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
    // once". Its keys are replaced and handed over now, and the marker is written only when a response carries
    // them (ADR-57). Any other existing account keeps its secret: proving control of the wallet again is not
    // proof that this caller is the one that created it.
    if (known.description === X402_ACCOUNT_DESCRIPTION && !(await credentialsShown(known.id))) {
      const keys = await recoverKeys(known, true)
      return { agent: known, credentials: { agent_id: known.id, handle: known.handle, api_keys: keys, keypair: null, keypair_note: 'The Ed25519 keypair was generated when this account was created by an earlier, failed purchase and cannot be recovered; rotate it with POST /v1/agents/me/key if you need one.' } }
    }
    return { agent: known, credentials: null }
  }
  const created = await createAgent({ name: `x402 buyer ${address.slice(0, 6)}${address.slice(-4)}`, description: X402_ACCOUNT_DESCRIPTION })
  await db().update(agents).set({ walletAddress: address, updatedAt: Date.now() }).where(eq(agents.id, created.agent.id))
  const agent = (await db().query.agents.findFirst({ where: eq(agents.id, created.agent.id) }))!
  return { agent, credentials: { agent_id: agent.id, handle: agent.handle, api_keys: created.apiKeys, keypair: created.keypair ?? null } }
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

type SettleFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>
let settleFetch: SettleFetch = (url, init) => fetch(url, init) as unknown as ReturnType<SettleFetch>
/** Tests only: replace the call to the public facilitator. */
export function _setSettleFetchForTests(f: SettleFetch | null) {
  settleFetch = f ?? ((url, init) => fetch(url, init) as unknown as ReturnType<SettleFetch>)
}

async function settleAtFacilitator(env: Env, requirements: RequirementsV2, resource: { url: string; description: string; mimeType: string }, payment: PaymentPayload): Promise<string> {
  const chain = CHAINS[networkFor(env)]
  const url = `${chain.facilitator.replace(/\/$/, '')}/settle`
  const body = JSON.stringify({
    x402Version: 2,
    paymentPayload: { x402Version: 2, resource, accepted: requirements, payload: payment.payload },
    paymentRequirements: requirements,
  })
  const res = await settleFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
  const text = await res.text()
  let parsed: { success?: boolean; transaction?: string; errorReason?: string } = {}
  try {
    parsed = JSON.parse(text) as typeof parsed
  } catch {
    /* fall through to the error below */
  }
  if (!res.ok || !parsed.success || !parsed.transaction) {
    log.warn({ status: res.status, reason: parsed.errorReason, body: text.slice(0, 300) }, 'x402 settle refused')
    throw errors.state('x402_settle_failed', `The facilitator did not broadcast the payment: ${parsed.errorReason ?? `HTTP ${res.status}`}.`, 'Nothing was charged. Check the wallet holds enough USDC and that the authorization has not expired, then request fresh terms and try again.')
  }
  return parsed.transaction
}

/**
 * The facilitator has broadcast the transfer, but a block still has to arrive before the platform's own on-chain
 * check will accept it. That wait belongs here: the buyer is holding an open HTTP request and has already paid,
 * and asking it to retry a purchase it cannot repeat (the nonce is spent) would be the wrong answer.
 */
async function payUntilMined(env: Env, buyer: Parameters<typeof createJob>[1], jobId: string, transaction: string, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs
  for (;;) {
    try {
      return await payJob(env, buyer, jobId, transaction)
    } catch (err) {
      const pending = err instanceof ApiError && (err.code === 'transaction_pending' || err.code === 'transaction_not_found')
      if (!pending || Date.now() >= until) throw err
      await new Promise((r) => setTimeout(r, 2500))
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
  return {
    object: 'x402_index' as const,
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
      url: `${base}/v1/x402/${listing.id}${env === 'test' ? '?env=test' : ''}`,
      title: listing.title,
      description: listing.description,
      tags: listing.tags,
      price: listing.price,
      price_display: formatUsdc(listing.price),
      pricing_model: listing.pricingModel,
      pay_to: seller.walletAddress,
      seller: seller.handle,
      input_schema: listing.inputSchema ?? null,
      output_schema: listing.outputSchema ?? null,
      example_input: listing.exampleInput ?? null,
      turnaround_seconds: listing.turnaroundSeconds,
    })),
    generated_at: new Date().toISOString(),
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
    allowHeaders: ['content-type', 'payment-signature', 'x-payment'],
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
      description: 'No auth. One document an x402 client or a crawler can read to find what is buyable here without an account, and what to POST to each URL. Add ?env=test for the sandbox on Base Sepolia.',
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
      middleware: [rateLimit({ name: 'x402', limit: 30, windowSec: 3600 })],
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
      const env: Env = c.req.valid('query').env ?? 'live'
      const { listing_id } = c.req.valid('param')
      const units = c.req.valid('query').units ?? 1
      const input = (c.req.valid('json') ?? {}) as Record<string, unknown>

      const listing = await db().query.listings.findFirst({ where: and(eq(listings.id, listing_id), eq(listings.env, env)) })
      if (!listing || listing.status !== 'active') throw errors.notFound('Listing', listing_id, 'GET /v1/listings lists what is active.')
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
      const price = (listing.price ?? 0) * (listing.pricingModel === 'per_unit' ? units : 1)
      if (price <= 0) throw errors.state('x402_needs_a_price', 'This listing is free; there is nothing to pay.', 'Order it the ordinary way with POST /v1/jobs.')
      const payTo = seller.walletAddress
      if (!payTo) throw errors.state('seller_has_no_wallet_address', 'The seller has no wallet address, so it cannot be paid.')

      const resourceUrl = `${base()}/v1/x402/${listing.id}${env === 'test' ? '?env=test' : ''}`
      const terms = paymentTerms({ env, amount: price, payTo, resourceUrl, description: listing.title })
      // ADR-50: v2 clients send the signed authorization in PAYMENT-SIGNATURE, v1 clients in X-PAYMENT. The
      // payload inside is the same shape, so one reader serves both generations.
      const header = c.req.header('payment-signature') ?? c.req.header('x-payment')
      if (!header) {
        recordX402('terms', c.req.header('user-agent'))
        const error = `Pay ${formatUsdc(price)} and retry with the PAYMENT-SIGNATURE header (x402 v2; X-PAYMENT is accepted for v1). The work is done before the payment is submitted, so a failed delivery costs you nothing.`
        // The whole object goes in the PAYMENT-REQUIRED header, because that is where a v2 client looks; the body
        // carries the SAME terms in the v1 shape, because that is where the older generation looks. Emitting the
        // v2 object into the body alone - which is what this endpoint did until ADR-50 - is the one combination
        // neither reads: v2 clients only fall back to a body when it says x402Version 1, and v1 clients reject a
        // v2 requirement outright. See ADR-50 for the executed proof.
        c.header('PAYMENT-REQUIRED', encodePaymentRequiredHeader({ ...terms.x402, error, extensions: bazaarExtension(listing) }))
        c.header('Access-Control-Expose-Headers', EXPOSED_HEADERS)
        return c.json(paymentRequiredV1(terms, error), 402)
      }

      const payment = parsePaymentHeader(header)
      const auth = payment.payload.authorization
      const requirements = terms.x402.accepts[0]!
      if (auth.to.toLowerCase() !== payTo.toLowerCase()) throw errors.validation(`authorization.to must be the seller wallet ${payTo}.`, 'X-PAYMENT')
      if (Number(auth.value) < price) throw errors.validation(`authorization.value must be at least ${price} (${formatUsdc(price)}).`, 'X-PAYMENT')
      if (Number(auth.validBefore) * 1000 <= Date.now()) throw errors.validation('The authorization has already expired; request fresh terms.', 'X-PAYMENT')
      assertNotSanctioned(auth.from, 'The paying wallet address')
      assertNotSanctioned(payTo, 'The seller wallet address')

      const { agent: buyer, credentials } = await buyerForWallet(auth.from)
      const job = await createJob(env, buyer, { listing_id: listing.id, input, units })
      const state = await waitForDelivery(job.id, 90_000)
      if (state !== 'delivered') {
        throw errors.state(
          state === 'gone' ? 'x402_not_delivered' : 'x402_timeout',
          state === 'gone' ? 'The seller did not deliver this job.' : 'The seller had not delivered within 90 seconds.',
          `Nothing was charged: your authorization was never submitted, and it expires on its own. The job is ${job.id}; if a delivery arrives later you can still pay it the ordinary way (GET ${base()}/v1/jobs/${job.id}).`,
        )
      }

      const transaction = await settleAtFacilitator(env, requirements, terms.x402.resource, payment)
      const paid = await payUntilMined(env, buyer, job.id, transaction)
      // The buyer is holding the result in this very response, so leaving the job open for a review window it will
      // never come back for would only make the seller wait. Accepting closes it and writes both public records.
      await acceptDelivery(env, buyer, job.id).catch((err) => log.warn({ err, job: job.id }, 'x402: could not close the job after payment'))
      recordX402('paid', c.req.header('user-agent'))
      // ADR-49: this is the event the operator cannot usefully read about later. A failure to alert must never
      // cost the buyer the answer it has already paid for, so it is best-effort and never in the way.
      await raiseX402Purchase({ env, jobId: job.id, listingTitle: listing.title, amount: price, payer: auth.from, transaction, firstBuy: credentials != null }).catch((err) => log.warn({ err, job: job.id }, 'x402: operator alert failed'))
      // The marker that makes "shown once" true: written only on the response that actually carries the credentials.
      if (credentials) await putMemory(buyer.id, CREDENTIALS_SHOWN_KEY, { at: new Date().toISOString(), job_id: job.id }).catch((err) => log.warn({ err, job: job.id }, 'x402: could not mark the credentials as shown'))
      return c.json(
        {
          object: 'x402_result' as const,
          job_id: job.id,
          listing_id: listing.id,
          output: paid.job.output,
          paid: { amount: price, display: formatUsdc(price), transaction, network: terms.network, payer: auth.from, pay_to: payTo },
          receipt_url: `${base()}/v1/jobs/${job.id}/receipt`,
          account: credentials
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
    },
  )

  return r
}
