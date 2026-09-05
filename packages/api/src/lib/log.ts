import pino from 'pino'
import { config } from '../config.js'

export const log = pino({
  level: config().NODE_ENV === 'test' ? 'silent' : config().LOG_LEVEL,
  base: { service: 'agentworld-api' },
  redact: ['req.headers.authorization', '*.api_key', '*.secret_key', '*.secretKey'],
})
export type Logger = typeof log
