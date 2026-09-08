/**
 * ERC-8004 (ADR-28), run locally by the operator: mint an agentId on the Identity Registry for the platform's own
 * identities and link them. Each identity mints from ITS OWN wallet, so ownerOf matches the wallet bound on the
 * platform (owner_verified = true):
 *
 *   platform  -> operator wallet, agentURI = <base>/.well-known/agent-registration.json (id goes into the API's
 *                ERC8004_PLATFORM_AGENT_ID_<ENV> secret; the script prints the flyctl command)
 *   bounties  -> operator wallet (souk-bounties), agentURI = <base>/agents/<id>/erc8004.json, linked via the API
 *   services  -> souk-services wallet (receive-only; gets ETH for gas from the operator wallet when register() reports
 *                that it cannot pay for gas)
 *
 * Idempotency, in this order: (1) a profile that already carries an erc8004 link is skipped; (2) the platform file's
 * own registrations[] for this env; (3) the local ledger ~/.agentsouk-ops/erc8004-ledger.json, which records every
 * mint the moment the transaction is broadcast (even when the receipt or the link step fails later); (4) --agent-id
 * <id>, which links an existing token after checking on-chain that it is ours (owner = the identity's wallet) and
 * points at the file. Nothing is minted while any of these finds a token. Without --send nothing is broadcast:
 * balances and the plan are printed.
 *
 *   npx tsx scripts/register-erc8004.ts --env live|test [--who platform|bounties|services[,...]] [--base https://api.agentsouk.dev]
 *                                       [--agent-id <id>] [--allow-unverified] [--send]
 *
 * Keys come from ~/.agentsouk-ops/operator.env (OPERATOR_PRIVATE_KEY, OPERATOR_API_KEY_<ENV>) and
 * ~/.agentsouk-ops/agents.env (WALLET_PRIVATE_KEY, AGENTSOUK_API_KEY_<ENV>). Nothing is printed but addresses and hashes.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CHAINS, decodeStringResult, encodeOwnerOf, encodeRegister, encodeTokenUri, ERC8004_IDENTITY_REGISTRY, parseRegisteredAgentId, sameAddress, toChecksumAddress, TransferError, UsdcWallet } from '../src/operator/usdc.js'

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith('--') ? process.argv[i + 1]! : fallback
}
const flag = (name: string) => process.argv.includes(`--${name}`)
const fail = (msg: string): never => {
  console.error(msg)
  process.exit(1)
}

const envArg = arg('env')
if (envArg !== 'live' && envArg !== 'test') fail('--env live|test is required (live = Base mainnet and real gas, test = Base Sepolia)')
const env = envArg as 'live' | 'test'
const base = (arg('base', 'https://api.agentsouk.dev') ?? '').replace(/\/$/, '')
if (!/^https:\/\//.test(base)) fail('--base must be an https URL')
const who = (arg('who', 'platform,bounties,services') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const send = flag('send')
const allowUnverified = flag('allow-unverified')
const knownAgentId = arg('agent-id')
if (knownAgentId !== undefined) {
  if (!/^\d{1,78}$/.test(knownAgentId) || BigInt(knownAgentId) >= 1n << 256n) fail('--agent-id must be a decimal uint256')
  if (who.length !== 1) fail('--agent-id links one known token: name exactly one identity with --who')
}
const registry = ERC8004_IDENTITY_REGISTRY[env]
const chain = CHAINS[env]
const MIN_TOPUP_WEI = 50_000_000_000_000n // 0.00005 ETH floor for a gas top-up

const opsDir = join(homedir(), '.agentsouk-ops')
const readEnv = (file: string): Record<string, string> => {
  const p = join(opsDir, file)
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
const need = (v: string | undefined, what: string): string => v ?? fail(`missing ${what}`)

// --- local ledger: every mint is recorded when broadcast, so a failed receipt/link never leads to a second mint ---
type LedgerEntry = { env: string; identity: string; uri: string; wallet: string; hash: string; agent_id: string | null; at: string; linked_at?: string }
const ledgerPath = join(opsDir, 'erc8004-ledger.json')
const ledger: LedgerEntry[] = existsSync(ledgerPath) ? (JSON.parse(readFileSync(ledgerPath, 'utf8')) as LedgerEntry[]) : []
const saveLedger = () => writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n')

const log = (msg: string, extra: Record<string, unknown> = {}) => console.log(msg, Object.keys(extra).length ? JSON.stringify(extra) : '')
const operatorWallet = new UsdcWallet(need(operatorEnv.OPERATOR_PRIVATE_KEY, 'OPERATOR_PRIVATE_KEY in operator.env'), chain, { log: (m, e) => log(`  ${m}`, e) })

type Identity = { key: string; name: string; wallet: UsdcWallet; apiKey?: string; agentUri: (agentId: string) => string; isPlatform?: boolean }

async function api(path: string, method = 'GET', key?: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, { method, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), 'user-agent': 'agentsouk-agents/erc8004-register' }, body: body ? JSON.stringify(body) : undefined })
  return { status: res.status, json: await res.json().catch(() => ({})) }
}

/** ownerOf + tokenURI of a token; null when the token does not exist; throws on node trouble (never "mint again" on a hiccup). */
async function readToken(agentId: bigint): Promise<{ owner: string; uri: string } | null> {
  let ownerRaw: string
  try {
    ownerRaw = await operatorWallet.view(registry, encodeOwnerOf(agentId))
  } catch (e) {
    if (/revert|execution error|nonexistent|invalid token/i.test(String((e as Error).message ?? e))) return null
    throw e
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(ownerRaw)) throw new Error(`malformed ownerOf result ${ownerRaw.slice(0, 80)} (wrong node or registry?)`)
  const owner = toChecksumAddress('0x' + ownerRaw.slice(-40))
  if (/^0x0{40}$/.test(owner)) return null
  const uri = decodeStringResult(await operatorWallet.view(registry, encodeTokenUri(agentId))) ?? ''
  return { owner, uri }
}

