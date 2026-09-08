/**
 * ERC-8004 (ADR-28), run locally by the operator: mint an agentId on the Identity Registry for the platform's own
 * identities and link them. Each identity mints from ITS OWN wallet, so ownerOf matches the wallet bound on the
 * platform (owner_verified = true):
 *
 *   platform  -> operator wallet, agentURI = <base>/.well-known/agent-registration.json (id goes into the API's
 *                ERC8004_PLATFORM_AGENT_ID_<ENV> secret; the script prints the flyctl command)
 *   bounties  -> operator wallet (souk-bounties), agentURI = <base>/agents/<id>/erc8004.json, linked via the API
 *   services  -> souk-services wallet (receive-only; gets a little ETH for gas from the operator wallet first)
 *
 * Idempotent: identities that already carry an erc8004 link are skipped; a token whose tokenURI already points at
 * the file is linked without minting again (pass --agent-id when you know it). Without --send nothing is
 * broadcast: balances and the plan are printed.
 *
 *   npx tsx scripts/register-erc8004.ts [--env live|test] [--who platform,bounties,services] [--base https://api.agentsouk.dev] [--send]
 *
 * Keys come from ~/.agentsouk-ops/operator.env (OPERATOR_PRIVATE_KEY, OPERATOR_API_KEY_<ENV>) and
 * ~/.agentsouk-ops/agents.env (WALLET_PRIVATE_KEY, AGENTSOUK_API_KEY_<ENV>). Nothing is printed but addresses and hashes.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CHAINS, decodeStringResult, encodeRegister, encodeTokenUri, ERC8004_IDENTITY_REGISTRY, parseRegisteredAgentId, UsdcWallet } from '../src/operator/usdc.js'

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith('--') ? process.argv[i + 1]! : fallback
}
const flag = (name: string) => process.argv.includes(`--${name}`)

const env = (arg('env', 'live') === 'test' ? 'test' : 'live') as 'live' | 'test'
const base = (arg('base', 'https://api.agentsouk.dev') ?? '').replace(/\/$/, '')
const who = (arg('who', 'platform,bounties,services') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const send = flag('send')
const knownAgentId = arg('agent-id')
const registry = ERC8004_IDENTITY_REGISTRY[env]
const chain = CHAINS[env]
const GAS_TOPUP_WEI = 100_000_000_000_000n // 0.0001 ETH: enough for several register() calls on Base

const readEnv = (file: string): Record<string, string> => {
  const p = join(homedir(), '.agentsouk-ops', file)
  if (!existsSync(p)) return {}
  const out: Record<string, string> = {}
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m) out[m[1]!] = m[2]!.trim()
  }
  return out
}
const operatorEnv = readEnv('operator.env')
const agentsEnv = readEnv('agents.env')
const need = (v: string | undefined, what: string): string => {
  if (!v) {
    console.error(`missing ${what}`)
    process.exit(1)
  }
  return v
}

const log = (msg: string, extra: Record<string, unknown> = {}) => console.log(msg, Object.keys(extra).length ? JSON.stringify(extra) : '')
const operatorWallet = new UsdcWallet(need(operatorEnv.OPERATOR_PRIVATE_KEY, 'OPERATOR_PRIVATE_KEY in operator.env'), chain, { log: (m, e) => log(`  ${m}`, e) })

type Identity = { name: string; wallet: UsdcWallet; apiKey?: string; agentUri: (agentId: string) => string; isPlatform?: boolean }

async function api(path: string, method = 'GET', key?: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, { method, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), 'user-agent': 'agentsouk-agents/erc8004-register' }, body: body ? JSON.stringify(body) : undefined })
  return { status: res.status, json: await res.json().catch(() => ({})) }
}

async function tokenUriOf(agentId: bigint): Promise<string | undefined> {
  try {
    return decodeStringResult(await operatorWallet.view(registry, encodeTokenUri(agentId)))
  } catch {
    return undefined
  }
}

async function run(identity: Identity) {
  console.log(`\n== ${identity.name} (${env}) ==`)
  let profile: any = null
  if (identity.apiKey) {
    const me = await api('/v1/agents/me', 'GET', identity.apiKey)
    if (me.status !== 200) {
      console.error('  cannot read /v1/agents/me:', me.status, JSON.stringify(me.json).slice(0, 200))
      return
    }
    profile = me.json
    if (profile.erc8004) {
      console.log(`  already linked: agentId ${profile.erc8004.agent_id} on ${profile.erc8004.registry} (owner_verified ${profile.erc8004.owner_verified})`)
      return
    }
    if (profile.wallet_address && profile.wallet_address.toLowerCase() !== identity.wallet.address.toLowerCase()) console.warn(`  WARNING: bound wallet ${profile.wallet_address} differs from the minting wallet ${identity.wallet.address}; owner_verified will be false`)
  }
  const uri = identity.agentUri(profile?.id ?? '')
  const [eth, usdc] = await Promise.all([identity.wallet.ethBalance(), identity.wallet.usdcBalance()])
  console.log(`  wallet ${identity.wallet.address}: ${eth} wei ETH, ${usdc} USDC minor · agentURI ${uri}`)
  const check = await fetch(uri, { headers: { accept: 'application/json' } }).catch(() => null)
  if (!check || check.status !== 200) {
    console.error(`  agentURI does not resolve (HTTP ${check?.status ?? 'unreachable'}); deploy the API first`)
    return
  }

  let agentId: bigint | undefined
  if (knownAgentId && /^\d+$/.test(knownAgentId)) {
    const existing = await tokenUriOf(BigInt(knownAgentId))
    if (existing === uri) {
      agentId = BigInt(knownAgentId)
      console.log(`  token ${agentId} already carries this agentURI; linking only`)
    } else console.warn(`  --agent-id ${knownAgentId} has tokenURI ${JSON.stringify(existing ?? null)}, not this file; minting a new one`)
  }

  if (agentId === undefined) {
    if (eth < 30_000_000_000_000n && !identity.isPlatform && identity.wallet.address.toLowerCase() !== operatorWallet.address.toLowerCase()) {
      console.log(`  needs gas: top up ${GAS_TOPUP_WEI} wei from the operator wallet ${operatorWallet.address}`)
      if (send) {
        const t = await operatorWallet.sendEth(identity.wallet.address, GAS_TOPUP_WEI)
        console.log(`  gas sent ${t.explorer}`)
        await operatorWallet.waitForReceipt(t.hash)
      }
    }
    console.log(`  plan: register("${uri}") on ${registry} (${chain.chainId})`)
    if (!send) {
      console.log('  dry run (pass --send to broadcast)')
      return
    }
    const sent = await identity.wallet.call(registry, encodeRegister(uri), 150_000n)
    console.log(`  register sent ${sent.explorer}`)
    const receipt = await identity.wallet.waitForReceipt(sent.hash, { timeoutMs: 300_000 })
    if (receipt.status !== 'success') {
      console.error(`  register reverted in block ${receipt.blockNumber}`)
      return
    }
    agentId = parseRegisteredAgentId(receipt.logs, registry)
    if (agentId === undefined) {
      console.error('  mined, but no Registered event from the registry in the receipt; check the explorer and pass --agent-id')
      return
    }
    console.log(`  minted agentId ${agentId} in block ${receipt.blockNumber}`)
    const back = await tokenUriOf(agentId)
    console.log(`  tokenURI on-chain: ${JSON.stringify(back ?? null)}`)
  }

  if (identity.isPlatform) {
    console.log(`\n  SET THE API SECRET:\n  flyctl secrets set ERC8004_PLATFORM_AGENT_ID_${env.toUpperCase()}=${agentId} -a agentsouk-api\n  (also add the line to ~/.agentsouk-ops/agentsouk-api.env)`)
    return
  }
  if (!send) return
  const linked = await api('/v1/agents/me/erc8004', 'POST', identity.apiKey, { agent_id: agentId.toString() })
  if (linked.status !== 200) {
    console.error('  link failed:', linked.status, JSON.stringify(linked.json).slice(0, 400))
    return
  }
  console.log(`  linked: ${JSON.stringify(linked.json.erc8004)}`)
}

const identities: Record<string, () => Identity> = {
  platform: () => ({ name: 'platform (Agent Souk)', wallet: operatorWallet, agentUri: () => `${base}/.well-known/agent-registration.json`, isPlatform: true }),
  bounties: () => ({ name: 'souk-bounties', wallet: operatorWallet, apiKey: need(operatorEnv[`OPERATOR_API_KEY_${env.toUpperCase()}`], `OPERATOR_API_KEY_${env.toUpperCase()} in operator.env`), agentUri: (id) => `${base}/agents/${id}/erc8004.json` }),
  services: () => ({ name: 'souk-services', wallet: new UsdcWallet(need(agentsEnv.WALLET_PRIVATE_KEY, 'WALLET_PRIVATE_KEY in agents.env'), chain, { log: (m, e) => log(`  ${m}`, e) }), apiKey: need(agentsEnv[`AGENTSOUK_API_KEY_${env.toUpperCase()}`], `AGENTSOUK_API_KEY_${env.toUpperCase()} in agents.env`), agentUri: (id) => `${base}/agents/${id}/erc8004.json` }),
}

console.log(`ERC-8004 registration · ${env} · registry ${registry} · ${send ? 'SENDING' : 'dry run'}`)
for (const w of who) {
  const make = identities[w]
  if (!make) {
    console.error(`unknown identity ${w} (platform, bounties, services)`)
    continue
  }
  try {
    await run(make())
  } catch (e) {
    console.error(`  failed: ${String((e as Error).message ?? e)}`)
  }
}
