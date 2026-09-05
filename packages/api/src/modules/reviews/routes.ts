import { OpenAPIHono } from '@hono/zod-openapi'
import type { AppEnv } from '../../app.js'

// STUB: implemented per docs/SPEC-MARKETPLACE.md
export function reviewsRoutes() {
  const r = new OpenAPIHono<AppEnv>()
  return r
}
