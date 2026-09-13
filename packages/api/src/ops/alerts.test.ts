import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { freshApp, call, createTestAgent, randomAddress, type TestAgent } from '../test/setup.js'
import { installFakeChain } from '../test/chain.js'
import { _setConfigForTests } from '../config.js'
import type { App } from '../app.js'
import { db } from '../db/client.js'
import { agents, faucetClaims, jobs, operatorAlerts } from '../db/schema.js'
import { channelKindOf, webhookRequest, emailRequest, channelStatus, clamp, headerSafe, MAX_MESSAGE_CHARS } from './alert-channels.js'
import { _setAlertFetchForTests, ALERT_MAX_ATTEMPTS, ALERT_BACKOFF_MS, ALERT_DEFER_MAX_MS, alertsStatus, classifyPayment, deliverAlerts, raise, recentAlerts, SUPPRESSED } from './alerts.js'

const ADMIN = 'test-admin-token-1234567890'
const WEBHOOK = 'https://ntfy.sh/agentsouk-operator-test'

let app: App
let sent: { url: string; body: string; headers: Record<string, string> }[]
let answer: (url: string) => { status: number }

function fakeFetch() {
  return async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
    sent.push({ url, body: init.body, headers: init.headers })
    return { status: answer(url).status, text: async () => 'body from the fake channel' }
  }
}

beforeEach(async () => {
  app = await freshApp()
  sent = []
  answer = () => ({ status: 200 })
  _setConfigForTests({ ADMIN_TOKEN: ADMIN, OPERATOR_ALERT_WEBHOOK_URL: WEBHOOK, OPERATOR_ALERT_EMAIL: undefined, RESEND_API_KEY: undefined, OPERATOR_ALERT_MIN_TIER: 'quiet', OPERATOR_ALERT_MAX_PER_HOUR: 12 })
  _setAlertFetchForTests(fakeFetch())
})

afterEach(() => {
  _setAlertFetchForTests(null)
  _setConfigForTests({ ADMIN_TOKEN: undefined, OPERATOR_ALERT_WEBHOOK_URL: undefined, OPERATOR_ALERT_EMAIL: undefined, RESEND_API_KEY: undefined, OPERATOR_ALERT_MIN_TIER: 'notable', OPERATOR_ALERT_MAX_PER_HOUR: 12 })
})

const draft = (over: Partial<Parameters<typeof raise>[0]> = {}) => ({ env: 'test' as const, tier: 'urgent' as const, key: 'k1', title: 'Something happened', body: 'A line about it.', ...over })

