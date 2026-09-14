import { describe, it, expect } from 'vitest'
import { ALIASES, bestPair, decodeString, decodeUint, formatUnits, priceFromPair, resolveToken, snapshot, tokenSnapshot } from './token-snapshot.js'

const WETH = '0x4200000000000000000000000000000000000006'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const WALLET = '0xa75Cc8545B169F0BeF2f29c9CCF86bc686D039E8'

/** ABI-encode a string return value the way Solidity does. */
const abiString = (s: string) => {
  const hex = Buffer.from(s, 'utf8').toString('hex')
  return '0x' + (32).toString(16).padStart(64, '0') + s.length.toString(16).padStart(64, '0') + hex.padEnd(Math.ceil(hex.length / 64) * 64, '0')
}
const abiUint = (n: bigint) => '0x' + n.toString(16).padStart(64, '0')

const pairs = {
  pairs: [
    { chainId: 'base', dexId: 'uniswap', url: 'https://dexscreener.com/base/0xpair1', pairAddress: '0xpair1', baseToken: { address: WETH, symbol: 'WETH' }, quoteToken: { address: USDC, symbol: 'USDC' }, priceNative: '2478.14', priceUsd: '2478.14', liquidity: { usd: 120113143.68 }, volume: { h24: 48490404.38 }, priceChange: { h24: -1.12 } },
    { chainId: 'base', dexId: 'aerodrome', url: 'https://dexscreener.com/base/0xpair2', pairAddress: '0xpair2', baseToken: { address: WETH, symbol: 'WETH' }, quoteToken: { address: USDC, symbol: 'USDC' }, priceNative: '2484.40', priceUsd: '2484.40', liquidity: { usd: 8985172.35 }, volume: { h24: 10979508.26 }, priceChange: { h24: -1.0 } },
    { chainId: 'ethereum', dexId: 'uniswap', pairAddress: '0xnotbase', baseToken: { address: WETH, symbol: 'WETH' }, quoteToken: { address: USDC, symbol: 'USDC' }, priceUsd: '9999', liquidity: { usd: 1e9 } },
  ],
}

type Rpc = { id: number; method: string; params: unknown[] }
type Over = { pairs?: unknown; code?: string; fail?: 'dex' | 'rpc'; rateLimitedUrls?: string[]; revertName?: boolean }

/** A fetch that answers DEX Screener with canned pairs and the RPC (single or batch) by method; records what was asked. */
function fakeFetch(over: Over = {}) {
  const calls: { url: string; methods?: string[] }[] = []
  const one = (body: Rpc, url: string) => {
    const reply = (result: string) => ({ jsonrpc: '2.0', id: body.id, result })
    const error = (message: string, code: number) => ({ jsonrpc: '2.0', id: body.id, error: { message, code } })
    if (over.rateLimitedUrls?.includes(url) && body.method === 'eth_call') return error('over rate limit', -32016)
    if (body.method === 'eth_getCode') return reply(over.code ?? '0x6080')
    if (body.method === 'eth_gasPrice') return reply('0x5b8d80') // 6,000,000 wei = 0.006 gwei
    if (body.method === 'eth_getBalance') return reply('0x5543df729c000') // 0.0015 ETH, short hex like a real node
    if (body.method === 'eth_call') {
      const data = String((body.params[0] as { data: string }).data)
      if (data.startsWith('0x95d89b41')) return reply(abiString('WETH'))
      if (data.startsWith('0x06fdde03')) return over.revertName ? error('execution reverted', 3) : reply(abiString('Wrapped Ether'))
      if (data.startsWith('0x313ce567')) return reply(abiUint(18n))
      if (data.startsWith('0x18160ddd')) return reply(abiUint(129384201000000000000000n))
      if (data.startsWith('0x70a08231')) return reply(abiUint(12_102_000_000_000_000_000n))
    }
    return error('unknown method', -32601)
  }
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('dexscreener')) {
      calls.push({ url })
      if (over.fail === 'dex') return new Response('down', { status: 503 })
      return new Response(JSON.stringify(over.pairs ?? pairs), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const body = JSON.parse(String(init?.body)) as Rpc | Rpc[]
    const list = Array.isArray(body) ? body : [body]
    calls.push({ url, methods: list.map((b) => b.method) })
    if (over.fail === 'rpc') return new Response('down', { status: 502 })
    const answers = list.map((b) => one(b, url))
    return new Response(JSON.stringify(Array.isArray(body) ? answers : answers[0]), { status: 200 })
  }) as typeof fetch
  return { f, calls }
}

