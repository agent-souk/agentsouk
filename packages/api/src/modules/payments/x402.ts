import { keccak_256 } from '@noble/hashes/sha3.js'
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js'
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

/**
 * ADR-50: the v1 shape of the same terms, for the still widely installed first generation of clients.
 *
 * v1 and v2 differ in more than a version number: v1 names the price `maxAmountRequired`, names the network
 * `base` rather than `eip155:8453`, and carries `resource` (a URL string), `description` and `mimeType` INSIDE
 * each requirement instead of in one object beside them. `outputSchema` is omitted deliberately: the published
 * v1 example prints `null`, but the shipped zod schema is `.optional()` and rejects an explicit null.
 */
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

export function paymentRequiredV1(terms: PaymentTerms, error?: string): PaymentRequiredV1 {
  const chain = CHAINS[terms.network]
  const r = terms.x402.accepts[0]!
  return {
    x402Version: 1,
    ...(error ? { error } : {}),
    accepts: [
      {
        scheme: 'exact',
        network: chain.v1,
        maxAmountRequired: r.amount,
        resource: terms.x402.resource.url,
        description: terms.x402.resource.description,
        mimeType: terms.x402.resource.mimeType,
        payTo: r.payTo,
        maxTimeoutSeconds: r.maxTimeoutSeconds,
        asset: r.asset,
        extra: r.extra,
      },
    ],
  }
}

/**
 * The wire form of a v2 PaymentRequired: standard base64 of the JSON, carried in the PAYMENT-REQUIRED response
 * header. NOT base64url - the reference client validates the value against /^[A-Za-z0-9+/]*={0,2}$/.
 */
export function encodePaymentRequiredHeader(pr: PaymentRequiredV2 & { extensions?: Record<string, unknown> }): string {
  return Buffer.from(JSON.stringify(pr), 'utf8').toString('base64')
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

// --- gas-free payment (ADR-30): the buyer signs an EIP-3009 authorization and a public facilitator broadcasts it ---

/**
 * EIP-712 types of USDC's transferWithAuthorization (EIP-3009). The buyer signs a message of this shape with the
 * wallet it bound; the facilitator submits it on-chain and pays the gas. The platform only prepares the text to
 * sign: it never receives the signature and never talks to the facilitator (ADR-22).
 */
export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
  ],
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const

export type TransferAuthorizationTypedData = {
  types: typeof TRANSFER_WITH_AUTHORIZATION_TYPES
  primaryType: 'TransferWithAuthorization'
  domain: { name: string; version: string; chainId: number; verifyingContract: string }
  /** numbers (all fit in 53 bits) so viem, ethers, eth_account and eth_signTypedData_v4 all take them unchanged */
  message: { from: string; to: string; value: number; validAfter: number; validBefore: number; nonce: string }
}

export type X402SettleBody = {
  x402Version: 2
  paymentPayload: {
    x402Version: 2
    resource: PaymentRequiredV2['resource']
    accepted: RequirementsV2
    payload: { signature: string; authorization: { from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: string } }
  }
  paymentRequirements: RequirementsV2
}

export type GaslessPayment = {
  method: 'eip3009_transfer_with_authorization'
  summary: string
  /** what to sign (EIP-712, eth_signTypedData_v4) with the wallet in typed_data.message.from */
  typed_data: TransferAuthorizationTypedData
  /** the authorization expires here; fetch fresh terms after that */
  valid_before: string
  /** POST settle_body (with the signature filled in) here; a public x402 facilitator, not the platform */
  settle_url: string
  facilitator: string
  settle_body: X402SettleBody
  signature_placeholder: string
  steps: string[]
  sign_with: Record<string, string>
  fallback: string
}

export const SIGNATURE_PLACEHOLDER = '<0x hex: your EIP-712 signature over typed_data (65 bytes for an EOA; the longer ERC-1271 bytes for a smart wallet)>'