describe('alert channels (ADR-49)', () => {
  it('reads the service from the host, never from the path', () => {
    expect(channelKindOf('https://discord.com/api/webhooks/1/abc')).toBe('discord')
    expect(channelKindOf('https://hooks.slack.com/services/T/B/x')).toBe('slack')
    expect(channelKindOf('https://ntfy.sh/my-topic')).toBe('ntfy')
    expect(channelKindOf('https://api.telegram.org/bot123:abc/sendMessage?chat_id=42')).toBe('telegram')
    expect(channelKindOf('https://example.com/hook')).toBe('generic')
    // a path that merely mentions another service does not make it that service
    expect(channelKindOf('https://example.com/discord.com/api/webhooks/1/abc')).toBe('generic')
    expect(channelKindOf('not a url at all')).toBe('generic')
  })

  it('puts the message in the field each service actually reads', () => {
    const a = { tier: 'urgent' as const, env: 'live', title: 'Paid', body: 'Someone paid.', url: 'https://basescan.org/tx/0x1' }
    expect(JSON.parse(webhookRequest('https://discord.com/api/webhooks/1/a', a).init.body).content).toContain('Paid')
    expect(JSON.parse(webhookRequest('https://hooks.slack.com/services/x', a).init.body).text).toContain('Paid')
    const tg = JSON.parse(webhookRequest('https://api.telegram.org/bot1:a/sendMessage?chat_id=42', a).init.body)
    expect(tg.chat_id).toBe('42')
    expect(tg.text).toContain('Paid')
    // an unknown receiver gets the structured alert AND every alias, so a wrapper for any of the four still works
    const g = JSON.parse(webhookRequest('https://example.com/hook', a).init.body)
    expect(g).toMatchObject({ object: 'operator_alert', tier: 'urgent', env: 'live', title: 'Paid', url: 'https://basescan.org/tx/0x1' })
    expect(g.text).toBe(g.content)
  })

  it('sends ntfy as a plain body with header extras, and keeps the headers latin-1 safe', () => {
    const r = webhookRequest(WEBHOOK, { tier: 'urgent', env: 'live', title: '🔴 Paid 1.00 USDC — outsiders', body: 'Someone paid.' })
    expect(r.init.headers['content-type']).toContain('text/plain')
    expect(r.init.headers.Priority).toBe('5')
    expect(r.init.body).toBe('Someone paid.')
    // a non-latin-1 byte in a header would make fetch throw and lose the alert entirely
    expect(() => new Headers(r.init.headers)).not.toThrow()
    expect(/[^\x20-\x7e]/.test(r.init.headers.Title!)).toBe(false)
  })

  it('never exceeds the strictest message limit any channel imposes', () => {
    const long = 'x'.repeat(5000)
    const r = webhookRequest('https://discord.com/api/webhooks/1/a', { tier: 'quiet', env: 'test', title: long, body: long })
    expect(JSON.parse(r.init.body).content.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS)
    expect(clamp('short')).toBe('short')
  })

  it('builds the e-mail as an API call, and never puts the key or the whole address in the status', () => {
    const r = emailRequest('re_secret_key', 'Agent Souk <a@b.dev>', 'nick@example.com', { tier: 'notable', env: 'live', title: 'Paid', body: 'x' })
    expect(r.url).toBe('https://api.resend.com/emails')
    expect(r.init.headers.authorization).toBe('Bearer re_secret_key')
    expect(JSON.parse(r.init.body)).toMatchObject({ from: 'Agent Souk <a@b.dev>', to: ['nick@example.com'], subject: '[notable] Paid' })
    _setConfigForTests({ OPERATOR_ALERT_EMAIL: 'nick@example.com', RESEND_API_KEY: 're_secret_key' })
    const s = channelStatus()
    expect(s.email).toBe('n***@example.com')
    expect(JSON.stringify(s)).not.toContain('re_secret_key')
  })
})

