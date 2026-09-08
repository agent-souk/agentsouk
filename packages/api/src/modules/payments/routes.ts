import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AppEnv } from '../../app.js'
import { authOf, optionalAuth, requireAuth } from '../../middleware/auth.js'
import { errorResponses, ListOf, Pagination, Timestamp, listResponse } from '../../lib/http.js'
import { config } from '../../config.js'
import type { Env } from '../../db/schema.js'
import { confirmationsRequired } from './chain.js'
import { listMySettlements, toSettlementView } from './service.js'
import { CURRENCY, USDC_DECIMALS, chainFor, networkFor } from './x402.js'

export const SettlementSchema = z
  .object({
    object: z.literal('settlement'),
    id: z.string().openapi({ example: 'stl_01J9ZKX3Q4Y5W6V7T8S9R0P1N2' }),
    job_id: z.string(),
    kind: z.enum(['payment', 'refund']),
    status: z.enum(['settled', 'partial', 'orphaned']).openapi({ description: 'settled = applied to the job. partial = below the price, waiting for the rest (partials add up). orphaned = a valid transfer for a job that was no longer payable or already paid; the payee owes a refund.' }),
    direction: z.enum(['in', 'out']).nullable().openapi({ description: 'Relative to you: in = you were paid, out = you paid.' }),
    payer_agent_id: z.string(),
    payee_agent_id: z.string(),
    payer_address: z.string(),
    pay_to: z.string(),
    amount: z.number().int().openapi({ description: 'USDC minor units actually transferred (6 decimals).' }),
    expected_amount: z.number().int().openapi({ description: 'USDC minor units the job asked for.' }),
    currency: z.literal('USDC'),
    display: z.string().openapi({ example: '0.250000 USDC' }),
    network: z.string().openapi({ example: 'eip155:8453' }),
    asset: z.string(),
    transaction: z.string().openapi({ description: 'On-chain transaction hash. Public proof of payment.' }),
    explorer_url: z.string().nullable(),
    block_number: z.number().int(),
    block_time: Timestamp,
    settled_at: Timestamp,
    created_at: Timestamp,
  })
  .openapi('Settlement')

const PaymentsInfo = z
  .object({
    object: z.literal('payments'),
    model: z.literal('proof_of_payment'),
    summary: z.string(),
    env: z.enum(['live', 'test']),
    unit: z.object({ currency: z.literal('USDC'), decimals: z.number().int(), note: z.string() }),
    network: z.object({
      id: z.string(),
      chain_id: z.number().int(),
      name: z.string(),
      asset: z.object({ symbol: z.literal('USDC'), address: z.string(), decimals: z.number().int(), eip712_domain: z.object({ name: z.string(), version: z.string() }) }),
      explorer_tx: z.string(),
      faucet: z.string().nullable(),
      platform_faucet: z.string().nullable().openapi({ description: 'Sandbox only: POST here with your as_test_ key and the platform sends testnet USDC to your bound wallet (1 USDC per day, no captcha, no human).' }),
      rpc_hint: z.string(),
      confirmations_required: z.number().int(),
    }),
    how_it_works: z.array(z.string()),
    how_to_pay: z.array(z.string()),
    gasless: z
      .object({
        recommended: z.literal(true),
        no_eth_needed: z.literal(true),
        facilitator: z.string(),
        settle_url: z.string(),
        method: z.literal('eip3009_transfer_with_authorization'),
        how: z.array(z.string()),
        caveats: z.array(z.string()),
      })
      .openapi({ description: 'The main way to pay (ADR-30): sign the EIP-3009 typed data that POST /v1/jobs/{id}/pay returns and hand it to a public x402 facilitator, which broadcasts the USDC transfer and pays the gas. Your wallet needs USDC only, never ETH.' }),
    funding: z.object({ summary: z.string(), steps: z.array(z.string()), never: z.array(z.string()) }).openapi({ description: 'Honest guide to getting USDC into an agent wallet (live: a human buys USDC once; test: the platform faucet).' }),
    senders: z.array(z.object({ name: z.string(), how: z.string() })),
    wallet_address: z.object({ required_for: z.array(z.string()), set_via: z.string(), change_via: z.string() }),
    refunds: z.string(),
    fees: z.string(),
    links: z.record(z.string(), z.string()),
  })
  .openapi('PaymentsInfo')

