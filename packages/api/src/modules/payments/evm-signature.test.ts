import { describe, it, expect } from 'vitest'
import { bytesToHex } from '@noble/hashes/utils.js'
import { eip191Hash, privateKeyToAddress, recoverAddress, signMessage, verifyWalletSignature } from './evm-signature.js'
import { _setRpcFetchForTests } from './chain.js'

// Hardhat/Anvil account #0: a public test key, never holds real funds.
const PRIV = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
// viem: signMessage({ message: 'hello world' }) with that key
const VIEM_SIG = '0xa461f509887bd19e312c0c58467ce8ff8e300d3c1a90b608a760c5b80318eaf15fe57c96f9175d6cd4daad4663763baa7e78836e067d0163e9a2ccf2ff753f5b1b'

describe('EVM wallet signatures (EIP-191 / EIP-1271)', () => {
  it('derives the address of a private key and hashes messages per EIP-191', () => {
    expect(privateKeyToAddress(PRIV)).toBe(ADDR)
    expect(bytesToHex(eip191Hash('hello world'))).toBe('d9eba16ed0ecae432b71fe008c98cc872bb4cc214d3220a36f365326cf807d68')
  })

  it('recovers the signer from a viem-produced personal_sign signature', () => {
    expect(recoverAddress('hello world', VIEM_SIG)).toBe(ADDR)
    expect(recoverAddress('hello world!', VIEM_SIG)).not.toBe(ADDR)
    expect(recoverAddress('hello world', VIEM_SIG.slice(0, -2))).toBeUndefined()
    expect(recoverAddress('hello world', 42)).toBeUndefined()
    // v encoded as 0/1 instead of 27/28 is accepted too
    const v01 = VIEM_SIG.slice(0, -2) + '00'
    expect(recoverAddress('hello world', v01)).toBe(ADDR)
  })

  it('round-trips our own signer (r||s||v with v = 27/28) and rejects tampering', () => {
    const msg = 'agentsouk:wallet:agt_test:' + ADDR.toLowerCase()
    const sig = signMessage(msg, PRIV)
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/)
    expect(recoverAddress(msg, sig)).toBe(ADDR)
    expect(recoverAddress(msg + 'x', sig)).not.toBe(ADDR)
  })

  it('verifyWalletSignature: EOA without touching the chain; contract wallets via EIP-1271 eth_call', async () => {
    const calls: string[] = []
    _setRpcFetchForTests(async (_url, body) => {
      const req = JSON.parse(body) as { id: number; method: string; params: any[] }
      calls.push(req.method)
      const to = String(req.params[0]?.to ?? '').toLowerCase()
      const data = String(req.params[0]?.data ?? '')
      const ok = to === '0x1111111111111111111111111111111111111111' && data.startsWith('0x1626ba7e')
      return { status: 200, json: async () => ({ jsonrpc: '2.0', id: req.id, result: ok ? '0x1626ba7e00000000000000000000000000000000000000000000000000000000' : '0x' }) }
    })
    const msg = 'agentsouk:wallet:agt_test:' + ADDR.toLowerCase()
    expect(await verifyWalletSignature('test', ADDR, msg, signMessage(msg, PRIV))).toBe(true)
    expect(calls).toHaveLength(0)
    // wrong EOA -> falls through to EIP-1271, which says no for an address without code
    expect(await verifyWalletSignature('test', '0x2222222222222222222222222222222222222222', msg, signMessage(msg, PRIV))).toBe(false)
    expect(calls).toEqual(['eth_call'])
    // a contract wallet that answers the magic value is accepted with an arbitrary signature blob
    expect(await verifyWalletSignature('test', '0x1111111111111111111111111111111111111111', msg, '0xdeadbeef')).toBe(true)
    expect(await verifyWalletSignature('test', '0x1111111111111111111111111111111111111111', msg, 'not hex')).toBe(false)
    _setRpcFetchForTests(undefined)
  })
})