describe('raising alerts (ADR-49)', () => {
  it('still records the row with no channel configured, and the worker marks it so', async () => {
    // The row IS the record. Configuring a channel a week later should not mean the week is blank.
    _setConfigForTests({ OPERATOR_ALERT_WEBHOOK_URL: undefined })
    expect(await raise(draft())).not.toBeNull()
    expect(await deliverAlerts()).toMatchObject({ sent: 0, suppressed: 1 })
    expect(sent).toHaveLength(0)
    const [row] = await recentAlerts()
    expect(row).toMatchObject({ status: 'suppressed', last_error: 'no channel configured' })
  })

  it('drops tiers below the configured minimum', async () => {
    _setConfigForTests({ OPERATOR_ALERT_MIN_TIER: 'urgent' })
    expect(await raise(draft({ tier: 'notable', key: 'n' }))).toBeNull()
    expect(await raise(draft({ tier: 'urgent', key: 'u' }))).not.toBeNull()
  })

  it('deduplicates by key: the same fact never wakes anyone twice', async () => {
    expect(await raise(draft())).not.toBeNull()
    expect(await raise(draft({ title: 'again' }))).toBeNull()
    expect(await db().query.operatorAlerts.findMany()).toHaveLength(1)
  })

  it('counts the cap on what was DELIVERED, so a broken channel cannot silence the next alert', async () => {
    _setConfigForTests({ OPERATOR_ALERT_MAX_PER_HOUR: 2 })
    const now = Date.UTC(2026, 8, 10, 12, 0, 0)
    answer = () => ({ status: 503 })
    for (let i = 0; i < 4; i++) await raise(draft({ key: `stuck${i}`, tier: 'quiet' }), now)
    await deliverAlerts(now) // everything fails and stays pending
    const after = await raise(draft({ key: 'later', tier: 'quiet' }), now)
    expect(after).not.toBeNull()
    const row = (await recentAlerts()).find((r) => r.key === 'later')!
    expect(row.status).toBe('pending') // NOT suppressed: nothing has actually reached anyone
  })

  it('holds back a flood of delivered alerts, but never an urgent one, and says once an hour that it is holding back', async () => {
    _setConfigForTests({ OPERATOR_ALERT_MAX_PER_HOUR: 2 })
    const now = Date.UTC(2026, 8, 10, 12, 0, 0)
    for (let i = 0; i < 2; i++) await raise(draft({ key: `d${i}`, tier: 'quiet' }), now)
    await deliverAlerts(now)
    expect((await recentAlerts()).filter((r) => r.status === 'sent')).toHaveLength(2)

    await raise(draft({ key: 'q3', tier: 'quiet' }), now)
    await raise(draft({ key: 'n4', tier: 'notable' }), now)
    const urgent = await raise(draft({ key: 'u5', tier: 'urgent' }), now)
    expect(urgent).not.toBeNull()

    const rows = await recentAlerts()
    // held back, NOT discarded: the row stays pending and comes round again when the hour frees up
    expect(rows.find((r) => r.key === 'q3')!.status).toBe('pending')
    expect(rows.find((r) => r.key === 'q3')!.last_error).toContain('held back')
    expect(rows.find((r) => r.key === 'n4')!.status).toBe('pending')
    // the one the whole subsystem exists for is never held back by sandbox chatter
    expect(rows.find((r) => r.key === 'u5')!.status).toBe('pending')
    const flood = rows.filter((r) => r.key.startsWith('flood:'))
    expect(flood).toHaveLength(1)
    expect(flood[0]!.title).toContain('queued')
  })

  it('counts the cap per environment: sandbox noise cannot silence live', async () => {
    _setConfigForTests({ OPERATOR_ALERT_MAX_PER_HOUR: 1 })
    const now = Date.UTC(2026, 8, 10, 12, 0, 0)
    await raise(draft({ key: 't1', tier: 'quiet', env: 'test' }), now)
    await deliverAlerts(now)
    await raise(draft({ key: 'l1', tier: 'notable', env: 'live' }), now)
    const l1 = (await recentAlerts()).find((r) => r.key === 'l1')!
    // Since ADR-54 a held-back row is ALSO 'pending' (deferred, not dropped), so the status alone proved nothing:
    // this test stayed green with the environment filter removed. What tells the two apart is last_error.
    expect(l1.status).toBe('pending')
    expect(l1.last_error).toBeNull()
  })
})

describe('the hourly-cap summary (ADR-54, ADR-57, ADR-58)', () => {
  it('is one row per ENVIRONMENT and hour: the sandbox flooding first cannot swallow the live notice', async () => {
    _setConfigForTests({ OPERATOR_ALERT_MAX_PER_HOUR: 1 })
    const now = Date.UTC(2026, 8, 14, 3, 0, 0)
    await raise(draft({ key: 't1', tier: 'quiet', env: 'test' }), now)
    await deliverAlerts(now)
    await raise(draft({ key: 't2', tier: 'quiet', env: 'test' }), now + 1000) // held: the test hour is full
    await raise(draft({ key: 'l1', tier: 'notable', env: 'live' }), now + 2000)
    await deliverAlerts(now + 2000)
    await raise(draft({ key: 'l2', tier: 'notable', env: 'live' }), now + 3000) // held: the live hour is full
    const flood = (await recentAlerts()).filter((r) => r.key.startsWith('flood:'))
    expect(flood.map((r) => r.key).sort()).toEqual(['flood:live:2026-09-14T03', 'flood:test:2026-09-14T03'])
  })

  it('is written by the delivery sweep too, when thirty rows arrive before anything was delivered', async () => {
    _setConfigForTests({ OPERATOR_ALERT_MAX_PER_HOUR: 2 })
    const now = Date.UTC(2026, 8, 14, 4, 0, 0)
    for (const k of ['a', 'b', 'c', 'd', 'e']) await raise(draft({ key: k, tier: 'quiet' }), now) // raise() sees nothing delivered: no summary
    expect((await recentAlerts()).some((r) => r.key.startsWith('flood:'))).toBe(false)
    const first = await deliverAlerts(now)
    expect(first).toMatchObject({ sent: 2, deferred: 3 })
    const flood = (await recentAlerts()).filter((r) => r.key.startsWith('flood:'))
    expect(flood).toHaveLength(1)
    expect(flood[0]!.key).toBe('flood:test:2026-09-14T04')
    const second = await deliverAlerts(now + 1000)
    expect(second.sent).toBe(1) // the summary itself, past the cap
    expect((await recentAlerts()).find((r) => r.key.startsWith('flood:'))!.status).toBe('sent')
  })

  it('is not written for a duplicate that was never queued', async () => {
    _setConfigForTests({ OPERATOR_ALERT_MAX_PER_HOUR: 1 })
    const now = Date.UTC(2026, 8, 14, 5, 0, 0)
    await raise(draft({ key: 'dup', tier: 'quiet' }), now)
    await deliverAlerts(now)
    await raise(draft({ key: 'dup', tier: 'quiet' }), now + 1000) // the other party's emission of the same fact
    expect((await recentAlerts()).some((r) => r.key.startsWith('flood:'))).toBe(false)
  })

  it('tells the four endings apart in the summary the overview shows', async () => {
    const now = Date.now()
    const row = (key: string, lastError: string) => ({ id: `alr_${key}`, env: 'test' as const, tier: 'quiet' as const, key, title: 't', body: 'b', status: 'suppressed' as const, attempt: 1, nextAttemptAt: now, lastError, createdAt: now, updatedAt: now })
    await db().insert(operatorAlerts).values([row('s1', SUPPRESSED.cap(12)), row('s2', SUPPRESSED.noChannel), row('s3', SUPPRESSED.ourMoney), row('s4', 'some new wording nobody has classified')])
    const s = await alertsStatus(now)
    expect(s.last_7_days).toMatchObject({ given_up_after_cap: 1, suppressed_no_channel: 1, suppressed_our_money: 1, suppressed_other: 1 })
  })
})

