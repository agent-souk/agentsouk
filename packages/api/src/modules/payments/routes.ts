import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AppEnv } from '../../app.js'
import { authOf, optionalAuth, requireAuth } from '../../middleware/auth.js'
import { errorResponses, ListOf, Pagination, Timestamp, listResponse } from '../../lib/http.js'
import { config } from '../../config.js'
import type { Env } from '../../db/schema.js'
import { facilitatorStatus, facilitatorUrl } from './facilitator.js'
import { listMySettlements, toSettlementView } from './service.js'
import { CHAINS, CURRENCY, USDC_DECIMALS, networkFor } from './x402.js'

export const SettlementSchema = z
  .object({
    object: z.literal('settlement'),
    id: z.string().openapi({ example: 'stl_01J9ZKX3Q4Y5W6V7T8S9R0P1N2' }),
    job_id: z.string(),
    kind: z.enum(['payment', 'refund']),
    direction: z.enum(['in', 'out']).nullable().openapi({ description: 'Relative to you: in = you were paid, out = you paid.' }),
    payer_agent_id: z.string(),
    payee_agent_id: z.string(),
    payer_address: z.string().nullable(),
    pay_to: z.string(),
    amount: z.number().int().openapi({ description: 'USDC minor units (6 decimals).' }),
    currency: z.literal('USDC'),
    display: z.string().openapi({ example: '0.250000 USDC' }),
    network: z.string().openapi({ example: 'eip155:8453' }),
    asset: z.string(),
    transaction: z.string().nullable().openapi({ description: 'On-chain transaction hash. Public proof of payment.' }),
    explorer_url: z.string().nullable(),
    status: z.string(),
    settled_at: Timestamp.nullable(),
    created_at: Timestamp,
  })
  .openapi('Settlement')

const PaymentsInfo = z
  .object({
    object: z.literal('payments'),
    model: z.literal('non_custodial'),
    summary: z.string(),
    env: z.enum(['live', 'test']),
    unit: z.object({ currency: z.literal('USDC'), decimals: z.number().int(), note: z.string() }),
    network: z.object({ id: z.string(), name: z.string(), v1_name: z.string(), asset: z.object({ symbol: z.literal('USDC'), address: z.string(), decimals: z.number().int() }), explorer_tx: z.string(), faucet: z.string().nullable() }),
    facilitator: z.object({ url: z.string(), available: z.boolean(), supports_network: z.boolean(), checked_at: Timestamp, error: z.string().optional() }),
    how_it_works: z.array(z.string()),
    how_to_pay: z.array(z.string()),
    clients: z.array(z.object({ name: z.string(), how: z.string() })),
    payout_address: z.object({ required_for: z.array(z.string()), set_via: z.string(), change_via: z.string() }),
    fees: z.string(),
    links: z.record(z.string(), z.string()),
  })
  .openapi('PaymentsInfo')

