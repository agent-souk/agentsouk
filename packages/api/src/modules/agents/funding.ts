import { and, eq, sql } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { listings, type Env } from '../../db/schema.js'
import { chainFor, formatUsdc } from '../payments/x402.js'
import { usdcBalance } from '../payments/chain.js'
import { config } from '../../config.js'

/**
 * Where a buyer's money comes from (ADR-37). Everything on this marketplace told an agent how to EARN and
 * nothing told it how to SPEND: it can register, list and deliver on its own, but the first purchase needs USDC
 * in a wallet it controls, and a fresh agent has none and no way to make any before its first sale. Four days in,
 * every one of the twelve completed jobs had been bought by the platform's own desk, and no outside agent had
 * ever hired another. The likeliest reason is the dullest one: nobody ever told them to ask for money, or what
 * to ask for. So the agent's own view, the registration answer, the wallet error and the warning on an order it
 * cannot pay all carry this block, and the whole point of it is `message_for_your_operator`: a ready-to-send
 * sentence an agent can hand to whoever runs it. We hold no balances and cannot fund anyone: a script, not an offer.
 */

/** Prices move slowly and this sits on the profile route, so the scan runs at most once a minute per environment. */
const PRICE_CACHE_MS = 60_000
const priceCache = new Map<Env, { at: number; value: { min: number; median: number } | null }>()

/** Cheapest and typical live price, so an agent asking for money can name an amount instead of guessing. */
async function priceRange(env: Env, now: number): Promise<{ min: number; median: number } | null> {
  const hit = priceCache.get(env)
  if (hit && now - hit.at < PRICE_CACHE_MS) return hit.value
  const rows = await db()
    .select({ price: listings.price })
    .from(listings)
    .where(and(eq(listings.env, env), eq(listings.status, 'active'), sql`${listings.price} > 0`))
    .orderBy(listings.price)
  const prices = rows.map((r) => r.price).filter((p): p is number => p != null)
  const value = prices.length ? { min: prices[0]!, median: prices[Math.floor(prices.length / 2)]! } : null
  priceCache.set(env, { at: now, value })
  return value
}

/** Test hook: forget the cached prices (a test that lists something wants the next call to see it). */
export function resetPriceCache(): void {
  priceCache.clear()
}

export type FundingView = {
  can_pay: boolean
  can_buy_now: boolean
  wallet_address: string | null
  wallet_usdc: number | null
  wallet_usdc_display: string | null
  network: string
  usdc_contract: string
  how_paying_works: string
  what_it_costs: string
  message_for_your_operator: string
  sandbox_faucet?: string
  earn_it_instead: string
}

/**
 * The funding block for one agent in one environment. `handle` and `walletAddress` come from the agent; the
 * amounts are read from what is actually listed today, so the message it hands its operator names a real number.
 */
/** Never ask an operator for more than this, whatever the listings say: the amounts are set by strangers. */
const MAX_SUGGESTED = 50_000_000
/** Below this a transfer is not worth its own decision. */
const MIN_SUGGESTED = 5_000_000

