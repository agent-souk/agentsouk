import { keccak_256 } from '@noble/hashes/sha3.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'
import { CHAINS, encodeBalanceOf, encodeTransfer, privateKeyToAddress, rlpEncode, signEip1559, toChecksumAddress, UsdcWallet, type RpcFetch } from './usdc.js'

const PK = '0x' + '11'.repeat(32)
// Produced independently with viem 2.56.3 (privateKeyToAccount(PK).signTransaction({...})) for exactly these fields.
const VIEM = {
  address: '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A',
  data: '0xa9059cbb000000000000000000000000a0a2494006b72109137630bc026434a809731c07000000000000000000000000000000000000000000000000000000000012d687',
  raw: '0x02f8b183014a3407830f4240847735940082ea6094036cbd53842c5426634e7929541ec2318f3dcf7e80b844a9059cbb000000000000000000000000a0a2494006b72109137630bc026434a809731c07000000000000000000000000000000000000000000000000000000000012d687c080a08b298c8c8f0bf3b7bab42b68ff9a702e73e66189ae8b8a1d104057dc76989d63a0357272e683aeb7e3d17994ccee4e1f4165e1d2e5b3a86fa06fd8d61b3d8c430d',
  hash: '0x7b8809b54ab7d4fe7294248f09c5df00b42d4bca7278f5a092061c9caa613fd2',
}
const hex = (b: Uint8Array) => '0x' + bytesToHex(b)

describe('encoding', () => {
  it('RLP matches the reference vectors', () => {
    expect(hex(rlpEncode(new TextEncoder().encode('dog')))).toBe('0x83646f67')
    expect(hex(rlpEncode(new Uint8Array(0)))).toBe('0x80')
    expect(hex(rlpEncode([new TextEncoder().encode('cat'), new TextEncoder().encode('dog')]))).toBe('0xc88363617483646f67')
    expect(hex(rlpEncode(hexToBytes('0400')))).toBe('0x820400')
    expect(hex(rlpEncode([]))).toBe('0xc0')
    expect(hex(rlpEncode(new Uint8Array(56).fill(1)))).toBe('0xb838' + '01'.repeat(56))
  })

  it('derives the address, the calldata and a signed EIP-1559 transaction identical to viem', () => {
    expect(privateKeyToAddress(PK)).toBe(VIEM.address)
    const data = encodeTransfer('0xA0a2494006B72109137630bC026434a809731c07', 1234567n)
    expect(hex(data)).toBe(VIEM.data)
    const r = signEip1559({ chainId: 84532, nonce: 7, maxPriorityFeePerGas: 1_000_000n, maxFeePerGas: 2_000_000_000n, gasLimit: 60_000n, to: CHAINS.test.usdc, value: 0n, data }, PK)
    expect(r.raw).toBe(VIEM.raw)
    expect(r.hash).toBe(VIEM.hash)
    expect(hex(encodeBalanceOf(VIEM.address))).toBe('0x70a0823100000000000000000000000019e7e376e7c213b7e7e7e46cc70a5dd086daff2a')
    expect(toChecksumAddress('0xa0a2494006b72109137630bc026434a809731c07')).toBe('0xA0a2494006B72109137630bC026434a809731c07')
    expect(() => encodeTransfer('0x1234', 1n)).toThrow(/not an address/)
  })
})

type Handlers = Record<string, (params: unknown[]) => unknown>
function fakeRpc(handlers: Handlers) {
  const calls: { method: string; params: unknown[] }[] = []
  const f: RpcFetch = async (_url, body) => {
    const req = JSON.parse(body) as { id: number; method: string; params: unknown[] }
    calls.push({ method: req.method, params: req.params })
    const h = handlers[req.method]
    if (!h) return { status: 200, json: async () => ({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'method not found' } }) }
    return { status: 200, json: async () => ({ jsonrpc: '2.0', id: req.id, result: h(req.params) }) }
  }
  return { f, calls }
}

const base: Handlers = {
  eth_call: () => '0x' + (50_000_000n).toString(16), // 50 USDC
  eth_getBalance: () => '0x' + (10n ** 16n).toString(16),
  eth_getTransactionCount: () => '0x7',
  eth_getBlockByNumber: () => ({ baseFeePerGas: '0x3b9aca00' }),
  eth_maxPriorityFeePerGas: () => '0xf4240',
  eth_estimateGas: () => '0xb000',
  eth_sendRawTransaction: (p) => hex(keccak_256(hexToBytes(String(p[0]).slice(2)))),
}

