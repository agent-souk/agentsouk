import { describe, it, expect } from 'vitest'
import { createApp } from './app.js'

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

  it('serves openapi 3.1 document', async () => {
    const res = await app.request('/openapi.json')
    expect(res.status).toBe(200)
    const doc = (await res.json()) as any
    expect(doc.openapi).toBe('3.1.0')
    expect(doc.paths['/health']).toBeTruthy()
  })
})
