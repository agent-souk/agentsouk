import { z } from 'zod'

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8787),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().default('file:./data/agentsouk.db'),
  DATABASE_AUTH_TOKEN: z.string().optional(),
  /** Public base URL under which the API is reachable (used in docs, agent cards, receipts, x402 resource URLs). */
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:8787'),
  /** Server signing key (hex, 32-byte Ed25519 seed). Generated on first boot if missing (dev only). */
  SERVER_SIGNING_SEED: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  /** Secret used as API-key hashing pepper and for webhook signing. */
  SECRET_PEPPER: z.string().min(16).default('dev-pepper-change-me-in-production'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  /** Shared secret for arbiter/admin endpoints (header X-Admin-Token). Unset = admin endpoints disabled. */
  ADMIN_TOKEN: z.string().min(16).optional(),
  /** Trust X-Forwarded-For / X-Real-IP (only when behind a reverse proxy you control). */
  TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /**
   * x402 facilitators (ADR-21). The platform never holds funds: a facilitator verifies the buyer's signed USDC
   * authorization (payTo = seller) and broadcasts it. Live keys pay on Base (eip155:8453), test keys on Base
   * Sepolia (eip155:84532). Both defaults need no API key; Coinbase CDP works with CDP_API_KEY_ID/SECRET.
   */
  X402_FACILITATOR_URL_LIVE: z.string().url().default('https://facilitator.payai.network'),
  X402_FACILITATOR_URL_TEST: z.string().url().default('https://x402.org/facilitator'),
  CDP_API_KEY_ID: z.string().optional(),
  CDP_API_KEY_SECRET: z.string().optional(),
  /** Buyer review window after an (unsealed) delivery before auto-accept (seconds). Also the payment window for sealed deliveries. */
  REVIEW_WINDOW_SECONDS_LIVE: z.coerce.number().int().positive().default(72 * 3600),
  REVIEW_WINDOW_SECONDS_TEST: z.coerce.number().int().positive().default(15 * 60),
  /** How long a buyer has to pay an upfront job after the seller accepted (seconds). */
  PAYMENT_WINDOW_SECONDS_LIVE: z.coerce.number().int().positive().default(72 * 3600),
  PAYMENT_WINDOW_SECONDS_TEST: z.coerce.number().int().positive().default(15 * 60),
})

export type Config = z.infer<typeof Env>

let cached: Config | undefined
export function config(): Config {
  if (!cached) cached = Env.parse(process.env)
  return cached
}
/** Test helper: override config. */
export function _setConfigForTests(patch: Partial<Config>) {
  cached = { ...config(), ...patch }
}
