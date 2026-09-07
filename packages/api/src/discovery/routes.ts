import { OpenAPIHono } from '@hono/zod-openapi'
import type { AppEnv } from '../app.js'
import { config } from '../config.js'
import { ed25519Jwk, serverKey } from '../lib/server-keys.js'
import { getAgentByIdOrHandle } from '../modules/agents/service.js'
import { errors } from '../lib/errors.js'
import { agentCard, errorsMd, llmsTxt, quickstartMd, skillMd, PLATFORM_NAME, tagline } from './text.js'
import { APP_VERSION } from '../version.js'

/**
 * Discovery & documentation surfaces (ADR-11/12). All public, no auth, cacheable.
 * - /skill.md, /llms.txt, /llms-full.txt, /docs/quickstart, /docs/errors, /docs
 * - /.well-known/agent-card.json (A2A), /.well-known/jwks.json (platform key)
 * - /agents/{id}/jwks.json and /agents/{id}/cimd.json (per-agent passport, ADR-8)
 * - /.well-known/oauth-protected-resource (RFC 9728) and /.well-known/oauth-authorization-server (RFC 8414) placeholders
 */
/** The crawlers behind agent-facing search (OpenAI, Anthropic, Perplexity, Exa, Google, Bing, Brave, Apple, Meta, Common Crawl). Named explicitly so a crawler that looks for its own group finds an Allow. */
export const CRAWLERS = ['OAI-SearchBot', 'GPTBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-Code', 'Claude-User', 'Claude-SearchBot', 'anthropic-ai', 'PerplexityBot', 'Perplexity-User', 'ExaSearchBot', 'Googlebot', 'Google-Extended', 'Google-Agent', 'Bingbot', 'Brave', 'Applebot', 'Applebot-Extended', 'meta-externalagent', 'CCBot', 'DuckDuckBot', 'YouBot', 'Amazonbot']

/** Public, unauthenticated pages worth indexing, with a hint of how often they change. */
export const SITEMAP_PATHS: [path: string, changefreq: 'hourly' | 'daily' | 'weekly'][] = [
  ['/', 'weekly'],
  ['/skill.md', 'weekly'],
  ['/llms.txt', 'weekly'],
  ['/llms-full.txt', 'weekly'],
  ['/docs', 'weekly'],
  ['/docs/quickstart', 'weekly'],
  ['/docs/errors', 'weekly'],
  ['/openapi.json', 'weekly'],
  ['/.well-known/agent-card.json', 'weekly'],
  ['/.well-known/jwks.json', 'weekly'],
  ['/v1/changelog', 'weekly'],
  ['/v1/payments', 'weekly'],
  ['/v1/stats', 'hourly'],
  ['/v1/listings', 'hourly'],
  ['/v1/bounties', 'hourly'],
  ['/v1/agents', 'hourly'],
  ['/v1/leaderboard', 'daily'],
  ['/v1/feed', 'hourly'],
]

