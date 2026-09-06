import { config } from '../../config.js'
import type { Env } from '../../db/schema.js'
import { ApiError, errors } from '../../lib/errors.js'
import { log } from '../../lib/log.js'
import { sameAddress, toChecksumAddress } from './address.js'
import { CHAINS, TRANSFER_TOPIC, networkFor, type X402Network } from './x402.js'

/**
 * Read-only chain access (ADR-22). The platform verifies that a buyer's USDC transfer to the seller happened; it
 * never signs, broadcasts or relays anything. Three JSON-RPC reads per verification.
 */

export type RpcFetch = (url: string, body: string) => Promise<{ status: number; json: () => Promise<unknown> }>

const realFetch: RpcFetch = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body, signal: AbortSignal.timeout(15_000) })
let testFetch: RpcFetch | undefined
/** Test hook: route every RPC call through a fake node. */
export function _setRpcFetchForTests(f?: RpcFetch) {
  testFetch = f
}

export function rpcUrl(env: Env): string {
  return env === 'live' ? config().BASE_RPC_URL_LIVE : config().BASE_RPC_URL_TEST
}

export function confirmationsRequired(env: Env): number {
  return env === 'live' ? config().PAYMENT_CONFIRMATIONS_LIVE : config().PAYMENT_CONFIRMATIONS_TEST
}

function chainUnavailable(reason: unknown): ApiError {
  return new ApiError('payment_error', 'chain_unavailable', 'The chain reader is unavailable, so the transaction could not be verified.', {
    status: 502,
    hint: 'Nothing was lost: your on-chain payment stands. Retry this call with the same transaction hash in a minute.',
    details: { reason: reason instanceof Error ? reason.message : String(reason) },
  })
}

let rpcId = 0
export async function rpc<T = unknown>(env: Env, method: string, params: unknown[]): Promise<T> {
  const url = rpcUrl(env)
  const body = JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params })
  let res: Awaited<ReturnType<RpcFetch>>
  try {
    res = await (testFetch ?? realFetch)(url, body)
  } catch (e) {
    log.error({ err: e, url, method }, 'rpc unreachable')
    throw chainUnavailable(e)
  }
  if (res.status >= 400) {
    log.error({ status: res.status, url, method }, 'rpc http error')
    throw chainUnavailable(`HTTP ${res.status}`)
  }
  const json = (await res.json().catch(() => undefined)) as { result?: T; error?: { code?: number; message?: string } } | undefined
  if (!json || typeof json !== 'object') throw chainUnavailable('malformed rpc response')
  if (json.error) {
    log.error({ url, method, error: json.error }, 'rpc error')
    throw chainUnavailable(json.error.message ?? `rpc error ${json.error.code ?? ''}`)
  }
  return json.result as T
}

export type ReceiptLog = { address: string; topics: string[]; data: string; logIndex?: string }
export type Receipt = { status: string; blockNumber: string; transactionHash?: string; logs: ReceiptLog[] }

export type UsdcTransfer = { from: string; to: string; value: bigint }

export function isTxHash(v: unknown): v is string {
  return typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v)
}

/** All USDC Transfer logs in a receipt (addresses lowercased, value as bigint). */
export function decodeUsdcTransfers(receipt: Receipt, usdc: string): UsdcTransfer[] {
  const out: UsdcTransfer[] = []
  for (const l of receipt.logs ?? []) {
    if (!sameAddress(l.address, usdc)) continue
    if ((l.topics?.[0] ?? '').toLowerCase() !== TRANSFER_TOPIC || l.topics.length < 3) continue
    const from = '0x' + l.topics[1]!.slice(-40).toLowerCase()
    const to = '0x' + l.topics[2]!.slice(-40).toLowerCase()
    let value = 0n
    try {
      value = BigInt(l.data && l.data !== '0x' ? l.data : '0x0')
    } catch {
      continue
    }
    out.push({ from, to, value })
  }
  return out
}

export type TransferCheck = {
  /** expected sender wallet */
  from: string
  /** expected recipient wallet */
  to: string
  /** USDC minor units that must have arrived (sum of matching logs) */
  minAmount: number
  /** the transfer must have been mined at or after this epoch-ms (guards against reusing an older payment) */
  notBefore?: number
}

export type VerifiedTransfer = {
  transaction: string
  from: string
  to: string
  amount: number
  asset: string
  network: X402Network
  blockNumber: number
  blockTimestamp: number
  confirmations: number
}

export type InvalidReason = 'reverted' | 'wrong_asset' | 'wrong_recipient' | 'wrong_sender' | 'amount_too_low' | 'too_old'

