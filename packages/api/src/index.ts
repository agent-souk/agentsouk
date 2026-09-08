import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { config } from './config.js'
import { log } from './lib/log.js'
import { prepareDatabase } from './db/migrate.js'
import { startScheduler, stopScheduler } from './lib/scheduler.js'
import { startSanctionsRefresh } from './modules/payments/sanctions.js'
import { flushHits } from './discovery/hits.js'
import { backfillReputation } from './modules/reviews/service.js'

async function main() {
  await prepareDatabase()
  // ADR-32: rows computed before the first/third-party split get the new fields once; a no-op afterwards.
  const backfill = await backfillReputation()
  if (backfill.recomputed || backfill.errors) log.info(backfill, 'reputation backfill')
  const app = createApp()
  startScheduler()
  startSanctionsRefresh()
  const { PORT, HOST, PUBLIC_BASE_URL } = config()
  serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
    log.info({ port: info.port, host: HOST, publicBaseUrl: PUBLIC_BASE_URL, database: config().DATABASE_URL }, 'agentsouk api listening')
  })
  // Graceful stop (deploys, restarts): stop the sweeps and persist the discovery counters gathered since the last sweep.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      stopScheduler()
      flushHits()
        .catch((e) => log.warn({ err: e }, 'final discovery flush failed'))
        .finally(() => process.exit(0))
    })
  }
}

main().catch((e) => {
  log.fatal(e, 'startup failed')
  process.exit(1)
})