const fast = { retryDelayMs: 0, now: () => 0 }

describe('ABI helpers', () => {
  it('decodes strings, bytes32 symbols and uints', () => {
    expect(decodeString(abiString('Wrapped Ether'))).toBe('Wrapped Ether')
    expect(decodeString('0x' + Buffer.from('MKR').toString('hex').padEnd(64, '0'))).toBe('MKR')
    expect(decodeString('0x')).toBeNull()
    expect(decodeUint(abiUint(18n))).toBe(18n)
    expect(decodeUint('0x5b8d80')).toBe(6_000_000n)
    expect(decodeUint('0x')).toBeNull()
  })
  it('formats base units as decimal strings without trailing zeros', () => {
    expect(formatUnits(2478140000n, 6)).toBe('2478.14')
    expect(formatUnits(12_102_000_000_000_000_000n, 18)).toBe('12.102')
    expect(formatUnits(0n, 18)).toBe('0')
    expect(formatUnits(5n, 0)).toBe('5')
  })
})

describe('pairs and prices', () => {
  it('prices the token as the base of a pool, or as its quote via priceNative', () => {
    expect(priceFromPair(pairs.pairs[0]!, WETH)).toEqual({ price: 2478.14, token_is: 'base' })
    // USDC is the quote of that pool: its price is priceUsd / priceNative = 1
    expect(priceFromPair(pairs.pairs[0]!, USDC)).toEqual({ price: 1, token_is: 'quote' })
    expect(priceFromPair(pairs.pairs[0]!, '0x' + '1'.repeat(40))).toBeNull()
  })
  it('picks the deepest pool on Base and ignores other chains', () => {
    const b = bestPair(pairs.pairs.filter((p) => p.chainId === 'base'), WETH)!
    expect(b.pair.dexId).toBe('uniswap')
    expect(b.price).toBe(2478.14)
  })
  it('resolves aliases and rejects anything that is not an address', () => {
    expect(resolveToken('ETH')).toBe(ALIASES.eth)
    expect(resolveToken(' usdc ')).toBe(USDC)
    expect(resolveToken(WETH)).toBe(WETH)
    expect(resolveToken('0x123')).toBeNull()
    expect(resolveToken(42)).toBeNull()
  })
})

