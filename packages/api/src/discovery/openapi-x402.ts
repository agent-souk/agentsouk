import { config } from '../config.js'
import { CHAINS, formatUsdc, networkFor } from '../modules/payments/x402.js'
import { sellableListings } from '../modules/x402/routes.js'
import { ownershipProofs } from './ownership.js'

/**
 * ADR-62: /openapi.json as the x402 indexes read it.
 *
 * x402scan and the @agentcash/discovery library behind it read /openapi.json BEFORE /.well-known/x402 and treat every
 * operation as a candidate. On 2026-09-13 their audit of this origin found 105 routes, no paid one, and 105 "auth mode
 * missing": nothing said which operations cost money, our key scheme is `http bearer` (the library only recognises
 * `apiKey`), public operations carried no `security` at all, and the one payable operation was the template
 * POST /v1/x402/{listing_id}, which a prober cannot call. The index would have registered nothing.
 *
 * So the document the API serves is the generated one plus four things the generator cannot know:
 *  - each operation says how it is reached: `security: []` public, bearer OR the X-API-Key header (declared as an
 *    `apiKey` scheme, which is what it is), the admin token for /v1/admin;
 *  - the template is replaced by one concrete POST per listing that GET /v1/x402 sells, each with `x-payment-info`
 *    (price in USD units, protocol x402 on Base, payTo) and the listing's own input schema, so a probe reaches the 402
 *    and an agent knows what to send;
 *  - info.contact names a way to reach the operator (e-mail only when one is configured: it is published);
 *  - x-discovery.ownershipProofs carries the signature that ties this origin to the wallet the listings are paid into.
 * With nothing sellable (a fresh database, the test suite) the template stays as it is.
 */

type Json = Record<string, any>
type Sellable = Awaited<ReturnType<typeof sellableListings>>

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const
export const X402_TEMPLATE_PATH = '/v1/x402/{listing_id}'

/** Minor units to the decimal string the price hint wants ("0.01", not "0.010000" or 10000). */
export const usdAmount = (minor: number) => (minor / 1e6).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')

export function enrichOpenApi(doc: Json, ctx: { base: string; sellable: Sellable; contactEmail?: string; ownershipProofs: string[] }): Json {
  const out = structuredClone(doc) as Json
  out.info = { ...out.info, contact: { name: 'Agent Souk', url: `${ctx.base}/v1/support/reports`, ...(ctx.contactEmail ? { email: ctx.contactEmail } : {}) } }
  if (ctx.ownershipProofs.length) out['x-discovery'] = { ...(out['x-discovery'] ?? {}), ownershipProofs: ctx.ownershipProofs }
  out.components = out.components ?? {}
  out.components.securitySchemes = {
    ...(out.components.securitySchemes ?? {}),
    apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key', description: 'The same API key as bearerAuth, sent in the X-API-Key header instead of Authorization.' },
    adminToken: { type: 'apiKey', in: 'header', name: 'X-Admin-Token', description: 'Operator only. Unset on a deployment = these endpoints answer 404.' },
  }
  const paths = (out.paths ?? {}) as Json
  for (const [path, item] of Object.entries(paths)) {
    for (const m of METHODS) {
      const op = (item as Json)[m] as Json | undefined
      if (!op) continue
      if (path.startsWith('/v1/admin/')) op.security = [{ adminToken: [] }]
      else if (Array.isArray(op.security) && op.security.some((r: Json) => r && 'bearerAuth' in r)) op.security = [{ bearerAuth: [] }, { apiKey: [] }]
      else if (op.security === undefined) op.security = []
    }
  }
  const template = paths[X402_TEMPLATE_PATH]?.post as Json | undefined
  if (template && ctx.sellable.length) {
    delete paths[X402_TEMPLATE_PATH]
    const chain = CHAINS[networkFor('live')]
    for (const { listing, seller } of ctx.sellable) {
      const price = listing.price ?? 0
      const perUnit = listing.pricingModel === 'per_unit'
      paths[`/v1/x402/${listing.id}`] = {
        post: {
          operationId: `x402_${listing.id}`,
          tags: template.tags,
          summary: `${listing.title} (x402, ${formatUsdc(price)}${perUnit ? ` per ${listing.unitName ?? 'unit'}` : ''})`,
          description: `${listing.description}\n\nBought with one x402 payment and no account: POST the input as JSON, read the 402 (PAYMENT-REQUIRED header, x402 v2), sign the EIP-3009 authorization, retry with PAYMENT-SIGNATURE. The work is done before the payment is submitted, so a failed delivery costs nothing.${perUnit ? ` Priced per ${listing.unitName ?? 'unit'}: add ?units=N, the 402 states the total (default 1).` : ''} Seller: ${seller.handle}, operated by Agent Souk. Every service sold this way: GET /v1/x402.`,
          security: [],
          ...(perUnit ? { parameters: [{ name: 'units', in: 'query', required: false, schema: { type: 'integer', minimum: 1, default: 1 }, description: `Number of ${listing.unitName ?? 'units'}.` }] } : {}),
          requestBody: {
            required: true,
            content: { 'application/json': { schema: listing.inputSchema ?? { type: 'object' }, ...(listing.exampleInput != null ? { example: listing.exampleInput } : {}) } },
          },
          responses: template.responses,
          'x-payment-info': {
            price: { mode: 'fixed', currency: 'USD', amount: usdAmount(price) },
            protocols: [{ x402: { network: networkFor('live'), asset: chain.usdc, payTo: seller.walletAddress } }],
          },
        },
      }
    }
  }
  return out
}

/** The served document: generated, then enriched with what GET /v1/x402 sells on live right now. */
export async function openApiDocument(generated: Json): Promise<Json> {
  const c = config()
  const sellable = await sellableListings('live').catch(() => [] as Sellable)
  return enrichOpenApi(generated, { base: c.PUBLIC_BASE_URL.replace(/\/$/, ''), sellable, contactEmail: c.OPERATOR_CONTACT_EMAIL, ownershipProofs: ownershipProofs() })
}
