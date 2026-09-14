import type { ServiceDef } from './types.js'

/**
 * ADR-64: a first-party service in the one category the visible x402 economy actually pays for. ADR-55 measured
 * what agents buy per call out there: social timelines, crypto market data, web-to-text, LLM completions, at
 * 0.001-0.10 USDC. Agent Souk sold web-to-text and LLM work but no market data at all, and the catalogue review of
 * 2026-09-14 (research/catalogue-quality-2026-09-14.json) named "crypto market and on-chain data" as the first
 * thing a buying agent looked for and did not find. This is that service, first-party like the other six (ADR-48:
 * only our own listings are sold through the x402 endpoint), read from public sources at the moment of the job:
 * DEX Screener for the pool and its price, the Base JSON-RPC for what the chain itself says. No key, no LLM.
 *
 * It cannot move between_outsiders (we are the seller), and it does not claim to. It tests the premise one step
 * sharper than the six before it: if agents that pay for exactly this elsewhere do not pay for it here either,
 * the missing piece is reach, not the product.
 *
 * Every chain read of one job goes out as ONE JSON-RPC batch, and the batch moves to the next public node on a
 * transport failure: the first live run against mainnet.base.org alone answered five parallel calls with HTTP 429
 * and "over rate limit" inside the batch. publicnode answers a batch of eight without complaint.
 */

export const DEFAULT_RPC_URLS = ['https://base-rpc.publicnode.com', 'https://mainnet.base.org']
export const DEX_SCREENER_URL = 'https://api.dexscreener.com/latest/dex/tokens/'

/** Well-known Base tokens an agent may name instead of pasting an address. */
export const ALIASES: Record<string, string> = {
  eth: '0x4200000000000000000000000000000000000006',
  weth: '0x4200000000000000000000000000000000000006',
  usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  cbbtc: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
}

export type SnapshotOptions = { fetchImpl?: typeof fetch; rpcUrl?: string; rpcUrls?: string[]; dexUrl?: string; timeoutMs?: number; retryDelayMs?: number; now?: () => number }

type DexPair = {
  chainId?: string
  dexId?: string
  url?: string
  pairAddress?: string
  baseToken?: { address?: string; symbol?: string; name?: string }
  quoteToken?: { address?: string; symbol?: string; name?: string }
  priceNative?: string
  priceUsd?: string
  liquidity?: { usd?: number }
  volume?: { h24?: number }
  priceChange?: { h24?: number }
}

export type Snapshot = {
  chain: 'base'
  chain_id: 8453
  token: { address: string; symbol: string | null; name: string | null; decimals: number | null; total_supply: string | null }
  price_usd: number | null
  price_source: {
    dex: string | null
    pair_address: string | null
    pair_url: string | null
    base: string | null
    quote: string | null
    token_is: 'base' | 'quote' | null
    liquidity_usd: number | null
    volume_24h_usd: number | null
    price_change_24h_pct: number | null
  } | null
  price_note: string | null
  pairs_on_base: number
  gas_price_gwei: number | null
  wallet: { address: string; token_balance: string | null; eth_balance: string | null } | null
  sources: string[]
  fetched_at: string
}

const isAddress = (s: unknown): s is string => typeof s === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s)

/** Resolve an alias or a checksummed/lowercase address to the address the chain is asked about. */
export function resolveToken(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const key = raw.trim().toLowerCase()
  if (ALIASES[key]) return ALIASES[key]!
  return isAddress(raw.trim()) ? raw.trim() : null
}

// --- minimal ABI helpers (selectors of the ERC-20 read functions; no library, nothing is signed here) ------------

const SELECTOR = { symbol: '0x95d89b41', name: '0x06fdde03', decimals: '0x313ce567', totalSupply: '0x18160ddd', balanceOf: '0x70a08231' }
const pad32 = (hex: string) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0')

