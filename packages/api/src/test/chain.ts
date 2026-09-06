import { randomBytes } from 'node:crypto'
import { _setRpcFetchForTests, type RpcFetch } from '../modules/payments/chain.js'
import { CHAINS, TRANSFER_TOPIC, networkFor } from '../modules/payments/x402.js'
import type { Env } from '../db/schema.js'

/**
 * A fake Base node for tests: answers the three JSON-RPC reads the chain reader makes. `pay()` mines a USDC
 * transfer and returns its hash; confirmations and block times are controllable.
 */

export type FakeTransfer = { from: string; to: string; value: number | bigint; asset?: string }
type Tx = { block: number; status: '0x1' | '0x0'; transfers: FakeTransfer[]; timestamp: number }

const pad = (addr: string) => '0x' + addr.toLowerCase().replace(/^0x/, '').padStart(64, '0')

export class FakeChain {
  head = 1000
  txs = new Map<string, Tx>()
  calls: { method: string; params: unknown[] }[] = []
  /** when set, every RPC call fails like an unreachable node */
  down = false

  constructor(readonly env: Env = 'test') {}

  get usdc(): string {
    return CHAINS[networkFor(this.env)].usdc
  }

  /** Mines a transaction with the given transfers. Returns the hash. By default it has exactly the required confirmations (1 on test). */
  mine(transfers: FakeTransfer[], opts: { status?: '0x1' | '0x0'; timestamp?: number; confirmations?: number } = {}): string {
    const hash = '0x' + randomBytes(32).toString('hex')
    this.head += 1
    const block = this.head
    this.txs.set(hash, { block, status: opts.status ?? '0x1', transfers, timestamp: opts.timestamp ?? Date.now() })
    if (opts.confirmations != null) this.head = block + opts.confirmations - 1
    return hash
  }

  /** A plain USDC transfer from -> to. */
  pay(from: string, to: string, value: number | bigint, opts: { status?: '0x1' | '0x0'; timestamp?: number; confirmations?: number; asset?: string } = {}): string {
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