/** Mints once. A gas shortage on a non-operator wallet is answered with one top-up from the operator wallet, then one retry. */
async function mint(identity: Identity, uri: string): Promise<{ hash: string; explorer: string }> {
  const attempt = () => identity.wallet.call(registry, encodeRegister(uri), 150_000n)
  try {
    return await attempt()
  } catch (e) {
    const err = e instanceof TransferError ? e : null
    const m = err && !err.broadcast ? err.message.match(/^(?:insufficient ETH for gas: need up to (\d+) wei|no ETH for gas)/) : null
    if (!err || !m || sameAddress(identity.wallet.address, operatorWallet.address)) throw e
    // top up exactly what send() computed (twice, for the retry's own fee drift), at least the floor
    const needWei = m[1] ? BigInt(m[1]) : MIN_TOPUP_WEI
    const balance = await identity.wallet.ethBalance()
    const topUp = needWei * 2n > balance + MIN_TOPUP_WEI ? needWei * 2n - balance : MIN_TOPUP_WEI
    console.log(`  gas: ${err.message}; topping up ${topUp} wei from the operator wallet ${operatorWallet.address}`)
    const t = await operatorWallet.sendEth(identity.wallet.address, topUp)
    console.log(`  gas sent ${t.explorer}`)
    const r = await operatorWallet.waitForReceipt(t.hash, { timeoutMs: 300_000 })
    if (r.status !== 'success') throw new Error(`gas top-up ${t.hash} reverted`)
    return attempt()
  }
}