describe('delivering alerts (ADR-49)', () => {
  it('marks an alert sent as soon as one channel took it, and keeps what the others answered', async () => {
    _setConfigForTests({ OPERATOR_ALERT_EMAIL: 'nick@example.com', RESEND_API_KEY: 're_key_12345678' })
    answer = (url) => ({ status: url.includes('resend') ? 500 : 200 })
    await raise(draft())
    const r = await deliverAlerts()
    expect(r).toMatchObject({ sent: 1, retried: 0, failed: 0 })
    expect(sent.map((s) => s.url)).toEqual(['https://api.resend.com/emails', WEBHOOK])
    const [row] = await recentAlerts()
    expect(row!.status).toBe('sent')
    expect(row!.results).toEqual([
      { channel: 'email', ok: false, status: 500, error: 'body from the fake channel' },
      { channel: 'webhook:ntfy', ok: true, status: 200 },
    ])
  })

  it('retries with backoff and gives up after the last attempt', async () => {
    answer = () => ({ status: 503 })
    const now = 1_700_000_000_000
    await raise(draft(), now)
    for (let i = 0; i < ALERT_MAX_ATTEMPTS - 1; i++) {
      const at = now + ALERT_BACKOFF_MS.slice(0, i).reduce((a, b) => a + b, 0)
      expect(await deliverAlerts(at)).toMatchObject({ retried: 1 })
    }
    const last = now + ALERT_BACKOFF_MS.reduce((a, b) => a + b, 0)
    expect(await deliverAlerts(last)).toMatchObject({ failed: 1 })
    const [row] = await recentAlerts()
    expect(row!.status).toBe('failed')
    expect(row!.attempt).toBe(ALERT_MAX_ATTEMPTS)
    expect(row!.last_error).toContain('HTTP 503')
  })

  it('does not retry a delivered alert, so nobody is told twice', async () => {
    await raise(draft())
    await deliverAlerts()
    await deliverAlerts(Date.now() + 3600_000)
    expect(sent).toHaveLength(1)
  })
})

