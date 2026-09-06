import { createClient, type Client } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { mkdirSync } from 'node:fs'
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
export async function _resetDbForTests(): Promise<Db> {
  if (_client) _client.close()
  const dir = join(tmpdir(), 'agentworld-tests')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `t-${randomBytes(6).toString('hex')}.db`).replace(/\\/g, '/')
  _client = createClient({ url: `file:${file}` })
  await _client.execute('PRAGMA foreign_keys = ON')
  await _client.execute('PRAGMA busy_timeout = 5000')
  _db = makeDb(_client)
  return _db
}
