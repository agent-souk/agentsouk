/** End-to-end against the real API in-process: a buyer orders, the runtime delivers (sealed), declines, or cancels. */
import { describe, it, expect, beforeEach } from 'vitest'
import { freshApp, call, createTestAgent, type TestAgent } from '../../api/src/test/setup.js'
import type { App } from '../../api/src/app.js'
import { AgentSouk } from '../../sdk/src/index.js'
import { SellerRuntime } from './runner.js'
import { extractWeb } from './services/extract-web.js'
import { validateJson } from './services/validate-json.js'
import type { ServiceDef } from './services/types.js'

let app: App
let seller: TestAgent
let buyer: TestAgent
const base = 'http://localhost:8787'
const client = (key: string) => new AgentSouk({ baseUrl: base, apiKey: key, fetch: (input, init) => Promise.resolve(app.request(String(input).replace(base, ''), init)) })

const page = '<html><head><title>T</title></head><body><main><p>' + 'word '.repeat(300) + '</p></main></body></html>'
const fetchImpl: typeof fetch = (async (input: string | URL | Request) => (String(input) === 'http://93.184.216.34/' ? new Response(page, { status: 200, headers: { 'content-type': 'text/html' } }) : new Response('x', { status: 500 }))) as typeof fetch

const boom: ServiceDef = {
  key: 'boom',
  listing: { title: 'Always fails', description: 'A service that fails after accepting, for the test.', category: 'test', tags: [], price: 0, input_schema: { type: 'object' }, turnaround_seconds: 60, accept_timeout_seconds: 60, max_open_jobs: 5 },
  validate: () => null,
  run: async () => {
    throw new Error('upstream exploded')
  },
}

beforeEach(async () => {
  app = await freshApp()
  seller = await createTestAgent(app, { name: 'Souk Services' })
  buyer = await createTestAgent(app, { name: 'Some Buyer' })
})

describe('SellerRuntime', () => {
  it('creates listings once, delivers sealed output via inbox catch-up, declines bad input, cancels on failure', async () => {
    const rt = new SellerRuntime(client(seller.api_keys.test), [extractWeb({ fetchImpl }), validateJson, boom], 'test')
    await rt.init()
    expect(rt.listingIds()).toHaveLength(3)
    const again = new SellerRuntime(client(seller.api_keys.test), [extractWeb({ fetchImpl }), validateJson, boom], 'test')
    await again.init()
    expect(again.listingIds().sort()).toEqual(rt.listingIds().sort())
    const mine = await call(app, 'GET', '/v1/agents/me/listings', { key: seller.api_keys.test })
    expect(mine.body.data).toHaveLength(3)
    const byTag = (tag: string) => mine.body.data.find((l: any) => l.tags.includes(tag)).id as string

    const b = client(buyer.api_keys.test)
    const j1 = await b.jobs.create({ listing_id: byTag('souk:extract-web'), input: { url: 'http://93.184.216.34/', max_chars: 500 } })
    const j2 = await b.jobs.create({ listing_id: byTag('souk:extract-web'), input: { url: 'ftp://nope' } })
    const j3 = await b.jobs.create({ listing_id: byTag('souk:validate-json'), input: { schema: { type: 'object', required: ['a'] }, data: {} } })
    const j4 = await b.jobs.create({ listing_id: byTag('souk:boom'), input: {} })

    expect(await rt.catchUp()).toBe(4)
    expect(await rt.catchUp()).toBe(0)

    const v1 = await b.jobs.get(j1.id)
    expect(v1.status).toBe('delivered')
    expect((v1 as any).output_sealed).toBe(true)
    expect(v1.output).toBeNull()
    expect((v1 as any).output_preview).toMatchObject({ title: 'T', clipped: true, text_chars: 500 })
    expect((await b.jobs.get(j2.id)).status).toBe('declined')
    const v3 = await b.jobs.get(j3.id)
    expect(v3.status).toBe('delivered')
    expect((v3 as any).output_preview).toMatchObject({ invalid_documents: 1 })
    const v4 = await b.jobs.get(j4.id)
    expect(v4.status).toBe('cancelled')
    const ev4 = await call(app, 'GET', `/v1/jobs/${j4.id}/events`, { key: buyer.api_keys.test })
    expect(JSON.stringify(ev4.body)).toContain('upstream exploded')

    // free job (price 0) is revealed immediately; paid ones stay sealed until the buyer pays
    const sellerView = await call(app, 'GET', `/v1/jobs/${j1.id}`, { key: seller.api_keys.test })
    expect(sellerView.body.output.title).toBe('T')
  })

  it('handles a job.created event only for its own jobs and ignores unrelated events', async () => {
    const rt = new SellerRuntime(client(seller.api_keys.test), [validateJson], 'test')
    await rt.init()
    const b = client(buyer.api_keys.test)
    const j = await b.jobs.create({ listing_id: rt.listingIds()[0], input: { schema: { type: 'string' }, data: 'x' } })
    expect(await rt.handleEvent({ type: 'job.paid', data: { job_id: j.id } })).toBeNull()
    expect(await rt.handleEvent({ type: 'job.created', data: { job_id: j.id, seller_id: 'agt_other' } })).toBeNull()
    expect(await rt.handleEvent({ type: 'job.created', data: { job_id: j.id, seller_id: seller.agent.id } })).toBe('delivered')
    expect(await rt.handleEvent({ type: 'job.created', data: { job_id: j.id, seller_id: seller.agent.id } })).toBe('skipped')
  })

  it('registers its webhook once', async () => {
    const rt = new SellerRuntime(client(seller.api_keys.test), [], 'test')
    await rt.init()
    const id1 = await rt.ensureWebhook('http://localhost:9999/webhooks/agentsouk/test', 'whsec_0123456789abcdef')
    const id2 = await rt.ensureWebhook('http://localhost:9999/webhooks/agentsouk/test', 'whsec_0123456789abcdef')
    expect(id1).toBe(id2)
    const hooks = await call(app, 'GET', '/v1/webhooks', { key: seller.api_keys.test })
    expect(hooks.body.data).toHaveLength(1)
  })
})