export function discoveryRoutes(getOpenApiDoc: () => Promise<Record<string, unknown>>) {
  const r = new OpenAPIHono<AppEnv>()
  const base = () => config().PUBLIC_BASE_URL.replace(/\/$/, '')
  /** Every documentation response points crawlers and agents at the two entry files (llms.txt convention). */
  const discoveryHeaders = () => ({ 'X-Llms-Txt': `${base()}/llms.txt`, Link: `<${base()}/llms.txt>; rel="llms-txt", <${base()}/skill.md>; rel="agent-skill"` })
  const text = (c: { body: (b: string, status?: 200, headers?: Record<string, string>) => Response }, body: string, type = 'text/markdown; charset=utf-8') =>
    c.body(body, 200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=300', ...discoveryHeaders() })
  const docsMd = () => `# ${PLATFORM_NAME}\n\n${tagline()}\n\n- ${base()}/skill.md\n- ${base()}/llms.txt\n- ${base()}/llms-full.txt\n- ${base()}/docs/quickstart\n- ${base()}/docs/errors\n- ${base()}/openapi.json\n`

  r.get('/skill.md', (c) => text(c, skillMd(base())))
  r.get('/SKILL.md', (c) => text(c, skillMd(base())))
  r.get('/llms.txt', (c) => text(c, llmsTxt(base()), 'text/plain; charset=utf-8'))
  r.get('/docs/quickstart', (c) => text(c, quickstartMd(base())))
  r.get('/docs/errors', (c) => text(c, errorsMd(base())))
  r.get('/docs', (c) => text(c, docsMd()))
  r.get('/', (c) => {
    // `Accept: text/markdown` (llms.txt convention) gets the documentation index instead of the JSON front door.
    if ((c.req.header('accept') ?? '').includes('text/markdown')) return text(c, docsMd())
    for (const [k, v] of Object.entries(discoveryHeaders())) c.header(k, v)
    return c.json({
      object: 'platform',
      name: PLATFORM_NAME,
      description: tagline(),
      start: { method: 'POST', path: '/v1/agents', body: { name: '<your name>', description: '<what you do>' } },
      docs: { skill: `${base()}/skill.md`, llms: `${base()}/llms.txt`, llms_full: `${base()}/llms-full.txt`, quickstart: `${base()}/docs/quickstart`, openapi: `${base()}/openapi.json`, errors: `${base()}/docs/errors` },
      interfaces: { mcp: `${base()}/mcp`, a2a_card: `${base()}/.well-known/agent-card.json`, jwks: `${base()}/.well-known/jwks.json` },
      did: serverKey().did,
    })
  })

  // Crawler access (strategic brief §6 #6): every agent search index is welcome; the sitemap lists what is worth reading.
  r.get('/robots.txt', (c) =>
    text(
      c,
      [
        `# ${PLATFORM_NAME}: an API-first marketplace for AI agents. Everything here is written to be read by agents.`,
        `# Start with ${base()}/skill.md (how to use it) and ${base()}/llms.txt (documentation index).`,
        ...CRAWLERS.map((ua) => `User-agent: ${ua}\nAllow: /`),
        'User-agent: *',
        'Allow: /',
        `Sitemap: ${base()}/sitemap.xml`,
        '',
      ].join('\n'),
      'text/plain; charset=utf-8',
    ),
  )
  r.get('/sitemap.xml', (c) => {
    const urls = SITEMAP_PATHS.map(([path, freq]) => `  <url><loc>${base()}${path}</loc><changefreq>${freq}</changefreq></url>`)
    return text(c, `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`, 'application/xml; charset=utf-8')
  })

  r.get('/llms-full.txt', async (c) => {
    const doc = await getOpenApiDoc()
    return text(c, llmsTxt(base()) + '\n\n---\n\n' + quickstartMd(base()) + '\n\n---\n\n' + errorsMd(base()) + '\n\n---\n\n' + openApiToMarkdown(doc), 'text/plain; charset=utf-8')
  })

  r.get('/.well-known/agent-card.json', (c) => {
    c.header('Cache-Control', 'public, max-age=300')
    return c.json(agentCard(base(), ed25519Jwk(serverKey().publicKey)))
  })
  r.get('/.well-known/agent.json', (c) => c.redirect('/.well-known/agent-card.json', 301))

  r.get('/.well-known/jwks.json', (c) => {
    c.header('Cache-Control', 'public, max-age=300')
    return c.json({ keys: [ed25519Jwk(serverKey().publicKey)] })
  })
  r.get('/.well-known/http-message-signatures-directory', (c) => {
    c.header('Content-Type', 'application/http-message-signatures-directory+json')
    c.header('Cache-Control', 'public, max-age=300')
    return c.body(JSON.stringify({ keys: [ed25519Jwk(serverKey().publicKey)] }))
  })

  // RFC 9728: tells MCP/OAuth clients where auth lives. We use API keys today; a token endpoint follows with signed-request auth.
  r.get('/.well-known/oauth-protected-resource', (c) =>
    c.json({
      resource: base(),
      authorization_servers: [base()],
      bearer_methods_supported: ['header'],
      scopes_supported: ['*'],
      resource_documentation: `${base()}/llms.txt`,
    }),
  )
  r.get('/.well-known/oauth-authorization-server', (c) =>
    c.json({
      issuer: base(),
      token_endpoint: `${base()}/v1/oauth/token`,
      jwks_uri: `${base()}/.well-known/jwks.json`,
      grant_types_supported: ['client_credentials'],
      token_endpoint_auth_methods_supported: ['private_key_jwt'],
      token_endpoint_auth_signing_alg_values_supported: ['EdDSA'],
      client_id_metadata_document_supported: true,
      service_documentation: `${base()}/llms.txt`,
    }),
  )

  // Per-agent passport: JWKS + OAuth Client ID Metadata Document (ADR-8).
  r.get('/agents/:id/jwks.json', async (c) => {
    const a = await getAgentByIdOrHandle(c.req.param('id'))
    if (!a || a.status === 'deleted') throw errors.notFound('Agent', c.req.param('id'))
    c.header('Cache-Control', 'public, max-age=300')
    return c.json({ keys: [ed25519Jwk(a.publicKey)] })
  })
  r.get('/agents/:id/cimd.json', async (c) => {
    const a = await getAgentByIdOrHandle(c.req.param('id'))
    if (!a || a.status === 'deleted') throw errors.notFound('Agent', c.req.param('id'))
    const clientId = `${base()}/agents/${a.id}/cimd.json`
    c.header('Cache-Control', 'public, max-age=300')
    return c.json({
      client_id: clientId,
      client_name: a.name,
      client_uri: `${base()}/v1/agents/${a.id}`,
      jwks_uri: `${base()}/agents/${a.id}/jwks.json`,
      token_endpoint_auth_method: 'private_key_jwt',
      token_endpoint_auth_signing_alg: 'EdDSA',
      grant_types: ['client_credentials'],
      response_types: [],
      redirect_uris: [],
      software_id: `${base()}#agent`,
      software_version: APP_VERSION,
      did: a.did,
    })
  })
  r.get('/agents/:id/did.json', async (c) => {
    const a = await getAgentByIdOrHandle(c.req.param('id'))
    if (!a || a.status === 'deleted') throw errors.notFound('Agent', c.req.param('id'))
    return c.json({
      '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/suites/ed25519-2020/v1'],
      id: a.did,
      alsoKnownAs: [`${base()}/v1/agents/${a.id}`],
      verificationMethod: [{ id: `${a.did}#${a.did.slice('did:key:'.length)}`, type: 'JsonWebKey2020', controller: a.did, publicKeyJwk: ed25519Jwk(a.publicKey) }],
      authentication: [`${a.did}#${a.did.slice('did:key:'.length)}`],
      assertionMethod: [`${a.did}#${a.did.slice('did:key:'.length)}`],
      service: [{ id: `${a.did}#agentsouk`, type: 'AgentSoukProfile', serviceEndpoint: `${base()}/v1/agents/${a.id}` }],
    })
  })

  return r
}

