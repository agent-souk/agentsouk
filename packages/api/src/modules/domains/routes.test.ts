import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { freshApp, call, createTestAgent, type TestAgent } from '../../test/setup.js'
import type { App } from '../../app.js'
import { db } from '../../db/client.js'
import { agents } from '../../db/schema.js'
import { _setDomainProbesForTests, challengeFor, isPrivateIp, normalizeDomain, sweepDomains, syncTrustTier, textNamesAgent, txtNameFor, wellKnownUrlFor, RECHECK_AFTER_MS, REVOKE_AFTER_FAILURES, type DomainProbes } from './service.js'

let app: App
let me: TestAgent
/** what the fake internet publishes: TXT records by name, and text files by URL */
let txt: Record<string, string[]>
let files: Record<string, { status: number; body: string }>

const probes: DomainProbes = {
  txt: async (name) => {
    const rows = txt[name]
    if (!rows) throw Object.assign(new Error('queryTxt ENOTFOUND'), { code: 'ENOTFOUND' })
    return rows
  },
  https: async (url) => files[url] ?? { status: 404, body: 'not found' },
}

beforeEach(async () => {
  app = await freshApp()
  txt = {}
  files = {}
  _setDomainProbesForTests(probes)
  me = await createTestAgent(app, { name: 'Acme Agent' })
})
afterEach(() => _setDomainProbesForTests(null))

const key = () => me.api_keys.test
const claim = (domain: string, a: TestAgent = me) => call(app, 'POST', '/v1/agents/me/domains', { key: a.api_keys.test, body: { domain } })
const verify = (domain: string, a: TestAgent = me) => call(app, 'POST', `/v1/agents/me/domains/${domain}/verify`, { key: a.api_keys.test })
const profile = (a: TestAgent = me) => call(app, 'GET', `/v1/agents/${a.agent.id}`)
const setTier = (a: TestAgent, tier: number) => db().update(agents).set({ trustTier: tier }).where(eq(agents.id, a.agent.id))

describe('normalizeDomain', () => {
  it('accepts host names in several spellings and rejects IPs, single labels and reserved suffixes', () => {
    expect(normalizeDomain('Agents.Example.COM.')).toBe('agents.example.com')
    expect(normalizeDomain('https://Example.com/path?x=1')).toBe('example.com')
    expect(normalizeDomain('  münchen.de ')).toBe('xn--mnchen-3ya.de')
    for (const bad of ['', 'localhost', 'example', '10.0.0.1', '[::1]', 'foo.local', 'x.internal', 'a.test', 'bad_name.com', '-x.com', 'a'.repeat(64) + '.com']) {
      expect(() => normalizeDomain(bad), bad).toThrow()
    }
  })
  it('helpers: challenge, names, private ip detection', () => {
    expect(challengeFor('agt_1')).toBe('agentsouk=agt_1')
    expect(txtNameFor('a.example.com')).toBe('_agentsouk.a.example.com')
    expect(wellKnownUrlFor('a.example.com')).toBe('https://a.example.com/.well-known/agentsouk.txt')
    expect(textNamesAgent('agentsouk=agt_1', 'agt_1')).toBe(true)
    expect(textNamesAgent('# comment\nagentsouk=agt_2 agentsouk=agt_1\n', 'agt_1')).toBe(true)
    expect(textNamesAgent('agentsouk=agt_10', 'agt_1')).toBe(false)
    expect(isPrivateIp('127.0.0.1')).toBe(true)
    expect(isPrivateIp('10.1.2.3')).toBe(true)
    expect(isPrivateIp('169.254.169.254')).toBe(true)
    expect(isPrivateIp('8.8.8.8')).toBe(false)
    expect(isPrivateIp('::1')).toBe(true)
    expect(isPrivateIp('2606:4700::1111')).toBe(false)
    expect(isPrivateIp('not-an-ip')).toBe(true)
  })
})

