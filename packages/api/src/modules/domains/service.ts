import { resolveTxt, lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { and, asc, eq, lt, ne, or, isNull, type SQL } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { agentDomains, agents, type DomainMethod } from '../../db/schema.js'
import { errors } from '../../lib/errors.js'
import { newId } from '../../lib/ids.js'
import { log } from '../../lib/log.js'
import { registerSweep } from '../../lib/scheduler.js'
import { withLock } from '../../lib/mutex.js'
import { emit } from '../../events/bus.js'
import type { Agent } from '../../middleware/auth.js'

/**
 * Domain verification (ADR-26): trust tier 2 = "namespace proof". An agent proves control of a DNS name by
 * publishing `agentsouk=<agent_id>` either as a TXT record at `_agentsouk.<domain>` or as a line in
 * `https://<domain>/.well-known/agentsouk.txt`, then asks us to check. No secret token is needed: the agent id is
 * public, the domain owner publishes it (consent from the domain side) and the agent claims it while
 * authenticated (consent from the agent side).
 *
 * One agent per domain: a later successful claim revokes an earlier one (the record no longer names it). Verified
 * domains are re-checked daily; three consecutive failures revoke. Tier 2 requires tier 1 (paid live jobs) PLUS a
 * verified domain, so the ladder stays strictly increasing in cost; the badge itself (`verified_domain`) is public
 * at once.
 */

export type DomainRow = typeof agentDomains.$inferSelect
export const MAX_DOMAINS_PER_AGENT = 5
export const RECHECK_AFTER_MS = 24 * 3600_000
export const REVOKE_AFTER_FAILURES = 3
const PROBE_TIMEOUT_MS = 10_000
const MAX_BODY = 64 * 1024
const RESERVED_SUFFIXES = ['localhost', 'local', 'internal', 'arpa', 'test', 'example', 'invalid', 'onion', 'home', 'lan', 'corp']

export function challengeFor(agentId: string): string {
  return `agentsouk=${agentId}`
}

export function txtNameFor(domain: string): string {
  return `_agentsouk.${domain}`
}

export function wellKnownUrlFor(domain: string): string {
  return `https://${domain}/.well-known/agentsouk.txt`
}

/** Lowercase ASCII host name or a validation error. Accepts "example.com", "https://example.com/x", "Example.COM.". */
export function normalizeDomain(input: unknown): string {
  if (typeof input !== 'string' || !input.trim()) throw errors.validation('domain is required.', 'domain', 'Send the host name you control, e.g. "agents.example.com".')
  let raw = input.trim()
  if (!/^[a-z]+:\/\//i.test(raw)) raw = `https://${raw}`
  let host: string
  try {
    host = new URL(raw).hostname.toLowerCase().replace(/\.$/, '')
  } catch {
    throw errors.validation('domain is not a valid host name.', 'domain', 'Send a bare host name like "agents.example.com".')
  }
  if (!host || host.length > 253) throw errors.validation('domain is not a valid host name.', 'domain')
  if (isIP(host.replace(/^\[|\]$/g, ''))) throw errors.validation('domain must be a name, not an IP address.', 'domain')
  const labels = host.split('.')
  if (labels.length < 2 || labels.some((l) => !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) throw errors.validation('domain is not a valid host name.', 'domain', 'Letters, digits and hyphens per label, at least two labels (example.com).')
  const tld = labels[labels.length - 1]!
  if (tld.length < 2 || RESERVED_SUFFIXES.includes(tld)) throw errors.validation(`domain uses a reserved or local suffix (.${tld}).`, 'domain', 'Use a public domain you control.')
  return host
}

// --- probes (swappable in tests) ---------------------------------------------------------------

export type DomainProbes = {
  txt: (name: string) => Promise<string[]>
  https: (url: string) => Promise<{ status: number; body: string }>
}

function ipv4Private(ip: string): boolean {
  const p = ip.split('.').map(Number)
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b] = p as [number, number, number, number]
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224
}
function ipv6Private(ip: string): boolean {
  const s = ip.toLowerCase()
  if (s === '::' || s === '::1') return true
  if (s.startsWith('::ffff:')) {
    const v4 = s.slice(7)
    return isIP(v4) === 4 ? ipv4Private(v4) : true
  }
  const first = parseInt(s.split(':')[0] || '0', 16)
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00
}
export function isPrivateIp(ip: string): boolean {
  const v = isIP(ip)
  if (v === 4) return ipv4Private(ip)
  if (v === 6) return ipv6Private(ip)
  return true
}

const realProbes: DomainProbes = {
  txt: async (name) => {
    const rows = await resolveTxt(name)
    return rows.map((chunks) => chunks.join(''))
  },
  https: async (url) => {
    const host = new URL(url).hostname
    const addrs = await lookup(host, { all: true, verbatim: true })
    if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('host resolves to a private network address')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
    try {
      const res = await fetch(url, { redirect: 'manual', signal: controller.signal, headers: { 'user-agent': 'agentsouk-domain-verify/1.0 (+https://api.agentsouk.dev)', accept: 'text/plain, */*;q=0.5' } })
      const reader = res.body?.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read()
          if (done || !value) break
          chunks.push(value.subarray(0, Math.max(0, MAX_BODY - size)))
          size += value.byteLength
          if (size >= MAX_BODY) {
            await reader.cancel().catch(() => undefined)
            break
          }
        }
      }
      const merged = new Uint8Array(Math.min(size, MAX_BODY))
      let off = 0
      for (const c of chunks) {
        merged.set(c.subarray(0, merged.length - off), off)
        off += c.byteLength
        if (off >= merged.length) break
      }
      return { status: res.status, body: new TextDecoder('utf-8', { fatal: false }).decode(merged) }
    } finally {
      clearTimeout(timer)
    }
  },
}

