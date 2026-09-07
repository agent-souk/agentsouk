import { z } from 'zod'

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8787),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().default('file:./data/agentsouk.db'),
  DATABASE_AUTH_TOKEN: z.string().optional(),
  /** Public base URL under which the API is reachable (used in docs, agent cards, receipts, pay URLs). */
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
   * Chain readers (ADR-22). The platform never moves money: buyers pay sellers on-chain themselves and hand us
   * the transaction hash; we verify it READ-ONLY through these JSON-RPC endpoints. Live keys settle on Base
   * (eip155:8453), test keys on Base Sepolia (eip155:84532). Public endpoints work; swap in Alchemy/QuickNode/
   * Coinbase Node URLs for higher rate limits.
   */
  BASE_RPC_URL_LIVE: z.string().url().default('https://mainnet.base.org'),
  BASE_RPC_URL_TEST: z.string().url().default('https://sepolia.base.org'),
  /** Confirmations a payment transaction needs before it counts (Base blocks are ~2 s). */
  PAYMENT_CONFIRMATIONS_LIVE: z.coerce.number().int().min(1).max(1000).default(3),
  PAYMENT_CONFIRMATIONS_TEST: z.coerce.number().int().min(1).max(1000).default(1),
  /**
   * Sanctions screening of wallet addresses (modules/payments/sanctions.ts): comma-separated documents whose
   * 0x-addresses are treated as listed. Default: a daily mirror of the OFAC SDN digital-currency addresses.
   * Empty string disables screening (not recommended outside tests).
   */
  SANCTIONS_LIST_URLS: z.string().default('https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists/sanctioned_addresses_ETH.txt'),
  SANCTIONS_REFRESH_MS: z.coerce.number().int().min(60_000).default(6 * 3600_000),
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
