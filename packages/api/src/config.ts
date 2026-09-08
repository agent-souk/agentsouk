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
  /** IndexNow key (Bing, Yandex, Naver, Seznam): served at /<key>.txt so search engines can verify URL submissions. */
  INDEXNOW_KEY: z.string().regex(/^[A-Za-z0-9-]{8,128}$/).optional(),
  /** Overrides the Glama connector claim token served at /.well-known/glama.json (default in discovery/wellknown.ts). */
  GLAMA_CLAIM: z.string().regex(/^glama_claim_[A-Za-z0-9_-]{32}$/).optional(),
  /**
   * ERC-8004 (ADR-28): the platform's own agentId on the Identity Registry (Base for live, Base Sepolia for test),
   * minted from the operator wallet with /.well-known/agent-registration.json as agentURI; listed in that file.
   */
  ERC8004_PLATFORM_AGENT_ID_LIVE: z.string().regex(/^\d{1,78}$/).optional(),
  ERC8004_PLATFORM_AGENT_ID_TEST: z.string().regex(/^\d{1,78}$/).optional(),
  /**
   * Sandbox faucet (ADR-30): the platform desk (packages/agents, POST /faucet) sends testnet USDC to sandbox agents;
   * FAUCET_URL is that endpoint, FAUCET_SECRET the shared secret (also set on the desk). Unset = no faucet (503).
   */
  FAUCET_URL: z.string().url().optional(),
  FAUCET_SECRET: z.string().min(16).optional(),
  /** USDC minor units per claim (default 1 USDC) and claims per UTC day across all agents. */
  FAUCET_AMOUNT_MINOR: z.coerce.number().int().min(1).default(1_000_000),
  FAUCET_DAILY_GLOBAL: z.coerce.number().int().min(1).default(100),
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
  /**
   * Dispute panels (ADR-25): how many evaluators are drawn per dispute and how long they have to vote. A verdict
   * needs a majority of the seats actually filled; missed deadlines redraw once, then the case escalates to the operator.
   */
  DISPUTE_PANEL_SIZE: z.coerce.number().int().min(1).max(9).default(3),
  DISPUTE_VERDICT_WINDOW_SECONDS_LIVE: z.coerce.number().int().positive().default(24 * 3600),
  DISPUTE_VERDICT_WINDOW_SECONDS_TEST: z.coerce.number().int().positive().default(10 * 60),
  /**
   * Public health page of the operator's own agents (bounty desk, first-buy desk, faucet). GET /v1/commitments
   * (ADR-32) points there so an agent can read the desk's live caps, spend and wallet instead of trusting prose.
   * Empty string = not published.
   */
  DESK_HEALTH_URL: z.string().default('https://agentsouk-agents.fly.dev/health'),
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
