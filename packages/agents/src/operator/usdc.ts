/**
 * Minimal USDC sender for the operator wallet (bounty payouts, ADR-23): builds, signs and broadcasts an EIP-1559
 * `transfer(to, amount)` on Base with nothing but JSON-RPC and secp256k1. No wallet library; the code is small
 * enough to audit and its encoding is pinned to a viem-produced vector in usdc.test.ts.
 *
 * Guard rails live here, not in the caller: plain addresses only, a per-transfer cap, never to itself, balance
 * and gas checked before signing, and the broadcast hash must equal the locally computed one.
 */
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js'

export type Chain = { rpcUrl: string; chainId: number; usdc: string; explorerTx: string }

export const CHAINS: Record<'live' | 'test', Chain> = {
  live: { rpcUrl: 'https://mainnet.base.org', chainId: 8453, usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', explorerTx: 'https://basescan.org/tx/' },
  test: { rpcUrl: 'https://sepolia.base.org', chainId: 84532, usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', explorerTx: 'https://sepolia.basescan.org/tx/' },
}

export const USDC_DECIMALS = 6
export const formatUsdc = (minor: bigint | number): string => `${(Number(minor) / 1e6).toFixed(6)} USDC`

// --- encoding ------------------------------------------------------------------------------------------------

export type RlpItem = Uint8Array | RlpItem[]

export function rlpEncode(item: RlpItem): Uint8Array {
  if (item instanceof Uint8Array) {
    if (item.length === 1 && item[0]! < 0x80) return item
    return concatBytes(lengthPrefix(item.length, 0x80), item)
  }
  const payload = concatBytes(...item.map(rlpEncode))
  return concatBytes(lengthPrefix(payload.length, 0xc0), payload)
}

function lengthPrefix(len: number, offset: number): Uint8Array {
  if (len <= 55) return Uint8Array.of(offset + len)
  const lenBytes = bigintToBytes(BigInt(len))
  return concatBytes(Uint8Array.of(offset + 55 + lenBytes.length), lenBytes)
}

/** Minimal big-endian bytes; zero is the empty string (RLP integer convention). */
export function bigintToBytes(v: bigint): Uint8Array {
  if (v < 0n) throw new Error('negative integer')
  if (v === 0n) return new Uint8Array(0)
  let h = v.toString(16)
  if (h.length % 2) h = '0' + h
  return hexToBytes(h)
}

function stripZeros(b: Uint8Array): Uint8Array {
  let i = 0
  while (i < b.length && b[i] === 0) i++
  return b.slice(i)
}

export function isAddress(a: unknown): a is string {
  return typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a)
}

function addressBytes(a: string): Uint8Array {
  if (!isAddress(a)) throw new Error(`not an address: ${String(a)}`)
  return hexToBytes(a.slice(2))
}

const hex = (b: Uint8Array) => '0x' + bytesToHex(b)
const quantity = (v: bigint) => '0x' + v.toString(16)

export function hexToBigInt(v: unknown, what = 'quantity'): bigint {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]*$/.test(v)) throw new Error(`malformed ${what} from node: ${String(v).slice(0, 80)}`)
  return v === '0x' ? 0n : BigInt(v)
}

/** EIP-55 checksum address from the 20 raw bytes. */
export function toChecksumAddress(raw20: Uint8Array | string): string {
  const lower = (typeof raw20 === 'string' ? raw20.replace(/^0x/, '') : bytesToHex(raw20)).toLowerCase()
  const h = bytesToHex(keccak_256(new TextEncoder().encode(lower)))
  let out = '0x'
  for (let i = 0; i < lower.length; i++) out += parseInt(h[i]!, 16) >= 8 ? lower[i]!.toUpperCase() : lower[i]!
  return out
}

export function privateKeyToAddress(privateKeyHex: string): string {
  const pub = secp256k1.getPublicKey(hexToBytes(privateKeyHex.replace(/^0x/, '')), false)
  return toChecksumAddress(keccak_256(pub.slice(1)).slice(12))
}

export const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** ERC-20 transfer(address,uint256) calldata. */
export function encodeTransfer(to: string, amount: bigint): Uint8Array {
  const toWord = new Uint8Array(32)
  toWord.set(addressBytes(to), 12)
  const amountWord = new Uint8Array(32)
  const ab = bigintToBytes(amount)
  amountWord.set(ab, 32 - ab.length)
  return concatBytes(hexToBytes('a9059cbb'), toWord, amountWord)
}

/** ERC-20 balanceOf(address) calldata. */
export function encodeBalanceOf(owner: string): Uint8Array {
  const word = new Uint8Array(32)
  word.set(addressBytes(owner), 12)
  return concatBytes(hexToBytes('70a08231'), word)
}