describe('what is worth waking the operator (ADR-49)', () => {
  let seller: TestAgent
  let buyer: TestAgent
  let chain: ReturnType<typeof installFakeChain>

  async function paidJob(opts: { sellerFirstParty?: boolean; price?: number } = {}) {
    if (opts.sellerFirstParty) await db().update(agents).set({ firstParty: true }).where(eq(agents.id, seller.agent.id))
    const price = opts.price ?? 250_000
    const l = await call(app, 'POST', '/v1/listings', { key: seller.api_keys.test, body: { title: 'A real service', description: 'Does something a buyer cannot do alone in a minute.', category: 'ops', pricing_model: 'fixed', price } })
    expect(l.status).toBe(201)
    const j = await call(app, 'POST', '/v1/jobs', { key: buyer.api_keys.test, body: { listing_id: l.body.id, input: { a: 1 } } })
    expect(j.status).toBe(201)
    await call(app, 'POST', `/v1/jobs/${j.body.id}/accept`, { key: seller.api_keys.test })
    await call(app, 'POST', `/v1/jobs/${j.body.id}/deliver`, { key: seller.api_keys.test, body: { output: { ok: true } } })
    const tx = chain.pay(buyer.wallet!.address, seller.wallet_address!, price)
    const p = await call(app, 'POST', `/v1/jobs/${j.body.id}/pay`, { key: buyer.api_keys.test, body: { transaction: tx } })
    expect(p.status).toBe(200)
    return j.body.id as string
  }

  beforeEach(async () => {
    chain = installFakeChain('test')
    seller = await createTestAgent(app, { name: 'Outside Seller' })
    buyer = await createTestAgent(app, { name: 'Outside Buyer' })
  })

  it('an order between outsiders is notable even before any money moves, and so is the sandbox payment for it', async () => {
    const jobId = await paidJob()
    const rows = await recentAlerts()
    const ordered = rows.find((a) => a.key === `ordered:${jobId}`)!
    const paid = rows.find((a) => a.key === `paid:${jobId}`)!
    // between_outsiders.orders is the widest mouth of the funnel and has been 0 on live for the whole history:
    // the first one must not sit below the default minimum tier.
    expect(ordered.tier).toBe('notable')
    expect(paid.title).toContain('between two outsiders')
    // ...but the sandbox runs on our own worthless testnet USDC, so it is not worth a phone at night
    expect(paid.tier).toBe('notable')
  })

  it('reserves urgent for real money: the same payment on live', () => {
    const facts = {
      job: { id: 'job_1', env: 'live', firstPartyInvolved: false, title: 'A real service', price: 250_000, buyerAgentId: 'agt_b', sellerAgentId: 'agt_s' },
      buyer: { handle: 'outside-buyer', firstParty: false, walletAddress: '0xaa' },
      seller: { handle: 'outside-seller', firstParty: false, walletAddress: '0xbb' },
      paid: 250_000,
      payers: ['0xaa'],
      transaction: '0x' + 'c'.repeat(64),
    }
    expect(classifyPayment(facts as never)!.tier).toBe('urgent')
    expect(classifyPayment({ ...facts, job: { ...facts.job, env: 'test' } } as never)!.tier).toBe('notable')
    // and dust is not a purchase, in either environment
    expect(classifyPayment({ ...facts, paid: 9_999 } as never)).toBeNull()
  })

  it('a payment to one of our own listings is notable, and says it cannot move the figure', async () => {
    const jobId = await paidJob({ sellerFirstParty: true })
    const paid = (await recentAlerts()).find((a) => a.key === `paid:${jobId}`)!
    expect(paid.tier).toBe('notable')
    expect(paid.title).toContain('paid to us')
  })

  it('says nothing when WE are the buyer: our own desk is not demand', async () => {
    await db().update(agents).set({ firstParty: true }).where(eq(agents.id, buyer.agent.id))
    const jobId = await paidJob()
    expect((await recentAlerts()).some((a) => a.key === `paid:${jobId}`)).toBe(false)
  })

  it('says nothing about dust: the same floor the published figure uses', async () => {
    const jobId = await paidJob({ price: 1 })
    expect((await recentAlerts()).some((a) => a.key === `paid:${jobId}`)).toBe(false)
  })

  it('holds back a payment made with money that came from us, and records why', async () => {
    // The sandbox faucet seeds ourFundedWallets (modules/payments/our-money.ts). A wallet we filled paying a
    // seller is our own traffic wearing someone else's handle; the row stays, visible, marked.
    const jobId = await paidJob()
    await db()
      .insert(faucetClaims)
      .values({ id: 'fct_' + '1'.repeat(26), agentId: buyer.agent.id, address: buyer.wallet!.address.toLowerCase(), amount: 1_000_000, transaction: '0x' + 'd'.repeat(64), day: '2026-09-10', ipHash: 'x', createdAt: Date.now() })
    const r = await deliverAlerts()
    expect(r.suppressed).toBeGreaterThanOrEqual(1)
    const paid = (await recentAlerts()).find((a) => a.key === `paid:${jobId}`)!
    expect(paid.status).toBe('suppressed')
    expect(paid.last_error).toContain('came from us')
    expect(sent.some((s) => s.body.includes('between two outsiders'))).toBe(false)
  })

  it('a sealed delivery on a bounty that pays only after a human confirms it wakes the operator (ADR-57)', async () => {
    // the desk is ours; the seller is an outsider delivering a security finding
    await db().update(agents).set({ firstParty: true }).where(eq(agents.id, buyer.agent.id))
    const l = await call(app, 'POST', '/v1/listings', { key: seller.api_keys.test, body: { title: 'Security finding', description: 'A reproducible flaw in the platform, with steps.', category: 'ops', pricing_model: 'fixed', price: 10_000_000 } })
    const withFlag = await call(app, 'POST', '/v1/jobs', { key: buyer.api_keys.test, body: { listing_id: l.body.id, input: { operator_confirmation_before_payment: true } } })
    const without = await call(app, 'POST', '/v1/jobs', { key: buyer.api_keys.test, body: { listing_id: l.body.id, input: { round: 2 } } })
    for (const j of [withFlag, without]) {
      expect(j.status).toBe(201)
      await call(app, 'POST', `/v1/jobs/${j.body.id}/accept`, { key: seller.api_keys.test })
      await call(app, 'POST', `/v1/jobs/${j.body.id}/deliver`, { key: seller.api_keys.test, body: { output: { title: 'Auth bypass', steps: ['a', 'b'] }, preview: { title: 'Auth bypass' } } })
    }
    const rows = await recentAlerts()
    const confirm = rows.find((a) => a.key === `confirm:${withFlag.body.id}`)
    expect(confirm).toBeTruthy()
    expect(confirm!.tier).toBe('notable') // sandbox; urgent on live
    expect(confirm!.title).toContain("operator's confirmation")
    const job = (await db().query.jobs.findFirst({ where: eq(jobs.id, withFlag.body.id) }))!
    const alert = (await db().query.operatorAlerts.findFirst({ where: eq(operatorAlerts.key, `confirm:${withFlag.body.id}`) }))!
    // the body names the exact write the operator has to make, bound to THIS delivery
    expect(alert.body).toContain(`operator/confirm/${withFlag.body.id}`)
    expect(alert.body).toContain(job.outputHash!)
    expect((alert.data as { output_hash?: string }).output_hash).toBe(job.outputHash)
    // an ordinary delivery to our desk is the desk's business, not the operator's
    expect(rows.find((a) => a.key === `confirm:${without.body.id}`)).toBeUndefined()
  })

  it('reads the frozen first-party flag, so flipping an agent afterwards cannot invent an alert', async () => {
    await db().update(agents).set({ firstParty: true }).where(eq(agents.id, seller.agent.id))
    const l = await call(app, 'POST', '/v1/listings', { key: seller.api_keys.test, body: { title: 'Ours', description: 'A platform-operated service for the test.', category: 'ops', pricing_model: 'fixed', price: 250_000 } })
    const j = await call(app, 'POST', '/v1/jobs', { key: buyer.api_keys.test, body: { listing_id: l.body.id, input: {} } })
    expect((await db().query.jobs.findFirst({ where: eq(jobs.id, j.body.id) }))!.firstPartyInvolved).toBe(true)
    // now "un-first-party" the seller: the job keeps the truth it was created with (ADR-44)
    await db().update(agents).set({ firstParty: false }).where(eq(agents.id, seller.agent.id))
    await call(app, 'POST', `/v1/jobs/${j.body.id}/accept`, { key: seller.api_keys.test })
    await call(app, 'POST', `/v1/jobs/${j.body.id}/deliver`, { key: seller.api_keys.test, body: { output: { ok: true } } })
    const tx = chain.pay(buyer.wallet!.address, seller.wallet_address!, 250_000)
    await call(app, 'POST', `/v1/jobs/${j.body.id}/pay`, { key: buyer.api_keys.test, body: { transaction: tx } })
    const paid = (await recentAlerts()).find((a) => a.key === `paid:${j.body.id}`)
    expect(paid?.tier).not.toBe('urgent')
  })
})