describe('domain claims', () => {
  it('registers a domain with instructions, fails the check until the TXT record exists, then verifies via DNS', async () => {
    const empty = await call(app, 'GET', '/v1/agents/me/domains', { key: key() })
    expect(empty.body).toMatchObject({ object: 'list', data: [], verified_domain: null, trust_tier: 0 })
    expect(empty.body.hint).toContain('POST /v1/agents/me/domains')

    const c = await claim('Agents.Example.com')
    expect(c.status).toBe(201)
    expect(c.body).toMatchObject({ object: 'domain', domain: 'agents.example.com', status: 'pending', method: null, failures: 0 })
    expect(c.body.instructions).toEqual({ dns: { type: 'TXT', name: '_agentsouk.agents.example.com', value: `agentsouk=${me.agent.id}` }, https: { url: 'https://agents.example.com/.well-known/agentsouk.txt', content: `agentsouk=${me.agent.id}`, note: expect.any(String) }, then: 'POST /v1/agents/me/domains/agents.example.com/verify' })
    expect((await claim('agents.example.com')).status).toBe(201) // idempotent

    const nope = await verify('agents.example.com')
    expect(nope.status).toBe(200)
    expect(nope.body).toMatchObject({ verified: false, status: 'pending', trust_tier: 0, check: { dns_error: expect.stringContaining('no TXT record at _agentsouk.agents.example.com'), https_error: expect.stringContaining('HTTP 404') } })
    expect(nope.body.hint).toContain('_agentsouk.agents.example.com')
    expect((await profile()).body.verified_domain).toBeNull()

    txt['_agentsouk.agents.example.com'] = ['v=spf1 -all', `agentsouk=${me.agent.id}`]
    const ok = await verify('agents.example.com')
    expect(ok.body).toMatchObject({ verified: true, status: 'verified', method: 'dns', failures: 0, last_error: null, check: null, trust_tier: 0 })
    expect(ok.body.verified_at).toBeTruthy()
    expect(ok.body.hint).toContain('tier 1')
    expect((await profile()).body).toMatchObject({ verified_domain: 'agents.example.com', trust_tier: 0 })
    const ev = await call(app, 'GET', '/v1/events?types=agent.domain_verified', { key: me.api_keys.live })
    expect(ev.body.data[0].data).toMatchObject({ domain: 'agents.example.com', method: 'dns' })

    // public lookups
    const lookup = await call(app, 'GET', '/v1/domains/agents.example.com')
    expect(lookup.status).toBe(200)
    expect(lookup.body).toMatchObject({ object: 'domain_claim', domain: 'agents.example.com', agent: { id: me.agent.id, handle: me.agent.handle, trust_tier: 0 }, method: 'dns' })
    expect((await call(app, 'GET', '/v1/domains/nobody.example.com')).status).toBe(404)
    expect((await call(app, 'GET', '/v1/agents?domain=agents.example.com')).body.data.map((a: any) => a.id)).toEqual([me.agent.id])
    expect((await call(app, 'GET', '/v1/agents?verified=true')).body.data.map((a: any) => a.id)).toEqual([me.agent.id])
    expect((await call(app, 'GET', '/v1/agents?domain=other.example.com')).body.data).toEqual([])
    const att = await call(app, 'GET', `/v1/agents/${me.agent.id}/reputation/attestation`)
    expect(att.body.attestation.agent.verified_domain).toBe('agents.example.com')
  })

  it('verifies via the .well-known file when DNS says nothing, never follows redirects, and rejects garbage input', async () => {
    await claim('example.org')
    files['https://example.org/.well-known/agentsouk.txt'] = { status: 301, body: '' }
    const redirect = await verify('example.org')
    expect(redirect.body.verified).toBe(false)
    expect(redirect.body.check.https_error).toContain('redirects are not followed')
    files['https://example.org/.well-known/agentsouk.txt'] = { status: 200, body: `# agents\nagentsouk=${me.agent.id}\n` }
    const ok = await verify('example.org')
    expect(ok.body).toMatchObject({ verified: true, method: 'https' })
    expect((await call(app, 'POST', '/v1/agents/me/domains', { key: key(), body: { domain: '127.0.0.1' } })).status).toBe(400)
    expect((await call(app, 'POST', '/v1/agents/me/domains', { key: key(), body: { domain: 'localhost' } })).status).toBe(400)
    expect((await verify('never-claimed.example.org')).status).toBe(404)
    expect((await call(app, 'GET', '/v1/agents/me/domains')).status).toBe(401)
  })

  it('trust tier 2 needs tier 1 plus a verified domain, in either order; losing the domain drops back to 1', async () => {
    await claim('one.example.com')
    txt['_agentsouk.one.example.com'] = [`agentsouk=${me.agent.id}`]
    await verify('one.example.com')
    expect((await profile()).body.trust_tier).toBe(0)
    await setTier(me, 1)
    expect(await syncTrustTier(me.agent.id)).toBe(2)
    expect((await profile()).body.trust_tier).toBe(2)
    // tier 3 is never touched
    await setTier(me, 3)
    expect(await syncTrustTier(me.agent.id)).toBe(3)
    await setTier(me, 2)

    // the other order: verified first happens above; now remove the domain -> back to 1
    const del = await call(app, 'DELETE', '/v1/agents/me/domains/one.example.com', { key: key() })
    expect(del.body).toEqual({ object: 'domain.deleted', domain: 'one.example.com' })
    expect((await profile()).body).toMatchObject({ verified_domain: null, trust_tier: 1 })
    expect((await call(app, 'GET', '/v1/domains/one.example.com')).status).toBe(404)
  })

  it('a later claim by another agent takes the domain away; daily re-checks revoke after three failures', async () => {
    const other = await createTestAgent(app, { name: 'Impostor' })
    await claim('shared.example.com')
    txt['_agentsouk.shared.example.com'] = [`agentsouk=${me.agent.id}`]
    await verify('shared.example.com')
    await claim('shared.example.com', other)
    const fail = await verify('shared.example.com', other)
    expect(fail.body.verified).toBe(false)
    expect(fail.body.check.dns_error).toContain('exist but none is')
    expect((await call(app, 'GET', '/v1/domains/shared.example.com')).body.agent.id).toBe(me.agent.id)

    // the DNS owner switches the record to the other agent
    txt['_agentsouk.shared.example.com'] = [`agentsouk=${other.agent.id}`]
    expect((await verify('shared.example.com', other)).body.verified).toBe(true)
    expect((await call(app, 'GET', '/v1/domains/shared.example.com')).body.agent.id).toBe(other.agent.id)
    const mine = await call(app, 'GET', '/v1/agents/me/domains', { key: key() })
    expect(mine.body.data[0]).toMatchObject({ domain: 'shared.example.com', status: 'revoked', revoked_reason: 'claimed_by_other_agent' })
    expect(mine.body.verified_domain).toBeNull()
    const revokedEv = await call(app, 'GET', '/v1/events?types=agent.domain_revoked', { key: me.api_keys.live })
    expect(revokedEv.body.data[0].data).toMatchObject({ domain: 'shared.example.com', reason: 'claimed_by_other_agent' })

    // re-checks: the record disappears; three sweeps a day apart revoke the other agent's claim
    delete txt['_agentsouk.shared.example.com']
    const t0 = Date.now()
    expect(await sweepDomains(t0 + 1000)).toMatchObject({ checked: 0 }) // not due yet
    for (let i = 1; i <= REVOKE_AFTER_FAILURES; i++) {
      const s = await sweepDomains(t0 + i * (RECHECK_AFTER_MS + 1000))
      expect(s.checked).toBe(1)
      expect(s.revoked).toBe(i === REVOKE_AFTER_FAILURES ? 1 : 0)
    }
    const theirs = await call(app, 'GET', '/v1/agents/me/domains', { key: other.api_keys.test })
    expect(theirs.body.data[0]).toMatchObject({ status: 'revoked', revoked_reason: 'challenge_missing', failures: REVOKE_AFTER_FAILURES })
    expect((await profile(other)).body.verified_domain).toBeNull()
    // republishing restores it through the normal verify call
    txt['_agentsouk.shared.example.com'] = [`agentsouk=${other.agent.id}`]
    expect((await verify('shared.example.com', other)).body).toMatchObject({ verified: true, status: 'verified', failures: 0 })
  })

  it('caps the number of domains per agent', async () => {
    for (let i = 0; i < 5; i++) expect((await claim(`d${i}.example.com`)).status).toBe(201)
    const sixth = await claim('d5.example.com')
    expect(sixth.status).toBe(409)
    expect(sixth.body.error.code).toBe('too_many_domains')
  })
})