/** 32 random bytes as 0x hex: an EIP-3009 nonce for one-off authorizations. */
export function randomAuthorizationNonce(): string {
  const b = new Uint8Array(32)
  globalThis.crypto.getRandomValues(b)
  return '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

/**
 * The EIP-3009 nonce for a job payment: derived, not random. USDC accepts each (signer, nonce) pair once, so an
 * agent that fetches the terms again and re-signs after a lost answer produces an authorization the chain refuses
 * instead of a second transfer. `sequence` moves on when the amount changes (a partial payment was recorded).
 */
export function authorizationNonceFor(input: { jobId: string; payFrom: string; amount: number; sequence: number }): string {
  return '0x' + bytesToHex(keccak_256(new TextEncoder().encode(`agentsouk:eip3009:v1:${input.jobId}:${input.payFrom.toLowerCase()}:${input.amount}:${input.sequence}`)))
}

/**
 * Everything a buyer needs to pay gas-free: the EIP-712 typed data to sign, and the x402 v2 settle body to hand to
 * the public facilitator once the signature is in. `requirements` must be the same object the terms advertise
 * (the facilitator checks that `accepted` matches). Pure: the caller passes the clock and (in tests) the nonce.
 */
export function gaslessPayment(input: { env: Env; requirements: RequirementsV2; resource: PaymentRequiredV2['resource']; payFrom: string; now?: number; nonce?: string }): GaslessPayment {
  const chain = CHAINS[input.requirements.network]
  const now = input.now ?? Date.now()
  const validBefore = Math.floor(now / 1000) + input.requirements.maxTimeoutSeconds
  const nonce = input.nonce ?? randomAuthorizationNonce()
  if (!/^0x[0-9a-f]{64}$/i.test(nonce)) throw new Error('nonce must be 0x + 64 hex characters')
  const value = Number(input.requirements.amount)
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('amount must be a safe non-negative integer')
  const typed_data: TransferAuthorizationTypedData = {
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: 'TransferWithAuthorization',
    domain: { name: chain.name, version: chain.version, chainId: chain.chainId, verifyingContract: chain.usdc },
    message: { from: input.payFrom, to: input.requirements.payTo, value, validAfter: 0, validBefore, nonce },
  }
  const settle_url = `${chain.facilitator.replace(/\/$/, '')}/settle`
  const settle_body: X402SettleBody = {
    x402Version: 2,
    paymentPayload: {
      x402Version: 2,
      resource: input.resource,
      accepted: input.requirements,
      payload: { signature: SIGNATURE_PLACEHOLDER, authorization: { from: input.payFrom, to: input.requirements.payTo, value: String(value), validAfter: '0', validBefore: String(validBefore), nonce } },
    },
    paymentRequirements: input.requirements,
  }
  return {
    method: 'eip3009_transfer_with_authorization',
    summary: `Pay ${formatUsdc(value)} without holding any ETH: sign typed_data with ${input.payFrom} and POST settle_body to the public facilitator; it broadcasts the transfer and pays the gas. The platform never sees your signature.`,
    typed_data,
    valid_before: new Date(validBefore * 1000).toISOString(),
    settle_url,
    facilitator: chain.facilitator,
    settle_body,
    signature_placeholder: SIGNATURE_PLACEHOLDER,
    steps: [
      `1. Sign typed_data (EIP-712 / eth_signTypedData_v4) with the wallet ${input.payFrom}. Do not change any field. The nonce is derived from this job: USDC executes it once, so signing the terms again after a lost answer cannot pay twice. The authorization expires at ${new Date(validBefore * 1000).toISOString()}.`,
      `2. Put the 0x signature into settle_body.paymentPayload.payload.signature and POST settle_body as JSON to ${settle_url} (Content-Type: application/json, no auth). Answer {"success":true,"transaction":"0x..."} = broadcast, gas paid by the facilitator. {"success":false,"errorReason":...} with HTTP 4xx = nothing moved: read the reason (insufficient USDC, expired, bad signature) and fix or fall back; a reason saying the authorization was already used means an earlier attempt went through: find the USDC transfer from ${input.payFrom} to ${input.requirements.payTo} on the explorer and submit its hash. No answer or HTTP 5xx = fate unknown: re-POST the same body (it cannot pay twice) before signing anything new.`,
      `3. POST ${input.resource.url} with {"transaction":"<that hash>"}; the platform verifies it on-chain like any other transfer.`,
    ],
    sign_with: {
      viem: 'account.signTypedData(typed_data)  // or walletClient.signTypedData({ account, ...typed_data })',
      ethers: 'wallet.signTypedData(typed_data.domain, { TransferWithAuthorization: typed_data.types.TransferWithAuthorization }, typed_data.message)',
      'eth_account (python)': "Account.sign_typed_data(private_key, full_message=typed_data).signature.to_0x_hex()  (older hexbytes: '0x' + sig.signature.hex().removeprefix('0x'))",
      'MetaMask / any EIP-1193 wallet': "provider.request({ method: 'eth_signTypedData_v4', params: [typed_data.message.from, JSON.stringify(typed_data)] })",
      'agentsouk SDK': 'jobs.payGasless(job_id, signTypedData) (npm) / jobs.pay_gasless(job_id, sign_typed_data) (pip): signs, settles and submits the hash for you',
    },
    fallback: `The facilitator is a public third-party service; if it is down or declines, send ${formatUsdc(value)} from ${input.payFrom} to ${input.requirements.payTo} yourself (an ordinary USDC transfer; needs a little ETH on ${chain.label} for gas) and submit that hash instead.`,
  }
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

// --- verifying an authorization locally (ADR-58) -------------------------------------------------------------

/**
 * EIP-712 digest of a TransferWithAuthorization for the USDC contract of `env`: the bytes the wallet signed and
 * the token verifies on-chain. The x402 endpoint recovers the signer from it BEFORE it looks up, creates or
 * touches an account. Until 0.5.8 the only signature check was the facilitator's - ninety seconds of seller work
 * and, since 0.5.7, one key rotation later - so a forged `from` could squat an account for a stranger's wallet,
 * leave that stranger an unpaid job on its record, and revoke the keys of an account this endpoint had created.
 */
export function transferAuthorizationDigest(env: Env, auth: { from: string; to: string; value: string | number | bigint; validAfter: string | number | bigint; validBefore: string | number | bigint; nonce: string }): Uint8Array {
  const chain = CHAINS[networkFor(env)]
  const utf8 = (t: string) => new TextEncoder().encode(t)
  const word = (v: bigint) => hexToBytes(v.toString(16).padStart(64, '0'))
  const addressWord = (a: string) => hexToBytes(a.slice(2).toLowerCase().padStart(64, '0'))
  const typeHash = (name: keyof typeof TRANSFER_WITH_AUTHORIZATION_TYPES) => keccak_256(utf8(`${name}(${TRANSFER_WITH_AUTHORIZATION_TYPES[name].map((f) => `${f.type} ${f.name}`).join(',')})`))
  const domain = keccak_256(concatBytes(typeHash('EIP712Domain'), keccak_256(utf8(chain.name)), keccak_256(utf8(chain.version)), word(BigInt(chain.chainId)), addressWord(chain.usdc)))
  const struct = keccak_256(concatBytes(typeHash('TransferWithAuthorization'), addressWord(auth.from), addressWord(auth.to), word(BigInt(auth.value)), word(BigInt(auth.validAfter)), word(BigInt(auth.validBefore)), hexToBytes(auth.nonce.slice(2))))
  return keccak_256(concatBytes(Uint8Array.of(0x19, 0x01), domain, struct))
}
