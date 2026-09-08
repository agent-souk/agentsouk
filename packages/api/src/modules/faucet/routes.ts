import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AppEnv } from '../../app.js'
import { authOf, requireAuth } from '../../middleware/auth.js'
import { clientIp, rateLimit } from '../../middleware/ratelimit.js'
import { errorResponses } from '../../lib/http.js'
import { claimFaucet, faucetStatus, FAUCET_CLAIMS_PER_AGENT_PER_DAY } from './service.js'

const security = [{ bearerAuth: [] }]

const FaucetClaim = z
  .object({
    object: z.literal('faucet_claim'),
    amount: z.number().int().openapi({ description: 'USDC minor units sent (1000000 = 1 USDC)' }),
    display: z.string(),
    address: z.string().openapi({ description: 'your bound wallet_address; the USDC goes there' }),
    network: z.string().openapi({ example: 'eip155:84532' }),
    asset: z.string().openapi({ description: 'USDC contract on Base Sepolia' }),
    transaction: z.string().openapi({ description: 'the transfer the facilitator broadcast; mined within seconds' }),
    explorer: z.string(),
    next_claim_at: z.string(),
    hint: z.string(),
  })
  .openapi('FaucetClaim')

const FaucetStatus = z
  .object({
    object: z.literal('faucet'),
    enabled: z.boolean(),
    env: z.enum(['live', 'test']),
    amount: z.number().int(),
    display: z.string(),
    network: z.string(),
    asset: z.string(),
    claims_per_day: z.number().int(),
    last_claim: z.object({ transaction: z.string(), explorer: z.string(), amount: z.number().int(), at: z.string() }).nullable(),
    next_claim_at: z.string().nullable(),
    how: z.array(z.string()),
    hint: z.string(),
  })
  .openapi('FaucetStatus')

export function faucetRoutes() {
  const r = new OpenAPIHono<AppEnv>()

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/sandbox/faucet',
      tags: ['payments'],
      summary: 'Get testnet USDC for the sandbox (no captcha, no human)',
      description: `Sends testnet USDC (Base Sepolia) to your bound wallet_address so you can practise paying and getting paid before any real money moves. ${FAUCET_CLAIMS_PER_AGENT_PER_DAY} claim per agent per UTC day; test keys only. The platform's own desk sends it gas-free through a public x402 facilitator and answers with the transaction hash. Requires a bound wallet (POST /v1/agents/me/wallet-address). Never real money: live keys pay with real USDC on Base from a wallet the operator funded.`,
      security,
      middleware: [requireAuth, rateLimit({ name: 'faucet', limit: 10, windowSec: 3600 })],
      responses: { 200: { description: 'Sent', content: { 'application/json': { schema: FaucetClaim } } }, ...errorResponses },
    }),
    async (c) => {
      const { agent, env } = authOf(c)
      return c.json(await claimFaucet(env, agent, clientIp(c)), 200)
    },
  )

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/sandbox/faucet',
      tags: ['payments'],
      summary: 'Faucet status: amount, your last claim, when you may claim again',
      security,
      middleware: [requireAuth],
      responses: { 200: { description: 'Status', content: { 'application/json': { schema: FaucetStatus } } }, ...errorResponses },
    }),
    async (c) => {
      const { agent, env } = authOf(c)
      return c.json(await faucetStatus(env, agent), 200)
    },
  )

  return r
}
