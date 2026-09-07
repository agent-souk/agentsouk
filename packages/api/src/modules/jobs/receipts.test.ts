import { describe, it, expect, beforeEach } from 'vitest'
import { base64urlnopad } from '@scure/base'
import { bytesToHex } from '@noble/hashes/utils.js'
import { freshApp, call, createTestAgent, type TestAgent } from '../../test/setup.js'
import { installFakeChain, type FakeChain } from '../../test/chain.js'
import type { App } from '../../app.js'
import { canonicalJson, verify } from '../../lib/crypto.js'

/** Signed receipts and reputation attestations: portable proofs verifiable with the platform JWKS. */

let app: App
let chain: FakeChain
let seller: TestAgent
let buyer: TestAgent
const PRICE = 250_000

beforeEach(async () => {
  app = await freshApp()
  chain = installFakeChain('test')
  seller = await createTestAgent(app, { name: 'Seller' })
  buyer = await createTestAgent(app, { name: 'Buyer' })
})

async function platformKeyHex(kid: string): Promise<string> {
  const jwks = (await call(app, 'GET', '/.well-known/jwks.json')).body
  const k = jwks.keys.find((x: { kid: string }) => x.kid === kid)
  expect(k).toBeTruthy()
  return bytesToHex(base64urlnopad.decode(k.x))
}

describe('signed receipts', () => {
  it('covers parties, output hash and settlements, verifies offline and via the endpoint, and is private to the parties', async () => {
    const l = await call(app, 'POST', '/v1/listings', { key: seller.api_keys.test, body: { title: 'Translate', description: 'Translate EN to DE. Send {text}, receive {translation}.', category: 'text', pricing_model: 'fixed', price: PRICE, input_schema: { type: 'object', required: ['text'] } } })
    const j = await call(app, 'POST', '/v1/jobs', { key: buyer.api_keys.test, body: { listing_id: l.body.id, input: { text: 'hi' } } })
    const id = j.body.id as string
    await call(app, 'POST', `/v1/jobs/${id}/accept`, { key: seller.api_keys.test, body: {} })
    await call(app, 'POST', `/v1/jobs/${id}/deliver`, { key: seller.api_keys.test, body: { output: { translation: 'hallo' } } })
    const early = await call(app, 'GET', `/v1/jobs/${id}/receipt`, { key: seller.api_keys.test })
    expect(early.status).toBe(200)
    expect(early.body.receipt.settlements).toEqual([])
    expect(early.body.receipt.job.status).toBe('delivered')
    const tx = chain.pay(buyer.wallet_address!, seller.wallet_address!, PRICE)
    const paid = await call(app, 'POST', `/v1/jobs/${id}/pay`, { key: buyer.api_keys.test, body: { transaction: tx } })
    expect(paid.status).toBe(200)
    await call(app, 'POST', `/v1/jobs/${id}/accept`, { key: buyer.api_keys.test, body: {} })

    const r = await call(app, 'GET', `/v1/jobs/${id}/receipt`, { key: buyer.api_keys.test })
    expect(r.status).toBe(200)
    expect(r.body.object).toBe('signed_receipt')
    expect(r.body.receipt).toMatchObject({ object: 'receipt', version: 1, job: { id, status: 'completed', price: PRICE, currency: 'USDC', payment: 'on_delivery' } })
    expect(r.body.receipt.job.output_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(r.body.receipt.buyer).toMatchObject({ id: buyer.agent.id, handle: buyer.agent.handle, first_party: false })
    expect(r.body.receipt.buyer.did).toMatch(/^did:key:/)
    expect(r.body.receipt.buyer.wallet_address.toLowerCase()).toBe(buyer.wallet_address!.toLowerCase())
    expect(r.body.receipt.seller.wallet_address.toLowerCase()).toBe(seller.wallet_address!.toLowerCase())
    expect(r.body.receipt.settlements).toHaveLength(1)
    expect(r.body.receipt.settlements[0]).toMatchObject({ transaction: tx, amount: PRICE, kind: 'payment', status: 'settled' })
    expect(r.body.receipt.verify.jwks).toContain('/.well-known/jwks.json')
    expect(r.body.signature).toMatchObject({ alg: 'EdDSA', canonical: 'json-sorted-keys' })
    expect(r.body.signature.did).toMatch(/^did:key:/)

    // offline: canonical JSON + Ed25519 with the key from the JWKS
    const pub = await platformKeyHex(r.body.signature.kid)
    expect(verify(r.body.signature.sig, canonicalJson(r.body.receipt), pub)).toBe(true)
    // online: the verify endpoint, and a tampered copy fails
    const ok = await call(app, 'POST', '/v1/receipts/verify', { body: { receipt: r.body.receipt, signature: r.body.signature } })
    expect(ok.status).toBe(200)
    expect(ok.body).toMatchObject({ valid: true, reason: null, kid: r.body.signature.kid })
    const tampered = { ...r.body.receipt, job: { ...r.body.receipt.job, price: 1 } }
    const bad = await call(app, 'POST', '/v1/receipts/verify', { body: { receipt: tampered, signature: r.body.signature } })
    expect(bad.body.valid).toBe(false)
    expect(bad.body.reason).toContain('signature')
    const wrongKid = await call(app, 'POST', '/v1/receipts/verify', { body: { receipt: r.body.receipt, signature: { ...r.body.signature, kid: 'nope' } } })
    expect(wrongKid.body.valid).toBe(false)
    expect(wrongKid.body.reason).toContain('unknown key id')
    expect((await call(app, 'POST', '/v1/receipts/verify', { body: { signature: r.body.signature } })).body.reason).toContain('receipt or attestation')

    expect((await call(app, 'GET', `/v1/jobs/${id}/receipt`, { key: seller.api_keys.test })).status).toBe(200)
    const stranger = await createTestAgent(app, { name: 'Stranger' })
    expect((await call(app, 'GET', `/v1/jobs/${id}/receipt`, { key: stranger.api_keys.test })).status).toBe(404)
  })
})

describe('reputation attestations', () => {
  it('signs a 7-day snapshot per environment that verifies with the platform key', async () => {
    const r = await call(app, 'GET', `/v1/agents/${seller.agent.handle}/reputation/attestation?env=test`)
    expect(r.status).toBe(200)
    expect(r.body.object).toBe('signed_attestation')
    expect(r.body.attestation).toMatchObject({ object: 'reputation_attestation', version: 1, env: 'test', agent: { id: seller.agent.id, handle: seller.agent.handle, trust_tier: 0, first_party: false } })
    expect(r.body.attestation.agent.did).toMatch(/^did:key:/)
    expect(r.body.attestation.reputation).toMatchObject({ score: expect.any(Number), as_seller: expect.any(Object), as_buyer: expect.any(Object) })
    expect(new Date(r.body.attestation.expires_at).getTime() - new Date(r.body.attestation.issued_at).getTime()).toBe(7 * 86_400_000)
    const pub = await platformKeyHex(r.body.signature.kid)
    expect(verify(r.body.signature.sig, canonicalJson(r.body.attestation), pub)).toBe(true)
    const ok = await call(app, 'POST', '/v1/receipts/verify', { body: { attestation: r.body.attestation, signature: r.body.signature } })
    expect(ok.body.valid).toBe(true)
    expect((await call(app, 'GET', `/v1/agents/${seller.agent.id}/reputation/attestation`)).body.attestation.env).toBe('live')
    expect((await call(app, 'GET', '/v1/agents/nobody-here/reputation/attestation')).status).toBe(404)
  })
})
