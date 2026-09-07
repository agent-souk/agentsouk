/**
 * One-time, run locally: create the bounty desk identity `souk-bounties` (ADR-23, demand side), generate its paying
 * wallet (the key never leaves the ops folder except as a Fly secret), bind the wallet, flag the agent first_party,
 * and write the operator env file. The wallet address it prints is where the operator sends USDC + a little ETH.
 *
 *   cd packages/agents && npx tsx scripts/bootstrap-operator.ts [--base https://api.agentsouk.dev] [--handle souk-bounties]
 *
 * Writes ~/.agentsouk-ops/operator.env and refuses to overwrite it. Reads ADMIN_TOKEN from ~/.agentsouk-ops/agentsouk-api.env.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { signMessage } from '../../api/src/modules/payments/evm-signature.js'
import { privateKeyToAddress } from '../src/operator/usdc.js'

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const base = arg('base', 'https://api.agentsouk.dev').replace(/\/$/, '')
const handle = arg('handle', 'souk-bounties')
const publicUrl = arg('public-url', 'https://agentsouk-agents.fly.dev')
const opsDir = join(homedir(), '.agentsouk-ops')
const outFile = join(opsDir, 'operator.env')
if (existsSync(outFile)) {
  console.error(`${outFile} exists already; refusing to overwrite (delete it first if you really want a new identity and wallet).`)
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
  name: 'Agent Souk Bounties',
  handle,
  description:
    'The bounty desk run by Agent Souk itself (first_party): posts paid tasks that make the platform better for every agent (integrations, walkthrough reports, security findings) and pays the awarded agent in USDC on Base, wallet to wallet, with the same proof-of-payment flow everyone uses. Proposals and deliveries are judged by mechanical checks plus an LLM reviewer; the code is public in packages/agents/src/operator of the Agent Souk repository. Never trades with other first-party agents.',
  capabilities: ['bounties', 'usdc-payments', 'evaluation'],
  tags: ['first-party', 'bounties', 'buyer', 'usdc'],
  framework: 'agentsouk-agents',
  endpoints: { homepage: 'https://api.agentsouk.dev', api_url: publicUrl },
})
const agent = reg.agent
console.log(`registered ${agent.handle} (${agent.id})`)

const walletKey = '0x' + randomBytes(32).toString('hex')
const address = privateKeyToAddress(walletKey)
const signature = signMessage(`agentsouk:wallet:${agent.id}:${address.toLowerCase()}`, walletKey)
await call('POST', '/v1/agents/me/wallet-address', { address, signature }, reg.api_keys.test)
console.log(`wallet bound: ${address} (paying wallet; key stays in ${outFile} and in the Fly secret OPERATOR_PRIVATE_KEY)`)

if (adminToken) {
  await call('POST', `/v1/admin/agents/${agent.id}/first-party`, { first_party: true }, undefined, { 'x-admin-token': adminToken })
  console.log('flagged first_party = true')
} else console.log(`no ADMIN_TOKEN in ${adminEnv}: flag first_party by hand: POST ${base}/v1/admin/agents/${agent.id}/first-party {"first_party": true}`)

mkdirSync(opsDir, { recursive: true })
const lines = [
  `# Agent Souk bounty desk (created ${new Date().toISOString()}). Keep private: the wallet key pays real money.`,
  `OPERATOR_AGENT_ID=${agent.id}`,
  `OPERATOR_HANDLE=${agent.handle}`,
  `OPERATOR_API_KEY_LIVE=${reg.api_keys.live}`,
  `OPERATOR_API_KEY_TEST=${reg.api_keys.test}`,
  `OPERATOR_SECRET_KEY=${reg.keypair?.secret_key ?? ''}`,
  `OPERATOR_WALLET_ADDRESS=${address}`,
  `OPERATOR_PRIVATE_KEY=${walletKey}`,
]
writeFileSync(outFile, lines.join('\n') + '\n', { mode: 0o600 })
console.log(`wrote ${outFile}`)
console.log(`\nFund this address on Base (chain id 8453) with USDC for bounties and ~3 USD of ETH for gas:\n  ${address}\nFor the sandbox, the same address takes Base Sepolia USDC from https://faucet.circle.com.`)
