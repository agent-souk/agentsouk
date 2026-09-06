import { config } from '../../config.js'
import type { Env } from '../../db/schema.js'
import { ApiError, errors } from '../../lib/errors.js'
import { log } from '../../lib/log.js'
import { sameAddress, toChecksumAddress } from './address.js'
import { CHAINS, TRANSFER_TOPIC, networkFor, type X402Network } from './x402.js'

/**
 * Read-only chain access (ADR-22). The platform verifies that a buyer's USDC transfer to the seller happened; it
 * never signs, broadcasts or relays anything. Three JSON-RPC reads per verification. Every response from the node
 * is treated as untrusted input: malformed shapes become 502 chain_unavailable, never a 500.
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

/** Parses a 0x-hex quantity from the node; throws chain_unavailable on garbage. */
function hexToBigInt(v: unknown, what: string): bigint {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]*$/.test(v)) throw chainUnavailable(`malformed ${what} from node`)
  return v === '0x' ? 0n : BigInt(v)
}

export type ReceiptLog = { address: string; topics: string[]; data: string; logIndex?: string }
export type Receipt = { status: string; blockNumber: string; transactionHash?: string; logs: ReceiptLog[] }

export type UsdcTransfer = { from: string; to: string; value: bigint }

/** Accepts 0x + 64 hex, or 64 bare hex (web3.py's HexBytes.hex() drops the prefix); returns the lowercase 0x form or undefined. */
export function normalizeTxHash(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  if (/^0x[0-9a-fA-F]{64}$/.test(t)) return t.toLowerCase()
  if (/^[0-9a-fA-F]{64}$/.test(t)) return ('0x' + t).toLowerCase()
  return undefined
}

export function isTxHash(v: unknown): v is string {
  return normalizeTxHash(v) !== undefined
}

