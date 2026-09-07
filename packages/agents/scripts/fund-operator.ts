/**
 * One-off, run locally: move the bounty budget (USDC) and gas money (ETH) from a funding wallet to the bounty desk
 * wallet on Base mainnet, so the funding wallet's key never touches a server. Reads the key from a file and never
 * prints it. Without --send it only shows balances and the plan.
 *
 *   cd packages/agents && npx tsx scripts/fund-operator.ts --key-file ../../privatekey.md [--to 0x...] [--keep-eth-wei 50000000000000] [--send]
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CHAINS, formatUsdc, UsdcWallet } from '../src/operator/usdc.js'

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith('--') ? process.argv[i + 1]! : fallback
}
const flag = (name: string) => process.argv.includes(`--${name}`)

const keyFile = arg('key-file')
if (!keyFile || !existsSync(keyFile)) {
  console.error('--key-file <path> is required (a file containing the 0x-prefixed private key of the funding wallet)')
  process.exit(1)
}
const opsEnv = join(homedir(), '.agentsouk-ops', 'operator.env')
const operatorAddress = existsSync(opsEnv) ? readFileSync(opsEnv, 'utf8').match(/^OPERATOR_WALLET_ADDRESS=(.+)$/m)?.[1]?.trim() : undefined
const to = arg('to', operatorAddress)
if (!to) {
  console.error('--to <address> is required (no OPERATOR_WALLET_ADDRESS in ~/.agentsouk-ops/operator.env)')
  process.exit(1)
}
if (operatorAddress && to.toLowerCase() !== operatorAddress.toLowerCase()) console.warn(`WARNING: --to ${to} is not the bounty desk wallet ${operatorAddress}`)
const keepEth = BigInt(arg('keep-eth-wei', '50000000000000')!) // 0.00005 ETH stays behind for the funding wallet's own fees
const usdcArg = arg('usdc') // e.g. 50 = send exactly 50 USDC; default: the whole balance
const send = flag('send')

const m = readFileSync(keyFile, 'utf8').match(/(0x)?([0-9a-fA-F]{64})/)
if (!m) {
  console.error('no 64-hex private key found in the key file')
  process.exit(1)
}
const from = new UsdcWallet('0x' + m[2]!, CHAINS.live, { maxPerTransfer: 1_000_000_000n, log: (msg, extra) => console.log(msg, JSON.stringify(extra)) })
const fmtEth = (wei: bigint) => `${(Number(wei) / 1e18).toFixed(6)} ETH`

const usdc = await from.usdcBalance()
const eth = await from.ethBalance()
console.log(`funding wallet ${from.address}: ${formatUsdc(usdc)}, ${fmtEth(eth)}`)
const toUsdc = await from.usdcBalance(to)
console.log(`bounty desk wallet ${to}: ${formatUsdc(toUsdc)} (before)`)
if (usdc === 0n && eth <= keepEth) {
  console.log('nothing to move')
  process.exit(0)
}
const usdcAmount = usdcArg ? BigInt(Math.round(Number(usdcArg) * 1e6)) : usdc
if (usdcAmount > usdc) {
  console.error(`cannot send ${formatUsdc(usdcAmount)}: the funding wallet holds ${formatUsdc(usdc)}`)
  process.exit(1)
}
console.log(`plan: send ${formatUsdc(usdcAmount)} and then all ETH except ${fmtEth(keepEth)} to ${to}`)
if (!send) {
  console.log('dry run; add --send to execute')
  process.exit(0)
}

if (usdcAmount > 0n) {
  const t = await from.transfer(to, usdcAmount)
  console.log(`USDC sent: ${t.explorer}`)
  const r = await from.waitForReceipt(t.hash)
  console.log(`USDC receipt: ${r.status} in block ${r.blockNumber}`)
  if (r.status !== 'success') process.exit(1)
}
const ethNow = await from.ethBalance()
if (ethNow > keepEth) {
  // leave the reserve plus the fee of this very transfer (21000 gas at twice the base fee is far below 0.00001 ETH on Base)
  const amount = ethNow - keepEth
  const t = await from.sendEth(to, amount)
  console.log(`ETH sent (${fmtEth(amount)}): ${t.explorer}`)
  const r = await from.waitForReceipt(t.hash)
  console.log(`ETH receipt: ${r.status} in block ${r.blockNumber}`)
}
const desk = new UsdcWallet('0x' + '11'.repeat(32), CHAINS.live) // key irrelevant: read-only use
console.log(`bounty desk wallet ${to}: ${formatUsdc(await desk.usdcBalance(to))}, ${fmtEth(await desk.rpc<string>('eth_getBalance', [to, 'latest']).then((v) => BigInt(v)))} (after)`)
console.log(`funding wallet ${from.address}: ${formatUsdc(await from.usdcBalance())}, ${fmtEth(await from.ethBalance())} (after)`)
