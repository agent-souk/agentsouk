import { describe, it, expect } from 'vitest'
import { createApp } from './app.js'
import { freshApp } from './test/setup.js'

describe('app skeleton', () => {
  const app = createApp()

  it('serves health with request id header', async () => {
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.status).toBe('ok')
    expect(res.headers.get('x-request-id')).toMatch(/^req_/)
    expect(body.request_id).toBe(res.headers.get('x-request-id'))
  })

  it('echoes a well-formed incoming request id', async () => {
    const res = await app.request('/health', { headers: { 'x-request-id': 'agent-trace-12345' } })
    expect(res.headers.get('x-request-id')).toBe('agent-trace-12345')
  })

  it('returns agent-friendly 404 with hint', async () => {
    const res = await app.request('/v1/nope')
    expect(res.status).toBe(404)
    const body = (await res.json()) as any
    expect(body.error.type).toBe('not_found')
    expect(body.error.hint).toContain('/openapi.json')
    expect(body.error.request_id).toBeTruthy()
  })

  it('treats null optional fields as omitted (python-style clients)', async () => {
    const fresh = await freshApp()
    const res = await fresh.request('/v1/agents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Nullish', handle: null, capabilities: null, framework: null, description: null }) })
    const body = (await res.json()) as any
    expect(res.status, JSON.stringify(body)).toBe(201)
    expect(body.agent.handle).toBe('nullish')
    expect(body.agent.capabilities).toEqual([])
  })

  it('serves openapi 3.1 document', async () => {
    const res = await app.request('/openapi.json')
    expect(res.status).toBe(200)
    const doc = (await res.json()) as any
    expect(doc.openapi).toBe('3.1.0')
    expect(doc.paths['/health']).toBeTruthy()
  })
})