/** All USDC Transfer logs in a receipt (addresses lowercased, value as bigint). Garbage entries are skipped. */
export function decodeUsdcTransfers(receipt: Receipt, usdc: string): UsdcTransfer[] {
  const out: UsdcTransfer[] = []
  const logs = Array.isArray(receipt.logs) ? receipt.logs : []
  for (const l of logs) {
    if (!l || typeof l !== 'object' || typeof l.address !== 'string' || !Array.isArray(l.topics)) continue
    if (!sameAddress(l.address, usdc)) continue
    if (String(l.topics[0] ?? '').toLowerCase() !== TRANSFER_TOPIC || l.topics.length < 3) continue
    const t1 = String(l.topics[1] ?? '')
    const t2 = String(l.topics[2] ?? '')
    if (!/^0x[0-9a-fA-F]{64}$/.test(t1) || !/^0x[0-9a-fA-F]{64}$/.test(t2)) continue
    const from = '0x' + t1.slice(-40).toLowerCase()
    const to = '0x' + t2.slice(-40).toLowerCase()
    let value = 0n
    try {
      value = typeof l.data === 'string' && /^0x[0-9a-fA-F]*$/.test(l.data) ? BigInt(l.data === '0x' ? '0x0' : l.data) : 0n
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
  /** expected recipient wallet(s); any of them satisfies the check (a frozen job address plus the current one) */
  to: string | string[]
  /** USDC minor units that must have arrived NET (transfers back from recipient to sender in the same tx are subtracted) */
  minAmount: number
  /** the transfer must have been mined at or after this epoch-ms (guards against reusing an older payment) */
  notBefore?: number
  /** accept a smaller net amount and report it (partial payments are recorded by the caller) */
  allowPartial?: boolean
}

export type VerifiedTransfer = {
  transaction: string
  from: string
  to: string
  /** net USDC minor units that reached `to` from `from` in this transaction */
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

const SMART_WALLET_HINT = 'If you use a smart wallet (ERC-4337, e.g. Coinbase Smart Wallet), submit the hash of the mined transaction (the bundler transaction from the receipt), not the userOperation hash.'

/**
 * Verifies an on-chain USDC transfer. Throws agent-friendly errors:
 * 409 transaction_not_found (retry), 409 transaction_pending (retry), 402 payment_invalid (details.reason), 502 chain_unavailable.
 */
export async function verifyUsdcTransfer(env: Env, txHash: unknown, check: TransferCheck): Promise<VerifiedTransfer> {
  const hash = normalizeTxHash(txHash)
  if (!hash) {
    throw errors.validation('transaction must be a 32-byte hex transaction hash (0x + 64 hex characters).', 'transaction', `Send the hash your wallet returned after the USDC transfer. ${SMART_WALLET_HINT}`)
  }
  const network = networkFor(env)
  const chain = CHAINS[network]
  const receipt = await rpc<Receipt | null>(env, 'eth_getTransactionReceipt', [hash])
  if (!receipt) {
    throw new ApiError('state_error', 'transaction_not_found', `Transaction ${hash} is not visible on ${chain.label} yet.`, {
      hint: `Wait a few seconds and retry with the same hash. Make sure you sent the USDC on ${network} (${chain.label}, chain id ${chain.chainId}) and pasted the full hash. ${SMART_WALLET_HINT}`,
      details: { network, retry_after_seconds: 3 },
    })
  }
  if (typeof receipt !== 'object') throw chainUnavailable('malformed receipt from node')
  if (receipt.status !== '0x1') {
    if (receipt.status !== '0x0') throw chainUnavailable('malformed receipt status from node')
    throw invalid('reverted', 'The transaction reverted on-chain; nothing was transferred.', 'Check your USDC balance and gas, send the transfer again and submit the new hash.')
  }
  const blockNumber = Number(hexToBigInt(receipt.blockNumber, 'blockNumber'))
  const head = Number(hexToBigInt(await rpc<string>(env, 'eth_blockNumber', []), 'block height'))
  const confirmations = Math.max(0, head - blockNumber + 1)
  const required = confirmationsRequired(env)
  if (confirmations < required) {
    const wait = Math.max(2, (required - confirmations) * 2)
    throw new ApiError('state_error', 'transaction_pending', `The transaction has ${confirmations} of ${required} required confirmations.`, {
      hint: `Retry in ${wait} seconds with the same hash.`,
      details: { confirmations, required, retry_after_seconds: wait },
    })
  }
  const block = await rpc<{ timestamp?: unknown } | null>(env, 'eth_getBlockByNumber', [receipt.blockNumber, false])
  if (!block || typeof block !== 'object') throw chainUnavailable('block not returned by node')
  const blockTimestamp = Number(hexToBigInt(block.timestamp, 'block timestamp')) * 1000
  if (check.notBefore != null && blockTimestamp < check.notBefore) {
    throw invalid('too_old', 'The transaction was mined before this payment became due, so it cannot be the payment for it.', 'Send a fresh transfer for this job and submit its hash. Every job needs its own transaction.', { block_time: new Date(blockTimestamp).toISOString(), not_before: new Date(check.notBefore).toISOString() })
  }
  const transfers = decodeUsdcTransfers(receipt, chain.usdc)
  if (!transfers.length) {
    throw invalid('wrong_asset', `The transaction contains no USDC transfer (contract ${chain.usdc}) on ${chain.label}.`, `Pay in USDC on ${network}; the token contract is ${chain.usdc}.`, { asset: chain.usdc })
  }
  const recipients = Array.isArray(check.to) ? check.to : [check.to]
  const toRecipient = transfers.filter((t) => recipients.some((r) => sameAddress(t.to, r)))
  if (!toRecipient.length) {
    throw invalid('wrong_recipient', 'The USDC in this transaction did not go to the required wallet.', `Send to ${recipients[0]} exactly (the counterparty wallet shown in the payment terms).`, { expected_to: recipients[0] })
  }
  const fromSender = toRecipient.filter((t) => sameAddress(t.from, check.from))
  if (!fromSender.length) {
    throw invalid('wrong_sender', 'The USDC was not sent from your registered wallet address.', `Pay from ${check.from} (your wallet_address). To pay from another wallet, prove control of it first via POST /v1/agents/me/wallet-address.`, { expected_from: check.from })
  }
  const matchedTo = fromSender[0]!.to
  // Net amount: anything the recipient sent back to the sender inside the same transaction does not count.
  const gross = fromSender.reduce((s, t) => s + t.value, 0n)
  const back = transfers.filter((t) => sameAddress(t.from, matchedTo) && sameAddress(t.to, check.from)).reduce((s, t) => s + t.value, 0n)
  const net = gross > back ? gross - back : 0n
  if (net < BigInt(check.minAmount) && !check.allowPartial) {
    throw invalid('amount_too_low', `The transaction transferred ${net.toString()} USDC minor units net, ${check.minAmount} are required.`, 'Send the full amount in ONE transaction (one hash pays one job) and submit that hash.', { transferred: net.toString(), required: check.minAmount })
  }
  if (net <= 0n) {
    throw invalid('amount_too_low', 'The transaction moved no USDC net from your wallet to the recipient.', 'Send the required amount and submit that hash.', { transferred: '0', required: check.minAmount })
  }
  return {
    transaction: hash,
    from: toChecksumAddress(check.from),
    to: toChecksumAddress(matchedTo),
    amount: net > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(net),
    asset: chain.usdc,
    network,
    blockNumber,
    blockTimestamp,
    confirmations,
  }
}

/**
 * EIP-1271: asks a smart-contract wallet whether it considers `signature` valid for `hash`. Read-only eth_call.
 * Returns false when the address has no code or the call reverts.
 */
export async function isValidContractSignature(env: Env, wallet: string, hash: Uint8Array, signature: Uint8Array): Promise<boolean> {
  const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  const pad32 = (h: string) => h.padStart(64, '0')
  const sigHex = hex(signature)
  const sigPadded = sigHex.padEnd(Math.ceil(sigHex.length / 64) * 64, '0')
  // isValidSignature(bytes32,bytes) selector 0x1626ba7e; args: hash, offset(0x40), length, data
  const data = '0x1626ba7e' + hex(hash) + pad32('40') + pad32(signature.length.toString(16)) + sigPadded
  try {
    const result = await rpc<string>(env, 'eth_call', [{ to: wallet, data }, 'latest'])
    return typeof result === 'string' && result.toLowerCase().startsWith('0x1626ba7e')
  } catch (e) {
    if (e instanceof ApiError && e.code === 'chain_unavailable') throw e
    return false
  }
}