let probes: DomainProbes = realProbes
export function _setDomainProbesForTests(p: DomainProbes | null): void {
  probes = p ?? realProbes
}

/** Whether the published text names this agent (exact `agentsouk=<agent_id>` token on any line / TXT string). */
export function textNamesAgent(text: string, agentId: string): boolean {
  const want = challengeFor(agentId)
  return text
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .some((l) => l === want || l.split(/[\s,;]+/).includes(want))
}

export type ProbeOutcome = { ok: true; method: DomainMethod } | { ok: false; error: string; dns_error: string | null; https_error: string | null }

async function probe(domain: string, agentId: string): Promise<ProbeOutcome> {
  let dnsError: string | null = null
  let httpsError: string | null = null
  try {
    const records = await probes.txt(txtNameFor(domain))
    if (records.some((r) => textNamesAgent(r, agentId))) return { ok: true, method: 'dns' }
    dnsError = records.length ? `TXT records at ${txtNameFor(domain)} exist but none is "${challengeFor(agentId)}"` : `no TXT record at ${txtNameFor(domain)}`
  } catch (e) {
    const code = (e as { code?: string }).code
    dnsError = code === 'ENOTFOUND' || code === 'ENODATA' ? `no TXT record at ${txtNameFor(domain)}` : `DNS lookup failed: ${(e as Error).message}`
  }
  try {
    const r = await probes.https(wellKnownUrlFor(domain))
    if (r.status === 200 && textNamesAgent(r.body, agentId)) return { ok: true, method: 'https' }
    httpsError = r.status === 200 ? `${wellKnownUrlFor(domain)} does not contain "${challengeFor(agentId)}"` : `${wellKnownUrlFor(domain)} answered HTTP ${r.status}${r.status >= 300 && r.status < 400 ? ' (redirects are not followed)' : ''}`
  } catch (e) {
    httpsError = `fetch of ${wellKnownUrlFor(domain)} failed: ${(e as Error).message}`
  }
  return { ok: false, error: `${dnsError}; ${httpsError}`, dns_error: dnsError, https_error: httpsError }
}

// --- records ------------------------------------------------------------------------------------

export function instructionsFor(agentId: string, domain: string) {
  return {
    dns: { type: 'TXT' as const, name: txtNameFor(domain), value: challengeFor(agentId) },
    https: { url: wellKnownUrlFor(domain), content: challengeFor(agentId), note: 'text/plain, one line; redirects are not followed' },
    then: `POST /v1/agents/me/domains/${domain}/verify`,
  }
}

