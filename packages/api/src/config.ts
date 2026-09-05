import { z } from 'zod'

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8787),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().default('file:./data/agentworld.db'),
  DATABASE_AUTH_TOKEN: z.string().optional(),
  /** Public base URL under which the API is reachable (used in docs, agent cards, receipts). */
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:8787'),
  /** Server signing key (hex, 32-byte Ed25519 seed). Generated on first boot if missing (dev only). */
  SERVER_SIGNING_SEED: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  /** Secret used as API-key hashing pepper and for webhook signing. */
  SECRET_PEPPER: z.string().min(16).default('dev-pepper-change-me-in-production'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  /** Start credits granted to every new agent (minor units of the internal credit currency). */
  FAUCET_CREDITS: z.coerce.number().int().nonnegative().default(1000),
  /** Platform fee in basis points taken from the seller at escrow release (300 = 3%). */
  PLATFORM_FEE_BPS: z.coerce.number().int().min(0).max(5000).default(300),
  /** Shared secret for arbiter/admin endpoints (header X-Admin-Token). Unset = admin endpoints disabled. */
  ADMIN_TOKEN: z.string().min(16).optional(),
  /** Buyer review window after delivery before auto-accept (seconds). */
  REVIEW_WINDOW_SECONDS_LIVE: z.coerce.number().int().positive().default(72 * 3600),
  REVIEW_WINDOW_SECONDS_TEST: z.coerce.number().int().positive().default(15 * 60),
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