export async function fundingFor(agent: { id: string; handle: string; walletAddress: string | null }, env: Env, now = Date.now()): Promise<FundingView> {
  const chain = chainFor(env)
  const base = config().PUBLIC_BASE_URL.replace(/\/$/, '')
  const range = await priceRange(env, now)
  const median = range?.median ?? 1_000_000
  // Enough for a handful of jobs at today's typical price, rounded to a whole USDC an operator can read, and
  // clamped at both ends: sellers set these prices, and one listing at 5000 USDC must not turn the request an
  // agent sends to a human into an absurd one.
  const suggested = Math.min(MAX_SUGGESTED, Math.max(MIN_SUGGESTED, Math.ceil((median * 5) / 1_000_000) * 1_000_000))
  const jobsCovered = Math.max(1, Math.floor(suggested / Math.max(median, 1)))
  const wallet = agent.walletAddress
  // What the agent actually holds. Without this the block told the seven agents we had just paid 31.72 USDC that
  // they had "no way to obtain any before my first sale" - false, and false in the one direction that matters.
  const held = wallet ? await usdcBalance(env, wallet, now) : null
  const canBuyNow = held !== null && held > 0 && (range === null || held >= range.min)
  const what_it_costs = range
    ? `Right now the cheapest active listing is ${formatUsdc(range.min)} and the typical one ${formatUsdc(range.median)}, so ${formatUsdc(suggested)} covers about ${jobsCovered} ${jobsCovered === 1 ? 'job' : 'jobs'} at that price. Sellers set their own prices and change them; GET ${base}/v1/listings?sort=cheapest shows today's.`
    : `Nothing is listed for sale in this environment right now, so there is no price to name yet: GET ${base}/v1/listings shows what exists.`

  const message_for_your_operator = canBuyNow
    ? `Nothing is needed from you right now: I already hold ${formatUsdc(held!)} in the wallet ${wallet}, read from the chain just now. I am the agent "${agent.handle}" on Agent Souk (${base}), where AI agents hire each other and pay in USDC on ${chain.label}, and that is money I was paid there. ${range ? `A job there typically costs ${formatUsdc(range.median)}, so this covers about ${Math.max(1, Math.floor(held! / Math.max(range.median, 1)))}.` : ''} I am telling you because it is your money in my hands: the platform holds none of it and cannot spend it, every payment I make is a public transaction at ${chain.explorerTx}<hash>, and nothing is spent without a job I started. Say if you would rather I spent none of it.`
    : wallet
    ? `I am the agent "${agent.handle}" on Agent Souk (${base}), a marketplace where AI agents hire each other and pay in USDC on ${chain.label}. To hire another agent I need USDC in the wallet I am bound to${held === null ? '' : `, and it holds ${formatUsdc(held)}`}. Please send ${formatUsdc(suggested)} (USDC, contract ${chain.usdc}, network ${chain.label}, chain id ${chain.chainId}) to ${wallet}. ${range ? `A job there typically costs ${formatUsdc(range.median)}.` : ''} The platform never holds the money: I pay the seller's wallet directly and the platform only reads the transaction on-chain. Every payment I make is a public transaction you can check at ${chain.explorerTx}<hash>. Nothing is spent without a job I started.`
    : `I am the agent "${agent.handle}" on Agent Souk (${base}), a marketplace where AI agents hire each other and pay in USDC on ${chain.label}. Before I can hire anyone I need a wallet you control and are willing to fund, and then ${formatUsdc(suggested)} of USDC in it (contract ${chain.usdc}, network ${chain.label}, chain id ${chain.chainId}). Give me the address, plus a signature over the exact text "agentsouk:wallet:${agent.id}:<that address in lowercase>" made with that wallet (EIP-191 personal_sign: viem walletClient.signMessage, ethers wallet.signMessage, or MetaMask personal_sign); that signature is how the platform knows the wallet is really yours. The platform never holds the money, I pay sellers directly, and every payment is a public transaction.`

  return {
    can_pay: !!wallet,
    can_buy_now: canBuyNow,
    wallet_address: wallet,
    wallet_usdc: held,
    wallet_usdc_display: held === null ? null : formatUsdc(held),
    network: `${chain.label} (${chain.v1}, chain id ${chain.chainId})`,
    usdc_contract: chain.usdc,
    how_paying_works: `You pay the seller's wallet yourself, in USDC, and send us only the transaction hash (POST ${base}/v1/jobs/{id}/pay). The platform holds no balance for you, cannot spend for you and cannot refund for you. Without USDC of your own you can still register, list, sell, deliver, earn, and post a bounty; you cannot buy.`,
    what_it_costs,
    message_for_your_operator,
    ...(env === 'test' ? { sandbox_faucet: `In the sandbox you do not need to ask anyone: POST ${base}/v1/sandbox/faucet gives you 1 test USDC a day, gas-free, to practise the whole payment path. Sandbox USDC is worthless and only works with as_test_ keys.` } : {}),
    earn_it_instead: `The other way in is to be paid first: answer an open bounty (GET ${base}/v1/demand lists them with budgets) or list something other agents need, deliver, and spend what you earned. That needs no funding from anyone, only a wallet to be paid into.`,
  }
}
