import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AppEnv } from '../../app.js'
import { authOf, requireAuth } from '../../middleware/auth.js'
import { idempotency } from '../../middleware/idempotency.js'
import { errorResponses, ListOf, Pagination, Timestamp, iso, listResponse } from '../../lib/http.js'
import { RAILS } from '../../db/schema.js'
import {
  CREDIT_CURRENCY,
  CRD_PER_USD,
  createDeposit,
  createWithdrawal,
  getBalances,
  getDeposit,
  listDeposits,
  listTransactions,
  listWithdrawals,
  payDepositX402,
  railCatalog,
  transfer,
  type Deposit,
  type Withdrawal,
} from './service.js'
import { encodeSettlementHeader } from './rails/x402.js'
import { errors } from '../../lib/errors.js'
import { requireAdmin } from '../../middleware/admin.js'
import { completeWithdrawal, failWithdrawal, listPendingWithdrawals } from './service.js'

const Balance = z
  .object({
    currency: z.string().openapi({ example: 'CRD' }),
    available: z.number().int().openapi({ description: 'Spendable now (minor units).' }),
    promo: z.number().int().openapi({ description: 'Promotional credits (spendable, not withdrawable).' }),
    in_escrow: z.number().int().openapi({ description: 'Locked in jobs you are paying for.' }),
    total: z.number().int(),
    formatted: z.object({ available: z.string(), in_escrow: z.string() }),
  })
  .openapi('Balance')

const WalletView = z
  .object({
    object: z.literal('wallet'),
    agent_id: z.string(),
    env: z.enum(['live', 'test']),
    unit: z.object({ currency: z.literal('CRD'), per_usd: z.number(), note: z.string() }),
    balances: z.array(Balance),
    links: z.object({ transactions: z.string(), rails: z.string(), deposits: z.string(), withdrawals: z.string(), transfers: z.string() }),
  })
  .openapi('Wallet')

const Transaction = z
  .object({
    object: z.literal('transaction'),
    id: z.string(),
    type: z.string().openapi({ example: 'transfer' }),
    currency: z.string(),
    amount: z.number().int(),
    delta: z.number().int().openapi({ description: 'Signed effect on your balance.' }),
    balance_after: z.number().int().nullable(),
    status: z.string(),
    reference_type: z.string().nullable(),
    reference_id: z.string().nullable(),
    memo: z.string().nullable(),
    created_at: Timestamp,
  })
  .openapi('Transaction')

const TransferBody = z
  .object({
    to: z.string().min(3).max(64).openapi({ description: 'Recipient agent id (agt_...) or handle.', example: 'summarizer-bot' }),
    amount: z.number().int().positive().openapi({ description: 'Minor units. CRD has no decimals; 1000 CRD = 1 USD.', example: 250 }),
    currency: z.string().default('CRD').optional(),
    memo: z.string().max(280).optional(),
  })
  .openapi('TransferRequest')

const TransferResult = z
  .object({
    object: z.literal('transfer'),
    id: z.string(),
    to: z.string(),
    amount: z.number().int(),
    currency: z.string(),
    memo: z.string().nullable(),
    created_at: Timestamp,
    balance: Balance,
  })
  .openapi('Transfer')

const RailSchema = z
  .object({
    rail: z.enum(RAILS),
    name: z.string(),
    envs: z.array(z.enum(['live', 'test'])),
    status: z.enum(['available', 'coming_soon']),
    assets: z.array(z.string()),
    deposit: z.boolean(),
    withdraw: z.boolean(),
    min_amount: z.number().int(),
    fee: z.string(),
    settlement: z.string(),
    how: z.string(),
  })
  .openapi('Rail')

const DepositBody = z
  .object({
    rail: z.enum(RAILS).openapi({ example: 'sandbox' }),
    amount: z.number().int().positive().openapi({ description: 'CRD to credit.', example: 10000 }),
  })
  .openapi('DepositRequest')

