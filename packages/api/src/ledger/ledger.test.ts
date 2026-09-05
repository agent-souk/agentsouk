import { describe, it, expect, beforeEach } from 'vitest'
import { _resetDbForTests, type Db } from '../db/client.js'
import { runMigrations } from '../db/migrate.js'
import { Ledger, type AccountRef } from './ledger.js'

let db: Db
let ledger: Ledger

const faucet: AccountRef = { ownerType: 'platform', ownerId: 'platform', currency: 'CRD', kind: 'faucet' }
const alice: AccountRef = { ownerType: 'agent', ownerId: 'agt_alice', currency: 'CRD', kind: 'available' }
const bob: AccountRef = { ownerType: 'agent', ownerId: 'agt_bob', currency: 'CRD', kind: 'available' }
const escrow: AccountRef = { ownerType: 'escrow', ownerId: 'job_1', currency: 'CRD', kind: 'escrow' }

beforeEach(async () => {
  db = await _resetDbForTests()
  await runMigrations(db)
  ledger = new Ledger(db)
})

describe('ledger', () => {
  it('posts a balanced faucet transaction', async () => {
    const t = await ledger.post({
      env: 'test',
      type: 'faucet',
      currency: 'CRD',
      amount: 1000,
      legs: [
        { account: faucet, delta: -1000 },
        { account: alice, delta: +1000 },
      ],
    })
    expect(t.entries).toHaveLength(2)
    expect(await ledger.balance('test', alice)).toBe(1000)
    expect(await ledger.balance('test', faucet)).toBe(-1000)
  })

  it('rejects overdraft on agent accounts', async () => {
    await expect(
      ledger.post({
        env: 'test',
        type: 'transfer',
        currency: 'CRD',
        amount: 5,
        legs: [
          { account: alice, delta: -5 },
          { account: bob, delta: +5 },
        ],
      }),
    ).rejects.toMatchObject({ code: 'insufficient_funds' })
    expect(await ledger.balance('test', alice)).toBe(0)
    expect(await ledger.balance('test', bob)).toBe(0)
  })

  it('rejects unbalanced legs', async () => {
    await expect(
      ledger.post({ env: 'test', type: 'transfer', currency: 'CRD', amount: 5, legs: [{ account: alice, delta: -5 }] }),
    ).rejects.toMatchObject({ code: 'unbalanced_transaction' })
  })

  it('is idempotent per initiator + key', async () => {
    const seed = () =>
      ledger.post({
        env: 'test',
        type: 'faucet',
        currency: 'CRD',
        amount: 100,
        legs: [
          { account: faucet, delta: -100 },
          { account: alice, delta: +100 },
        ],
        initiatorAgentId: 'agt_alice',
        idempotencyKey: 'k1',
      })
    const a = await seed()
    const b = await seed()
    expect(a.id).toBe(b.id)
    expect(await ledger.balance('test', alice)).toBe(100)
  })

  it('escrow lock, release and reverse', async () => {
    await ledger.post({ env: 'test', type: 'faucet', currency: 'CRD', amount: 100, legs: [{ account: faucet, delta: -100 }, { account: alice, delta: +100 }] })
    const lock = await ledger.post({ env: 'test', type: 'escrow_lock', currency: 'CRD', amount: 60, legs: [{ account: alice, delta: -60 }, { account: escrow, delta: +60 }], referenceType: 'job', referenceId: 'job_1' })
    expect(await ledger.balance('test', alice)).toBe(40)
    expect(await ledger.balance('test', escrow)).toBe(60)
    await ledger.post({ env: 'test', type: 'escrow_release', currency: 'CRD', amount: 60, legs: [{ account: escrow, delta: -60 }, { account: bob, delta: +57 }, { account: { ownerType: 'platform', ownerId: 'platform', currency: 'CRD', kind: 'fees' }, delta: +3 }] })
    expect(await ledger.balance('test', escrow)).toBe(0)
    expect(await ledger.balance('test', bob)).toBe(57)
    // reversing the lock now would overdraw escrow -> insufficient funds on the escrow account
    await expect(ledger.reverse(lock.id)).rejects.toMatchObject({ code: 'insufficient_funds' })
  })

  it('separates envs', async () => {
    await ledger.post({ env: 'live', type: 'faucet', currency: 'CRD', amount: 7, legs: [{ account: faucet, delta: -7 }, { account: alice, delta: +7 }] })
    expect(await ledger.balance('live', alice)).toBe(7)
    expect(await ledger.balance('test', alice)).toBe(0)
  })
})