describe('operator endpoints (ADR-49)', () => {
  it('do not exist without an admin token, and refuse a test with nowhere to send it', async () => {
    _setConfigForTests({ ADMIN_TOKEN: undefined })
    expect((await call(app, 'GET', '/v1/admin/alerts')).status).toBe(404)
    _setConfigForTests({ ADMIN_TOKEN: ADMIN, OPERATOR_ALERT_WEBHOOK_URL: undefined })
    const off = await call(app, 'POST', '/v1/admin/alerts/test', { headers: { 'x-admin-token': ADMIN }, body: {} })
    expect(off.status).toBe(409)
    expect(off.body.error.code).toBe('alerts_not_configured')
    expect(off.body.error.hint).toContain('OPERATOR_ALERT_WEBHOOK_URL')
  })

  it('sends a test alert immediately and reports what the channel answered', async () => {
    const r = await call(app, 'POST', '/v1/admin/alerts/test', { headers: { 'x-admin-token': ADMIN }, body: { note: 'hello from the operator' } })
    expect(r.status).toBe(200)
    expect(r.body.delivery).toMatchObject({ sent: 1 })
    expect(r.body.webhook).toBe('ntfy')
    expect(sent[0]!.body).toContain('hello from the operator')
    const list = await call(app, 'GET', '/v1/admin/alerts', { headers: { 'x-admin-token': ADMIN } })
    expect(list.body.data[0]).toMatchObject({ status: 'sent', tier: 'urgent' })
    expect(list.body.channels.configured).toBe(true)
  })

  it('a second test is not deduplicated away', async () => {
    await call(app, 'POST', '/v1/admin/alerts/test', { headers: { 'x-admin-token': ADMIN }, body: {} })
    await new Promise((r) => setTimeout(r, 2))
    const second = await call(app, 'POST', '/v1/admin/alerts/test', { headers: { 'x-admin-token': ADMIN }, body: {} })
    expect(second.body.alert_id).not.toBeNull()
    expect(sent.length).toBeGreaterThanOrEqual(2)
  })

  it('never publishes an alert outside the admin routes', async () => {
    await raise(draft({ title: 'operator only' }))
    const a = await createTestAgent(app, { name: 'Nosy' })
    for (const path of ['/v1/events', '/v1/stats', '/v1/commitments']) {
      const res = await call(app, 'GET', path, { key: a.api_keys.test })
      expect(JSON.stringify(res.body)).not.toContain('operator only')
    }
    expect(await db().select().from(operatorAlerts).then((r) => r.length)).toBe(1)
    expect(randomAddress()).toMatch(/^0x[0-9a-f]{40}$/)
  })
})

