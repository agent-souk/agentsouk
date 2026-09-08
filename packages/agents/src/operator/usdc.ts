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

// --- ERC-8004 Identity Registry (ADR-28) ------------------------------------------------------------------------

/** github.com/erc-8004/erc-8004-contracts; checked on-chain 2026-09-08 (name() = "AgentIdentity", symbol AGENT). */
export const ERC8004_IDENTITY_REGISTRY: Record<'live' | 'test', string> = {
  live: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
  test: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
}
const utf8 = (s: string) => new TextEncoder().encode(s)
const selector = (signature: string) => keccak_256(utf8(signature)).slice(0, 4)
/** keccak("Registered(uint256,string,address)") */
export const ERC8004_REGISTERED_TOPIC = '0x' + bytesToHex(keccak_256(utf8('Registered(uint256,string,address)')))

/** ABI-encodes one dynamic `string` argument (offset word, length word, padded bytes). */
function encodeStringArg(value: string): Uint8Array {
  const bytes = utf8(value)
  const padded = new Uint8Array(Math.ceil(bytes.length / 32) * 32)
  padded.set(bytes)
  return concatBytes(bigintToBytes32(32n), bigintToBytes32(BigInt(bytes.length)), padded)
}

/** calldata for register(string agentURI) on the Identity Registry: mints an agentId owned by the sender. */
export function encodeRegister(agentUri: string): Uint8Array {
  if (!agentUri || agentUri.length > 2048 || !/^https:\/\//.test(agentUri)) throw new Error('agentURI must be an https URL of at most 2048 characters')
  return concatBytes(selector('register(string)'), encodeStringArg(agentUri))
}

/** calldata for tokenURI(uint256) */
export function encodeTokenUri(agentId: bigint): Uint8Array {
  return concatBytes(selector('tokenURI(uint256)'), bigintToBytes32(agentId))
}

/** calldata for ownerOf(uint256) */
export function encodeOwnerOf(agentId: bigint): Uint8Array {
  return concatBytes(selector('ownerOf(uint256)'), bigintToBytes32(agentId))
}

/** Decodes a single ABI `string` return value ("0x…"); undefined when malformed. */
export function decodeStringResult(result: unknown): string | undefined {
  if (typeof result !== 'string' || !/^0x[0-9a-fA-F]*$/.test(result) || result.length < 2 + 128) return undefined
  const h = result.slice(2)
  const offset = Number(BigInt('0x' + h.slice(0, 64)))
  const len = Number(BigInt('0x' + h.slice(64, 128)))
  if (offset !== 32 || !Number.isSafeInteger(len) || len > 8192 || h.length < 128 + len * 2) return undefined
  return new TextDecoder().decode(hexToBytes(h.slice(128, 128 + len * 2)))
}

export type ReceiptLog = { address?: string; topics?: string[]; data?: string; removed?: boolean }

/**
 * The agentId minted by a register() transaction: the Registered(agentId, agentURI, owner) event emitted by the
 * registry. With `owner` given, only an event minted to that address counts (a proxy or a future upgrade could emit
 * more than one); reorged logs (removed: true) never count.
 */
export function parseRegisteredAgentId(logs: ReceiptLog[] | undefined, registry: string, owner?: string): bigint | undefined {
  for (const l of logs ?? []) {
    if (!l || l.removed === true || typeof l.address !== 'string' || !sameAddress(l.address, registry) || !Array.isArray(l.topics)) continue
    if (String(l.topics[0] ?? '').toLowerCase() !== ERC8004_REGISTERED_TOPIC || !/^0x[0-9a-fA-F]{64}$/.test(String(l.topics[1] ?? ''))) continue
    if (owner) {
      const t2 = String(l.topics[2] ?? '')
      if (!/^0x[0-9a-fA-F]{64}$/.test(t2) || !sameAddress('0x' + t2.slice(-40), owner)) continue
    }
    return BigInt(String(l.topics[1]))
  }
  return undefined
}

function bigintToBytes32(v: bigint): Uint8Array {
  if (v < 0n || v >= 1n << 256n) throw new Error('value does not fit in uint256')
  const out = new Uint8Array(32)
  const b = bigintToBytes(v)
  out.set(b, 32 - b.length)
  return out
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
  /** wei; refuse to sign above these (Base normally runs far below: ~0.001 gwei tip, ~0.01 gwei base fee) */
  maxPriorityFeePerGas?: bigint
  maxFeePerGas?: bigint
  sleep?: (ms: number) => Promise<void>
  log?: (msg: string, extra?: Record<string, unknown>) => void
}

export type Receipt = { status: 'success' | 'reverted'; blockNumber: bigint; logs: ReceiptLog[] }
export type Sent = { hash: string; nonce: number; explorer: string; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }

/**
 * A transfer that did not happen (broadcast: false, nothing left the wallet, safe to retry) or one whose fate is
 * unknown (broadcast: true, the node may have accepted it: never retry blindly).
 */
export class TransferError extends Error {
  constructor(
    message: string,
    readonly broadcast: boolean,
  ) {
    super(message)
    this.name = 'TransferError'
  }
}

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
  async transfer(to: string, amount: bigint): Promise<Sent> {
    if (!isAddress(to)) throw new TransferError(`refusing to pay: recipient is not a plain address (${String(to).slice(0, 60)})`, false)
    if (sameAddress(to, this.address)) throw new TransferError('refusing to pay: recipient is the operator wallet itself', false)
    if (amount <= 0n) throw new TransferError('refusing to pay: amount must be positive', false)
    if (amount > this.maxPerTransfer) throw new TransferError(`refusing to pay: ${formatUsdc(amount)} exceeds the per-transfer cap of ${formatUsdc(this.maxPerTransfer)}`, false)
    const [usdc, eth] = await this.pre(() => Promise.all([this.usdcBalance(), this.ethBalance()]))
    if (usdc < amount) throw new TransferError(`insufficient USDC: wallet holds ${formatUsdc(usdc)}, payment needs ${formatUsdc(amount)}`, false)
    if (eth === 0n) throw new TransferError('no ETH for gas on the operator wallet', false)
    const r = await this.send(this.chain.usdc, 0n, encodeTransfer(to, amount), 60_000n, eth)
    this.opts.log?.('usdc transfer sent', { to, amount: amount.toString(), hash: r.hash, nonce: r.nonce, chain_id: this.chain.chainId })
    return r
  }

  /**
   * Re-broadcasts a USDC transfer that is stuck in the mempool: same nonce, fees at least 25% above the previous
   * ones (nodes drop replacements that bump less than ~10%). The old hash can no longer mine once this one is accepted.
   */
  async replaceTransfer(to: string, amount: bigint, prev: { nonce: number; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }): Promise<Sent> {
    if (!isAddress(to) || sameAddress(to, this.address) || amount <= 0n || amount > this.maxPerTransfer) throw new TransferError('refusing to replace: the original transfer parameters are not acceptable', false)
    const eth = await this.pre(() => this.ethBalance())
    const bump = (v: bigint) => (v * 125n) / 100n + 1n
    const r = await this.send(this.chain.usdc, 0n, encodeTransfer(to, amount), 60_000n, eth, { nonce: prev.nonce, minPriority: bump(prev.maxPriorityFeePerGas), minMaxFee: bump(prev.maxFeePerGas) })
    this.opts.log?.('usdc transfer replaced', { to, amount: amount.toString(), hash: r.hash, nonce: r.nonce, chain_id: this.chain.chainId })
    return r
  }

  /** Sends native ETH (wei) to `to`: only used to move gas money between the operator's own wallets. */
  async sendEth(to: string, amountWei: bigint): Promise<Sent> {
    if (!isAddress(to)) throw new TransferError(`refusing to send: recipient is not a plain address (${String(to).slice(0, 60)})`, false)
    if (sameAddress(to, this.address)) throw new TransferError('refusing to send: recipient is the wallet itself', false)
    if (amountWei <= 0n) throw new TransferError('refusing to send: amount must be positive', false)
    const eth = await this.pre(() => this.ethBalance())
    if (eth <= amountWei) throw new TransferError(`insufficient ETH: wallet holds ${eth} wei, sending ${amountWei} plus gas`, false)
    const r = await this.send(to, amountWei, new Uint8Array(0), 21_000n, eth)
    this.opts.log?.('eth transfer sent', { to, amount_wei: amountWei.toString(), hash: r.hash, nonce: r.nonce, chain_id: this.chain.chainId })
    return r
  }

  /**
   * Calls a contract function with no value (e.g. ERC-8004 register(agentURI)). Same nonce/fee/gas discipline as a
   * transfer; `minGas` is the floor for the gas limit. Only used by operator scripts, never by the desk at runtime.
   */
  async call(to: string, data: Uint8Array, minGas = 100_000n): Promise<Sent> {
    if (!isAddress(to)) throw new TransferError(`refusing to call: target is not a plain address (${String(to).slice(0, 60)})`, false)
    if (!data.length) throw new TransferError('refusing to call: empty calldata', false)
    const eth = await this.pre(() => this.ethBalance())
    if (eth === 0n) throw new TransferError('no ETH for gas on the wallet', false)
    const r = await this.send(to, 0n, data, minGas, eth)
    this.opts.log?.('contract call sent', { to, selector: hex(data.slice(0, 4)), hash: r.hash, nonce: r.nonce, chain_id: this.chain.chainId })
    return r
  }

  /** Read-only eth_call; returns the raw 0x result. */
  async view(to: string, data: Uint8Array): Promise<string> {
    const r = await this.rpc<string>('eth_call', [{ to, data: hex(data) }, 'latest'])
    if (typeof r !== 'string') throw new Error('eth_call: malformed result')
    return r
  }

  get maxPriorityFeePerGas(): bigint {
    return this.opts.maxPriorityFeePerGas ?? 500_000_000n // 0.5 gwei (Base tips are ~0.001 gwei)
  }

  get maxFeePerGas(): bigint {
    return this.opts.maxFeePerGas ?? 5_000_000_000n // 5 gwei (Base base fees are ~0.01 gwei; 60k gas at 5 gwei is 0.0003 ETH)
  }

  /** Reads before the broadcast: any failure is a pre-broadcast failure (nothing left the wallet). */
  private async pre<T>(f: () => Promise<T>): Promise<T> {
    try {
      return await f()
    } catch (e) {
      throw e instanceof TransferError ? e : new TransferError(String((e as Error).message ?? e), false)
    }
  }

  /**
   * Nonce, EIP-1559 fees (capped), gas estimate with a 30% margin, sign, broadcast, and insist on the expected
   * hash. Everything up to the broadcast throws TransferError(broadcast: false); the broadcast itself and the hash
   * check throw TransferError(broadcast: true), because the node may have accepted the transaction.
   */
  private async send(to: string, value: bigint, data: Uint8Array, minGas: bigint, ethBalance: bigint, opts: { nonce?: number; minPriority?: bigint; minMaxFee?: bigint } = {}): Promise<Sent> {
    const prep = await this.pre(async () => {
      const nonce = opts.nonce ?? Number(hexToBigInt(await this.rpc('eth_getTransactionCount', [this.address, 'pending']), 'nonce'))
      const block = (await this.rpc<{ baseFeePerGas?: string } | null>('eth_getBlockByNumber', ['latest', false])) ?? {}
      const baseFee = hexToBigInt(block.baseFeePerGas ?? '0x0', 'baseFeePerGas')
      let priority = 1_000_000n // 0.001 gwei, the usual tip on Base
      try {
        priority = hexToBigInt(await this.rpc('eth_maxPriorityFeePerGas', []), 'priority fee')
        if (priority < 1_000_000n) priority = 1_000_000n
      } catch {
        /* not every node implements it */
      }
      if (opts.minPriority && priority < opts.minPriority) priority = opts.minPriority
      let maxFeePerGas = baseFee * 2n + priority
      if (opts.minMaxFee && maxFeePerGas < opts.minMaxFee) maxFeePerGas = opts.minMaxFee
      if (priority > this.maxPriorityFeePerGas || maxFeePerGas > this.maxFeePerGas) throw new TransferError(`gas price above the cap (priority ${priority} wei, max fee ${maxFeePerGas} wei); retry later`, false)
      const callObj: Record<string, string> = { from: this.address, to }
      if (data.length) callObj.data = hex(data)
      if (value > 0n) callObj.value = quantity(value)
      const estimated = hexToBigInt(await this.rpc('eth_estimateGas', [callObj]), 'gas estimate')
      const gasLimit = (estimated * 130n) / 100n < minGas ? minGas : (estimated * 130n) / 100n
      if (ethBalance < value + gasLimit * maxFeePerGas) throw new TransferError(`insufficient ETH for gas: need up to ${value + gasLimit * maxFeePerGas} wei, wallet holds ${ethBalance}`, false)
      const tx: UnsignedTx = { chainId: this.chain.chainId, nonce, maxPriorityFeePerGas: priority, maxFeePerGas, gasLimit, to, value, data }
      return { tx, ...signEip1559(tx, this.privateKey) }
    })
    let sent: unknown
    try {
      sent = await this.rpc<string>('eth_sendRawTransaction', [prep.raw])
    } catch (e) {
      throw new TransferError(`broadcast failed: ${String((e as Error).message ?? e)}`, true)
    }
    if (typeof sent !== 'string' || !sameAddress(sent, prep.hash)) throw new TransferError(`node returned an unexpected hash ${String(sent)} for ${prep.hash}`, true)
    return { hash: prep.hash, nonce: prep.tx.nonce, explorer: this.chain.explorerTx + prep.hash, maxFeePerGas: prep.tx.maxFeePerGas, maxPriorityFeePerGas: prep.tx.maxPriorityFeePerGas }
  }

  /** Waits until the transaction is mined; throws on timeout (the transfer may still land later: keep the hash). */
  async waitForReceipt(hash: string, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<Receipt> {
    const timeoutMs = opts.timeoutMs ?? 180_000
    const intervalMs = opts.intervalMs ?? 3000
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
    const started = Date.now()
    for (;;) {
      const r = await this.rpc<{ status?: string; blockNumber?: string; logs?: ReceiptLog[] } | null>('eth_getTransactionReceipt', [hash])
      if (r && r.blockNumber) return { status: hexToBigInt(r.status ?? '0x0', 'status') === 1n ? 'success' : 'reverted', blockNumber: hexToBigInt(r.blockNumber, 'blockNumber'), logs: Array.isArray(r.logs) ? r.logs : [] }
      if (Date.now() - started > timeoutMs) throw new Error(`transaction ${hash} not mined after ${timeoutMs} ms`)
      await sleep(intervalMs)
    }
  }

  /** Quantity helper for callers that build their own RPC params. */
  static quantity = quantity
}