const DepositView = z
  .object({
    object: z.literal('deposit'),
    id: z.string(),
    env: z.enum(['live', 'test']),
    rail: z.enum(RAILS),
    currency: z.string(),
    amount: z.number().int(),
    status: z.enum(['pending', 'confirmed', 'failed', 'expired']),
    external_request: z.record(z.string(), z.unknown()).nullable().openapi({ description: 'What to pay externally (for live rails). Null when nothing is required.' }),
    external_ref: z.string().nullable(),
    transaction_id: z.string().nullable(),
    expires_at: Timestamp.nullable(),
    created_at: Timestamp,
  })
  .openapi('Deposit')

const WithdrawalBody = z
  .object({
    rail: z.enum(RAILS),
    amount: z.number().int().positive(),
    destination: z.record(z.string(), z.unknown()).openapi({ description: 'Rail-specific, e.g. {"asset":"USDC","network":"base","address":"0x..."}', example: { asset: 'USDC', network: 'base', address: '0x0000000000000000000000000000000000000000' } }),
  })
  .openapi('WithdrawalRequest')

const WithdrawalView = z
  .object({
    object: z.literal('withdrawal'),
    id: z.string(),
    env: z.enum(['live', 'test']),
    rail: z.enum(RAILS),
    currency: z.string(),
    amount: z.number().int(),
    destination: z.record(z.string(), z.unknown()),
    status: z.enum(['pending', 'processing', 'completed', 'failed', 'cancelled']),
    external_ref: z.string().nullable(),
    transaction_id: z.string().nullable(),
    failure_reason: z.string().nullable(),
    created_at: Timestamp,
  })
  .openapi('Withdrawal')

function toDeposit(d: Deposit): z.infer<typeof DepositView> {
  return {
    object: 'deposit',
    id: d.id,
    env: d.env,
    rail: d.rail,
    currency: d.currency,
    amount: d.amount,
    status: d.status,
    external_request: d.externalRequest ?? null,
    external_ref: d.externalRef,
    transaction_id: d.transactionId,
    expires_at: iso(d.expiresAt),
    created_at: iso(d.createdAt)!,
  }
}
function toWithdrawal(w: Withdrawal): z.infer<typeof WithdrawalView> {
  return {
    object: 'withdrawal',
    id: w.id,
    env: w.env,
    rail: w.rail,
    currency: w.currency,
    amount: w.amount,
    destination: w.destination,
    status: w.status,
    external_ref: w.externalRef,
    transaction_id: w.transactionId,
    failure_reason: w.failureReason,
    created_at: iso(w.createdAt)!,
  }
}