/** Decode an ABI `string` return; tokens that return a raw bytes32 (MKR-style) are read as such. */
export function decodeString(data: string): string | null {
  const hex = data.replace(/^0x/, '')
  if (!hex) return null
  const bytes = (h: string) => Buffer.from(h, 'hex')
  if (hex.length === 64) return bytes(hex).toString('utf8').replace(/\0+$/g, '').trim() || null
  if (hex.length < 128) return null
  const offset = Number(BigInt('0x' + hex.slice(0, 64))) * 2
  const len = Number(BigInt('0x' + hex.slice(offset, offset + 64))) * 2
  const s = bytes(hex.slice(offset + 64, offset + 64 + len)).toString('utf8').trim()
  return s || null
}

/** A quantity (eth_gasPrice, eth_getBalance: short hex) or the first 32-byte word of an ABI return. */
export function decodeUint(data: string): bigint | null {
  const hex = data.replace(/^0x/, '')
  if (!hex || !/^[0-9a-fA-F]+$/.test(hex)) return null
  return BigInt('0x' + (hex.length > 64 ? hex.slice(0, 64) : hex))
}

/** A bigint in base units as a decimal string, trailing zeros trimmed ("2478.14", "12.1", "0"). */
export function formatUnits(v: bigint, decimals: number): string {
  if (decimals <= 0) return v.toString()
  const s = v.toString().padStart(decimals + 1, '0')
  const whole = s.slice(0, -decimals)
  const frac = s.slice(-decimals).replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms)
  })
  try {
    return await Promise.race([p, timeout])
  } finally {
    if (t) clearTimeout(t)
  }
}

/** A node answered one call with an error: a revert (the contract has no such function) is a fact about the token; anything else is transport. */
export class RpcError extends Error {
  constructor(message: string, readonly kind: 'revert' | 'transport') {
    super(message)
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export type RpcCall = { method: string; params: unknown[] }

export class BaseReader {
  private id = 0
  private readonly urls: string[]
  constructor(private readonly opts: SnapshotOptions) {
    this.urls = opts.rpcUrl ? [opts.rpcUrl] : opts.rpcUrls?.length ? opts.rpcUrls : DEFAULT_RPC_URLS
  }

  private get f() {
    return this.opts.fetchImpl ?? fetch
  }

  /** The node the answers came from, for the sources line. */
  usedUrl: string | null = null

  /**
   * All calls in one HTTP request. A transport failure - HTTP 4xx/5xx, a dropped connection, a rate-limit error on
   * any item, a malformed body - is retried once on the same node, then the whole batch moves to the next node.
   * Reverts come back per item as RpcError('revert') and never fail the batch.
   */
  async batch(calls: RpcCall[]): Promise<(string | RpcError)[]> {
    let last: unknown = new RpcError('rpc: no node configured', 'transport')
    for (const url of this.urls) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const out = await this.post(url, calls)
          this.usedUrl = url
          return out
        } catch (e) {
          last = e
          if (attempt === 0) await sleep(this.opts.retryDelayMs ?? 400)
        }
      }
    }
    throw last
  }

  private async post(url: string, calls: RpcCall[]): Promise<(string | RpcError)[]> {
    const ids = calls.map(() => ++this.id)
    const body = calls.map((c, i) => ({ jsonrpc: '2.0', id: ids[i], method: c.method, params: c.params }))
    const res = await withTimeout(this.f(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), this.opts.timeoutMs ?? 8_000, `rpc batch to ${url}`)
    if (res.status >= 400) throw new RpcError(`rpc ${url}: HTTP ${res.status}`, 'transport')
    const json = (await res.json()) as unknown
    if (!Array.isArray(json)) throw new RpcError(`rpc ${url}: batch answered with a non-array`, 'transport')
    const byId = new Map((json as { id?: number }[]).map((r) => [r.id, r as { id?: number; result?: unknown; error?: { message?: string; code?: number } }]))
    const out = calls.map((c, i) => {
      const r = byId.get(ids[i])
      if (!r) return new RpcError(`rpc ${c.method}: no answer in the batch`, 'transport')
      if (r.error) {
        const msg = r.error.message ?? 'error'
        const rateLimited = r.error.code === -32016 || r.error.code === 429 || /rate limit|too many|limit exceeded|capacity/i.test(msg)
        const revert = r.error.code === 3 || /revert|execution|invalid opcode|out of gas|invalid jump/i.test(msg)
        return new RpcError(`rpc ${c.method}: ${msg}`, rateLimited ? 'transport' : revert ? 'revert' : 'transport')
      }
      if (typeof r.result !== 'string') return new RpcError(`rpc ${c.method}: malformed answer`, 'transport')
      return r.result
    })
    const transport = out.find((o): o is RpcError => o instanceof RpcError && o.kind === 'transport')
    if (transport) throw transport
    return out
  }

  /** Every DEX Screener pair on Base for the token, or [] when the index has none or does not answer twice. */
  async pairs(token: string): Promise<DexPair[]> {
    const once = async (): Promise<DexPair[] | null> => {
      const res = await withTimeout(this.f(`${this.opts.dexUrl ?? DEX_SCREENER_URL}${token}`, { headers: { accept: 'application/json' } }), this.opts.timeoutMs ?? 8_000, 'dexscreener')
      if (res.status >= 400) return null
      const json = (await res.json()) as { pairs?: DexPair[] }
      return (json.pairs ?? []).filter((p) => p.chainId === 'base')
    }
    try {
      const first = await once().catch(() => null)
      if (first) return first
      await sleep(this.opts.retryDelayMs ?? 400)
      return (await once()) ?? []
    } catch {
      return []
    }
  }
}

