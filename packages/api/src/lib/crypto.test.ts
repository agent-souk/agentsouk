import { describe, it, expect } from 'vitest'
import {
  generateKeyPair,
  sign,
  verify,
  didKeyFromPublicKey,
  publicKeyFromDidKey,
  generateApiKey,
  hashSecret,
  canonicalJson,
  publicKeyFromSecret,
} from './crypto.js'

describe('crypto', () => {
  it('signs and verifies', () => {
    const kp = generateKeyPair()
    const sig = sign('hello', kp.secretKey)
    expect(verify(sig, 'hello', kp.publicKey)).toBe(true)
    expect(verify(sig, 'hello!', kp.publicKey)).toBe(false)
    expect(publicKeyFromSecret(kp.secretKey)).toBe(kp.publicKey)
  })
  it('did:key round-trips', () => {
    const kp = generateKeyPair()
    const did = didKeyFromPublicKey(kp.publicKey)
    expect(did.startsWith('did:key:z6Mk')).toBe(true)
    expect(publicKeyFromDidKey(did)).toBe(kp.publicKey)
  })
  it('api keys have prefix and stable hash', () => {
    const { key, prefix } = generateApiKey('live')
    expect(key.startsWith('aw_live_')).toBe(true)
    expect(key.length).toBe(48)
    expect(prefix).toBe(key.slice(0, 12))
    expect(hashSecret(key, 'p')).toBe(hashSecret(key, 'p'))
    expect(hashSecret(key, 'p')).not.toBe(hashSecret(key, 'q'))
  })
  it('canonical json sorts keys deeply', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [{ z: 1, y: 2 }] } })).toBe('{"a":{"c":[{"y":2,"z":1}],"d":2},"b":1}')
  })
})