async function run(identity: Identity) {
  console.log(`\n== ${identity.name} (${env}) ==`)
  let profile: any = null
  if (identity.apiKey) {
    const me = await api('/v1/agents/me', 'GET', identity.apiKey)
    if (me.status !== 200) return console.error('  cannot read /v1/agents/me:', me.status, JSON.stringify(me.json).slice(0, 200))
    profile = me.json
    if (profile.erc8004) return console.log(`  already linked: agentId ${profile.erc8004.agent_id} on ${profile.erc8004.registry} (owner_verified ${profile.erc8004.owner_verified})`)
    if (profile.wallet_address && !sameAddress(profile.wallet_address, identity.wallet.address)) {
      const msg = `bound wallet ${profile.wallet_address} differs from the minting wallet ${identity.wallet.address}: the token could never be owner_verified`
      if (!allowUnverified) return console.error(`  ABORT: ${msg} (pass --allow-unverified to mint anyway)`)
      console.warn(`  WARNING: ${msg}`)
    }
  }
  const uri = identity.agentUri(profile?.id ?? '')
  const [eth, usdc] = await Promise.all([identity.wallet.ethBalance(), identity.wallet.usdcBalance()])
  console.log(`  wallet ${identity.wallet.address}: ${eth} wei ETH, ${usdc} USDC minor · agentURI ${uri}`)
  const check = await fetch(uri, { headers: { accept: 'application/json' } }).catch(() => null)
  if (!check || check.status !== 200) return console.error(`  agentURI does not resolve (HTTP ${check?.status ?? 'unreachable'}); deploy the API first`)
  const file = (await check.json().catch(() => null)) as { registrations?: { agentId?: number | string; agentRegistry?: string }[] } | null

  // --- find a token we already have, in order: platform file, ledger, --agent-id ---------------------------------
  let agentId: bigint | undefined
  const caip = `eip155:${chain.chainId}:${registry}`
  const claim = async (candidate: bigint, source: string): Promise<boolean> => {
    const tok = await readToken(candidate)
    if (!tok) return console.log(`  ${source}: token ${candidate} does not exist on ${registry}`), false
    if (tok.uri !== uri) return console.log(`  ${source}: token ${candidate} points at ${JSON.stringify(tok.uri.slice(0, 120))}, not this file`), false
    if (!sameAddress(tok.owner, identity.wallet.address)) return console.log(`  ${source}: token ${candidate} is owned by ${tok.owner}, not by this identity's wallet`), false
    console.log(`  ${source}: token ${candidate} is ours and points at this file; linking only`)
    agentId = candidate
    return true
  }
  if (identity.isPlatform) {
    const listed = (file?.registrations ?? []).find((r) => r.agentRegistry?.toLowerCase() === caip.toLowerCase() && r.agentId != null)
    if (listed && (await claim(BigInt(String(listed.agentId)), 'platform file'))) return console.log(`  the platform file already lists agentId ${agentId}; nothing to do`)
  }
  if (agentId === undefined) {
    for (const entry of ledger.filter((l) => l.env === env && l.identity === identity.key && l.uri === uri)) {
      if (entry.agent_id) {
        if (await claim(BigInt(entry.agent_id), `ledger (${entry.hash})`)) break
        continue
      }
      // broadcast recorded, id unknown: resolve it from the receipt before anything else
      console.log(`  ledger: mint ${entry.hash} was broadcast on ${entry.at} without a known agentId; reading its receipt`)
      const r = await identity.wallet.waitForReceipt(entry.hash, { timeoutMs: 60_000 }).catch((e: Error) => fail(`  cannot read receipt of ${entry.hash}: ${e.message}. Resolve by hand (explorer), then re-run with --agent-id <id>`))
      const id = parseRegisteredAgentId(r.logs, registry, identity.wallet.address)
      if (r.status === 'success' && id !== undefined) {
        entry.agent_id = id.toString()
        saveLedger()
        if (await claim(id, `ledger (${entry.hash})`)) break
      } else console.log(`  ledger: ${entry.hash} ${r.status}, no Registered event for our wallet`)
    }
  }
  if (agentId === undefined && knownAgentId !== undefined && !(await claim(BigInt(knownAgentId), '--agent-id'))) return console.error('  ABORT: --agent-id does not name a token of ours for this file; nothing minted')

  // --- mint ------------------------------------------------------------------------------------------------------
  if (agentId === undefined) {
    console.log(`  plan: register("${uri}") on ${registry} (chain ${chain.chainId}) from ${identity.wallet.address}`)
    if (!send) return console.log('  dry run (pass --send to broadcast)')
    const sent = await mint(identity, uri)
    const entry: LedgerEntry = { env, identity: identity.key, uri, wallet: identity.wallet.address, hash: sent.hash, agent_id: null, at: new Date().toISOString() }
    ledger.push(entry)
    saveLedger()
    console.log(`  register sent ${sent.explorer} (recorded in ${ledgerPath})`)
    const receipt = await identity.wallet.waitForReceipt(sent.hash, { timeoutMs: 300_000 })
    if (receipt.status !== 'success') return console.error(`  register reverted in block ${receipt.blockNumber}; the ledger keeps the hash`)
    agentId = parseRegisteredAgentId(receipt.logs, registry, identity.wallet.address)
    if (agentId === undefined) return console.error('  mined, but no Registered event for our wallet in the receipt; check the explorer, then re-run (the ledger resolves the id from the receipt)')
    entry.agent_id = agentId.toString()
    saveLedger()
    console.log(`  minted agentId ${agentId} in block ${receipt.blockNumber}`)
    const back = await readToken(agentId)
    console.log(`  on-chain: owner ${back?.owner ?? '?'}, tokenURI ${JSON.stringify(back?.uri ?? null)}`)
  }

  // --- link ------------------------------------------------------------------------------------------------------
  if (identity.isPlatform) {
    console.log(`\n  SET THE API SECRET:\n  flyctl secrets set ERC8004_PLATFORM_AGENT_ID_${env.toUpperCase()}=${agentId} -a agentsouk-api\n  (also add the line to ~/.agentsouk-ops/agentsouk-api.env)`)
    return
  }
  if (!send) return console.log(`  dry run: would link agentId ${agentId} via POST /v1/agents/me/erc8004`)
  const linked = await api('/v1/agents/me/erc8004', 'POST', identity.apiKey, { agent_id: agentId.toString() })
  if (linked.status !== 200) return console.error(`  link failed: ${linked.status} ${JSON.stringify(linked.json).slice(0, 400)}\n  re-run with --who ${identity.key} --agent-id ${agentId} --send once the cause is fixed`)
  const entry = ledger.find((l) => l.env === env && l.identity === identity.key && l.agent_id === agentId!.toString())
  if (entry) {
    entry.linked_at = new Date().toISOString()
    saveLedger()
  }
  console.log(`  linked: ${JSON.stringify(linked.json.erc8004)}`)
}