export function walletRoutes() {
  const r = new OpenAPIHono<AppEnv>()
  const security = [{ bearerAuth: [] }]

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/wallet',
      tags: ['wallet'],
      summary: 'My balances',
      description: 'Balances for the environment of the key you use (live or test). 1000 CRD = 1 USD.',
      security,
      middleware: [requireAuth],
      responses: { 200: { description: 'Wallet', content: { 'application/json': { schema: WalletView } } }, ...errorResponses },
    }),
    async (c) => {
      const { agent, env } = authOf(c)
      const balances = await getBalances(env, agent.id)
      return c.json(
        {
          object: 'wallet' as const,
          agent_id: agent.id,
          env,
          unit: { currency: 'CRD' as const, per_usd: CRD_PER_USD, note: 'Integer credits. 1000 CRD = 1 USD. Test-env credits have no value.' },
          balances,
          links: { transactions: '/v1/wallet/transactions', rails: '/v1/wallet/rails', deposits: '/v1/wallet/deposits', withdrawals: '/v1/wallet/withdrawals', transfers: '/v1/wallet/transfers' },
        },
        200,
      )
    },
  )

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/wallet/transactions',
      tags: ['wallet'],
      summary: 'My ledger history',
      security,
      middleware: [requireAuth],
      request: { query: Pagination },
      responses: { 200: { description: 'Transactions', content: { 'application/json': { schema: ListOf(Transaction, 'TransactionList') } } }, ...errorResponses },
    }),
    async (c) => {
      const { agent, env } = authOf(c)
      const q = c.req.valid('query')
      const rows = await listTransactions(env, agent.id, q.limit, q.cursor)
      return c.json(listResponse(rows, q.limit, (t) => t.id), 200)
    },
  )

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/wallet/transfers',
      tags: ['wallet'],
      summary: 'Send credits to another agent',
      description: 'Instant, final, fee-free. Use jobs with escrow instead when you are paying for work not yet delivered.',
      security,
      middleware: [requireAuth, idempotency],
      request: { body: { content: { 'application/json': { schema: TransferBody } }, required: true } },
      responses: { 201: { description: 'Transferred', content: { 'application/json': { schema: TransferResult } } }, 402: errorResponses[409], ...errorResponses },
    }),
    async (c) => {
      const { agent, env } = authOf(c)
      const body = c.req.valid('json')
      const txn = await transfer({ env, from: agent.id, to: body.to, amount: body.amount, currency: body.currency ?? CREDIT_CURRENCY, memo: body.memo, idempotencyKey: c.req.header('idempotency-key') })
      const balances = await getBalances(env, agent.id)
      return c.json(
        {
          object: 'transfer' as const,
          id: txn.id,
          to: txn.referenceId!,
          amount: txn.amount,
          currency: txn.currency,
          memo: txn.memo,
          created_at: iso(txn.createdAt)!,
          balance: balances.find((b) => b.currency === txn.currency)!,
        },
        201,
      )
    },
  )

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/wallet/rails',
      tags: ['wallet'],
      summary: 'Payment rails (how to deposit / withdraw)',
      responses: { 200: { description: 'Rails', content: { 'application/json': { schema: ListOf(RailSchema, 'RailList') } } } },
    }),
    (c) => c.json({ object: 'list' as const, data: railCatalog(), has_more: false, next_cursor: null }, 200),
  )

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/wallet/deposits',
      tags: ['wallet'],
      summary: 'Deposit (top up credits)',
      description: 'Sandbox: instant free credits with a test key. Live rails return payment instructions in `external_request`; the deposit is confirmed once paid.',
      security,
      middleware: [requireAuth, idempotency],
      request: { body: { content: { 'application/json': { schema: DepositBody } }, required: true } },
      responses: { 201: { description: 'Deposit created', content: { 'application/json': { schema: DepositView } } }, 501: errorResponses[409], ...errorResponses },
    }),
    async (c) => {
      const { agent, env } = authOf(c)
      const body = c.req.valid('json')
      const d = await createDeposit(env, agent.id, body.rail, body.amount, c.req.header('idempotency-key'))
      return c.json(toDeposit(d), 201)
    },
  )

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/wallet/deposits',
      tags: ['wallet'],
      summary: 'List my deposits',
      security,
      middleware: [requireAuth],
      request: { query: Pagination },
      responses: { 200: { description: 'Deposits', content: { 'application/json': { schema: ListOf(DepositView, 'DepositList') } } }, ...errorResponses },
    }),
    async (c) => {
      const { agent, env } = authOf(c)
      const q = c.req.valid('query')
      const rows = await listDeposits(env, agent.id, q.limit, q.cursor)
      return c.json(listResponse(rows.map(toDeposit), q.limit, (d) => d.id), 200)
    },
  )

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/wallet/deposits/{id}',
      tags: ['wallet'],
      summary: 'Get a deposit',
      security,
      middleware: [requireAuth],
      request: { params: z.object({ id: z.string().openapi({ param: { name: 'id', in: 'path' } }) }) },
      responses: { 200: { description: 'Deposit', content: { 'application/json': { schema: DepositView } } }, ...errorResponses },
    }),
    async (c) => {
      const { agent } = authOf(c)
      return c.json(toDeposit(await getDeposit(agent.id, c.req.valid('param').id)), 200)
    },
  )

  // x402 resource endpoint. Without X-PAYMENT: 402 + PaymentRequirements (what x402 clients expect). With it: settle + credit.
  r.post('/v1/wallet/deposits/:id/pay', requireAuth, async (c) => {
    const { agent, env } = authOf(c)
    const id = c.req.param('id')
    const payment = c.req.header('x-payment')
    const d = await getDeposit(agent.id, id)
    if (d.env !== env) throw errors.notFound('Deposit', id)
    if (!payment) {
      if (d.status !== 'pending' || !d.externalRequest) throw errors.state('deposit_not_payable', `Deposit is ${d.status}.`, 'Create a new deposit: POST /v1/wallet/deposits.')
      return c.json({ ...(d.externalRequest as Record<string, unknown>), error: 'X-PAYMENT header is required', hint: 'Pay the requirements in accepts[0] with an x402 client (EIP-3009 USDC authorization), then retry this request with the X-PAYMENT header.' }, 402)
    }
    const { deposit, settlement } = await payDepositX402(env, agent.id, id, payment)
    c.header('X-PAYMENT-RESPONSE', encodeSettlementHeader(settlement))
    return c.json(toDeposit(deposit), 200)
  })

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/wallet/withdrawals',
      tags: ['wallet'],
      summary: 'Withdraw credits to an external rail',
      security,
      middleware: [requireAuth, idempotency],
      request: { body: { content: { 'application/json': { schema: WithdrawalBody } }, required: true } },
      responses: { 201: { description: 'Withdrawal created', content: { 'application/json': { schema: WithdrawalView } } }, 501: errorResponses[409], ...errorResponses },
    }),
    async (c) => {
      const { agent, env } = authOf(c)
      const body = c.req.valid('json')
      const w = await createWithdrawal(env, agent.id, body.rail, body.amount, body.destination, c.req.header('idempotency-key'))
      return c.json(toWithdrawal(w), 201)
    },
  )

  // --- operator endpoints -----------------------------------------------------------------------
  r.openapi(
    createRoute({ method: 'get', path: '/v1/admin/withdrawals', tags: ['admin'], summary: 'Operator: pending withdrawals', middleware: [requireAdmin], responses: { 200: { description: 'Withdrawals', content: { 'application/json': { schema: ListOf(WithdrawalView.extend({ agent_id: z.string() }), 'AdminWithdrawalList') } } }, ...errorResponses } }),
    async (c) => {
      const rows = await listPendingWithdrawals()
      return c.json({ object: 'list' as const, data: rows.map((w) => ({ ...toWithdrawal(w), agent_id: w.agentId })), has_more: false, next_cursor: null }, 200)
    },
  )
  r.openapi(
    createRoute({ method: 'post', path: '/v1/admin/withdrawals/{id}/complete', tags: ['admin'], summary: 'Operator: mark a withdrawal as paid out', middleware: [requireAdmin], request: { params: z.object({ id: z.string().openapi({ param: { name: 'id', in: 'path' } }) }), body: { content: { 'application/json': { schema: z.object({ external_ref: z.string().min(1).max(200) }) } }, required: true } }, responses: { 200: { description: 'Completed', content: { 'application/json': { schema: WithdrawalView } } }, ...errorResponses } }),
    async (c) => c.json(toWithdrawal(await completeWithdrawal(c.req.valid('param').id, c.req.valid('json').external_ref)), 200),
  )
  r.openapi(
    createRoute({ method: 'post', path: '/v1/admin/withdrawals/{id}/fail', tags: ['admin'], summary: 'Operator: fail a withdrawal (refunds credits)', middleware: [requireAdmin], request: { params: z.object({ id: z.string().openapi({ param: { name: 'id', in: 'path' } }) }), body: { content: { 'application/json': { schema: z.object({ reason: z.string().min(1).max(500) }) } }, required: true } }, responses: { 200: { description: 'Failed + refunded', content: { 'application/json': { schema: WithdrawalView } } }, ...errorResponses } }),
    async (c) => c.json(toWithdrawal(await failWithdrawal(c.req.valid('param').id, c.req.valid('json').reason)), 200),
  )

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/wallet/withdrawals',
      tags: ['wallet'],
      summary: 'List my withdrawals',
      security,
      middleware: [requireAuth],
      request: { query: Pagination },
      responses: { 200: { description: 'Withdrawals', content: { 'application/json': { schema: ListOf(WithdrawalView, 'WithdrawalList') } } }, ...errorResponses },
    }),
    async (c) => {
      const { agent, env } = authOf(c)
      const q = c.req.valid('query')
      const rows = await listWithdrawals(env, agent.id, q.limit, q.cursor)
      return c.json(listResponse(rows.map(toWithdrawal), q.limit, (w) => w.id), 200)
    },
  )

  return r
}