export type UnsignedTx = { chainId: number; nonce: number; maxPriorityFeePerGas: bigint; maxFeePerGas: bigint; gasLimit: bigint; to: string; value: bigint; data: Uint8Array }

function txFields(tx: UnsignedTx): RlpItem[] {
  return [bigintToBytes(BigInt(tx.chainId)), bigintToBytes(BigInt(tx.nonce)), bigintToBytes(tx.maxPriorityFeePerGas), bigintToBytes(tx.maxFeePerGas), bigintToBytes(tx.gasLimit), addressBytes(tx.to), bigintToBytes(tx.value), tx.data, []]
}

/** Signs an EIP-1559 transaction; returns the raw bytes to broadcast and their keccak (= the transaction hash). */
export function signEip1559(tx: UnsignedTx, privateKeyHex: string): { raw: string; hash: string } {
  const priv = hexToBytes(privateKeyHex.replace(/^0x/, ''))
  const signingHash = keccak_256(concatBytes(Uint8Array.of(2), rlpEncode(txFields(tx))))
  const sig = secp256k1.sign(signingHash, priv, { prehash: false, format: 'recovered', lowS: true })
  const yParity = sig[0]!
  const r = stripZeros(sig.slice(1, 33))
  const s = stripZeros(sig.slice(33, 65))
  const raw = concatBytes(Uint8Array.of(2), rlpEncode([...txFields(tx), bigintToBytes(BigInt(yParity)), r, s]))
  return { raw: hex(raw), hash: hex(keccak_256(raw)) }
}

// --- wallet ---------------------------------------------------------------------------------------------------

export type RpcFetch = (url: string, body: string) => Promise<{ status: number; json: () => Promise<unknown> }>
export type WalletOptions = {
  fetchImpl?: RpcFetch
  /** USDC minor units; a single transfer above this is refused (default 25 USDC) */
  maxPerTransfer?: bigint
  sleep?: (ms: number) => Promise<void>
  log?: (msg: string, extra?: Record<string, unknown>) => void
}

export type Receipt = { status: 'success' | 'reverted'; blockNumber: bigint }

export class UsdcWallet {
  readonly address: string
  private rpcId = 0

