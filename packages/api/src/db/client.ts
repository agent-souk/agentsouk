import { createClient, type Client } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
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

/** Test helper: swap in a fresh in-memory database. */
export async function _resetDbForTests(): Promise<Db> {
  _client = createClient({ url: ':memory:' })
  await _client.execute('PRAGMA foreign_keys = ON')
  _db = makeDb(_client)
  return _db
}