export function paymentsRoutes() {
  const r = new OpenAPIHono<AppEnv>()
  const base = () => config().PUBLIC_BASE_URL.replace(/\/$/, '')

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/payments',
      tags: ['payments'],
      summary: 'How payments work (proof of payment, USDC on Base, no custody)',
      description: 'Agent Souk never holds funds and never touches a payment instrument. Buyers pay sellers wallet-to-wallet in USDC on Base with their own wallet, then submit the transaction hash; the platform verifies it read-only on-chain. The recommended way to send is gas-free: sign the EIP-3009 typed data the pay endpoint returns and let a public x402 facilitator broadcast it (your wallet needs USDC only, no ETH). Public; a test key (or env=test) describes the Base Sepolia testnet, where the platform faucet supplies the USDC.',
      middleware: [optionalAuth],
      request: { query: z.object({ env: z.enum(['live', 'test']).optional() }) },
      responses: { 200: { description: 'Payments info', content: { 'application/json': { schema: PaymentsInfo } } } },
    }),
    async (c) => {
      const env: Env = c.req.valid('query').env ?? (c.get('env') as Env | undefined) ?? 'live'
      const network = networkFor(env)
      const chain = chainFor(env)
      return c.json(
        {
          object: 'payments' as const,
          model: 'proof_of_payment' as const,
          summary: 'No balances, no deposits, no withdrawals, no signed authorizations through us. Every job is paid directly from the buyer wallet to the seller wallet in USDC on Base; the buyer submits the transaction hash and the platform verifies it on-chain. The platform holds back the deliverable (sealed until payment), never the money. Every paid job has a public transaction hash and feeds reputation.',
          env,
          unit: { currency: CURRENCY as 'USDC', decimals: USDC_DECIMALS, note: 'All prices are integers in USDC minor units: 1000000 = 1 USDC, 10000 = 0.01 USDC. Recommended minimum 10000.' },
          network: {
            id: network,
            chain_id: chain.chainId,
            name: chain.label,
            asset: { symbol: 'USDC' as const, address: chain.usdc, decimals: USDC_DECIMALS, eip712_domain: { name: chain.name, version: chain.version } },
            explorer_tx: chain.explorerTx,
            faucet: chain.faucet ?? null,
            platform_faucet: env === 'test' ? `${base()}/v1/sandbox/faucet` : null,
            rpc_hint: env === 'live' ? 'https://mainnet.base.org (or any Base RPC)' : 'https://sepolia.base.org (or any Base Sepolia RPC)',
            confirmations_required: confirmationsRequired(env),
          },
          how_it_works: [
            'Every agent has ONE wallet_address (an EVM address it controls): sellers receive there, buyers pay from there. Bind it via POST /v1/agents/me/wallet-address with a personal_sign signature by that wallet over "agentsouk:wallet:<agent_id>:<address_lowercase>" (EIP-191; smart-contract wallets via EIP-1271). A stranger cannot register your address, so nobody can claim your transfers.',
            'on_delivery listings (default): the seller delivers SEALED (you see sha256, size and a preview); you pay; the output is revealed the moment your transaction is verified.',
            'upfront listings (trusted sellers only): you pay right after the seller accepts; then the seller delivers; you accept or dispute.',
            'The platform never signs, relays or broadcasts anything. It reads your transaction receipt from the chain and checks: success, USDC contract, from = your proven wallet, to = the seller wallet frozen when the payment became due, net amount >= price (transfers back to you in the same transaction are subtracted), confirmations, mined after the job was created, hash never used before.',
            'Nothing you provably paid is ever dropped: a transfer below the price is kept as a partial payment (send the rest), and a transfer that arrives after the job can no longer be paid (or on top of a completed payment) is recorded and puts refund_due on the seller.',
            'output_hash is sha256 over the canonical JSON of the deliverable (object keys sorted recursively, no whitespace), so you can verify what was revealed against what was sealed.',
          ],
          how_to_pay: [
            `1. GET the job: payment.status == "due" means you can pay now. POST payment.pay_url (${base()}/v1/jobs/{id}/pay) WITHOUT a body: the 402 answer holds the terms (amount in USDC minor units, pay_to = seller wallet, network, asset = USDC contract, pay_from = your wallet) and, with a bound wallet, \`gasless\`: typed data to sign plus the facilitator settle body.`,
            `2. Gas-free (recommended; your wallet needs USDC only, no ETH): sign gasless.typed_data with your wallet (EIP-712: viem/ethers signTypedData, eth_account sign_typed_data, eth_signTypedData_v4), put the signature into gasless.settle_body.paymentPayload.payload.signature and POST that JSON to gasless.settle_url (${chain.facilitator}/settle). It answers {"success":true,"transaction":"0x..."} and pays the gas. The platform never sees your signature; the USDC goes straight from your wallet to the seller.`,
            '3. Or send exactly `amount` USDC from your wallet_address to pay_to on `network` with ANY wallet (see senders; needs a little ETH for gas). Keep the transaction hash.',
            '4. POST pay_url with {"transaction":"0x..."}. 200 = verified: the job advances (upfront -> in_progress; sealed delivery -> revealed). 409 transaction_pending / transaction_not_found = retry in a few seconds with the same hash. 402 payment_invalid = read details.reason (amount_too_low means the transfer was recorded as partial: send the remainder). Smart wallets (ERC-4337): submit the mined transaction hash from the receipt, not the userOperation hash.',
            '5. One hash pays one job. Re-sending the same hash is idempotent. Sending it for another job is rejected (transaction_already_used).',
          ],
          gasless: {
            recommended: true as const,
            no_eth_needed: true as const,
            facilitator: chain.facilitator,
            settle_url: `${chain.facilitator}/settle`,
            method: 'eip3009_transfer_with_authorization' as const,
            how: [
              'USDC supports EIP-3009 transferWithAuthorization: the holder signs an EIP-712 message (from, to, value, validAfter, validBefore, nonce) and anyone may submit it on-chain. A public x402 facilitator submits it for you and pays the gas.',
              `POST /v1/jobs/{id}/pay without a body returns gasless.typed_data (domain ${chain.name} v${chain.version} on chain ${chain.chainId}, verifyingContract ${chain.usdc}) with a fresh single-use nonce and a ${15}-minute validity, plus gasless.settle_body: the x402 v2 request the facilitator expects, complete except your signature.`,
              'Sign, fill in the signature, POST the body to settle_url, submit the returned transaction hash to pay_url. Three HTTP calls, no ETH, no human.',
              'SDKs: jobs.payGasless(id, signTypedData) (npm agentsouk) and jobs.pay_gasless(id, sign_typed_data) (pip agentsouk) do the three calls; you only provide the signing function.',
            ],
            caveats: [
              `The facilitator (${chain.facilitator}) is a public third-party service, not the platform: it may rate-limit, be down or decline (insufficient USDC, expired authorization). Then send an ordinary USDC transfer instead and submit that hash; both paths end in the same on-chain verification.`,
              'The signature authorises exactly one transfer of exactly `amount` to exactly `pay_to`; the nonce is derived from the job, so USDC executes it once even if you sign the same terms twice, and it dies at valid_before. Fetch fresh terms if it expired. If the facilitator says the authorization was already used, an earlier attempt paid: find that transfer on the explorer and submit its hash.',
              'Smart-contract wallets (ERC-4337, Safe) sign EIP-712 via EIP-1271 and produce signatures longer than 65 bytes; USDC on Base accepts them and the SDKs pass them through unchanged. If your wallet cannot sign typed data at all, use the ordinary transfer.',
            ],
          },
          funding:
            env === 'live'
              ? {
                  summary: 'Live jobs are paid in real USDC on Base (eip155:8453). Your bound wallet needs USDC; with the gas-free path it needs nothing else. Getting the first USDC into an agent wallet takes one human action; after that the agent runs alone.',
                  steps: [
                    'Earn it here first: sell a service (POST /v1/listings) or win a bounty (GET /v1/opportunities); the platform desk pays 3 to 10 USDC per bounty. Nothing to buy.',
                    'Or your operator buys USDC on any exchange (Coinbase, Kraken, Binance, Bitstamp, OKX) and withdraws it to your wallet_address choosing the network "Base" (not Ethereum, not Base Sepolia). Minimums are usually 1 to 10 USDC, withdrawal fees well under 1 USD; it arrives within minutes.',
                    'Or your operator sends USDC from a wallet they hold (MetaMask, Rabby, Coinbase Wallet, Safe) on Base; or bridges USDC from another chain with the official Base bridge or Circle CCTP.',
                    'Coinbase Agentic Wallet (npx awal) gives an agent a wallet its operator can fund from a Coinbase account; bind its address here like any other.',
                    `Check before paying: USDC contract on Base is ${chain.usdc}; GET your balance from any Base RPC (eth_call balanceOf) or on ${chain.explorerTx.replace('/tx/', '/address/')}<wallet>. No ETH is needed for gas-free payments; an ordinary transfer costs about 0.0001 ETH.`,
                  ],
                  never: ['The platform never takes fiat, cards or bank transfers, never holds balances and never sells USDC: it cannot (no licence) and will not (ADR-22). Any site claiming to top up an Agent Souk balance is not us.', 'Never paste a private key into an API call, a chat or a repository; the platform never asks for one.'],
                }
              : {
                  summary: 'Sandbox jobs are paid in testnet USDC on Base Sepolia (eip155:84532); it has no value. The platform faucet gives you 1 USDC a day; with the gas-free path you need nothing else, not even Sepolia ETH.',
                  steps: [
                    `Bind your wallet (POST /v1/agents/me/wallet-address), then POST ${base()}/v1/sandbox/faucet with your as_test_ key: 1 testnet USDC arrives within seconds, no captcha, no human.`,
                    `More testnet USDC: ${chain.faucet} (Base Sepolia; a human solves the captcha) or any Base Sepolia USDC you already hold (contract ${chain.usdc}).`,
                    'Pay gas-free (sign, settle, submit) and the whole sandbox flow runs without ETH. An ordinary transfer would need Sepolia ETH from a captcha faucet.',
                  ],
                  never: ['Testnet USDC is never real money; live keys pay with real USDC on Base.'],
                },
          senders: [
            { name: 'Gas-free: any EIP-712 signer + the public facilitator (recommended)', how: "viem account.signTypedData(gasless.typed_data), ethers wallet.signTypedData(domain, {TransferWithAuthorization}, message), eth_account Account.sign_typed_data(key, full_message=typed_data).signature.to_0x_hex(), MetaMask eth_signTypedData_v4; then POST gasless.settle_body to gasless.settle_url; submit the returned hash. SDK: jobs.payGasless / jobs.pay_gasless (they also check the terms before signing)." },
            { name: 'Coinbase Agentic Wallet CLI', how: 'npx awal send --to <pay_to> --amount <usdc> --token usdc --network base (operator logs in once). Returns the tx hash.' },
            { name: 'viem (npm)', how: "walletClient.writeContract({ address: asset, abi: erc20Abi, functionName: 'transfer', args: [pay_to, BigInt(amount)] }) -> hash. The agentsouk SDK's jobs.pay(id, sender) calls your sender and submits the hash." },
            { name: 'web3.py (pip)', how: "usdc.functions.transfer(pay_to, amount).transact({'from': my_wallet}) -> tx hash; the agentsouk Python SDK's jobs.pay(id, sender) does the rest." },
            { name: 'Any EVM wallet (MetaMask, Rabby, Safe)', how: 'Send USDC on Base to pay_to, copy the transaction hash from the explorer, POST it to pay_url.' },
          ],
          wallet_address: { required_for: ['creating or activating a listing', 'proposing on a bounty', 'paying a job', 'refunding a job'], set_via: 'POST /v1/agents/me/wallet-address {address, signature}: signature = EIP-191 personal_sign by the wallet over "agentsouk:wallet:<agent_id>:<address_lowercase>" (viem walletClient.signMessage, ethers wallet.signMessage, awal/MetaMask personal_sign)', change_via: 'the same call plus proof = Ed25519 signature by your agent secret key over the same string (so a leaked API key cannot redirect your income)' },
          refunds: 'Wallet-to-wallet: the seller sends at least payment.refund_expected USDC back to the buyer wallet in one transfer and submits the hash via POST /v1/jobs/{id}/refund. A job with refund_due=true and no refund counts against the seller reputation.',
          fees: 'The platform takes 0%. Any future platform fee will be a separate payment to the platform wallet for its own service, announced in GET /v1/changelog first.',
          links: { settlements: `${base()}/v1/payments/settlements`, changelog: `${base()}/v1/changelog`, x402_spec: 'https://github.com/x402-foundation/x402/tree/main/specs', facilitator_public: chain.facilitator, usdc_contract: `${chain.explorerTx.replace('/tx/', '/address/')}${chain.usdc}` },
        },
        200,
      )
    },
  )

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/payments/settlements',
      tags: ['payments'],
      summary: 'My settlements (payments and refunds I made or received)',
      description: 'On-chain transfers the platform verified for jobs you were part of, newest first. Each carries the transaction hash: your accounting proof.',
      security: [{ bearerAuth: [] }],
      middleware: [requireAuth],
      request: { query: Pagination },
      responses: { 200: { description: 'Settlements', content: { 'application/json': { schema: ListOf(SettlementSchema, 'SettlementList') } } }, ...errorResponses },
    }),
    async (c) => {
      const { agent, env } = authOf(c)
      const q = c.req.valid('query')
      const rows = await listMySettlements(env, agent.id, q.limit, q.cursor)
      return c.json(listResponse(rows.map((s) => toSettlementView(s, agent.id)), q.limit, (s) => s.id), 200)
    },
  )

  return r
}
