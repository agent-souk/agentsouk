import { randomBytes } from 'node:crypto'
import { _setRpcFetchForTests, type RpcFetch } from '../modules/payments/chain.js'
import { CHAINS, TRANSFER_TOPIC, networkFor } from '../modules/payments/x402.js'
import { IDENTITY_REGISTRY } from '../modules/agents/erc8004.js'
import type { Env } from '../db/schema.js'

/**
 * A fake Base node for tests: answers the three JSON-RPC reads the chain reader makes. `pay()` mines a USDC
 * transfer and returns its hash; confirmations and block times are controllable.
 */

export type FakeTransfer = { from: string; to: string; value: number | bigint; asset?: string }
export type FakeLog = { address: string; topics: string[]; data?: string }
type Tx = { block: number; status: '0x1' | '0x0'; transfers: FakeTransfer[]; timestamp: number; logs?: FakeLog[] }

const pad = (addr: string) => '0x' + addr.toLowerCase().replace(/^0x/, '').padStart(64, '0')

export class FakeChain {
  head = 1000
  txs = new Map<string, Tx>()
  calls: { method: string; params: unknown[] }[] = []
  /** when set, every RPC call fails like an unreachable node */
  down = false
  /** ERC-8004 Identity Registry tokens (agentId -> owner + tokenURI) answered to eth_call ownerOf/tokenURI */
  erc8004 = new Map<string, { owner: string; uri: string | null }>()
  /** when set, every ERC-8004 eth_call answers this raw result (e.g. '0x' = no code at the address) */
  erc8004Raw: string | null = null
  /** when set, every ERC-8004 eth_call fails with this non-revert node error (e.g. rate limit) */
  erc8004Error: { code: number; message: string } | null = null
  /** USDC balance answered to balanceOf(address) eth_calls (default 50 USDC for everyone) */
  usdcBalanceOf: (address: string) => bigint = () => 50_000_000n

  constructor(readonly env: Env = 'test') {}

  get usdc(): string {
    return CHAINS[networkFor(this.env)].usdc
  }

  /** Mines a transaction with the given transfers. Returns the hash. By default it has exactly the required confirmations (1 on test). */
  mine(transfers: FakeTransfer[], opts: { status?: '0x1' | '0x0'; timestamp?: number; confirmations?: number; logs?: FakeLog[] } = {}): string {
    const hash = '0x' + randomBytes(32).toString('hex')
    this.head += 1
    const block = this.head
    this.txs.set(hash, { block, status: opts.status ?? '0x1', transfers, timestamp: opts.timestamp ?? Date.now(), logs: opts.logs })
    if (opts.confirmations != null) this.head = block + opts.confirmations - 1
    return hash
  }

  /** A plain USDC transfer from -> to. */
  pay(from: string, to: string, value: number | bigint, opts: { status?: '0x1' | '0x0'; timestamp?: number; confirmations?: number; asset?: string; logs?: FakeLog[] } = {}): string {
    return this.mine([{ from, to, value, asset: opts.asset }], opts)
  }

  advance(blocks = 1) {
    this.head += blocks
  }