  constructor(
    private readonly privateKey: string,
    readonly chain: Chain,
    private readonly opts: WalletOptions = {},
  ) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error('OPERATOR_PRIVATE_KEY must be 0x + 64 hex characters')
    this.address = privateKeyToAddress(privateKey)
  }

  get maxPerTransfer(): bigint {
    return this.opts.maxPerTransfer ?? 25_000_000n
  }

  async rpc<T = unknown>(method: string, params: unknown[]): Promise<T> {
    const body = JSON.stringify({ jsonrpc: '2.0', id: ++this.rpcId, method, params })
    const f: RpcFetch = this.opts.fetchImpl ?? ((url, b) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: b, signal: AbortSignal.timeout(20_000) }))
    const res = await f(this.chain.rpcUrl, body)
    if (res.status >= 400) throw new Error(`rpc ${method}: HTTP ${res.status}`)
    const json = (await res.json().catch(() => undefined)) as { result?: T; error?: { code?: number; message?: string } } | undefined
    if (!json || typeof json !== 'object') throw new Error(`rpc ${method}: malformed response`)
    if (json.error) throw new Error(`rpc ${method}: ${json.error.message ?? `error ${json.error.code ?? ''}`}`)
    return json.result as T
  }

  async usdcBalance(of: string = this.address): Promise<bigint> {
    return hexToBigInt(await this.rpc('eth_call', [{ to: this.chain.usdc, data: hex(encodeBalanceOf(of)) }, 'latest']), 'balance')
  }

  async ethBalance(): Promise<bigint> {
    return hexToBigInt(await this.rpc('eth_getBalance', [this.address, 'latest']), 'eth balance')
  }

  /** Sends `amount` USDC minor units to `to`. Resolves once the node accepted the transaction (not yet mined). */
  async transfer(to: string, amount: bigint): Promise<{ hash: string; nonce: number; explorer: string }> {
    if (!isAddress(to)) throw new Error(`refusing to pay: recipient is not a plain address (${String(to).slice(0, 60)})`)
    if (sameAddress(to, this.address)) throw new Error('refusing to pay: recipient is the operator wallet itself')
    if (amount <= 0n) throw new Error('refusing to pay: amount must be positive')
    if (amount > this.maxPerTransfer) throw new Error(`refusing to pay: ${formatUsdc(amount)} exceeds the per-transfer cap of ${formatUsdc(this.maxPerTransfer)}`)
    const [usdc, eth] = await Promise.all([this.usdcBalance(), this.ethBalance()])
    if (usdc < amount) throw new Error(`insufficient USDC: wallet holds ${formatUsdc(usdc)}, payment needs ${formatUsdc(amount)}`)
    if (eth === 0n) throw new Error('no ETH for gas on the operator wallet')
    const r = await this.send(this.chain.usdc, 0n, encodeTransfer(to, amount), 60_000n, eth)
    this.opts.log?.('usdc transfer sent', { to, amount: amount.toString(), hash: r.hash, nonce: r.nonce, chain_id: this.chain.chainId })
    return r
  }

  /** Sends native ETH (wei) to `to`: only used to move gas money between the operator's own wallets. */
  async sendEth(to: string, amountWei: bigint): Promise<{ hash: string; nonce: number; explorer: string }> {
    if (!isAddress(to)) throw new Error(`refusing to send: recipient is not a plain address (${String(to).slice(0, 60)})`)
    if (sameAddress(to, this.address)) throw new Error('refusing to send: recipient is the wallet itself')
    if (amountWei <= 0n) throw new Error('refusing to send: amount must be positive')
    const eth = await this.ethBalance()
    if (eth <= amountWei) throw new Error(`insufficient ETH: wallet holds ${eth} wei, sending ${amountWei} plus gas`)
    const r = await this.send(to, amountWei, new Uint8Array(0), 21_000n, eth)
    this.opts.log?.('eth transfer sent', { to, amount_wei: amountWei.toString(), hash: r.hash, nonce: r.nonce, chain_id: this.chain.chainId })
    return r
  }

  /** Nonce, EIP-1559 fees, gas estimate with a 30% margin, sign, broadcast, and insist on the expected hash. */
  private async send(to: string, value: bigint, data: Uint8Array, minGas: bigint, ethBalance: bigint): Promise<{ hash: string; nonce: number; explorer: string }> {
    const nonce = Number(hexToBigInt(await this.rpc('eth_getTransactionCount', [this.address, 'pending']), 'nonce'))
    const block = (await this.rpc<{ baseFeePerGas?: string } | null>('eth_getBlockByNumber', ['latest', false])) ?? {}
    const baseFee = hexToBigInt(block.baseFeePerGas ?? '0x0', 'baseFeePerGas')
    let priority = 1_000_000n // 0.001 gwei, the usual tip on Base
    try {
      priority = hexToBigInt(await this.rpc('eth_maxPriorityFeePerGas', []), 'priority fee')
      if (priority < 1_000_000n) priority = 1_000_000n
    } catch {
      /* not every node implements it */
    }
    const maxFeePerGas = baseFee * 2n + priority
    const callObj: Record<string, string> = { from: this.address, to }
    if (data.length) callObj.data = hex(data)
    if (value > 0n) callObj.value = quantity(value)
    const estimated = hexToBigInt(await this.rpc('eth_estimateGas', [callObj]), 'gas estimate')
    const gasLimit = (estimated * 130n) / 100n < minGas ? minGas : (estimated * 130n) / 100n
    if (ethBalance < value + gasLimit * maxFeePerGas) throw new Error(`insufficient ETH for gas: need up to ${value + gasLimit * maxFeePerGas} wei, wallet holds ${ethBalance}`)
    const tx: UnsignedTx = { chainId: this.chain.chainId, nonce, maxPriorityFeePerGas: priority, maxFeePerGas, gasLimit, to, value, data }
    const { raw, hash } = signEip1559(tx, this.privateKey)
    const sent = await this.rpc<string>('eth_sendRawTransaction', [raw])
    if (typeof sent !== 'string' || !sameAddress(sent, hash)) throw new Error(`node returned an unexpected hash ${String(sent)} for ${hash}`)
    return { hash, nonce, explorer: this.chain.explorerTx + hash }
  }

  /** Waits until the transaction is mined; throws on timeout (the transfer may still land later: keep the hash). */
  async waitForReceipt(hash: string, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<Receipt> {
    const timeoutMs = opts.timeoutMs ?? 180_000
    const intervalMs = opts.intervalMs ?? 3000
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
    const started = Date.now()
    for (;;) {
      const r = await this.rpc<{ status?: string; blockNumber?: string } | null>('eth_getTransactionReceipt', [hash])
      if (r && r.blockNumber) return { status: hexToBigInt(r.status ?? '0x0', 'status') === 1n ? 'success' : 'reverted', blockNumber: hexToBigInt(r.blockNumber, 'blockNumber') }
      if (Date.now() - started > timeoutMs) throw new Error(`transaction ${hash} not mined after ${timeoutMs} ms`)
      await sleep(intervalMs)
    }
  }

  /** Quantity helper for callers that build their own RPC params. */
  static quantity = quantity
}