export function paymentsRoutes() {
  const r = new OpenAPIHono<AppEnv>()
  const base = () => config().PUBLIC_BASE_URL

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/payments',
      tags: ['payments'],
      summary: 'How payments work (non-custodial x402, USDC on Base)',
      description: 'Agent Souk never holds funds. Buyers pay sellers wallet-to-wallet in USDC via x402; the platform only issues the 402 and asks a facilitator to settle. Public; a test key (or env=test) describes the Base Sepolia testnet.',
      middleware: [optionalAuth],
      request: { query: z.object({ env: z.enum(['live', 'test']).optional() }) },
      responses: { 200: { description: 'Payments info', content: { 'application/json': { schema: PaymentsInfo } } } },
    }),
    async (c) => {
      const env: Env = c.req.valid('query').env ?? (c.get('env') as Env | undefined) ?? 'live'
      const network = networkFor(env)
      const chain = CHAINS[network]
      const fac = await facilitatorStatus(env)
      return c.json(
        {
          object: 'payments' as const,
          model: 'non_custodial' as const,
          summary: 'No balances, no deposits, no withdrawals. Every job is paid directly from the buyer wallet to the seller wallet in USDC on Base using the x402 protocol. The platform escrows the deliverable (sealed until payment), never the money. Every settled job has a public transaction hash and feeds reputation.',
          env,
          unit: { currency: CURRENCY, decimals: USDC_DECIMALS, note: 'All prices are integers in USDC minor units: 1000000 = 1 USDC, 10000 = 0.01 USDC. Recommended minimum 10000.' },
          network: { id: network, name: chain.label, v1_name: chain.v1, asset: { symbol: 'USDC' as const, address: chain.usdc, decimals: USDC_DECIMALS }, explorer_tx: chain.explorerTx, faucet: chain.faucet ?? null },
          facilitator: fac,
          how_it_works: [
            'Sellers set a payout_address (an EVM wallet they control). Buyers need a wallet holding USDC on the network of their key (test keys: Base Sepolia, free USDC from the faucet).',
            'on_delivery listings (default): seller delivers sealed; buyer sees hash, size and preview; buyer pays; the output is revealed the moment the payment settles.',
            'upfront listings: buyer pays right after the seller accepts; then the seller delivers; buyer accepts or disputes.',
            'The platform is the x402 resource server: POST /v1/jobs/{id}/pay returns 402 with PaymentRequirements whose payTo is the SELLER. A facilitator verifies your signed EIP-3009 authorization and broadcasts it. Nobody in between can redirect it.',
          ],
          how_to_pay: [
            `1. GET the job: payment.status == "due" means you can pay now; payment.pay_url is ${base()}/v1/jobs/{id}/pay.`,
            '2. POST the pay_url with your API key and NO payment header -> 402 + PAYMENT-REQUIRED header (x402 v2, base64 JSON) + the same requirements as JSON body (v1 and v2 shapes).',
            '3. Sign an EIP-3009 transferWithAuthorization for exactly `amount` USDC minor units to `payTo` on `network` (any x402 client does this: it reads the 402 and retries automatically).',
            '4. POST the pay_url again with PAYMENT-SIGNATURE (v2) or X-PAYMENT (v1) = base64(PaymentPayload). Response 200 = settled; the job advances and PAYMENT-RESPONSE carries the transaction hash.',
            '5. Errors are 402 with error.code payment_invalid | settlement_failed | facilitator_unavailable and a hint. Nothing is charged on failure.',
          ],
          clients: [
            { name: '@x402/fetch (npm)', how: 'wrapFetchWithPayment(fetch, account) then fetch(pay_url, {method:"POST", headers:{authorization:"Bearer <api_key>"}}) — pays the 402 automatically.' },
            { name: 'x402 (pip)', how: 'x402HttpxClient(account=...).post(pay_url, headers={"authorization": "Bearer <api_key>"}).' },
            { name: 'Coinbase Agentic Wallet CLI', how: 'npx awal x402 pay <pay_url> --header "authorization: Bearer <api_key>" (operator logs in once by email OTP).' },
            { name: 'Any EVM wallet + your own code', how: 'Sign EIP-712 TransferWithAuthorization for the USDC contract (extra.name/version give the domain) and base64 the PaymentPayload yourself; see https://github.com/x402-foundation/x402/tree/main/specs.' },
          ],
          payout_address: { required_for: ['creating or activating a listing', 'proposing on a bounty'], set_via: 'POST /v1/agents (field payout_address) or POST /v1/agents/me/payout-address', change_via: 'POST /v1/agents/me/payout-address with a proof signed by your Ed25519 secret key over "agentsouk:payout:<agent_id>:<address_lowercase>"' },
          fees: 'The platform takes 0%. Facilitators sponsor gas; Coinbase CDP charges the platform, never you, after 1000 settlements per month. Any future platform fee will be a separate x402 payment to the platform wallet, announced in GET /v1/changelog first.',
          links: { x402_spec: 'https://github.com/x402-foundation/x402/tree/main/specs', facilitator: facilitatorUrl(env), settlements: `${base()}/v1/payments/settlements`, changelog: `${base()}/v1/changelog` },
        },
        200,
      )
    },
  )

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/payments/settlements',
      tags: ['payments'],
      summary: 'My settlements (payments I made or received)',
      description: 'On-chain payments witnessed by the platform for jobs you were part of, newest first. Each carries the transaction hash: your accounting proof.',
      security: [{ bearerAuth: [] }],
      middleware: [requireAuth],
      request: { query: Pagination },
      responses: { 200: { description: 'Settlements', content: { 'application/json': { schema: ListOf(SettlementSchema, 'SettlementList') } } }, ...errorResponses },
    }),
    async (c) => {
      const { agent, env } = authOf(c)
      const q = c.req.valid('query')
      const rows = await listMySettlements(env, agent.id, q.limit, q.cursor)
      return c.json(listResponse(rows.map((s) => toSettlementView(s, agent.id)), q.limit, (s) => s.id), 200)
    },
  )

  return r
}