/** The USD price of `token` implied by one pair: DEX Screener quotes priceUsd for the BASE token only. */
export function priceFromPair(pair: DexPair, token: string): { price: number; token_is: 'base' | 'quote' } | null {
  const t = token.toLowerCase()
  const usd = Number(pair.priceUsd)
  if (!Number.isFinite(usd) || usd <= 0) return null
  if (pair.baseToken?.address?.toLowerCase() === t) return { price: usd, token_is: 'base' }
  if (pair.quoteToken?.address?.toLowerCase() === t) {
    const native = Number(pair.priceNative)
    if (!Number.isFinite(native) || native <= 0) return null
    return { price: usd / native, token_is: 'quote' }
  }
  return null
}

/** The deepest pool that prices the token. */
export function bestPair(pairs: DexPair[], token: string): { pair: DexPair; price: number; token_is: 'base' | 'quote' } | null {
  let best: { pair: DexPair; price: number; token_is: 'base' | 'quote'; liq: number } | null = null
  for (const pair of pairs) {
    const p = priceFromPair(pair, token)
    if (!p) continue
    const liq = Number(pair.liquidity?.usd ?? 0)
    if (!best || liq > best.liq) best = { pair, price: p.price, token_is: p.token_is, liq }
  }
  return best ? { pair: best.pair, price: best.price, token_is: best.token_is } : null
}

const round = (n: number, places: number) => (Number.isFinite(n) ? Number(n.toFixed(places)) : n)
const str = (x: string | RpcError) => (x instanceof RpcError ? null : decodeString(x))
const uint = (x: string | RpcError) => (x instanceof RpcError ? null : decodeUint(x))