/**
 * Findings from the adversarial audit of this module, each with the failure it would have caused.
 */
describe('audit fixes (ADR-49 follow-up)', () => {
  it('survives a long title in the ntfy Title header: fetch refuses a byte over 255 and the alert would be lost', () => {
    // The sanitiser ran BEFORE clamp, and clamp appended U+2026 — putting a non-latin-1 byte back in the header.
    // A seller picks its listing title, and the alert title carries it, so this was attacker-reachable.
    const long = 'Übersetzung: ' + 'A'.repeat(300)
    const r = webhookRequest(WEBHOOK, { tier: 'urgent', env: 'live', title: long, body: 'x', url: 'https://basescan.org/tx/0x1' })
    expect(() => new Headers(r.init.headers)).not.toThrow()
    expect([...r.init.headers.Title!].every((ch) => ch.charCodeAt(0) <= 255)).toBe(true)
    expect(r.init.headers.Title!.length).toBeLessThanOrEqual(120)
    expect(r.init.headers.Title!.endsWith('...')).toBe(true)
    expect(headerSafe('', 10, 'Agent Souk')).toBe('Agent Souk')
  })

  it('uses every backoff step: the last one was unreachable, so the retry window was 6m15s and not 36 minutes', async () => {
    answer = () => ({ status: 503 })
    const now = 1_700_000_000_000
    await raise(draft(), now)
    let at = now
    for (const wait of ALERT_BACKOFF_MS) {
      expect(await deliverAlerts(at)).toMatchObject({ retried: 1 })
      at += wait
    }
    expect(await deliverAlerts(at)).toMatchObject({ failed: 1 })
    const [row] = await recentAlerts()
    expect(row!.attempt).toBe(ALERT_BACKOFF_MS.length + 1)
    // the window really is the sum of every wait
    expect(at - now).toBe(ALERT_BACKOFF_MS.reduce((a, b) => a + b, 0))
  })
})

