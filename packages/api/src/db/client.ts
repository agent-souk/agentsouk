import { createClient, type Client } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { config } from '../config.js'
import * as schema from './schema.js'

export type Db = ReturnType<typeof makeDb>

let _client: Client | undefined
let _db: Db | undefined

function makeDb(client: Client) {
  return drizzle(client, { schema })
}

export function getClient(): Client {
  if (!_client) {
    const url = config().DATABASE_URL
    if (url.startsWith('file:')) {
      const path = url.slice('file:'.length)
      if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    }
    _client = createClient({ url, authToken: config().DATABASE_AUTH_TOKEN })
  }
  return _client
}

export function db(): Db {
  if (!_db) _db = makeDb(getClient())
  return _db
}

/**
 * Test helper: swap in a fresh database. libsql's `:memory:` opens a separate connection for
 * batch/transaction calls (so migrations would land in a different DB), therefore tests use a
 * unique temp file instead.
 */
let _testFile: string | null = null

export async function _resetDbForTests(): Promise<Db> {
  if (_client) _client.close()
  const dir = join(tmpdir(), 'agentsouk-tests')
  mkdirSync(dir, { recursive: true })
  // every freshApp() gets a new file; the previous one and any file older than 30 minutes are deleted so a day of test
  // runs does not fill the disk (it once did: 7,861 files, 3.1 GB). Best effort: Windows keeps a just-closed file
  // locked for a moment, so a failed unlink is not an error. The directory is safe to wipe at any time.
  const unlink = (f: string) => {
    try {
      rmSync(f, { force: true })
    } catch {
      /* still open (Windows): the age-based prune of a later run picks it up */
    }
  }
  if (_testFile) for (const suffix of ['', '-wal', '-shm', '-journal']) unlink(_testFile + suffix)
  const cutoff = Date.now() - 30 * 60_000
  try {
    for (const name of readdirSync(dir)) {
      const f = join(dir, name)
      try {
        if (statSync(f).mtimeMs < cutoff) unlink(f)
      } catch {
        /* vanished meanwhile */
      }
    }
  } catch {
    /* unreadable directory: ignore */
  }
  const file = join(dir, `t-${randomBytes(6).toString('hex')}.db`).replace(/\\/g, '/')
  _testFile = file
  _client = createClient({ url: `file:${file}` })
  await _client.execute('PRAGMA foreign_keys = ON')
  await _client.execute('PRAGMA busy_timeout = 5000')
  _db = makeDb(_client)
  return _db
}