const identities: Record<string, () => Identity> = {
  platform: () => ({ key: 'platform', name: 'platform (Agent Souk)', wallet: operatorWallet, agentUri: () => `${base}/.well-known/agent-registration.json`, isPlatform: true }),
  bounties: () => ({ key: 'bounties', name: 'souk-bounties', wallet: operatorWallet, apiKey: need(operatorEnv[`OPERATOR_API_KEY_${env.toUpperCase()}`], `OPERATOR_API_KEY_${env.toUpperCase()} in operator.env`), agentUri: (id) => `${base}/agents/${id}/erc8004.json` }),
  services: () => ({ key: 'services', name: 'souk-services', wallet: new UsdcWallet(need(agentsEnv.WALLET_PRIVATE_KEY, 'WALLET_PRIVATE_KEY in agents.env'), chain, { log: (m, e) => log(`  ${m}`, e) }), apiKey: need(agentsEnv[`AGENTSOUK_API_KEY_${env.toUpperCase()}`], `AGENTSOUK_API_KEY_${env.toUpperCase()} in agents.env`), agentUri: (id) => `${base}/agents/${id}/erc8004.json` }),
}
for (const w of who) if (!identities[w]) fail(`unknown identity ${w} (platform, bounties, services)`)

console.log(`ERC-8004 registration · ${env} · registry ${registry} · ${send ? 'SENDING' : 'dry run'} · ledger ${ledgerPath}`)
for (const w of who) {
  try {
    await run(identities[w]!())
  } catch (e) {
    const t = e instanceof TransferError ? (e.broadcast ? 'BROADCAST STATE UNKNOWN (check the wallet history before re-running)' : 'nothing was broadcast') : 'error'
    console.error(`  failed (${t}): ${String((e as Error).message ?? e)}`)
  }
}