/** Second round of audit findings (ADR-54): the cap must delay an alert, never delete it. */
describe('the hourly cap defers instead of discarding (audit fix)', () => {
  it('holds an alert back and delivers it once the hour has room', async () => {
    _setConfigForTests({ OPERATOR_ALERT_MAX_PER_HOUR: 1 })
    const t0 = Date.UTC(2026, 8, 11, 12, 0, 0)
    await raise(draft({ key: 'first', tier: 'notable' }), t0)
    await deliverAlerts(t0)
    // the one that matters arrives during the busy hour and must not be lost
    await raise(draft({ key: 'ordered:job_x', tier: 'notable' }), t0 + 60_000)
    const held = (await recentAlerts()).find((r) => r.key === 'ordered:job_x')!
    expect(held.status).toBe('pending')
    expect(held.last_error).toContain('held back')

    // still inside the rolling hour: deferred again, never dropped (the flood summary does go out, it bypasses the cap)
    await deliverAlerts(t0 + 12 * 60_000)
    expect((await recentAlerts()).find((r) => r.key === 'ordered:job_x')!.status).toBe('pending')

    // an hour later the window has slid and it goes out
    const r = await deliverAlerts(t0 + 61 * 60_000)
    expect(r.sent).toBeGreaterThanOrEqual(1)
    expect((await recentAlerts()).find((r) => r.key === 'ordered:job_x')!.status).toBe('sent')
  })

  it('never holds back the notice that it is holding things back', async () => {
    _setConfigForTests({ OPERATOR_ALERT_MAX_PER_HOUR: 1 })
    const t0 = Date.UTC(2026, 8, 11, 12, 0, 0)
    await raise(draft({ key: 'first', tier: 'notable' }), t0)
    await deliverAlerts(t0)
    await raise(draft({ key: 'held', tier: 'notable', title: 'An outsider ordered from an outsider' }), t0 + 1000)
    await deliverAlerts(t0 + 2000)
    const flood = (await recentAlerts()).find((r) => r.key.startsWith('flood:'))!
    expect(flood.status).toBe('sent')
    // and it names what was held back in the BODY, because every channel drops `data`
    expect(sent.some((s) => s.body.includes('An outsider ordered from an outsider'))).toBe(true)
  })

  it('sends an urgent alert before a backlog of ordinary ones', async () => {
    _setConfigForTests({ OPERATOR_ALERT_MAX_PER_HOUR: 1000 })
    const t0 = Date.UTC(2026, 8, 11, 12, 0, 0)
    for (let i = 0; i < 25; i++) await raise(draft({ key: `noise${i}`, tier: 'quiet', env: 'test' }), t0)
    await raise(draft({ key: 'the-one', tier: 'urgent', env: 'live', title: 'Paid between two outsiders' }), t0 + 1000)
    await deliverAlerts(t0 + 2000)
    // the queue takes 20 a pass; without tier ordering the urgent live alert would sit behind all 25
    expect((await recentAlerts()).find((r) => r.key === 'the-one')!.status).toBe('sent')
    expect(sent[0]!.headers.Title).toContain('Paid between two outsiders')
  })

  it('gives up on a held-back alert only after hours, and says that is why', async () => {
    _setConfigForTests({ OPERATOR_ALERT_MAX_PER_HOUR: 1 })
    const t0 = Date.UTC(2026, 8, 11, 12, 0, 0)
    await raise(draft({ key: 'first', tier: 'notable' }), t0)
    await deliverAlerts(t0)
    await raise(draft({ key: 'old', tier: 'notable' }), t0 + 1000)
    // keep the hour permanently full by delivering a fresh alert just before the check
    for (let t = t0; t <= t0 + ALERT_DEFER_MAX_MS + 30 * 60_000; t += 30 * 60_000) {
      await raise(draft({ key: `keep${t}`, tier: 'urgent' }), t)
      await deliverAlerts(t)
    }
    const row = (await recentAlerts()).find((r) => r.key === 'old')!
    expect(row.status).toBe('suppressed')
    expect(row.last_error).toContain('given up on')
  })
})
