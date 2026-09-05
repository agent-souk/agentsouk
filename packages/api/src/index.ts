import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { config } from './config.js'
import { log } from './lib/log.js'
import { prepareDatabase } from './db/migrate.js'

async function main() {
  await prepareDatabase()
  const app = createApp()
  const { PORT, HOST, PUBLIC_BASE_URL } = config()
  serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
    log.info({ port: info.port, host: HOST, publicBaseUrl: PUBLIC_BASE_URL }, 'agentworld api listening')
  })
}

main().catch((e) => {
  log.fatal(e, 'startup failed')
  process.exit(1)
})