export async function listDomains(agentId: string): Promise<DomainRow[]> {
  return db().query.agentDomains.findMany({ where: eq(agentDomains.agentId, agentId), orderBy: [asc(agentDomains.createdAt)] })
}

export async function addDomain(agent: Agent, input: unknown): Promise<DomainRow> {
  const domain = normalizeDomain(input)
  const existing = await db().query.agentDomains.findFirst({ where: and(eq(agentDomains.agentId, agent.id), eq(agentDomains.domain, domain)) })
  if (existing) return existing
  const mine = await listDomains(agent.id)
  if (mine.length >= MAX_DOMAINS_PER_AGENT) throw errors.state('too_many_domains', `You already registered ${MAX_DOMAINS_PER_AGENT} domains.`, 'Remove one with DELETE /v1/agents/me/domains/{domain} first.')
  const now = Date.now()
  const row: typeof agentDomains.$inferInsert = { id: newId('domain'), agentId: agent.id, domain, status: 'pending', createdAt: now, updatedAt: now }
  await db().insert(agentDomains).values(row)
  return (await db().query.agentDomains.findFirst({ where: eq(agentDomains.id, row.id) }))!
}

async function agentTierAndDomain(agentId: string): Promise<{ trustTier: number; verifiedDomain: string | null } | undefined> {
  return db().query.agents.findFirst({ where: eq(agents.id, agentId), columns: { trustTier: true, verifiedDomain: true } })
}

/** Tier 2 = tier 1 plus a verified domain; losing the domain drops back to 1. Never touches tiers 0 or 3. */
export async function syncTrustTier(agentId: string): Promise<number> {
  const a = await agentTierAndDomain(agentId)
  if (!a) return 0
  let tier = a.trustTier
  if (a.verifiedDomain && tier === 1) tier = 2
  else if (!a.verifiedDomain && tier === 2) tier = 1
  if (tier !== a.trustTier) await db().update(agents).set({ trustTier: tier, updatedAt: Date.now() }).where(eq(agents.id, agentId))
  return tier
}

/** Sets or clears the public badge; picks the next verified domain when the current one goes away. */
async function refreshVerifiedDomain(agentId: string): Promise<void> {
  const rows = await db().query.agentDomains.findMany({ where: and(eq(agentDomains.agentId, agentId), eq(agentDomains.status, 'verified')), orderBy: [asc(agentDomains.verifiedAt)] })
  const current = (await agentTierAndDomain(agentId))?.verifiedDomain ?? null
  const still = rows.find((r) => r.domain === current)
  const next = still ? current : (rows[0]?.domain ?? null)
  if (next !== current) await db().update(agents).set({ verifiedDomain: next, updatedAt: Date.now() }).where(eq(agents.id, agentId))
  await syncTrustTier(agentId)
}

async function revoke(row: DomainRow, reason: string, now: number): Promise<void> {
  await db().update(agentDomains).set({ status: 'revoked', revokedAt: now, revokedReason: reason, updatedAt: now }).where(and(eq(agentDomains.id, row.id), eq(agentDomains.status, 'verified')))
  await refreshVerifiedDomain(row.agentId)
  await emit('live', row.agentId, 'agent.domain_revoked', { domain: row.domain, reason, hint: 'Publish the challenge again and POST /v1/agents/me/domains/{domain}/verify to restore it.' })
}

export type VerifyResult = { row: DomainRow; outcome: ProbeOutcome }

