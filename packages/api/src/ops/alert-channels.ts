import { config } from '../config.js'
import type { AlertTier } from '../db/schema.js'

/**
 * ADR-49: where an operator alert physically goes.
 *
 * Two facts shaped this file. First, no new dependency: this repository has a short, deliberate dependency list
 * and an alert is one HTTP POST, so both channels are plain `fetch`. Second, Fly.io blocks outbound SMTP, so
 * e-mail goes through a provider's HTTP API rather than a mail transport.
 *
 * The webhook channel is deliberately one URL and nothing else. Discord, Slack, ntfy and Telegram are all "POST
 * a body to a URL" and differ only in the field name, so the shape is derived from the host: the operator can
 * change where the alerts land by changing one environment variable, without a code change and without an
 * account anywhere if they pick ntfy. An unknown host still gets a well-formed JSON body carrying every alias
 * those services use, which is the most useful thing to send to a receiver we know nothing about.
 */

export type ChannelKind = 'discord' | 'slack' | 'ntfy' | 'telegram' | 'generic'

export type AlertPayload = {
  tier: AlertTier
  env: string
  title: string
  body: string
  url?: string | null
  data?: Record<string, unknown>
}

export type ChannelRequest = { channel: string; url: string; init: { method: string; headers: Record<string, string>; body: string } }

/** Discord refuses a message over 2000 characters outright, so every channel gets the same conservative budget. */
export const MAX_MESSAGE_CHARS = 1800

export function clamp(text: string, max = MAX_MESSAGE_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/**
 * A string safe to put in an HTTP header: latin-1 only, clamped, with an ASCII marker.
 *
 * Order matters and it bit us: stripping non-latin-1 characters and THEN clamping puts a U+2026 ellipsis back in,
 * and `fetch` refuses the whole request ("character ... greater than 255"). The alert is then lost, retried four
 * times and marked failed - and the text that triggers it is a job title, which a seller chooses. Anything that
 * reaches a header goes through here.
 */
export function headerSafe(text: string, max: number, fallback: string): string {
  const ascii = text.replace(/[^\x20-\x7e]/g, '').trim() || fallback
  return ascii.length <= max ? ascii : `${ascii.slice(0, max - 3)}...`
}

/** Which service a webhook URL belongs to. Host only: a path is not evidence of anything. */
export function channelKindOf(url: string): ChannelKind {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return 'generic'
  }
  if (host === 'discord.com' || host === 'discordapp.com' || host.endsWith('.discord.com') || host.endsWith('.discordapp.com')) return 'discord'
  if (host === 'hooks.slack.com' || host.endsWith('.slack.com')) return 'slack'
  if (host === 'ntfy.sh' || host.endsWith('.ntfy.sh')) return 'ntfy'
  if (host === 'api.telegram.org' || host.endsWith('.telegram.org')) return 'telegram'
  return 'generic'
}

/** ntfy priority: 5 max, 4 high, 3 default. An urgent alert is the one that may break through a phone's silence. */
const NTFY_PRIORITY: Record<AlertTier, string> = { urgent: '5', notable: '4', quiet: '3' }
const TIER_MARK: Record<AlertTier, string> = { urgent: '🔴', notable: '🟡', quiet: '⚪' }

function plain(a: AlertPayload): string {
  return clamp([`${TIER_MARK[a.tier]} ${a.title}`, '', a.body, a.url ? `\n${a.url}` : ''].join('\n').trim())
}

/** The webhook request for one alert, in whatever shape the target host reads. */
export function webhookRequest(url: string, a: AlertPayload, kind: ChannelKind = channelKindOf(url)): ChannelRequest {
  const text = plain(a)
  const json = (body: unknown, target = url) => ({ channel: `webhook:${kind}`, url: target, init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } })
  if (kind === 'discord') return json({ content: text, username: 'Agent Souk' })
  if (kind === 'slack') return json({ text })
  if (kind === 'ntfy') {
    // ntfy takes the message as the raw body; the extras are headers. Latin-1 only, so the tier mark is dropped
    // from the title and carried as a tag instead - an invalid header byte would fail the whole request.
    return {
      channel: 'webhook:ntfy',
      url,
      init: {
        method: 'POST',
        headers: { 'content-type': 'text/plain; charset=utf-8', Title: headerSafe(a.title, 120, 'Agent Souk'), Priority: NTFY_PRIORITY[a.tier], Tags: a.tier === 'urgent' ? 'rotating_light' : 'bell', ...(a.url ? { Click: headerSafe(a.url, 500, '') } : {}) },
        body: clamp(a.body),
      },
    }
  }
  if (kind === 'telegram') {
    // The bot API wants chat_id with every message; the operator puts it in the URL query, where it is visible
    // and changeable without a deploy. Telegram ignores an unknown query parameter, so passing it on in the body
    // is the safe half of the two.
    let chatId: string | null = null
    try {
      chatId = new URL(url).searchParams.get('chat_id')
    } catch {
      /* generic body below still applies */
    }
    return json({ ...(chatId ? { chat_id: chatId } : {}), text, disable_web_page_preview: true })
  }
  // Unknown receiver: send the whole alert, plus the field names the four known services use, so a wrapper
  // written for any of them keeps working.
  return json({ object: 'operator_alert', tier: a.tier, env: a.env, title: a.title, body: a.body, url: a.url ?? null, data: a.data ?? {}, text, content: text, message: text })
}

/** The e-mail request for one alert (Resend's HTTP API; no SMTP, no dependency). */
export function emailRequest(apiKey: string, from: string, to: string, a: AlertPayload): ChannelRequest {
  const subject = clamp(`[${a.tier}] ${a.title}`, 200)
  const text = [a.body, a.url ? `\n${a.url}` : '', '', `env: ${a.env} · Agent Souk operator alert (ADR-49). Set OPERATOR_ALERT_MIN_TIER or unset OPERATOR_ALERT_EMAIL to change what arrives here.`].join('\n')
  return {
    channel: 'email',
    url: 'https://api.resend.com/emails',
    init: { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ from, to: [to], subject, text }) },
  }
}

/** Every channel the current configuration would send this alert to. Empty = alerting is off, which is allowed. */
export function requestsFor(a: AlertPayload): ChannelRequest[] {
  const c = config()
  const out: ChannelRequest[] = []
  if (c.OPERATOR_ALERT_EMAIL && c.RESEND_API_KEY) out.push(emailRequest(c.RESEND_API_KEY, c.OPERATOR_ALERT_EMAIL_FROM, c.OPERATOR_ALERT_EMAIL, a))
  if (c.OPERATOR_ALERT_WEBHOOK_URL) out.push(webhookRequest(c.OPERATOR_ALERT_WEBHOOK_URL, a))
  return out
}

/** What is configured, for the operator overview: names only, never the key or the full URL. */
export function channelStatus(): { email: string | null; webhook: ChannelKind | null; min_tier: AlertTier; configured: boolean } {
  const c = config()
  const email = c.OPERATOR_ALERT_EMAIL && c.RESEND_API_KEY ? c.OPERATOR_ALERT_EMAIL.replace(/^(.).*(@.*)$/, '$1***$2') : null
  const webhook = c.OPERATOR_ALERT_WEBHOOK_URL ? channelKindOf(c.OPERATOR_ALERT_WEBHOOK_URL) : null
  return { email, webhook, min_tier: c.OPERATOR_ALERT_MIN_TIER, configured: !!(email || webhook) }
}