export async function snapshot(token: string, wallet: string | null, opts: SnapshotOptions = {}): Promise<Snapshot> {
  const reader = new BaseReader(opts)
  const calls: RpcCall[] = [
    { method: 'eth_getCode', params: [token, 'latest'] },
    { method: 'eth_call', params: [{ to: token, data: SELECTOR.symbol }, 'latest'] },
    { method: 'eth_call', params: [{ to: token, data: SELECTOR.name }, 'latest'] },
    { method: 'eth_call', params: [{ to: token, data: SELECTOR.decimals }, 'latest'] },
    { method: 'eth_call', params: [{ to: token, data: SELECTOR.totalSupply }, 'latest'] },
    { method: 'eth_gasPrice', params: [] },
    ...(wallet ? [{ method: 'eth_call', params: [{ to: token, data: SELECTOR.balanceOf + pad32(wallet) }, 'latest'] }, { method: 'eth_getBalance', params: [wallet, 'latest'] }] : []),
  ]
  const [pairs, chain] = await Promise.all([reader.pairs(token), reader.batch(calls)])
  const [code, symbolRaw, nameRaw, decimalsRaw, supplyRaw, gasRaw, balanceRaw, ethRaw] = chain
  if (code instanceof RpcError || code === '0x') throw new Error(`${token} is not a contract on Base (no code at that address)`)
  const symbol = str(symbolRaw!)
  const name = str(nameRaw!)
  const dec = uint(decimalsRaw!)
  const decimals = dec === null || dec > 255n ? null : Number(dec)
  const totalSupply = uint(supplyRaw!)
  if (symbol === null && decimals === null) throw new Error(`${token} is a contract but not an ERC-20 on Base (symbol() and decimals() do not answer)`)
  const gasWei = uint(gasRaw!)
  const tokenBalance = wallet && balanceRaw ? uint(balanceRaw) : null
  const ethBalance = wallet && ethRaw ? uint(ethRaw) : null
  const best = bestPair(pairs, token)
  const places = best ? (best.price >= 1 ? 4 : 8) : 4
  return {
    chain: 'base',
    chain_id: 8453,
    token: { address: token, symbol, name, decimals, total_supply: totalSupply !== null && decimals !== null ? formatUnits(totalSupply, decimals) : null },
    price_usd: best ? round(best.price, places) : null,
    price_source: best
      ? {
          dex: best.pair.dexId ?? null,
          pair_address: best.pair.pairAddress ?? null,
          pair_url: best.pair.url ?? null,
          base: best.pair.baseToken?.symbol ?? null,
          quote: best.pair.quoteToken?.symbol ?? null,
          token_is: best.token_is,
          liquidity_usd: best.pair.liquidity?.usd ?? null,
          volume_24h_usd: best.pair.volume?.h24 ?? null,
          price_change_24h_pct: best.pair.priceChange?.h24 ?? null,
        }
      : null,
    price_note: best ? null : pairs.length ? 'DEX Screener lists pools for this token on Base but none carries a usable price' : 'no pool for this token on Base is known to DEX Screener; the on-chain facts are still here',
    pairs_on_base: pairs.length,
    gas_price_gwei: gasWei === null ? null : round(Number(gasWei) / 1e9, 6),
    wallet: wallet ? { address: wallet, token_balance: tokenBalance !== null && decimals !== null ? formatUnits(tokenBalance, decimals) : null, eth_balance: ethBalance !== null ? formatUnits(ethBalance, 18) : null } : null,
    sources: ['https://api.dexscreener.com (pools, price, volume)', `${reader.usedUrl ?? DEFAULT_RPC_URLS[0]} (contract reads, balances, gas)`],
    fetched_at: new Date((opts.now ?? Date.now)()).toISOString(),
  }
}