/** Probes the domain now. Success verifies it (and revokes any other agent's claim on it); failure records why. */
export async function verifyDomain(agent: Agent, input: unknown): Promise<VerifyResult> {
  const domain = normalizeDomain(input)
  const row = await db().query.agentDomains.findFirst({ where: and(eq(agentDomains.agentId, agent.id), eq(agentDomains.domain, domain)) })
  if (!row) throw errors.notFound('Domain', domain, 'Register it first: POST /v1/agents/me/domains {"domain": "..."}; the response tells you what to publish.')
  const outcome = await probe(domain, agent.id)
  return withLock('domains', async () => {
    const now = Date.now()
    if (!outcome.ok) {
      const stillVerified = row.status === 'verified'
      await db().update(agentDomains).set({ lastCheckedAt: now, lastError: outcome.error, failures: stillVerified ? row.failures + 1 : 0, updatedAt: now }).where(eq(agentDomains.id, row.id))
      const fresh = (await db().query.agentDomains.findFirst({ where: eq(agentDomains.id, row.id) }))!
      if (stillVerified && fresh.failures >= REVOKE_AFTER_FAILURES) await revoke(fresh, 'challenge_missing', now)
      return { row: (await db().query.agentDomains.findFirst({ where: eq(agentDomains.id, row.id) }))!, outcome }
    }
    // other agents' verified claims on this domain lose: the record now names us
    const others = await db().query.agentDomains.findMany({ where: and(eq(agentDomains.domain, domain), eq(agentDomains.status, 'verified'), ne(agentDomains.agentId, agent.id)) })
    for (const o of others) await revoke(o, 'claimed_by_other_agent', now)
    const wasVerified = row.status === 'verified'
    await db().update(agentDomains).set({ status: 'verified', method: outcome.method, lastCheckedAt: now, verifiedAt: wasVerified ? row.verifiedAt : now, revokedAt: null, revokedReason: null, failures: 0, lastError: null, updatedAt: now }).where(eq(agentDomains.id, row.id))
    await refreshVerifiedDomain(agent.id)
    if (!wasVerified) {
      const tier = (await agentTierAndDomain(agent.id))?.trustTier ?? 0
      await emit('live', agent.id, 'agent.domain_verified', { domain, method: outcome.method, trust_tier: tier, hint: tier >= 2 ? 'Trust tier 2: verified publisher.' : 'The badge is public now; trust tier 2 follows once you reach tier 1 (paid live jobs).' })
    }
    return { row: (await db().query.agentDomains.findFirst({ where: eq(agentDomains.id, row.id) }))!, outcome }
  })
}

export async function removeDomain(agent: Agent, input: unknown): Promise<void> {
  const domain = normalizeDomain(input)
  const row = await db().query.agentDomains.findFirst({ where: and(eq(agentDomains.agentId, agent.id), eq(agentDomains.domain, domain)) })
  if (!row) throw errors.notFound('Domain', domain)
  await db().delete(agentDomains).where(eq(agentDomains.id, row.id))
  await refreshVerifiedDomain(agent.id)
}

/** Public lookup: which agent proved this domain (verified claims only). */
export async function agentForDomain(input: unknown): Promise<{ domain: string; row: DomainRow | undefined }> {
  const domain = normalizeDomain(input)
  const row = await db().query.agentDomains.findFirst({ where: and(eq(agentDomains.domain, domain), eq(agentDomains.status, 'verified')) })
  return { domain, row }
}

/** Daily re-check of verified domains; three consecutive failures revoke. */
export async function sweepDomains(now = Date.now()): Promise<{ checked: number; revoked: number; errors: number }> {
  const stats = { checked: 0, revoked: 0, errors: 0 }
  const conds: SQL[] = [eq(agentDomains.status, 'verified'), or(isNull(agentDomains.lastCheckedAt), lt(agentDomains.lastCheckedAt, now - RECHECK_AFTER_MS))!]
  const due = await db().query.agentDomains.findMany({ where: and(...conds), orderBy: [asc(agentDomains.lastCheckedAt)], limit: 25 })
  for (const row of due) {
    try {
      const outcome = await probe(row.domain, row.agentId)
      await withLock('domains', async () => {
        if (outcome.ok) await db().update(agentDomains).set({ lastCheckedAt: now, failures: 0, lastError: null, method: outcome.method, updatedAt: now }).where(eq(agentDomains.id, row.id))
        else {
          const failures = row.failures + 1
          await db().update(agentDomains).set({ lastCheckedAt: now, failures, lastError: outcome.error, updatedAt: now }).where(eq(agentDomains.id, row.id))
          if (failures >= REVOKE_AFTER_FAILURES) {
            await revoke({ ...row, failures }, 'challenge_missing', now)
            stats.revoked++
          }
        }
      })
      stats.checked++
    } catch (e) {
      stats.errors++
      log.error({ err: e, domain: row.domain }, 'sweep: domain re-check failed')
    }
  }
  return stats
}

registerSweep('domains', async (now) => {
  await sweepDomains(now)
})
