import { describe, it, expect, beforeEach } from 'vitest'
import { _setConfigForTests } from '../../config.js'
import { _setRpcFetchForTests, decodeUsdcTransfers, isTxHash, verifyUsdcTransfer } from './chain.js'
import { normalizeEvmAddress, sameAddress, toChecksumAddress } from './address.js'
import { formatUsdc, paymentTerms, CHAINS, TRANSFER_TOPIC } from './x402.js'
import { FakeChain } from '../../test/chain.js'

const A = '0x1111111111111111111111111111111111111111'
const B = '0x2222222222222222222222222222222222222222'

describe('addresses', () => {
  it('checksums (EIP-55), accepts lowercase/uppercase, rejects wrong mixed case', () => {
    const lower = '0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359'
    const checksummed = '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359'
    expect(toChecksumAddress(lower)).toBe(checksummed)
    expect(normalizeEvmAddress(lower)).toBe(checksummed)
    expect(normalizeEvmAddress(lower.toUpperCase().replace('0X', '0x'))).toBe(checksummed)
    expect(normalizeEvmAddress(checksummed)).toBe(checksummed)
    expect(normalizeEvmAddress('0xFb6916095ca1df60bB79Ce92cE3Ea74c37c5d359')).toBeUndefined()
    expect(normalizeEvmAddress('0x123')).toBeUndefined()
    expect(normalizeEvmAddress(42)).toBeUndefined()
    expect(sameAddress(lower, checksummed)).toBe(true)
    expect(sameAddress(lower, null)).toBe(false)
  })
})

describe('x402 terms and formatting', () => {
  it('formats USDC minor units and builds v2 requirements with the seller as payTo', () => {
    expect(formatUsdc(250000)).toBe('0.250000 USDC')
    expect(formatUsdc(1)).toBe('0.000001 USDC')
    expect(formatUsdc(1_000_000)).toBe('1.000000 USDC')
    expect(formatUsdc(null)).toBe('quote')
    const t = paymentTerms({ env: 'live', amount: 250000, payTo: A, resourceUrl: 'https://x/pay', description: 'd' })
    expect(t).toMatchObject({ network: 'eip155:8453', chainId: 8453, asset: CHAINS['eip155:8453'].usdc, payTo: A, facilitator: 'https://facilitator.payai.network' })
    expect(t.x402.accepts[0]!).toMatchObject({ scheme: 'exact', amount: '250000', payTo: A, extra: { name: 'USD Coin', version: '2' } })
    expect(paymentTerms({ env: 'test', amount: 1, payTo: A, resourceUrl: 'u', description: 'd' }).x402.accepts[0]!.extra.name).toBe('USDC')
  })
})

