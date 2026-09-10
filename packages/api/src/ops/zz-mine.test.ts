import { appendFileSync, writeFileSync } from 'node:fs'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
const OUT = 'C:/Users/nicki/AppData/Local/Temp/claude/c--Users-nicki-Desktop-AI-PLATTFORM/fa4c45d3-e1a4-481d-88fb-9722c41f0090/scratchpad/mine.txt'
const say = (...a: unknown[]) => appendFileSync(OUT, a.join(' ') + '
')
import { freshApp, call, createTestAgent, type TestAgent } from '../test/setup.js'
import { _setConfigForTests } from '../config.js'
import type { App } from '../app.js'
import { db } from '../db/client.js'
import { operatorAlerts } from '../db/schema.js'
import { _setAlertFetchForTests, deliverAlerts, recentAlerts } from './alerts.js'

const WEBHOOK = 'https://ntfy.sh/agentsouk-operator-test'
let app: App
let sent: string[] = []
let seller: TestAgent
let buyer: TestAgent

beforeEach(async () => {
  app = await freshApp()
  sent = []
  _setConfigForTests({ OPERATOR_ALERT_WEBHOOK_URL: WEBHOOK, OPERATOR_ALERT_EMAIL: undefined, RESEND_API_KEY: undefined, OPERATOR_ALERT_MIN_TIER: 'notable', OPERATOR_ALERT_MAX_PER_HOUR: 2 })
  _setAlertFetchForTests((async (url: string) => { sent.push(url); return { status: 200, text: async () => '' } }) as never)
  seller = await createTestAgent(app, { name: 'Outside Seller' })
  buyer = await createTestAgent(app, { name: 'Outside Buyer' })
})
afterEach(() => {
  _setAlertFetchForTests(null)
  _setConfigForTests({ OPERATOR_ALERT_WEBHOOK_URL: undefined, OPERATOR_ALERT_MAX_PER_HOUR: 12, OPERATOR_ALERT_MIN_TIER: 'notable' })
})

describe('END-TO-END burst through POST /v1/jobs', () => {
  it('30 free orders with cap 2', async () => {
    writeFileSync(OUT, '')
    const l = await call(app, 'POST', '/v1/listings', {
      key: seller.api_keys.test,
      body: { title: 'Translate', description: 'Translate EN to DE. Send {text}, receive {translation}.', category: 'text', pricing_model: 'fixed', price: 1_000_000, input_schema: { type: 'object', required: ['text'] }, turnaround_seconds: 600, accept_timeout_seconds: 600 },
    })
    if (l.status !== 201) throw new Error(JSON.stringify(l.body))
    let created = 0
    let firstErr = ''
    for (let i = 0; i < 30; i++) {
      const r = await call(app, 'POST', '/v1/jobs', { key: buyer.api_keys.test, body: { listing_id: l.body.id, input: { text: 'hi ' + i } } })
      if (r.status === 201) created++
      else if (!firstErr) firstErr = `${r.status} ${JSON.stringify(r.body)}`
    }
    const rows = await db().query.operatorAlerts.findMany()
    // eslint-disable-next-line no-console
    say('ORDERS_CREATED', created, 'firstErr', firstErr)
    say('ALERT_ROWS', rows.length,
      'pending', rows.filter((r) => r.status === 'pending').length,
      'suppressed', rows.filter((r) => r.status === 'suppressed').length,
      'tiers', JSON.stringify(rows.reduce<Record<string, number>>((a, r) => { a[r.tier] = (a[r.tier] ?? 0) + 1; return a }, {})))
    const now = Date.now()
    const p1 = await deliverAlerts(now)
    say('PASS1', JSON.stringify(p1), 'http', sent.length)
    const p2 = await deliverAlerts(now + 1000)
    say('PASS2', JSON.stringify(p2), 'http', sent.length)
    const p3 = await deliverAlerts(now + 2000)
    say('PASS3', JSON.stringify(p3), 'http', sent.length)
    const after = await recentAlerts(200)
    say('FINAL sent', after.filter((r) => r.status === 'sent').length, 'suppressed', after.filter((r) => r.status === 'suppressed').length, 'pending', after.filter((r) => r.status === 'pending').length)
    expect(true).toBe(true)
  })
})
