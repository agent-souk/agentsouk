import { describe, it, expect } from 'vitest'
import { digestText, runDailyDigest, snapshotOf, type DigestFacts, type DigestSnapshot } from './digest.js'

const facts: DigestFacts = {
  sellerUsdc: 1_124_000n,
  deskSpentTotal: 43_151_370n,
  deskBudget: 0n,
  deskUsdc: 6_848_630n,
  jobsCompleted: 60,
  outsiderOrders: 78,
  outsiderJobsCompleted: 0,
  llmLiveUsd: 0.7435,
  llmTestUsd: 0.0407,
}

describe('daily money digest (ADR-71)', () => {
  it('reports the levels and, once there is a yesterday, the movement', () => {
    const first = digestText(facts, null)
    expect(first).toContain('1.124000 USDC earned ever')
    expect(first).toContain('43.151370 USDC desk spend ever')
    expect(first).toContain('of 0.000000 USDC budget')
    expect(first).toContain('0.7435 USD live today')
    expect(first).toContain('78 orders between outsiders, 0 completed')
    expect(first).toContain('first report')

    const yesterday: DigestSnapshot = { day: '2026-09-16', earned_usdc: '1074000', spent_usdc: '43151370', jobs_completed: 58, outsider_orders: 78 }
    const second = digestText(facts, yesterday)
    expect(second).toContain('1.124000 USDC earned ever (+0.050000)') // the day's takings
    expect(second).toContain('43.151370 USDC desk spend ever (+0.000000)') // nothing went out
    expect(second).toContain('60 delivered (+2)')
    expect(second).toContain('78 orders between outsiders (+0)')
    expect(second).not.toContain('first report')
  })

  it('sends once a day, keeps the snapshot only after a successful send, and retries a failed one', async () => {
    let saved: DigestSnapshot | null = null
    const sent: string[] = []
    const store = { load: async () => saved, save: async (v: DigestSnapshot) => void (saved = v) }
    const day = Date.parse('2026-09-17T06:00:00Z')
    const deps = { store, facts: async () => facts, send: async (t: string) => void sent.push(t), now: () => day }

    expect(await runDailyDigest(deps)).toBe('sent')
    expect(sent).toHaveLength(1)
    expect(saved).toEqual(snapshotOf(facts, '2026-09-17'))
    // the tick runs every ten minutes: the rest of the day is quiet
    expect(await runDailyDigest(deps)).toBe('already-sent')
    expect(sent).toHaveLength(1)
    // a new UTC day reports again
    expect(await runDailyDigest({ ...deps, now: () => day + 86_400_000 })).toBe('sent')
    expect(sent).toHaveLength(2)

    // a webhook that is down does not burn the day: nothing is stored, so the next tick tries again
    saved = null
    const failing = { ...deps, send: async () => Promise.reject(new Error('ntfy down')) }
    expect(await runDailyDigest(failing)).toBe('failed')
    expect(saved).toBeNull()
    expect(await runDailyDigest(deps)).toBe('sent')
  })
})
