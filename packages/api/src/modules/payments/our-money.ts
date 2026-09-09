import { sql } from 'drizzle-orm'
import { db } from '../../db/client.js'
import type { Env } from '../../db/schema.js'

/**
 * ADR-44/45: the wallets holding USDC that came from us, so that no figure we publish as evidence of outside
 * demand is counting our own money one hop later. One definition, used by GET /v1/stats (between_outsiders) and
 * by the per-agent reputation, because the two drifting apart is how ADR-43 happened in the first place.
 *
 * Seeds: everything our own first-party agents have paid out in this environment (the bounty desk, the first-buy
 * programme), plus - in the sandbox only - every wallet the platform faucet handed test USDC to. The faucet is
 * deliberately NOT a seed on live: an agent that tried the sandbox first holds worthless testnet USDC on a
 * different chain, and treating it as funded by us for ever would suppress exactly the live signal we are
 * waiting for.
 *
 * Then followed through every further payment recorded here: if we paid A and A paid B, B is spending our money
 * too. The trail only covers hops this platform can see - an ordinary on-chain transfer between two wallets
 * breaks it, and GET /v1/commitments says so rather than implying the check is complete.
 */
export async function ourFundedWallets(env: Env): Promise<Set<string>> {
  const faucetSeed = env === 'test' ? sql`select lower(fc.address) from faucet_claims fc union` : sql``
  const rows = await db().all<{ addr: string }>(sql`
    with recursive ours(addr) as (
        ${faucetSeed}
        select lower(st.pay_to) from settlements st join agents a on a.id = st.payer_agent_id
         where st.env = ${env} and st.kind = 'payment' and st.status = 'settled' and a.first_party = 1
      union
        select lower(s2.pay_to) from settlements s2, ours
         where s2.env = ${env} and s2.kind = 'payment' and s2.status = 'settled' and lower(s2.payer_address) = ours.addr
    )
    select addr from ours where addr is not null
  `)
  return new Set(rows.map((r) => r.addr))
}

/** A SQL predicate for "this address is one of ours", safe for an empty set. */
export function isOurWallet(column: ReturnType<typeof sql>, wallets: Set<string>) {
  if (!wallets.size) return sql`0 = 1`
  return sql`lower(${column}) in (${sql.join([...wallets].map((a) => sql`${a}`), sql`, `)})`
}
