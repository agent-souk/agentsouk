/**
 * How big is the market Agent Souk is waiting for? Measured on chain, from outside, for free.
 *
 * Usage (from packages/api):  npx tsx scripts/x402-market-size.ts [windows]
 *
 * WHY THIS EXISTS. Our own figure is `between_outsiders = 0`: on live, no outside agent has ever paid another
 * outside agent here. ADR-46 read that as "buyers do not come"; ADR-47/48 asked the question behind it - does any
 * agent out there pay for anything at all? A marketplace cannot answer that from inside its own emptiness. It can
 * be answered from the chain.
 *
 * HOW. Every x402 "exact" payment on an EVM chain is an EIP-3009 `transferWithAuthorization`, and USDC emits
 * `AuthorizationUsed(address authorizer, bytes32 nonce)` on every one - whoever broadcast it, through whichever
 * facilitator, for whichever seller. Counting that event counts gasless USDC payments. To separate x402 from
 * everything else that pays gaslessly, the recipients are intersected with the `payTo` addresses published by a
 * public x402 discovery index.
 *
 * WHAT THE TWO NUMBERS MEAN, AND WHAT THEY DO NOT.
 *  - "all gasless" is an UPPER bound on x402: wallet apps and payment relayers use EIP-3009 too.
 *  - "to a listed x402 seller" is a LOWER bound: a seller that is not in that index is invisible here.
 *  - Both are extrapolated from a few minutes of chain. The listed-seller count is small enough that the daily
 *    figure swings by a factor of several between runs - read it as an order of magnitude, never as a rate. Run
 *    it more than once before believing any of it.
 *
 * COUNT PAYMENTS, NOT RECIPIENTS. This script first counted USDC Transfer events inside an authorized
 * transaction, which is wrong twice over: an x402 settler that forwards to the merchant produces TWO transfers
 * for ONE payment, so both the payment count and the distinct-recipient count are inflated; and several of the
 * biggest "recipients" turned out to be facilitator contracts and escrow buckets that buy nothing at all.
 * One AuthorizationUsed = one payment, by construction (one signer, one unique nonce). The payer side is the
 * honest unit for "how many parties are paying"; the recipient side needs the forwarding hop stripped first.
 * See ADR-55.
 */
import { keccak_256 } from '@noble/hashes/sha3.js'
import { bytesToHex } from '@noble/hashes/utils.js'

const RPC = process.env.BASE_RPC_URL_LIVE ?? 'https://mainnet.base.org'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const INDEX = 'https://facilitator.payai.network/discovery/resources'
const AUTH_USED = '0x' + bytesToHex(keccak_256(new TextEncoder().encode('AuthorizationUsed(address,bytes32)')))
const TRANSFER = '0x' + bytesToHex(keccak_256(new TextEncoder().encode('Transfer(address,address,uint256)')))
const BLOCKS_PER_DAY = 43_200 // Base: 2-second blocks

const windows = Number(process.argv[2] ?? 12)

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  const j = (await r.json()) as { result?: T; error?: unknown }
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 200)}`)
  return j.result as T
}

type Log = { topics: string[]; data: string; transactionHash: string }
const hex = (n: number) => '0x' + n.toString(16)
const addrOf = (topic: string) => ('0x' + topic.slice(26)).toLowerCase()

/** Every EVM payTo the public x402 index publishes. Sellers outside it are invisible to the second figure. */
async function listedSellers(): Promise<Set<string>> {
  const out = new Set<string>()
  for (const offset of [0, 1000, 2000, 3000, 4000, 5000]) {
    const d = (await (await fetch(`${INDEX}?limit=1000&offset=${offset}`)).json()) as { items?: { accepts?: { payTo?: string }[] }[] }
    for (const it of d.items ?? []) for (const a of it.accepts ?? []) if (typeof a.payTo === 'string' && a.payTo.startsWith('0x')) out.add(a.payTo.toLowerCase())
  }
  return out
}

/** USDC on Base moves enough that a wide Transfer query is refused; the range halves until it comes back. */
let span = 60
async function transfersTo(to: number): Promise<Log[]> {
  for (;;) {
    try {
      return await rpc<Log[]>('eth_getLogs', [{ address: USDC, topics: [TRANSFER], fromBlock: hex(to - span), toBlock: hex(to) }])
    } catch (e) {
      if (!/too large/i.test(String(e)) || span <= 2) throw e
      span = Math.floor(span / 2)
    }
  }
}

const sellers = await listedSellers()
const head = await rpc<string>('eth_blockNumber', []).then((h) => parseInt(h, 16))
console.log(`Base mainnet · USDC ${USDC}`)
console.log(`x402 index: ${sellers.size} distinct payTo addresses\n`)

let blocks = 0
let all = 0
let allValue = 0n
let listed = 0
let listedValue = 0n
const payers = new Set<string>()
for (let i = 0; i < windows; i++) {
  const to = head - i * 1500 // spread over hours, so no single burst carries the result
  const transfers = await transfersTo(to)
  const auth = await rpc<Log[]>('eth_getLogs', [{ address: USDC, topics: [AUTH_USED], fromBlock: hex(to - span), toBlock: hex(to) }])
  blocks += span
  const txs = new Set(auth.map((l) => l.transactionHash))
  for (const l of auth) payers.add(addrOf(l.topics[1]!))
  for (const t of transfers.filter((t) => txs.has(t.transactionHash))) {
    const v = BigInt(t.data)
    all++
    allValue += v
    if (sellers.has(addrOf(t.topics[2]!))) {
      listed++
      listedValue += v
    }
  }
}

const perDay = (n: number) => Math.round((n / blocks) * BLOCKS_PER_DAY)
const usdc = (v: bigint) => Number(v) / 1e6
const perDayValue = (v: bigint) => (usdc(v) / blocks) * BLOCKS_PER_DAY
console.log(`sampled ${blocks} blocks over ${windows} windows (about ${Math.round((blocks * 2) / 60)} minutes of chain), ${payers.size} distinct paying wallets\n`)
console.log(`ALL gasless USDC payments      ${String(all).padStart(6)} in sample  ~${perDay(all).toLocaleString('en-US').padStart(9)}/day   ~${perDayValue(allValue).toFixed(0)} USDC/day   (UPPER bound on x402)`)
console.log(`to a LISTED x402 seller        ${String(listed).padStart(6)} in sample  ~${perDay(listed).toLocaleString('en-US').padStart(9)}/day   ~${perDayValue(listedValue).toFixed(2)} USDC/day   (LOWER bound)`)
console.log(`average payment to a listed x402 seller: ${listed ? usdc(listedValue / BigInt(listed)).toFixed(4) : '-'} USDC`)
console.log(`\nRead the second line as an order of magnitude, not a rate: it rests on ${listed} events.`)
