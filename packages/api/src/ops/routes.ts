import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AppEnv } from '../app.js'
import { errors } from '../lib/errors.js'
import { errorResponses } from '../lib/http.js'
import { requireAdmin } from '../middleware/admin.js'
import { channelStatus } from './alert-channels.js'
import { alertsStatus, deliverAlerts, raise, recentAlerts } from './alerts.js'

/**
 * ADR-49: the operator's own endpoints. Not part of the marketplace API, not in any discovery text, and behind
 * X-Admin-Token like every other operator route - so when ADMIN_TOKEN is unset they answer 404 and do not exist.
 */
export function opsRoutes() {
  const r = new OpenAPIHono<AppEnv>()

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/admin/alerts',
      tags: ['admin'],
      summary: 'Operator alerts: what was raised, what got through, what is stuck',
      description: 'Requires header X-Admin-Token. Newest first. `channels` says what is configured, without the key or the full URL.',
      middleware: [requireAdmin],
      request: { query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }) },
      responses: { 200: { description: 'Alerts', content: { 'application/json': { schema: z.object({ object: z.literal('operator_alerts') }).passthrough().openapi('OperatorAlerts') } } }, ...errorResponses },
    }),
    async (c) => {
      const { limit } = c.req.valid('query')
      const [data, status] = await Promise.all([recentAlerts(limit), alertsStatus()])
      return c.json({ object: 'operator_alerts' as const, ...status, data, generated_at: new Date().toISOString() }, 200)
    },
  )

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/admin/alerts/test',
      tags: ['admin'],
      summary: 'Send a test alert through every configured channel, now',
      description:
        'Requires header X-Admin-Token. Delivers immediately instead of waiting for the sweep and answers with what each channel returned, so a wrong webhook URL or an unverified sender is visible here rather than on the night a real purchase happens.',
      middleware: [requireAdmin],
      request: { body: { content: { 'application/json': { schema: z.object({ note: z.string().max(200).optional() }).optional() } }, required: false } },
      responses: { 200: { description: 'Delivered', content: { 'application/json': { schema: z.object({ object: z.literal('operator_alert_test') }).passthrough().openapi('OperatorAlertTest') } } }, ...errorResponses },
    }),
    async (c) => {
      const status = channelStatus()
      if (!status.configured) {
        throw errors.state(
          'alerts_not_configured',
          'No alert channel is configured, so there is nowhere to send a test.',
          'Set OPERATOR_ALERT_WEBHOOK_URL (a Discord, Slack, ntfy or Telegram URL - ntfy needs no account), or OPERATOR_ALERT_EMAIL together with RESEND_API_KEY, and restart.',
        )
      }
      const note = (await c.req.json().catch(() => ({})))?.note as string | undefined
      const now = Date.now()
      // A fresh key every call: a test that silently deduplicated against an earlier test would prove nothing.
      const id = await raise({ env: 'test', tier: 'urgent', key: `test:${now}`, title: 'Test alert from Agent Souk', body: [note ?? 'If you can read this, the channel works.', '', 'A real alert looks like this. The ones that matter say "paid between two outsiders".'].join('\n'), data: { test: true } }, now)
      const result = await deliverAlerts(now)
      const [row] = await recentAlerts(1)
      return c.json({ object: 'operator_alert_test' as const, ...status, alert_id: id, delivery: result, alert: row ?? null }, 200)
    },
  )

  return r
}