describe('snapshot', () => {
  it('reads the chain in one batch and the pool, with a wallet', async () => {
    const { f, calls } = fakeFetch()
    const s = await snapshot(WETH, WALLET, { fetchImpl: f, rpcUrl: 'https://node.example', ...fast })
    expect(s.token).toEqual({ address: WETH, symbol: 'WETH', name: 'Wrapped Ether', decimals: 18, total_supply: '129384.201' })
    expect(s.price_usd).toBe(2478.14)
    expect(s.price_source).toMatchObject({ dex: 'uniswap', pair_address: '0xpair1', base: 'WETH', quote: 'USDC', token_is: 'base', liquidity_usd: 120113143.68, volume_24h_usd: 48490404.38, price_change_24h_pct: -1.12 })
    expect(s.pairs_on_base).toBe(2) // the ethereum pair is not counted
    expect(s.gas_price_gwei).toBe(0.006)
    expect(s.wallet).toEqual({ address: WALLET, token_balance: '12.102', eth_balance: '0.0015' })
    expect(s.fetched_at).toBe('1970-01-01T00:00:00.000Z')
    expect(s.sources[1]).toContain('https://node.example')
    // one HTTP request to the node carried all eight reads
    const rpc = calls.filter((c) => c.methods)
    expect(rpc).toHaveLength(1)
    expect(rpc[0]!.methods).toEqual(['eth_getCode', 'eth_call', 'eth_call', 'eth_call', 'eth_call', 'eth_gasPrice', 'eth_call', 'eth_getBalance'])
  })
  it('moves the whole batch to the next node when one rate-limits inside the batch', async () => {
    const { f, calls } = fakeFetch({ rateLimitedUrls: ['https://a.example'] })
    const s = await snapshot(WETH, null, { fetchImpl: f, rpcUrls: ['https://a.example', 'https://b.example'], ...fast })
    expect(s.token.symbol).toBe('WETH')
    expect(s.sources[1]).toContain('https://b.example')
    expect(calls.filter((c) => c.methods).map((c) => c.url)).toEqual(['https://a.example', 'https://a.example', 'https://b.example'])
  })
  it('a revert on one read is a fact about the token, not a failure', async () => {
    const { f } = fakeFetch({ revertName: true })
    const s = await snapshot(WETH, null, { fetchImpl: f, rpcUrl: 'https://node.example', ...fast })
    expect(s.token.symbol).toBe('WETH')
    expect(s.token.name).toBeNull()
  })
  it('still delivers the on-chain facts when DEX Screener is down, and says so', async () => {
    const { f } = fakeFetch({ fail: 'dex' })
    const s = await snapshot(WETH, null, { fetchImpl: f, rpcUrl: 'https://node.example', ...fast })
    expect(s.price_usd).toBeNull()
    expect(s.price_source).toBeNull()
    expect(s.price_note).toContain('no pool')
    expect(s.token.symbol).toBe('WETH')
    expect(s.wallet).toBeNull()
  })
  it('refuses an address that is not a contract, and fails the job when no node answers', async () => {
    await expect(snapshot(WETH, null, { fetchImpl: fakeFetch({ code: '0x' }).f, rpcUrl: 'https://node.example', ...fast })).rejects.toThrow(/not a contract/)
    await expect(snapshot(WETH, null, { fetchImpl: fakeFetch({ fail: 'rpc' }).f, rpcUrls: ['https://a.example', 'https://b.example'], ...fast })).rejects.toThrow(/HTTP 502/)
  })
})

describe('tokenSnapshot service', () => {
  it('validates input and runs with the resolved token', async () => {
    const svc = tokenSnapshot({ fetchImpl: fakeFetch().f, rpcUrl: 'https://node.example', ...fast })
    expect(svc.key).toBe('token-snapshot')
    expect(svc.listing.price).toBe(2_000)
    expect(svc.listing.pricing_model ?? 'fixed').toBe('fixed')
    expect(svc.listing.title.length).toBeLessThanOrEqual(120)
    expect(await svc.validate({}, { units: 1 })).toMatch(/token must be/)
    expect(await svc.validate({ token: 'weth', wallet: 'nope' }, { units: 1 })).toMatch(/wallet must be/)
    expect(await svc.validate({ token: 'weth' }, { units: 1 })).toBeNull()
    const r = await svc.run({ token: 'weth', wallet: WALLET }, { units: 1 })
    const out = r.output as { token: { address: string }; price_usd: number }
    expect(out.token.address).toBe(WETH)
    expect(out.price_usd).toBe(2478.14)
    expect(r.preview).toMatchObject({ symbol: 'WETH', price_usd: 2478.14, pairs_on_base: 2, wallet: { token_balance: '12.102' } })
    expect(r.message).toContain('WETH: 2478.14 USD (uniswap WETH/USDC, 120113k USD liquidity)')
  })
  it("the example output has exactly the fields the listing's output schema names", () => {
    const svc = tokenSnapshot()
    const ex = svc.listing.example_output as Record<string, unknown>
    const props = (svc.listing.output_schema as { properties: Record<string, unknown> }).properties
    expect(Object.keys(ex).sort()).toEqual(Object.keys(props).sort())
  })
})