  readonly fetch: RpcFetch = async (_url, body) => {
    const req = JSON.parse(body) as { id: number; method: string; params: unknown[] }
    this.calls.push({ method: req.method, params: req.params })
    if (this.down) throw new Error('ECONNREFUSED')
    const reply = (result: unknown) => ({ status: 200, json: async () => ({ jsonrpc: '2.0', id: req.id, result }) })
    switch (req.method) {
      case 'eth_blockNumber':
        return reply('0x' + this.head.toString(16))
      case 'eth_getTransactionReceipt': {
        const hash = String(req.params[0]).toLowerCase()
        const tx = this.txs.get(hash)
        if (!tx) return reply(null)
        return reply({
          status: tx.status,
          blockNumber: '0x' + tx.block.toString(16),
          transactionHash: hash,
          logs: tx.transfers.map((t, i) => ({ address: t.asset ?? this.usdc, topics: [TRANSFER_TOPIC, pad(t.from), pad(t.to)], data: '0x' + BigInt(t.value).toString(16).padStart(64, '0'), logIndex: '0x' + i.toString(16) })),
        })
      }
      case 'eth_getBlockByNumber': {
        const n = Number(BigInt(String(req.params[0])))
        const tx = [...this.txs.values()].find((t) => t.block === n)
        return reply({ number: '0x' + n.toString(16), timestamp: '0x' + Math.floor((tx?.timestamp ?? Date.now()) / 1000).toString(16) })
      }
      case 'eth_getLogs': {
        const f = (req.params[0] ?? {}) as { address?: string; fromBlock?: string; toBlock?: string; topics?: (string | null)[] }
        const from = f.fromBlock && f.fromBlock !== 'earliest' ? Number(BigInt(f.fromBlock)) : 0
        const to = !f.toBlock || f.toBlock === 'latest' ? this.head : Number(BigInt(f.toBlock))
        const topics = f.topics ?? []
        const out: unknown[] = []
        for (const [hash, tx] of this.txs) {
          if (tx.block < from || tx.block > to || tx.status !== '0x1') continue
          tx.transfers.forEach((t, i) => {
            const asset = t.asset ?? this.usdc
            if (f.address && asset.toLowerCase() !== String(f.address).toLowerCase()) return
            const log = [TRANSFER_TOPIC, pad(t.from), pad(t.to)]
            if (topics.some((want, k) => want != null && String(want).toLowerCase() !== log[k])) return
            out.push({ address: asset, topics: log, data: '0x' + BigInt(t.value).toString(16).padStart(64, '0'), blockNumber: '0x' + tx.block.toString(16), transactionHash: hash, logIndex: '0x' + i.toString(16), removed: false })
          })
          for (const [i, l] of (tx.logs ?? []).entries()) {
            if (f.address && l.address.toLowerCase() !== String(f.address).toLowerCase()) continue
            const lower = l.topics.map((t) => t.toLowerCase())
            if (topics.some((want, k) => want != null && String(want).toLowerCase() !== lower[k])) continue
            out.push({ address: l.address, topics: l.topics, data: l.data ?? '0x', blockNumber: '0x' + tx.block.toString(16), transactionHash: hash, logIndex: '0x' + (tx.transfers.length + i).toString(16), removed: false })
          }
        }
        return reply(out)
      }
      case 'eth_call': {
        const call = (req.params[0] ?? {}) as { to?: string; data?: string }
        const data = String(call.data ?? '')
        if (String(call.to ?? '').toLowerCase() === this.usdc.toLowerCase() && /^0x70a08231[0-9a-f]{64}$/i.test(data)) return reply('0x' + this.usdcBalanceOf('0x' + data.slice(-40)).toString(16).padStart(64, '0'))
        if (String(call.to ?? '').toLowerCase() === IDENTITY_REGISTRY[this.env].address.toLowerCase() && /^0x(6352211e|c87b56dd)[0-9a-f]{64}$/i.test(data)) {
          if (this.erc8004Error) return { status: 200, json: async () => ({ jsonrpc: '2.0', id: req.id, error: this.erc8004Error }) }
          if (this.erc8004Raw != null) return reply(this.erc8004Raw)
          const id = BigInt('0x' + data.slice(10)).toString()
          const tok = this.erc8004.get(id)
          if (!tok) return { status: 200, json: async () => ({ jsonrpc: '2.0', id: req.id, error: { code: 3, message: 'execution reverted' } }) }
          if (data.startsWith('0x6352211e')) return reply(pad(tok.owner))
          if (tok.uri == null) return { status: 200, json: async () => ({ jsonrpc: '2.0', id: req.id, error: { code: -32000, message: 'VM execution error.', data: '0x08c379a0' } }) }
          const bytes = Buffer.from(tok.uri, 'utf8')
          const hex = bytes.toString('hex').padEnd(Math.ceil(bytes.length / 32) * 64, '0')
          return reply('0x' + (32n).toString(16).padStart(64, '0') + BigInt(bytes.length).toString(16).padStart(64, '0') + hex)
        }
        // Any other address: a real node answers a call to something with no code with empty data, not a revert.
        // ERC-1271 signature checks against an ordinary wallet land here, and the difference decides whether the
        // caller sees "signature invalid" (400) or "chain unavailable" (502).
        return reply('0x')
      }
      default:
        return { status: 200, json: async () => ({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'method not found' } }) }
    }
  }
}

/** Installs a fake chain as the RPC backend for the current test. */
export function installFakeChain(env: Env = 'test'): FakeChain {
  const chain = new FakeChain(env)
  _setRpcFetchForTests(chain.fetch)
  return chain
}