describe('UsdcWallet', () => {
  it('sends a transfer with a fresh nonce, a 30% gas margin and the node-confirmed hash', async () => {
    const rpc = fakeRpc(base)
    const w = new UsdcWallet(PK, CHAINS.test, { fetchImpl: rpc.f })
    expect(w.address).toBe(VIEM.address)
    expect(await w.usdcBalance()).toBe(50_000_000n)
    const r = await w.transfer('0xA0a2494006B72109137630bC026434a809731c07', 1_234_567n)
    expect(r.nonce).toBe(7)
    expect(r.hash).toMatch(/^0x[0-9a-f]{64}$/)
    expect(r.explorer).toBe(CHAINS.test.explorerTx + r.hash)
    const sent = rpc.calls.find((c) => c.method === 'eth_sendRawTransaction')!
    expect(String(sent.params[0]).startsWith('0x02')).toBe(true)
    const est = rpc.calls.find((c) => c.method === 'eth_estimateGas')!
    expect(est.params[0]).toMatchObject({ from: VIEM.address, to: CHAINS.test.usdc })
  })

  it('refuses unsafe transfers before touching the chain', async () => {
    const rpc = fakeRpc(base)
    const w = new UsdcWallet(PK, CHAINS.test, { fetchImpl: rpc.f, maxPerTransfer: 5_000_000n })
    await expect(w.transfer('nope', 1n)).rejects.toThrow(/plain address/)
    await expect(w.transfer(VIEM.address, 1n)).rejects.toThrow(/itself/)
    await expect(w.transfer('0xA0a2494006B72109137630bC026434a809731c07', 0n)).rejects.toThrow(/positive/)
    await expect(w.transfer('0xA0a2494006B72109137630bC026434a809731c07', 5_000_001n)).rejects.toThrow(/per-transfer cap/)
    expect(rpc.calls).toHaveLength(0)
    const poor = fakeRpc({ ...base, eth_call: () => '0x0' })
    await expect(new UsdcWallet(PK, CHAINS.test, { fetchImpl: poor.f }).transfer('0xA0a2494006B72109137630bC026434a809731c07', 1n)).rejects.toThrow(/insufficient USDC/)
    const noGas = fakeRpc({ ...base, eth_getBalance: () => '0x0' })
    await expect(new UsdcWallet(PK, CHAINS.test, { fetchImpl: noGas.f }).transfer('0xA0a2494006B72109137630bC026434a809731c07', 1n)).rejects.toThrow(/no ETH/)
    const liar = fakeRpc({ ...base, eth_sendRawTransaction: () => '0x' + 'ab'.repeat(32) })
    await expect(new UsdcWallet(PK, CHAINS.test, { fetchImpl: liar.f }).transfer('0xA0a2494006B72109137630bC026434a809731c07', 1n)).rejects.toThrow(/unexpected hash/)
    expect(() => new UsdcWallet('0x12', CHAINS.test)).toThrow(/64 hex/)
  })

  it('waits for the receipt and reports reverted transactions', async () => {
    let n = 0
    const rpc = fakeRpc({ eth_getTransactionReceipt: () => (++n < 3 ? null : { status: '0x1', blockNumber: '0x10' }) })
    const slept: number[] = []
    const w = new UsdcWallet(PK, CHAINS.test, { fetchImpl: rpc.f, sleep: async (ms) => void slept.push(ms) })
    expect(await w.waitForReceipt('0x' + 'ab'.repeat(32), { intervalMs: 5 })).toEqual({ status: 'success', blockNumber: 16n })
    expect(slept).toEqual([5, 5])
    const bad = fakeRpc({ eth_getTransactionReceipt: () => ({ status: '0x0', blockNumber: '0x11' }) })
    expect((await new UsdcWallet(PK, CHAINS.test, { fetchImpl: bad.f }).waitForReceipt('0x' + 'ab'.repeat(32))).status).toBe('reverted')
    const never = fakeRpc({ eth_getTransactionReceipt: () => null })
    await expect(new UsdcWallet(PK, CHAINS.test, { fetchImpl: never.f, sleep: async () => undefined }).waitForReceipt('0x' + 'ab'.repeat(32), { timeoutMs: 0, intervalMs: 1 })).rejects.toThrow(/not mined/)
  })
})
