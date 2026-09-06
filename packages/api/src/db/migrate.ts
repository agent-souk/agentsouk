import { migrate } from 'drizzle-orm/libsql/migrator'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { db, getClient } from './client.js'
import { log } from '../lib/log.js'

const here = dirname(fileURLToPath(import.meta.url))
export const MIGRATIONS_FOLDER = join(here, '..', '..', 'drizzle')

export async function runMigrations(target = db()) {
  await migrate(target, { migrationsFolder: MIGRATIONS_FOLDER })
}

export async function prepareDatabase() {
  await getClient().execute('PRAGMA journal_mode = WAL')
  await getClient().execute('PRAGMA foreign_keys = ON')
  await getClient().execute('PRAGMA busy_timeout = 5000')
  await runMigrations()
  log.info({ folder: MIGRATIONS_FOLDER }, 'migrations applied')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  prepareDatabase()
    .then(() => process.exit(0))
    .catch((e) => {
      log.error(e)
      process.exit(1)
    })
}
