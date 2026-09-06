import { describe, it, expect, beforeEach } from 'vitest'
import { freshApp, call, createTestAgent } from '../test/setup.js'
import type { App } from '../app.js'

let app: App
beforeEach(async () => {
  app = await freshApp()
})

const rpc = (method: string, params: Record<string, unknown>, id = 1) => ({ jsonrpc: '2.0', id, method, params })
const textMsg = (text: string, extra: Record<string, unknown> = {}) => ({ kind: 'message', messageId: 'm1', role: 'user', parts: [{ kind: 'text', text }], ...extra })

describe('A2A', () => {
  it('concierge answers message/send with a completed task and the skill artifact', async () => {
    const r = await call(app, 'POST', '/a2a', { body: rpc('message/send', { message: textMsg('I need a translation') }) })
    expect(r.status).toBe(200)
    expect(r.body.result.kind).toBe('task')
    expect(r.body.result.status.state).toBe('completed')
    expect(r.body.result.status.message.parts[0].text).toContain('POST http://localhost:8787/v1/agents')
    expect(r.body.result.artifacts[0].parts[0].text).toContain('name: agentsouk')
    const bad = await call(app, 'POST', '/a2a', { body: { jsonrpc: '2.0', id: 2, method: 'nope' } })
    expect(bad.body.error.code).toBe(-32601)
    const get = await call(app, 'POST', '/a2a', { body: rpc('tasks/get', { id: 'task_x' }) })
    expect(get.body.result.status.state).toBe('completed')
  })

  it('serves per-agent cards with listings as skills', async () => {
    const s = await createTestAgent(app, { name: 'Card Bot', description: 'I translate.' })
    await call(app, 'POST', '/v1/listings', { key: s.api_keys.live, body: { title: 'EN->DE', description: 'Translate English to German quickly and accurately.', category: 'text', pricing_model: 'fixed', price: 500, example_input: { text: 'Hi' } } })
    const card = await call(app, 'GET', `/agents/card-bot/agent-card.json`)
    expect(card.status).toBe(200)
    expect(card.body.url).toBe(`http://localhost:8787/a2a/agents/${s.agent.id}`)
    expect(card.body.skills[0].name).toBe('EN->DE')
    expect(card.body.skills[0].description).toContain('POST http://localhost:8787/v1/jobs')
    expect(card.body.identity.did).toMatch(/^did:key:/)
    expect((await call(app, 'GET', '/agents/nobody/agent-card.json')).status).toBe(404)
  })

  it('bridges message/send into a direct thread and reports replies via tasks/get', async () => {
    const a = await createTestAgent(app, { name: 'Caller' })
    const b = await createTestAgent(app, { name: 'Callee' })
    const unauth = await call(app, 'POST', `/a2a/agents/${b.agent.id}`, { body: rpc('message/send', { message: textMsg('hello') }) })
    expect(unauth.status).toBe(401)
    const sent = await call(app, 'POST', `/a2a/agents/${b.agent.id}`, { key: a.api_keys.test, body: rpc('message/send', { message: textMsg('hello from A2A', { parts: [{ kind: 'text', text: 'hello from A2A' }, { kind: 'data', data: { order: 1 } }] }) }) })
    expect(sent.status).toBe(200)
    expect(sent.body.result.status.state).toBe('working')
    const threadId = sent.body.result.id
    expect(threadId).toMatch(/^thr_/)
    const inbox = await call(app, 'GET', '/v1/inbox', { key: b.api_keys.test })
    expect(inbox.body.unread_threads[0].id).toBe(threadId)
    const msgs = await call(app, 'GET', `/v1/threads/${threadId}/messages`, { key: b.api_keys.test })
    expect(msgs.body.data[0].data).toEqual({ order: 1 })
    await call(app, 'POST', `/v1/threads/${threadId}/messages`, { key: b.api_keys.test, body: { body: 'hi back' } })
    const got = await call(app, 'POST', `/a2a/agents/${b.agent.id}`, { key: a.api_keys.test, body: rpc('tasks/get', { id: threadId }) })
    expect(got.body.result.status.state).toBe('completed')
    expect(got.body.result.history.map((m: any) => m.role)).toEqual(['user', 'agent'])
    expect(got.body.result.status.message.parts[0].text).toBe('hi back')
    const stranger = await createTestAgent(app, { name: 'Stranger' })
    const denied = await call(app, 'POST', `/a2a/agents/${b.agent.id}`, { key: stranger.api_keys.test, body: rpc('tasks/get', { id: threadId }) })
    expect(denied.body.error.code).toBe(-32001)
  })
})
