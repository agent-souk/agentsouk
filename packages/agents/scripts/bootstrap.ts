/**
 * One-time, run locally: create the first-party identity on Agent Souk, bind a fresh receive-only wallet
 * (private key stays in the ops folder, never on the server), flag the agent first_party (ADR-23), and write
 * the runtime's env file.
 *
 *   cd packages/agents && npx tsx scripts/bootstrap.ts [--base https://api.agentsouk.dev] [--name "Agent Souk Services"] [--handle souk-services] [--public-url https://agentsouk-agents.fly.dev]
 *
 * Writes ~/.agentsouk-ops/agents.env and refuses to overwrite it. Reads ADMIN_TOKEN from ~/.agentsouk-ops/agentsouk-api.env.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { privateKeyToAddress, signMessage } from '../../api/src/modules/payments/evm-signature.js'

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const base = arg('base', 'https://api.agentsouk.dev').replace(/\/$/, '')
const name = arg('name', 'Agent Souk Services')
const handle = arg('handle', 'souk-services')
const publicUrl = arg('public-url', 'https://agentsouk-agents.fly.dev')
const opsDir = join(homedir(), '.agentsouk-ops')
const outFile = join(opsDir, 'agents.env')
if (existsSync(outFile)) {
  console.error(`${outFile} exists already; refusing to overwrite (delete it first if you really want a new identity).`)
  process.exit(1)
}
const adminEnv = join(opsDir, 'agentsouk-api.env')
const adminToken = existsSync(adminEnv) ? readFileSync(adminEnv, 'utf8').match(/^ADMIN_TOKEN=(.+)$/m)?.[1]?.trim().replace(/^"|"$/g, '') : undefined

async function call(method: string, path: string, body?: unknown, key?: string, headers: Record<string, string> = {}) {
  const h: Record<string, string> = { accept: 'application/json', ...headers }
  if (key) h.authorization = `Bearer ${key}`
  if (body !== undefined) h['content-type'] = 'application/json'
  const res = await fetch(base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`)
  return json as Record<string, any>
}

const reg = await call('POST', '/v1/agents', {
  name,
  handle,
  description: 'The reference seller run by Agent Souk itself (first_party). Deterministic utility services at cost: fetch and extract web pages, validate JSON against JSON Schema. Built with the public SDK exactly like any third-party seller; the code is in packages/agents of the Agent Souk repository.',
  capabilities: ['web-extraction', 'html-to-text', 'json-schema-validation', 'data-quality'],
  tags: ['first-party', 'reference', 'deterministic', 'utilities'],
  framework: 'agentsouk-agents',
  endpoints: { homepage: 'https://api.agentsouk.dev', api_url: publicUrl },
})
const agent = reg.agent
console.log(`registered ${agent.handle} (${agent.id})`)

const walletKey = '0x' + randomBytes(32).toString('hex')
const address = privateKeyToAddress(walletKey)
const signature = signMessage(`agentsouk:wallet:${agent.id}:${address.toLowerCase()}`, walletKey)
await call('POST', '/v1/agents/me/wallet-address', { address, signature }, reg.api_keys.test)
console.log(`wallet bound: ${address} (receive-only; key stays in ${outFile})`)

if (adminToken) {
  await call('POST', `/v1/admin/agents/${agent.id}/first-party`, { first_party: true }, undefined, { 'x-admin-token': adminToken })
  console.log('flagged first_party = true')
} else console.log(`no ADMIN_TOKEN in ${adminEnv}: flag first_party by hand: POST ${base}/v1/admin/agents/${agent.id}/first-party {"first_party": true}`)

mkdirSync(opsDir, { recursive: true })
const lines = [
  `# Agent Souk first-party agent runtime (created ${new Date().toISOString()}). Keep private.`,
  `AGENTSOUK_BASE_URL=${base}`,
  `AGENTSOUK_AGENT_ID=${agent.id}`,
  `AGENTSOUK_HANDLE=${agent.handle}`,
  `AGENTSOUK_API_KEY_LIVE=${reg.api_keys.live}`,
  `AGENTSOUK_API_KEY_TEST=${reg.api_keys.test}`,
  `AGENTSOUK_SECRET_KEY=${reg.keypair?.secret_key ?? ''}`,
  `WALLET_ADDRESS=${address}`,
  `WALLET_PRIVATE_KEY=${walletKey}`,
  `WEBHOOK_SECRET=${randomBytes(24).toString('hex')}`,
  `PUBLIC_URL=${publicUrl}`,
]
writeFileSync(outFile, lines.join('\n') + '\n', { mode: 0o600 })
console.log(`wrote ${outFile}`)
console.log('next: flyctl secrets set AGENTSOUK_API_KEY_LIVE=... AGENTSOUK_API_KEY_TEST=... WEBHOOK_SECRET=... -a agentsouk-agents')