describe('chain reader', () => {
  let chain: FakeChain
  beforeEach(() => {
    chain = new FakeChain('test')
    _setRpcFetchForTests(chain.fetch)
    _setConfigForTests({ PAYMENT_CONFIRMATIONS_TEST: 1 })
  })

  it('validates hashes and decodes Transfer logs (address padding, bigint data)', () => {
    expect(isTxHash('0x' + 'ab'.repeat(32))).toBe(true)
    expect(isTxHash('0x' + 'ab'.repeat(31))).toBe(false)
    expect(isTxHash('ab'.repeat(32))).toBe(true) // bare 64-hex is accepted (web3.py HexBytes.hex())
    expect(isTxHash('ab'.repeat(31))).toBe(false)
    const usdc = CHAINS['eip155:84532'].usdc
    const pad = (a: string) => '0x' + a.slice(2).padStart(64, '0')
    const receipt = {
      status: '0x1',
      blockNumber: '0x10',
      logs: [
        { address: usdc, topics: [TRANSFER_TOPIC, pad(A), pad(B)], data: '0x' + (250000).toString(16).padStart(64, '0') },
        { address: usdc.toLowerCase(), topics: [TRANSFER_TOPIC, pad(B), pad(A)], data: '0x' + (7).toString(16).padStart(64, '0') },
        { address: '0x3333333333333333333333333333333333333333', topics: [TRANSFER_TOPIC, pad(A), pad(B)], data: '0x1' },
        { address: usdc, topics: ['0xdeadbeef'], data: '0x1' },
        { address: usdc, topics: [TRANSFER_TOPIC, pad(A), pad(B)], data: '0x' },
      ],
    }
    const transfers = decodeUsdcTransfers(receipt, usdc)
    expect(transfers).toEqual([
      { from: A, to: B, value: 250000n },
      { from: B, to: A, value: 7n },
      { from: A, to: B, value: 0n },
    ])
  })

  it('verifies a matching transfer and reports block, confirmations and the summed amount', async () => {
    const ts = Date.now() - 5000
    const tx = chain.mine([{ from: A, to: B, value: 100 }, { from: A, to: B, value: 50 }, { from: B, to: A, value: 20 }], { timestamp: ts, confirmations: 4 })
    const v = await verifyUsdcTransfer('test', tx, { from: A, to: B, minAmount: 130, notBefore: ts - 2000 })
    expect(v).toMatchObject({ transaction: tx, from: toChecksumAddress(A), to: toChecksumAddress(B), amount: 130, network: 'eip155:84532', confirmations: 4 })
    expect(v.blockTimestamp).toBe(Math.floor(ts / 1000) * 1000)
    expect(v.asset).toBe(CHAINS['eip155:84532'].usdc)
  })

  it('nets out transfers back to the sender in the same transaction and accepts bare 64-hex hashes', async () => {
    const roundTrip = chain.mine([{ from: A, to: B, value: 500 }, { from: B, to: A, value: 500 }])
    await expect(verifyUsdcTransfer('test', roundTrip, { from: A, to: B, minAmount: 1 })).rejects.toMatchObject({ code: 'payment_invalid', opts: { details: { reason: 'amount_too_low', transferred: '0' } } })
    const partlyBack = chain.mine([{ from: A, to: B, value: 500 }, { from: B, to: A, value: 200 }])
    expect((await verifyUsdcTransfer('test', partlyBack, { from: A, to: B, minAmount: 300 })).amount).toBe(300)
    const bare = chain.pay(A, B, 7).slice(2)
    expect((await verifyUsdcTransfer('test', bare, { from: A, to: B, minAmount: 7 })).transaction).toBe('0x' + bare)
    // any of several recipients satisfies the check (frozen job address + current wallet)
    expect((await verifyUsdcTransfer('test', chain.pay(A, B, 7), { from: A, to: ['0x3333333333333333333333333333333333333333', B], minAmount: 7 })).to).toBe(toChecksumAddress(B))
    // malformed node data is 502, not 500
    _setRpcFetchForTests(async (_u, body) => {
      const req = JSON.parse(body)
      const result = req.method === 'eth_getTransactionReceipt' ? { status: '0x1', blockNumber: 'not-hex', logs: 'nope' } : '0x10'
      return { status: 200, json: async () => ({ jsonrpc: '2.0', id: req.id, result }) }
    })
    await expect(verifyUsdcTransfer('test', '0x' + 'a'.repeat(64), { from: A, to: B, minAmount: 1 })).rejects.toMatchObject({ code: 'chain_unavailable' })
    _setRpcFetchForTests(chain.fetch)
  })

  it('maps every failure to an agent-readable error', async () => {
    const code = async (p: Promise<unknown>) => p.then(() => 'ok').catch((e) => `${e.status}:${e.code}:${e.opts?.details?.reason ?? ''}`)
    expect(await code(verifyUsdcTransfer('test', 'zzz', { from: A, to: B, minAmount: 1 }))).toBe('400:invalid_request:')
    expect(await code(verifyUsdcTransfer('test', '0x' + '0'.repeat(64), { from: A, to: B, minAmount: 1 }))).toBe('409:transaction_not_found:')
    expect(await code(verifyUsdcTransfer('test', chain.pay(A, B, 5, { status: '0x0' }), { from: A, to: B, minAmount: 1 }))).toBe('402:payment_invalid:reverted')
    expect(await code(verifyUsdcTransfer('test', chain.pay(A, B, 5, { asset: '0x3333333333333333333333333333333333333333' }), { from: A, to: B, minAmount: 1 }))).toBe('402:payment_invalid:wrong_asset')
    expect(await code(verifyUsdcTransfer('test', chain.pay(A, A, 5), { from: A, to: B, minAmount: 1 }))).toBe('402:payment_invalid:wrong_recipient')
    expect(await code(verifyUsdcTransfer('test', chain.pay(B, B, 5), { from: A, to: B, minAmount: 1 }))).toBe('402:payment_invalid:wrong_sender')
    expect(await code(verifyUsdcTransfer('test', chain.pay(A, B, 5), { from: A, to: B, minAmount: 6 }))).toBe('402:payment_invalid:amount_too_low')
    expect(await code(verifyUsdcTransfer('test', chain.pay(A, B, 5, { timestamp: 1000 }), { from: A, to: B, minAmount: 1, notBefore: 5000 }))).toBe('402:payment_invalid:too_old')
    _setConfigForTests({ PAYMENT_CONFIRMATIONS_TEST: 2 })
    expect(await code(verifyUsdcTransfer('test', chain.pay(A, B, 5, { confirmations: 1 }), { from: A, to: B, minAmount: 1 }))).toBe('409:transaction_pending:')
    _setConfigForTests({ PAYMENT_CONFIRMATIONS_TEST: 1 })
    chain.down = true
    expect(await code(verifyUsdcTransfer('test', chain.pay(A, B, 5), { from: A, to: B, minAmount: 1 }))).toBe('502:chain_unavailable:ECONNREFUSED')
    chain.down = false
    _setRpcFetchForTests(async () => ({ status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'rate limited' } }) }))
    expect((await code(verifyUsdcTransfer('test', '0x' + 'a'.repeat(64), { from: A, to: B, minAmount: 1 }))).startsWith('502:chain_unavailable:')).toBe(true)
    _setRpcFetchForTests(async () => ({ status: 503, json: async () => ({}) }))
    expect((await code(verifyUsdcTransfer('test', '0x' + 'a'.repeat(64), { from: A, to: B, minAmount: 1 }))).startsWith('502:chain_unavailable:')).toBe(true)
  })
})