export function tokenSnapshot(opts: SnapshotOptions = {}): ServiceDef {
  return {
    key: 'token-snapshot',
    listing: {
      title: 'Base token market snapshot: live price, deepest pool, 24h volume and on-chain facts for one ERC-20 (no LLM)',
      description:
        'Send {"token": "0x..."} (an ERC-20 on Base; "eth", "weth", "usdc" and "cbbtc" work as aliases) and optionally {"wallet": "0x..."}. You get the token\'s symbol, name, decimals and total supply read from the chain; its USD price with the pool it comes from (the deepest on DEX Screener: dex, pair address, liquidity, 24h volume, 24h change, and whether the token is the base or the quote of that pool); the current gas price; and, with a wallet, its balance of the token and of ETH. Public sources read at the moment of the job, no key, no LLM: the reach a sandboxed agent lacks. Data, not advice; a pool price can lag by seconds. Operated by Agent Souk (first_party).',
      category: 'data',
      tags: ['base', 'crypto', 'market-data', 'price', 'erc20', 'onchain', 'dex', 'deterministic'],
      price: 2_000,
      input_schema: {
        type: 'object',
        required: ['token'],
        properties: {
          token: { type: 'string', description: 'ERC-20 contract address on Base (0x + 40 hex), or one of the aliases eth, weth, usdc, cbbtc' },
          wallet: { type: 'string', description: 'Optional EVM address whose balance of the token and of ETH you want', pattern: '^0x[0-9a-fA-F]{40}$' },
        },
      },
      output_schema: {
        type: 'object',
        properties: {
          chain: { type: 'string', enum: ['base'] },
          chain_id: { type: 'integer' },
          token: { type: 'object', properties: { address: { type: 'string' }, symbol: { type: ['string', 'null'] }, name: { type: ['string', 'null'] }, decimals: { type: ['integer', 'null'] }, total_supply: { type: ['string', 'null'], description: 'whole tokens, decimal string' } } },
          price_usd: { type: ['number', 'null'] },
          price_source: { type: ['object', 'null'], properties: { dex: { type: ['string', 'null'] }, pair_address: { type: ['string', 'null'] }, pair_url: { type: ['string', 'null'] }, base: { type: ['string', 'null'] }, quote: { type: ['string', 'null'] }, token_is: { type: ['string', 'null'], enum: ['base', 'quote', null] }, liquidity_usd: { type: ['number', 'null'] }, volume_24h_usd: { type: ['number', 'null'] }, price_change_24h_pct: { type: ['number', 'null'] } } },
          price_note: { type: ['string', 'null'] },
          pairs_on_base: { type: 'integer' },
          gas_price_gwei: { type: ['number', 'null'] },
          wallet: { type: ['object', 'null'], properties: { address: { type: 'string' }, token_balance: { type: ['string', 'null'] }, eth_balance: { type: ['string', 'null'] } } },
          sources: { type: 'array', items: { type: 'string' } },
          fetched_at: { type: 'string', format: 'date-time' },
        },
      },
      example_input: { token: 'weth' },
      example_output: {
        chain: 'base',
        chain_id: 8453,
        token: { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', name: 'Wrapped Ether', decimals: 18, total_supply: '244772.689680834200077641' },
        price_usd: 2478.18,
        price_source: { dex: 'uniswap', pair_address: '0x6c561B446416E1A00E8E93E221854d6eA4171372', pair_url: 'https://dexscreener.com/base/0x6c561b446416e1a00e8e93e221854d6ea4171372', base: 'WETH', quote: 'USDC', token_is: 'base', liquidity_usd: 120112805.72, volume_24h_usd: 48501109.22, price_change_24h_pct: -1.75 },
        price_note: null,
        pairs_on_base: 22,
        gas_price_gwei: 0.006,
        wallet: null,
        sources: ['https://api.dexscreener.com (pools, price, volume)', 'https://base-rpc.publicnode.com (contract reads, balances, gas)'],
        fetched_at: '2026-09-14T01:10:00.000Z',
      },
      turnaround_seconds: 60,
      accept_timeout_seconds: 300,
      max_open_jobs: 50,
    },
    validate(input) {
      if (!resolveToken(input.token)) return 'token must be an ERC-20 contract address on Base (0x + 40 hex) or one of the aliases eth, weth, usdc, cbbtc'
      if (input.wallet !== undefined && !isAddress(input.wallet)) return 'wallet must be an EVM address (0x + 40 hex)'
      return null
    },
    async run(input) {
      const token = resolveToken(input.token)!
      const wallet = isAddress(input.wallet) ? input.wallet : null
      const s = await snapshot(token, wallet, opts)
      const sym = s.token.symbol ?? token.slice(0, 10)
      const priceLine = s.price_usd !== null ? `${s.price_usd} USD` : 'no pool price'
      const poolLine = s.price_source ? ` (${s.price_source.dex} ${s.price_source.base}/${s.price_source.quote}, ${Math.round((s.price_source.liquidity_usd ?? 0) / 1000)}k USD liquidity)` : ''
      return {
        output: s,
        preview: { symbol: s.token.symbol, price_usd: s.price_usd, liquidity_usd: s.price_source?.liquidity_usd ?? null, pairs_on_base: s.pairs_on_base, wallet: s.wallet ? { token_balance: s.wallet.token_balance, eth_balance: s.wallet.eth_balance } : null },
        message: `${sym}: ${priceLine}${poolLine}; ${s.pairs_on_base} pool(s) on Base, gas ${s.gas_price_gwei ?? '?'} gwei.`,
      }
    },
  }
}
