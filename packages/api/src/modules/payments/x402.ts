import type { Env } from '../../db/schema.js'

/**
 * Payment constants and the x402-shaped "payment required" description (ADR-21/22).
 *
 * The platform is NOT an x402 resource server any more: it never receives a signed authorization and never
 * calls a facilitator. It only tells the buyer what to pay (amount, USDC contract, seller wallet, network) and
 * verifies the resulting on-chain transaction. The x402 v2 `PaymentRequired` shape is still emitted inside the
 * JSON body so x402-aware tooling can build a payload and settle it THROUGH A PUBLIC FACILITATOR ITSELF.
 */

export const NETWORKS = { live: 'eip155:8453', test: 'eip155:84532' } as const
export type X402Network = (typeof NETWORKS)[Env]

export type ChainInfo = {
  label: string
  chainId: number
  /** x402 v1 network name */
  v1: string
  usdc: string
  /** EIP-712 domain of the USDC contract (for self-signed EIP-3009 authorizations) */
  name: string
  version: string
  explorerTx: string
  faucet?: string
  /** a public facilitator that broadcasts x402 authorizations for this network. Info only; we never call it. */
  facilitator: string
}

export const CHAINS: Record<X402Network, ChainInfo> = {
  'eip155:8453': { label: 'Base', chainId: 8453, v1: 'base', usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', name: 'USD Coin', version: '2', explorerTx: 'https://basescan.org/tx/', facilitator: 'https://facilitator.payai.network' },
  'eip155:84532': { label: 'Base Sepolia (testnet)', chainId: 84532, v1: 'base-sepolia', usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', name: 'USDC', version: '2', explorerTx: 'https://sepolia.basescan.org/tx/', faucet: 'https://faucet.circle.com', facilitator: 'https://x402.org/facilitator' },
}

/** keccak256("Transfer(address,address,uint256)") */
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

export const USDC_DECIMALS = 6
export const CURRENCY = 'USDC'

export function networkFor(env: Env): X402Network {
  return NETWORKS[env]
}

export function chainFor(env: Env): ChainInfo {
  return CHAINS[networkFor(env)]
}

/** 250000 -> "0.250000 USDC" */
export function formatUsdc(minor: number | null | undefined): string {
  if (minor == null) return 'quote'
  const neg = minor < 0
  const abs = Math.abs(minor)
  const whole = Math.floor(abs / 10 ** USDC_DECIMALS)
  const frac = String(abs % 10 ** USDC_DECIMALS).padStart(USDC_DECIMALS, '0')
  return `${neg ? '-' : ''}${whole}.${frac} ${CURRENCY}`
}

export type RequirementsV2 = {
  scheme: 'exact'
  network: X402Network
  amount: string
  asset: string
  payTo: string
  maxTimeoutSeconds: number
  extra: { name: string; version: string }
}
export type PaymentRequiredV2 = {
  x402Version: 2
  error?: string
  resource: { url: string; description: string; mimeType: string }
  accepts: RequirementsV2[]
}

export type PaymentTerms = {
  network: X402Network
  chainId: number
  amount: number
  asset: string
  payTo: string
  facilitator: string
  x402: PaymentRequiredV2
}

/** Everything a buyer needs to pay a job on its own. payTo is ALWAYS the seller's wallet. */
export function paymentTerms(input: { env: Env; amount: number; payTo: string; resourceUrl: string; description: string; maxTimeoutSeconds?: number }): PaymentTerms {
  const network = networkFor(input.env)
  const chain = CHAINS[network]
  const x402: PaymentRequiredV2 = {
    x402Version: 2,
    resource: { url: input.resourceUrl, description: input.description, mimeType: 'application/json' },
    accepts: [{ scheme: 'exact', network, amount: String(input.amount), asset: chain.usdc, payTo: input.payTo, maxTimeoutSeconds: input.maxTimeoutSeconds ?? 900, extra: { name: chain.name, version: chain.version } }],
  }
  return { network, chainId: chain.chainId, amount: input.amount, asset: chain.usdc, payTo: input.payTo, facilitator: chain.facilitator, x402 }
}

/** Detects an x402 payment header. We do not settle it (ADR-22); the caller answers with self-settlement guidance. */
export function paymentHeaderPresent(get: (name: string) => string | undefined): 'payment-signature' | 'x-payment' | undefined {
  if (get('payment-signature')) return 'payment-signature'
  if (get('x-payment')) return 'x-payment'
  return undefined
}

export function explorerTxUrl(network: string, tx: string | null | undefined): string | null {
  if (!tx) return null
  const chain = (CHAINS as Record<string, { explorerTx: string }>)[network]
  return chain ? `${chain.explorerTx}${tx}` : null
}
