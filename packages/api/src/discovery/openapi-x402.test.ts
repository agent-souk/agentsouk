import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { freshApp, call } from '../test/setup.js'
import { _setConfigForTests } from '../config.js'
import type { App } from '../app.js'
import { recoverAddress } from '../modules/payments/evm-signature.js'
import { enrichOpenApi, usdAmount, X402_TEMPLATE_PATH } from './openapi-x402.js'
import { ownershipProofs, PROOF_ADDRESS, PROOF_ORIGIN, X402_OWNERSHIP_PROOF } from './ownership.js'

let app: App
const METHODS = ['get', 'put', 'post', 'delete', 'patch']

beforeEach(async () => {
  app = await freshApp()
})
afterEach(() => _setConfigForTests({ PUBLIC_BASE_URL: 'http://localhost:8787', OPERATOR_CONTACT_EMAIL: undefined, X402_OWNERSHIP_PROOFS: undefined }))

/** What @agentcash/discovery (and so x402scan) infers per operation - the rule copied from its source, ADR-62. */
function authModeOf(op: Record<string, any>, schemes: Record<string, any>): string | undefined {
  const paid = Boolean(op['x-payment-info'])
  if (Array.isArray(op.security) && op.security.length === 0 && !paid) return 'unprotected'
  const reqs = (op.security ?? []) as Record<string, unknown>[]
  const apiKey = reqs.some((r) => Object.keys(r).some((name) => name === 'apiKey' || schemes[name]?.type === 'apiKey'))
  if (paid && apiKey) return 'apiKey+paid'
  if (paid) return 'paid'
  if (apiKey) return 'apiKey'
  return undefined
}

describe('/openapi.json as the x402 indexes read it (ADR-62)', () => {
  it('declares how every operation is reached, so no route is "auth mode missing"', async () => {
    const doc = (await call(app, 'GET', '/openapi.json')).body
    const schemes = doc.components.securitySchemes
    const missing: string[] = []
    for (const [path, item] of Object.entries(doc.paths as Record<string, Record<string, any>>)) {
      for (const m of METHODS) if (item[m] && !authModeOf(item[m], schemes)) missing.push(`${m.toUpperCase()} ${path}`)
    }
    expect(missing).toEqual([])
    expect(authModeOf(doc.paths['/v1/agents/me'].get, schemes)).toBe('apiKey')
    expect(authModeOf(doc.paths['/v1/listings'].get, schemes)).toBe('unprotected')
    expect(doc.paths['/v1/admin/overview'].get.security).toEqual([{ adminToken: [] }])
    expect(doc.info.contact.url).toContain('/v1/support/reports')
    expect(doc.info.contact.email).toBeUndefined() // nothing private is ever published by default
    // nothing sellable on live in a fresh database: the template stays documented
    expect(doc.paths[X402_TEMPLATE_PATH]?.post).toBeTruthy()
  })

  it('replaces the template with one payable operation per listing GET /v1/x402 sells', async () => {
    const generated = (await call(app, 'GET', '/openapi.json')).body
    const row = (id: string, pricingModel: string, price: number, unitName: string | null) => ({
      listing: { id, title: `Service ${id}`, description: 'Does one thing well.', price, pricingModel, unitName, inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } }, exampleInput: { text: 'hello' } },
      seller: { handle: 'souk-services', walletAddress: PROOF_ADDRESS },
    })
    const doc = enrichOpenApi(generated, { base: 'https://api.agentsouk.dev', sellable: [row('lst_fixed', 'fixed', 10_000, null), row('lst_unit', 'per_unit', 20_000, '1,000 characters')] as never, contactEmail: 'hello@agentsouk.dev', ownershipProofs: [X402_OWNERSHIP_PROOF] })
    expect(doc.paths[X402_TEMPLATE_PATH]).toBeUndefined()
    const fixed = doc.paths['/v1/x402/lst_fixed'].post
    expect(authModeOf(fixed, doc.components.securitySchemes)).toBe('paid')
    expect(fixed['x-payment-info']).toEqual({ price: { mode: 'fixed', currency: 'USD', amount: '0.01' }, protocols: [{ x402: { network: 'eip155:8453', asset: expect.stringMatching(/^0x/), payTo: PROOF_ADDRESS } }] })
    expect(fixed.responses['402']).toBeTruthy()
    expect(fixed.requestBody.content['application/json'].schema.required).toEqual(['text'])
    const unit = doc.paths['/v1/x402/lst_unit'].post
    expect(unit['x-payment-info'].price.amount).toBe('0.02')
    expect(unit.parameters[0]).toMatchObject({ name: 'units', in: 'query' })
    expect(unit.summary).toContain('per 1,000 characters')
    expect(doc.info.contact.email).toBe('hello@agentsouk.dev')
    expect(doc['x-discovery'].ownershipProofs).toEqual([X402_OWNERSHIP_PROOF])
    // the generated document itself is not mutated
    expect(generated.paths[X402_TEMPLATE_PATH]).toBeTruthy()
    expect(usdAmount(1_500_000)).toBe('1.5')
  })

  it('publishes an ownership proof that recovers to the wallet the listings are paid into, and only on its own origin', async () => {
    expect(recoverAddress(PROOF_ORIGIN, X402_OWNERSHIP_PROOF)).toBe(PROOF_ADDRESS)
    expect(ownershipProofs()).toEqual([]) // http://localhost:8787 is not the signed origin
    _setConfigForTests({ PUBLIC_BASE_URL: 'https://api.agentsouk.dev' })
    expect(ownershipProofs()).toEqual([X402_OWNERSHIP_PROOF])
    const doc = (await call(app, 'GET', '/openapi.json')).body
    expect(doc['x-discovery'].ownershipProofs).toEqual([X402_OWNERSHIP_PROOF])
    const wk = (await call(app, 'GET', '/.well-known/x402')).body
    expect(wk).toMatchObject({ version: 1, resources: expect.any(Array), ownershipProofs: [X402_OWNERSHIP_PROOF] })
  })

  it('serves an icon at the root', async () => {
    const res = await app.request('/favicon.ico')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/x-icon')
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect([...bytes.slice(0, 4)]).toEqual([0, 0, 1, 0])
  })
})
