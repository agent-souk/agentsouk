import { describe, it, expect, beforeEach } from 'vitest'
import { freshApp, call, createTestAgent } from '../../test/setup.js'
import type { App } from '../../app.js'
import { sweepMemory } from './service.js'
import { fireSchedules } from '../schedules/service.js'

let app: App
type Ag = Awaited<ReturnType<typeof createTestAgent>>
let a: Ag
beforeEach(async () => {
  app = await freshApp()
  a = await createTestAgent(app, { name: 'Rememberer' })
})

describe('memory', () => {
  it('put/get/list/delete with prefix, ttl and ownership', async () => {
    const put = await call(app, 'PUT', '/v1/memory/notes%2Fcustomer-42', { key: a.api_keys.test, body: { value: { name: 'ACME', score: 7 } } })
    expect(put.status, JSON.stringify(put.body)).toBe(200)
    expect(put.body.value).toEqual({ name: 'ACME', score: 7 })
    await call(app, 'PUT', '/v1/memory/notes%2Fcustomer-43', { key: a.api_keys.test, body: { value: 'plain string' } })
    await call(app, 'PUT', '/v1/memory/state:last_run', { key: a.api_keys.test, body: { value: 123, ttl_seconds: 1 } })
    const get = await call(app, 'GET', '/v1/memory/notes%2Fcustomer-42', { key: a.api_keys.live })
    expect(get.body.value.name).toBe('ACME')
    const list = await call(app, 'GET', '/v1/memory?prefix=notes/', { key: a.api_keys.test })
    expect(list.body.data.map((m: any) => m.key)).toEqual(['notes/customer-42', 'notes/customer-43'])
    expect(list.body.data[0].value).toBeUndefined()
    const all = await call(app, 'GET', '/v1/memory', { key: a.api_keys.test })
    expect(all.body.data).toHaveLength(3)
    const other = await createTestAgent(app, { name: 'Other' })
    expect((await call(app, 'GET', '/v1/memory/notes%2Fcustomer-42', { key: other.api_keys.test })).status).toBe(404)
    const bad = await call(app, 'PUT', '/v1/memory/bad key!', { key: a.api_keys.test, body: { value: 1 } })
    expect(bad.status).toBe(400)
    const big = await call(app, 'PUT', '/v1/memory/big', { key: a.api_keys.test, body: { value: 'x'.repeat(70_000) } })
    expect(big.status).toBe(400)
    const del = await call(app, 'DELETE', '/v1/memory/notes%2Fcustomer-43', { key: a.api_keys.test })
    expect(del.body.deleted).toBe(true)
    expect((await call(app, 'DELETE', '/v1/memory/notes%2Fcustomer-43', { key: a.api_keys.test })).body.deleted).toBe(false)
    expect(await sweepMemory(Date.now() + 2000)).toBe(1)
    expect((await call(app, 'GET', '/v1/memory/state:last_run', { key: a.api_keys.test })).status).toBe(404)
  })
})

describe('schedules', () => {
  it('fires one-shot and recurring schedules as events; pause/resume/delete; ownership', async () => {
    const now = Date.now()
    const one = await call(app, 'POST', '/v1/schedules', { key: a.api_keys.test, body: { name: 'wake me', in_seconds: 60, payload: { task: 'check inbox' } } })
    expect(one.status, JSON.stringify(one.body)).toBe(201)
    expect(one.body.status).toBe('active')
    const rec = await call(app, 'POST', '/v1/schedules', { key: a.api_keys.test, body: { run_at: new Date(now + 120_000).toISOString(), interval_seconds: 300, max_runs: 2, payload: { task: 'poll' } } })
    expect(rec.status).toBe(201)
    const bad = await call(app, 'POST', '/v1/schedules', { key: a.api_keys.test, body: { in_seconds: 10, interval_seconds: 5 } })
    expect(bad.status).toBe(400)
    expect(await fireSchedules(now + 30_000)).toBe(0)
    expect(await fireSchedules(now + 61_000)).toBe(1)
    const ev = await call(app, 'GET', '/v1/events?types=schedule.fired', { key: a.api_keys.test })
    expect(ev.body.data).toHaveLength(1)
    expect(ev.body.data[0].data.payload.task).toBe('check inbox')
    expect((await call(app, 'GET', `/v1/schedules/${one.body.id}`, { key: a.api_keys.test })).body.status).toBe('done')
    expect(await fireSchedules(now + 121_000)).toBe(1)
    const after1 = await call(app, 'GET', `/v1/schedules/${rec.body.id}`, { key: a.api_keys.test })
    expect(after1.body.run_count).toBe(1)
    expect(new Date(after1.body.run_at).getTime()).toBe(now + 120_000 + 300_000)
    const paused = await call(app, 'PATCH', `/v1/schedules/${rec.body.id}`, { key: a.api_keys.test, body: { status: 'paused' } })
    expect(paused.body.status).toBe('paused')
    expect(await fireSchedules(now + 500_000)).toBe(0)
    await call(app, 'PATCH', `/v1/schedules/${rec.body.id}`, { key: a.api_keys.test, body: { status: 'active' } })
    expect(await fireSchedules(now + 1_000_000)).toBe(1)
    const done = await call(app, 'GET', `/v1/schedules/${rec.body.id}`, { key: a.api_keys.test })
    expect(done.body.status).toBe('done')
    expect(done.body.run_count).toBe(2)
    const other = await createTestAgent(app, { name: 'Other' })
    expect((await call(app, 'GET', `/v1/schedules/${rec.body.id}`, { key: other.api_keys.test })).status).toBe(404)
    expect((await call(app, 'GET', `/v1/schedules/${rec.body.id}`, { key: a.api_keys.live })).status).toBe(404)
    const list = await call(app, 'GET', '/v1/schedules?status=done', { key: a.api_keys.test })
    expect(list.body.data).toHaveLength(2)
    const del = await call(app, 'DELETE', `/v1/schedules/${rec.body.id}`, { key: a.api_keys.test })
    expect(del.body.deleted).toBe(true)
  })
})
