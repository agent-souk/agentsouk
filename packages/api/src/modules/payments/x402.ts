import type { Env } from '../../db/schema.js'
import { ApiError } from '../../lib/errors.js'

/**
 * x402 wire format (ADR-21). We speak v2 natively (headers PAYMENT-REQUIRED / PAYMENT-SIGNATURE /
 * PAYMENT-RESPONSE, CAIP-2 network ids, `amount`) and still accept v1 clients (X-PAYMENT, network "base",
 * `maxAmountRequired`). The platform is only the resource server: `payTo` is always the SELLER's wallet.
 */

export const NETWORKS = { live: 'eip155:8453', test: 'eip155:84532' } as const
export type X402Network = (typeof NETWORKS)[Env]

export const CHAINS: Record<X402Network, { label: string; v1: string; usdc: string; name: string; version: string; explorerTx: string; faucet?: string }> = {
  'eip155:8453': { label: 'Base', v1: 'base', usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', name: 'USD Coin', version: '2', explorerTx: 'https://basescan.org/tx/' },
  'eip155:84532': { label: 'Base Sepolia (testnet)', v1: 'base-sepolia', usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', name: 'USDC', version: '2', explorerTx: 'https://sepolia.basescan.org/tx/', faucet: 'https://faucet.circle.com' },
}

export const USDC_DECIMALS = 6
export const CURRENCY = 'USDC'

export function networkFor(env: Env): X402Network {
  return NETWORKS[env]
}

/** "250000" -> "0.250000 USDC" */
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
export type RequirementsV1 = {
  scheme: 'exact'
  network: string
  maxAmountRequired: string
  resource: string
  description: string
  mimeType: string
  payTo: string
  maxTimeoutSeconds: number
  asset: string
  extra: { name: string; version: string }
}
export type PaymentRequiredV1 = { x402Version: 1; error?: string; accepts: RequirementsV1[] }

export type BuiltRequirements = { v2: PaymentRequiredV2; v1: PaymentRequiredV1; network: X402Network; amount: string; asset: string; payTo: string }

export function buildRequirements(input: { env: Env; amount: number; payTo: string; resourceUrl: string; description: string; maxTimeoutSeconds?: number; error?: string }): BuiltRequirements {
  const network = networkFor(input.env)
  const chain = CHAINS[network]
  const amount = String(input.amount)
  const timeout = input.maxTimeoutSeconds ?? 900
  const v2: PaymentRequiredV2 = {
    x402Version: 2,
    ...(input.error ? { error: input.error } : {}),
    resource: { url: input.resourceUrl, description: input.description, mimeType: 'application/json' },
    accepts: [{ scheme: 'exact', network, amount, asset: chain.usdc, payTo: input.payTo, maxTimeoutSeconds: timeout, extra: { name: chain.name, version: chain.version } }],
  }
  const v1: PaymentRequiredV1 = {
    x402Version: 1,
    ...(input.error ? { error: input.error } : {}),
    accepts: [{ scheme: 'exact', network: chain.v1, maxAmountRequired: amount, resource: input.resourceUrl, description: input.description, mimeType: 'application/json', payTo: input.payTo, maxTimeoutSeconds: timeout, asset: chain.usdc, extra: { name: chain.name, version: chain.version } }],
  }
  return { v2, v1, network, amount, asset: chain.usdc, payTo: input.payTo }
}

export const b64json = {
  encode(value: unknown): string {
    return Buffer.from(JSON.stringify(value), 'utf8').toString('base64')
  },
  decode<T = unknown>(raw: string): T {
    return JSON.parse(Buffer.from(raw.trim(), 'base64').toString('utf8')) as T
  },
}

export type PaymentPayload = {
  x402Version: number
  scheme?: string
  network?: string
  /** v2: the PaymentRequirements the client selected */
  accepted?: Partial<RequirementsV2>
  payload: unknown
  resource?: unknown
}

export type ReadPayment = { version: 1 | 2; payload: PaymentPayload; raw: string; header: 'payment-signature' | 'x-payment' }

/** Reads PAYMENT-SIGNATURE (v2) or X-PAYMENT (v1). Returns undefined when neither is present. */
export function readPaymentHeader(get: (name: string) => string | undefined): ReadPayment | undefined {
  const v2 = get('payment-signature')
  const v1 = get('x-payment')
  const raw = v2 ?? v1
  if (!raw) return undefined
  const header = v2 ? 'payment-signature' : 'x-payment'
  let payload: PaymentPayload
  try {
    payload = b64json.decode<PaymentPayload>(raw)
  } catch {
    throw new ApiError('payment_error', 'payment_header_malformed', `The ${header.toUpperCase()} header is not base64-encoded JSON.`, { hint: 'Send the x402 PaymentPayload as base64(JSON) in PAYMENT-SIGNATURE (v2) or X-PAYMENT (v1). Any x402 client library does this for you.' })
  }
  if (!payload || typeof payload !== 'object' || typeof payload.payload !== 'object') {
    throw new ApiError('payment_error', 'payment_header_malformed', `The ${header.toUpperCase()} header does not contain an x402 PaymentPayload.`, { hint: 'Expected {x402Version, accepted|scheme+network, payload:{signature, authorization}}.' })
  }
  const version = payload.x402Version === 1 ? 1 : payload.x402Version === 2 ? 2 : header === 'x-payment' ? 1 : 2
  return { version, payload, raw, header }
}

export function requirementsForVersion(built: BuiltRequirements, version: 1 | 2): RequirementsV1 | RequirementsV2 {
  return version === 1 ? built.v1.accepts[0]! : built.v2.accepts[0]!
}

/** Cheap consistency check before touching the facilitator: the client must be paying THIS job's terms. */
export function assertPayloadMatches(read: ReadPayment, built: BuiltRequirements): void {
  const p = read.payload
  const chain = CHAINS[built.network]
  const network = p.accepted?.network ?? p.network
  if (network && network !== built.network && network !== chain.v1) {
    throw new ApiError('payment_error', 'payment_invalid', `Payment is for network '${network}', this job settles on ${built.network} (${chain.label}).`, { hint: `Sign the authorization on ${built.network} (v1 name "${chain.v1}") and retry.` })
  }
  const acc = p.accepted
  if (acc) {
    if (acc.payTo && acc.payTo.toLowerCase() !== built.payTo.toLowerCase()) throw new ApiError('payment_error', 'payment_invalid', 'accepted.payTo does not match the seller address of this job.', { hint: 'Re-fetch the requirements (POST the pay URL without a payment header) and sign for the returned payTo.' })
    if (acc.amount && acc.amount !== built.amount) throw new ApiError('payment_error', 'payment_invalid', `accepted.amount is ${acc.amount}, the job requires exactly ${built.amount}.`, { hint: 'Sign an authorization for exactly the required amount.' })
    if (acc.asset && acc.asset.toLowerCase() !== built.asset.toLowerCase()) throw new ApiError('payment_error', 'payment_invalid', 'accepted.asset is not the USDC contract for this network.', { hint: `Use asset ${built.asset}.` })
  }
  const auth = (p.payload as { authorization?: { to?: string; value?: string } } | null)?.authorization
  if (auth?.to && auth.to.toLowerCase() !== built.payTo.toLowerCase()) throw new ApiError('payment_error', 'payment_invalid', 'authorization.to does not match the seller address of this job.', { hint: 'The signed transfer must go to payTo from the requirements.' })
  if (auth?.value && String(auth.value) !== built.amount) throw new ApiError('payment_error', 'payment_invalid', `authorization.value is ${auth.value}, the job requires exactly ${built.amount}.`, { hint: 'Sign for exactly the required amount (USDC minor units).' })
}

export type SettleResponse = { success: boolean; transaction?: string; network?: string; payer?: string; errorReason?: string }

export function settleResponseHeaders(r: SettleResponse): Record<string, string> {
  const v2 = b64json.encode({ success: r.success, transaction: r.transaction ?? '', network: r.network ?? null, payer: r.payer ?? null, ...(r.errorReason ? { errorReason: r.errorReason } : {}) })
  return { 'PAYMENT-RESPONSE': v2, 'X-PAYMENT-RESPONSE': v2 }
}

export function explorerTxUrl(network: string, tx: string | null | undefined): string | null {
  if (!tx) return null
  const chain = (CHAINS as Record<string, { explorerTx: string }>)[network]
  return chain ? `${chain.explorerTx}${tx}` : null
}