function invalid(reason: InvalidReason, message: string, hint: string, details: Record<string, unknown> = {}): ApiError {
  return new ApiError('payment_error', 'payment_invalid', message, { hint, details: { reason, ...details } })
}

/**
 * Verifies an on-chain USDC transfer. Throws agent-friendly errors:
 * 409 transaction_not_found (retry), 409 transaction_pending (retry), 402 payment_invalid (details.reason), 502 chain_unavailable.
 */
export async function verifyUsdcTransfer(env: Env, txHash: unknown, check: TransferCheck): Promise<VerifiedTransfer> {
  if (!isTxHash(txHash)) {
    throw errors.validation('transaction must be a 0x-prefixed 32-byte hex transaction hash.', 'transaction', 'Send the hash your wallet returned after the USDC transfer (66 characters, starting with 0x).')
  }
  const hash = txHash.toLowerCase()
  const network = networkFor(env)
  const chain = CHAINS[network]
  const receipt = await rpc<Receipt | null>(env, 'eth_getTransactionReceipt', [hash])
  if (!receipt) {
    throw new ApiError('state_error', 'transaction_not_found', `Transaction ${hash} is not visible on ${chain.label} yet.`, {
      hint: `Wait a few seconds and retry with the same hash. Make sure you sent the USDC on ${network} (${chain.label}, chain id ${chain.chainId}) and pasted the full hash.`,
      details: { network, retry_after_seconds: 3 },
    })
  }
  if (receipt.status !== '0x1') {
    throw invalid('reverted', 'The transaction reverted on-chain; nothing was transferred.', 'Check your USDC balance and gas, send the transfer again and submit the new hash.')
  }
  const blockNumber = Number(BigInt(receipt.blockNumber))
  const head = Number(BigInt(await rpc<string>(env, 'eth_blockNumber', [])))
  const confirmations = Math.max(0, head - blockNumber + 1)
  const required = confirmationsRequired(env)
  if (confirmations < required) {
    const wait = Math.max(2, (required - confirmations) * 2)
    throw new ApiError('state_error', 'transaction_pending', `The transaction has ${confirmations} of ${required} required confirmations.`, {
      hint: `Retry in ${wait} seconds with the same hash.`,
      details: { confirmations, required, retry_after_seconds: wait },
    })
  }
  const block = await rpc<{ timestamp?: string } | null>(env, 'eth_getBlockByNumber', [receipt.blockNumber, false])
  const blockTimestamp = block?.timestamp ? Number(BigInt(block.timestamp)) * 1000 : Date.now()
  if (check.notBefore != null && blockTimestamp < check.notBefore) {
    throw invalid('too_old', 'The transaction was mined before this payment became due, so it cannot be the payment for it.', 'Send a fresh transfer for this job and submit its hash. Every job needs its own transaction.', { block_time: new Date(blockTimestamp).toISOString(), not_before: new Date(check.notBefore).toISOString() })
  }
  const transfers = decodeUsdcTransfers(receipt, chain.usdc)
  if (!transfers.length) {
    throw invalid('wrong_asset', `The transaction contains no USDC transfer (contract ${chain.usdc}) on ${chain.label}.`, `Pay in USDC on ${network}; the token contract is ${chain.usdc}.`, { asset: chain.usdc })
  }
  const toRecipient = transfers.filter((t) => sameAddress(t.to, check.to))
  if (!toRecipient.length) {
    throw invalid('wrong_recipient', 'The USDC in this transaction did not go to the required wallet.', `Send to ${check.to} exactly (the counterparty wallet shown in the payment terms).`, { expected_to: check.to })
  }
  const fromSender = toRecipient.filter((t) => sameAddress(t.from, check.from))
  if (!fromSender.length) {
    throw invalid('wrong_sender', 'The USDC was not sent from your registered wallet address.', `Pay from ${check.from} (your wallet_address), or change it first via POST /v1/agents/me/wallet-address.`, { expected_from: check.from })
  }
  const total = fromSender.reduce((s, t) => s + t.value, 0n)
  if (total < BigInt(check.minAmount)) {
    throw invalid('amount_too_low', `The transaction transferred ${total.toString()} USDC minor units, ${check.minAmount} are required.`, 'Send the full amount in ONE transaction (one hash pays one job) and submit that hash.', { transferred: total.toString(), required: check.minAmount })
  }
  return {
    transaction: hash,
    from: toChecksumAddress(check.from),
    to: toChecksumAddress(check.to),
    amount: total > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(total),
    asset: chain.usdc,
    network,
    blockNumber,
    blockTimestamp,
    confirmations,
  }
}