/** Compact, LLM-friendly rendering of an OpenAPI 3.1 document. */
export function openApiToMarkdown(doc: Record<string, unknown>): string {
  const out: string[] = ['# API reference (generated from openapi.json)', '']
  const paths = (doc.paths ?? {}) as Record<string, Record<string, any>>
  const components = ((doc.components as any)?.schemas ?? {}) as Record<string, any>
  const resolve = (schema: any, depth = 0): any => {
    if (!schema || depth > 6) return schema
    if (schema.$ref) {
      const name = String(schema.$ref).split('/').pop()!
      return resolve(components[name], depth + 1)
    }
    return schema
  }
  const describeSchema = (schema: any, indent = '  ', depth = 0): string[] => {
    const s = resolve(schema, depth)
    const lines: string[] = []
    if (!s || depth > 4) return lines
    if (s.type === 'object' && s.properties) {
      const req = new Set<string>(s.required ?? [])
      for (const [k, v0] of Object.entries<any>(s.properties)) {
        const v = resolve(v0, depth + 1)
        const type = v?.type ?? (v?.enum ? 'enum' : v?.anyOf ? 'oneOf' : 'any')
        const bits = [type, v?.enum ? `[${v.enum.join('|')}]` : '', req.has(k) ? 'required' : 'optional', v?.description ?? '', v?.example !== undefined ? `e.g. ${JSON.stringify(v.example)}` : ''].filter(Boolean)
        lines.push(`${indent}- ${k}: ${bits.join(' · ')}`)
        if (v?.type === 'object' && v.properties) lines.push(...describeSchema(v, indent + '  ', depth + 1))
        if (v?.type === 'array' && v.items) {
          const it = resolve(v.items, depth + 1)
          if (it?.type === 'object' && it.properties) lines.push(...describeSchema(it, indent + '  ', depth + 1))
        }
      }
    }
    return lines
  }
  const byTag = new Map<string, string[]>()
  for (const [path, methods] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (!op || typeof op !== 'object') continue
      const tag = (op.tags?.[0] ?? 'other') as string
      const block: string[] = []
      block.push(`## ${method.toUpperCase()} ${path}`)
      if (op.summary) block.push(op.summary)
      if (op.description) block.push('', op.description)
      if (op.security?.length) block.push('', 'Auth: Authorization: Bearer <api_key>')
      const params = (op.parameters ?? []) as any[]
      if (params.length) {
        block.push('', 'Parameters:')
        for (const p of params) block.push(`  - ${p.name} (${p.in}${p.required ? ', required' : ''})${p.schema?.type ? `: ${p.schema.type}` : ''}${p.description ? ` · ${p.description}` : ''}`)
      }
      const body = op.requestBody?.content?.['application/json']?.schema
      if (body) {
        block.push('', 'Body (JSON):')
        block.push(...describeSchema(body))
      }
      const responses = (op.responses ?? {}) as Record<string, any>
      for (const [code, res] of Object.entries(responses)) {
        if (!code.startsWith('2')) continue
        const schema = res?.content?.['application/json']?.schema
        block.push('', `Response ${code}: ${res?.description ?? ''}`)
        if (schema) block.push(...describeSchema(schema))
      }
      block.push('')
      const list = byTag.get(tag) ?? []
      list.push(block.join('\n'))
      byTag.set(tag, list)
    }
  }
  for (const [tag, blocks] of byTag) {
    out.push(`# ${tag}`, '', ...blocks)
  }
  return out.join('\n')
}
