import { setImmediate as yieldToLoop } from 'node:timers/promises'
import type { ServiceDef } from './types.js'

/**
 * ADR-69: the ninth first-party x402 service, and the first that carries a method out of Nick's own research
 * workshop (FTMORESEARCH, the prop-firm challenge lab) instead of wrapping a public source. Nick's ask was to sell
 * "the engine and the data" to traders. What can be sold here is neither: the terminal data belongs to the broker,
 * the engine is a multi-hour walk-forward search, and this platform sells to agents, per call, in seconds. What CAN
 * be sold per call is the one piece of that lab every strategy-evaluating agent needs and gets wrong with i.i.d.
 * resampling: given a series of daily returns and a prop-firm rule set (profit target, overall loss limit, daily
 * loss limit, trading-day window), what is the probability of passing before busting? The lab answered that with a
 * stationary block bootstrap (Politis & Romano 1994) after measuring that i.i.d. resampling destroys volatility
 * clustering and understates the bust probability (its AUG2R-MC-BLOCKFIX), and with the daily-loss rule as an
 * instant stop after the same mistake had sold an 85 % pass as reality that was 66 % (its Q-076 fix). Both are in
 * here, plus the plain risk statistics of the series. No data of ours, no model, no advice: statistics of the
 * numbers the buyer sends, deterministic for a given seed.
 *
 * Conventions, stated in the listing: returns are fractions of the STARTING balance and are added, not compounded -
 * that is how prop-firm rules are measured (a 10 % target on 100k is 10k of closed P&L, whatever the path). Days are
 * trading days. The output never claims to be a forecast; a bootstrap assumes the sent days are representative.
 */

export const MIN_DAYS = 20
export const MAX_DAYS_INPUT = 5000
export const MAX_SIMULATIONS = 50_000
export const MIN_SIMULATIONS = 100
export const DEFAULT_SIMULATIONS = 10_000
export const MAX_HORIZON = 365
export const DEFAULT_HORIZON = 42
export const DEFAULT_BLOCK_LENGTH = 5
export const MAX_BLOCK_LENGTH = 250
export const MAX_SCALE = 100
export const P_VALUE_RESAMPLES = 2000
/** simulations are run in slices of this many paths, with the event loop released in between */
const SLICE = 1000

export type StrategyInput = {
  daily_returns: number[]
  scale: number
  target: number
  max_loss: number
  daily_loss: number
  max_days: number
  simulations: number
  block_length: number
  seed: number
  trading_days_per_year: number
}

export type SeriesStats = {
  days: number
  mean_daily: number
  std_daily: number
  cumulative_return: number
  annualized_return: number
  annualized_volatility: number
  sharpe: number
  sortino: number
  max_drawdown: number
  var_99: number
  cvar_95: number
  worst_day: number
  best_day: number
  positive_days_ratio: number
  autocorr_lag1: number | null
  skewness: number | null
  excess_kurtosis: number | null
  p_value_mean_gt_zero: number
}

export type ChallengeResult = {
  pass_probability: number
  bust_probability: number
  undecided_probability: number
  bust_by: { daily_loss: number; max_loss: number }
  days_to_target: { median: number; p25: number; p75: number } | null
  terminal_return: { p5: number; p25: number; p50: number; p75: number; p95: number }
  path_max_drawdown: { p50: number; p95: number }
  simulations: number
  block_length: number
  seed: number
}

export type StrategyOutput = {
  input_summary: Omit<StrategyInput, 'daily_returns'> & { days: number }
  stats: SeriesStats
  challenge: ChallengeResult
  method: string
  caveats: string[]
  computed_at: string
}

/* ---------- deterministic randomness: xoshiro128** seeded by splitmix32 ---------- */

export class Rng {
  private s0: number
  private s1: number
  private s2: number
  private s3: number

  constructor(seed: number) {
    let x = seed >>> 0
    const next = () => {
      x = (x + 0x9e3779b9) >>> 0
      let z = x
      z = Math.imul(z ^ (z >>> 16), 0x21f0aaad)
      z = Math.imul(z ^ (z >>> 15), 0x735a2d97)
      return (z ^ (z >>> 15)) >>> 0
    }
    this.s0 = next()
    this.s1 = next()
    this.s2 = next()
    this.s3 = next()
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1
  }

  /** 32 random bits */
  next32(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5), 7), 9) >>> 0
    const t = this.s1 << 9
    this.s2 ^= this.s0
    this.s3 ^= this.s1
    this.s1 ^= this.s2
    this.s0 ^= this.s3
    this.s2 ^= t
    this.s3 = rotl(this.s3, 11)
    return result
  }

  /** uniform in [0, 1) */
  float(): number {
    return this.next32() / 4294967296
  }

  /** uniform integer in [0, n) */
  int(n: number): number {
    return Math.floor(this.float() * n)
  }
}

const rotl = (x: number, k: number) => ((x << k) | (x >>> (32 - k))) >>> 0

/* ---------- statistics ---------- */

/** numpy's default linear interpolation between order statistics */
export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return Number.NaN
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

const r6 = (x: number) => (Number.isFinite(x) ? Number(x.toPrecision(6)) : x)

/** peak-to-trough on the cumulative sum, starting from 0 (a first negative day is drawdown) */
export function maxDrawdown(returns: number[]): number {
  let cum = 0
  let peak = 0
  let dd = 0
  for (const r of returns) {
    cum += r
    if (cum > peak) peak = cum
    if (peak - cum > dd) dd = peak - cum
  }
  return dd
}

export function seriesStats(returns: number[], tradingDaysPerYear: number, rng: Rng, pResamples = P_VALUE_RESAMPLES): SeriesStats {
  const n = returns.length
  const mean = returns.reduce((a, b) => a + b, 0) / n
  const varPop = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / n
  const std = Math.sqrt(varPop)
  const sqrtN = Math.sqrt(tradingDaysPerYear)
  const downside = Math.sqrt(returns.reduce((a, b) => a + Math.min(b, 0) ** 2, 0) / n)
  const sorted = [...returns].sort((a, b) => a - b)
  const q05 = quantile(sorted, 0.05)
  const tail = sorted.filter((r) => r <= q05)
  let ac1: number | null = null
  if (n > 2 && varPop > 1e-24) {
    let num = 0
    for (let i = 1; i < n; i++) num += (returns[i] - mean) * (returns[i - 1] - mean)
    ac1 = num / (varPop * n)
  }
  let skew: number | null = null
  let kurt: number | null = null
  if (std > 1e-12) {
    const m3 = returns.reduce((a, b) => a + (b - mean) ** 3, 0) / n
    const m4 = returns.reduce((a, b) => a + (b - mean) ** 4, 0) / n
    skew = m3 / std ** 3
    kurt = m4 / std ** 4 - 3
  }
  // bootstrap p-value of "mean > 0": share of resampled means at or below zero (i.i.d., as in the lab)
  let atOrBelow = 0
  for (let b = 0; b < pResamples; b++) {
    let s = 0
    for (let i = 0; i < n; i++) s += returns[rng.int(n)]
    if (s <= 0) atOrBelow++
  }
  return {
    days: n,
    mean_daily: r6(mean),
    std_daily: r6(std),
    cumulative_return: r6(returns.reduce((a, b) => a + b, 0)),
    annualized_return: r6(mean * tradingDaysPerYear),
    annualized_volatility: r6(std * sqrtN),
    sharpe: std < 1e-12 ? 0 : r6((mean / std) * sqrtN),
    sortino: downside < 1e-12 ? 0 : r6((mean / downside) * sqrtN),
    max_drawdown: r6(maxDrawdown(returns)),
    var_99: r6(Math.abs(quantile(sorted, 0.01))),
    cvar_95: tail.length ? r6(Math.abs(tail.reduce((a, b) => a + b, 0) / tail.length)) : 0,
    worst_day: r6(sorted[0]),
    best_day: r6(sorted[n - 1]),
    positive_days_ratio: r6(returns.filter((r) => r > 0).length / n),
    autocorr_lag1: ac1 == null ? null : r6(ac1),
    skewness: skew == null ? null : r6(skew),
    excess_kurtosis: kurt == null ? null : r6(kurt),
    p_value_mean_gt_zero: r6(atOrBelow / pResamples),
  }
}

/* ---------- the Monte Carlo ---------- */

/**
 * Stationary block bootstrap over the scaled daily returns, one path at a time, stopping a path on the day the
 * target is reached (pass) or a rule is broken (bust). Ports FTMORESEARCH `_ftmo_pass_prob_fast` (vectorised
 * numpy) into a sequential loop with the same semantics: pass = cumulative >= target on a day no later than the
 * death day and inside the window; death = cumulative <= -max_loss, or a single day <= -daily_loss when that rule
 * is on; the two rules breaking on the same day count as the daily rule.
 */
export async function simulateChallenge(returns: number[], p: Omit<StrategyInput, 'daily_returns'>, rng: Rng, yieldEvery = SLICE): Promise<ChallengeResult> {
  const n = returns.length
  const fresh = 1 / p.block_length
  let passes = 0
  let bustDaily = 0
  let bustMax = 0
  const daysToTarget: number[] = []
  const terminal: number[] = new Array(p.simulations)
  const pathDd: number[] = new Array(p.simulations)
  for (let s = 0; s < p.simulations; s++) {
    if (s > 0 && s % yieldEvery === 0) await yieldToLoop()
    let idx = rng.int(n)
    let cum = 0
    let peak = 0
    let dd = 0
    let outcome: 'pass' | 'daily' | 'max' | null = null
    for (let t = 0; t < p.max_days; t++) {
      if (t > 0) idx = rng.float() < fresh ? rng.int(n) : (idx + 1) % n
      const r = returns[idx]
      cum += r
      if (cum > peak) peak = cum
      if (peak - cum > dd) dd = peak - cum
      // the lab's rule: the target on or before the death day passes, a death strictly before the target busts. In a
      // sequential walk the two cannot fall on the same day (a losing day cannot lift a path from below the target to
      // it), so the first event decides.
      if (cum >= p.target) {
        outcome = 'pass'
        daysToTarget.push(t + 1)
        break
      }
      if (p.daily_loss > 0 && r <= -p.daily_loss) {
        outcome = 'daily'
        break
      }
      if (cum <= -p.max_loss) {
        outcome = 'max'
        break
      }
    }
    if (outcome === 'pass') passes++
    else if (outcome === 'daily') bustDaily++
    else if (outcome === 'max') bustMax++
    terminal[s] = cum
    pathDd[s] = dd
  }
  terminal.sort((a, b) => a - b)
  pathDd.sort((a, b) => a - b)
  daysToTarget.sort((a, b) => a - b)
  const N = p.simulations
  return {
    pass_probability: r6(passes / N),
    bust_probability: r6((bustDaily + bustMax) / N),
    undecided_probability: r6((N - passes - bustDaily - bustMax) / N),
    bust_by: { daily_loss: r6(bustDaily / N), max_loss: r6(bustMax / N) },
    days_to_target: daysToTarget.length ? { median: quantile(daysToTarget, 0.5), p25: quantile(daysToTarget, 0.25), p75: quantile(daysToTarget, 0.75) } : null,
    terminal_return: { p5: r6(quantile(terminal, 0.05)), p25: r6(quantile(terminal, 0.25)), p50: r6(quantile(terminal, 0.5)), p75: r6(quantile(terminal, 0.75)), p95: r6(quantile(terminal, 0.95)) },
    path_max_drawdown: { p50: r6(quantile(pathDd, 0.5)), p95: r6(quantile(pathDd, 0.95)) },
    simulations: N,
    block_length: p.block_length,
    seed: p.seed,
  }
}

/* ---------- input handling ---------- */

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function num(input: Record<string, unknown>, key: string, dflt: number, min: number, max: number, integer = false): number | string {
  const v = input[key]
  if (v === undefined || v === null) return dflt
  if (!isNum(v)) return `${key} must be a number`
  if (integer && !Number.isInteger(v)) return `${key} must be an integer`
  if (v < min || v > max) return `${key} must be between ${min} and ${max}`
  return v
}

/** Parses and bounds the input; returns the reason to decline instead of a parsed input. */
export function parseInput(input: Record<string, unknown>): StrategyInput | string {
  const raw = input.daily_returns
  if (!Array.isArray(raw)) return 'daily_returns must be an array of numbers (fractions of the starting balance per trading day, e.g. 0.004 for +0.4 %)'
  if (raw.length < MIN_DAYS) return `daily_returns needs at least ${MIN_DAYS} days`
  if (raw.length > MAX_DAYS_INPUT) return `daily_returns holds ${raw.length} days; at most ${MAX_DAYS_INPUT} per job`
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i]
    if (!isNum(r)) return `daily_returns[${i}] is not a finite number`
    if (r < -1 || r > 1) return `daily_returns[${i}] is ${r}; returns are fractions of the starting balance between -1 and 1 (send 0.004, not 0.4 %)`
  }
  const fields = {
    scale: num(input, 'scale', 1, 0.001, MAX_SCALE),
    target: num(input, 'target', 0.1, 0.0001, 5),
    max_loss: num(input, 'max_loss', 0.1, 0.0001, 1),
    daily_loss: num(input, 'daily_loss', 0.05, 0, 1),
    max_days: num(input, 'max_days', DEFAULT_HORIZON, 1, MAX_HORIZON, true),
    simulations: num(input, 'simulations', DEFAULT_SIMULATIONS, MIN_SIMULATIONS, MAX_SIMULATIONS, true),
    block_length: num(input, 'block_length', DEFAULT_BLOCK_LENGTH, 1, MAX_BLOCK_LENGTH),
    seed: num(input, 'seed', 0, 0, 4294967295, true),
    trading_days_per_year: num(input, 'trading_days_per_year', 252, 1, 366, true),
  }
  for (const v of Object.values(fields)) if (typeof v === 'string') return v
  const f = fields as Record<keyof typeof fields, number>
  if (f.block_length > raw.length) return `block_length ${f.block_length} is longer than the series (${raw.length} days)`
  return { daily_returns: raw.map((r) => Number(r)), ...f }
}

export const METHOD =
  'Returns are fractions of the starting balance, multiplied by scale and added day by day (not compounded), the way prop-firm rules are measured. The challenge is simulated with a stationary block bootstrap (Politis & Romano 1994): each simulated day continues the previous historical day with probability 1 - 1/block_length, otherwise it restarts at a random historical day (block_length 1 = i.i.d. resampling). A path passes on the first day the cumulative return reaches target; it busts on the first day the cumulative return is at or below -max_loss, or a single day is at or below -daily_loss when daily_loss > 0. Paths that neither pass nor bust within max_days are undecided. Statistics use population standard deviation, a risk-free rate of zero and linear-interpolation quantiles; the p-value is the share of i.i.d. resampled means at or below zero. Deterministic for a given seed.'

export const CAVEATS = [
  'Statistics of the numbers you sent, not a forecast: a bootstrap assumes the sent days are representative of the days to come, and it cannot see regimes that are not in the sample.',
  'Costs, slippage, weekends, holidays and the account-specific definition of a trading day are whatever your returns already contain; nothing is added.',
  'Not investment advice and no recommendation of any instrument, strategy or account.',
]

export async function analyse(parsed: StrategyInput, opts: { now?: () => number; yieldEvery?: number; pResamples?: number } = {}): Promise<StrategyOutput> {
  const scaled = parsed.daily_returns.map((r) => r * parsed.scale)
  const params = { scale: parsed.scale, target: parsed.target, max_loss: parsed.max_loss, daily_loss: parsed.daily_loss, max_days: parsed.max_days, simulations: parsed.simulations, block_length: parsed.block_length, seed: parsed.seed, trading_days_per_year: parsed.trading_days_per_year }
  // two independent streams from one seed: the statistics never shift the simulation and vice versa
  const stats = seriesStats(scaled, parsed.trading_days_per_year, new Rng(parsed.seed ^ 0x5bd1e995), opts.pResamples)
  const challenge = await simulateChallenge(scaled, params, new Rng(parsed.seed), opts.yieldEvery)
  return {
    input_summary: { ...params, days: parsed.daily_returns.length },
    stats,
    challenge,
    method: METHOD,
    caveats: CAVEATS,
    computed_at: new Date(opts.now ? opts.now() : Date.now()).toISOString(),
  }
}

export function strategyStats(opts: { now?: () => number } = {}): ServiceDef {
  return {
    key: 'strategy-stats',
    listing: {
      title: 'Prop-firm challenge pass probability and risk statistics from daily returns (block-bootstrap Monte Carlo, no LLM)',
      description:
        'Send {"daily_returns": [0.004, -0.002, ...]} - your strategy\'s daily results as fractions of the starting balance (20 to 5,000 trading days) - and get (1) the probability of passing a prop-firm style challenge before busting: target (default 0.10 = +10 %), max_loss (overall loss limit, default 0.10), daily_loss (single-day loss limit, default 0.05, 0 = off) within max_days trading days (default 42), with the split of busts by rule, the days to target (median, p25, p75), the distribution of the terminal return and of the worst drawdown per path; (2) the risk statistics of the series: mean and standard deviation per day, annualized return and volatility, Sharpe, Sortino, max drawdown, VaR 99, CVaR 95, best and worst day, share of positive days, lag-1 autocorrelation, skewness, excess kurtosis and a bootstrap p-value for "mean > 0". Optional scale multiplies every return (position size), simulations (100-50,000, default 10,000), block_length (mean length of the resampled blocks, default 5; 1 = i.i.d.), seed (default 0; same input and seed give the identical answer), trading_days_per_year (default 252). Returns are added, not compounded, the way prop-firm rules count closed P&L. Method: stationary block bootstrap from a prop-firm research lab that measured how i.i.d. resampling understates bust risk. Statistics of the numbers you send, not a forecast, not advice. Deterministic, no LLM, no data of ours. Operated by Agent Souk (first_party).',
      category: 'data',
      tags: ['trading', 'backtest', 'monte-carlo', 'prop-firm', 'risk', 'deterministic'],
      price: 10_000,
      input_schema: {
        type: 'object',
        required: ['daily_returns'],
        properties: {
          daily_returns: { type: 'array', minItems: MIN_DAYS, maxItems: MAX_DAYS_INPUT, items: { type: 'number', minimum: -1, maximum: 1 }, description: 'Daily results as fractions of the starting balance, in trading-day order (0.004 = +0.4 %)' },
          scale: { type: 'number', minimum: 0.001, maximum: MAX_SCALE, default: 1, description: 'Multiplies every return (position-size multiplier)' },
          target: { type: 'number', minimum: 0.0001, maximum: 5, default: 0.1, description: 'Profit target as a fraction of the starting balance' },
          max_loss: { type: 'number', minimum: 0.0001, maximum: 1, default: 0.1, description: 'Overall loss limit as a fraction of the starting balance (cumulative return at or below -max_loss busts)' },
          daily_loss: { type: 'number', minimum: 0, maximum: 1, default: 0.05, description: 'Single-day loss limit (a day at or below -daily_loss busts); 0 turns the rule off' },
          max_days: { type: 'integer', minimum: 1, maximum: MAX_HORIZON, default: DEFAULT_HORIZON, description: 'Trading days the challenge may take' },
          simulations: { type: 'integer', minimum: MIN_SIMULATIONS, maximum: MAX_SIMULATIONS, default: DEFAULT_SIMULATIONS },
          block_length: { type: 'number', minimum: 1, maximum: MAX_BLOCK_LENGTH, default: DEFAULT_BLOCK_LENGTH, description: 'Mean length of the resampled blocks (stationary block bootstrap); 1 = i.i.d.' },
          seed: { type: 'integer', minimum: 0, maximum: 4294967295, default: 0 },
          trading_days_per_year: { type: 'integer', minimum: 1, maximum: 366, default: 252 },
        },
      },
      output_schema: {
        type: 'object',
        properties: {
          input_summary: { type: 'object', properties: { days: { type: 'integer' }, scale: { type: 'number' }, target: { type: 'number' }, max_loss: { type: 'number' }, daily_loss: { type: 'number' }, max_days: { type: 'integer' }, simulations: { type: 'integer' }, block_length: { type: 'number' }, seed: { type: 'integer' }, trading_days_per_year: { type: 'integer' } } },
          stats: {
            type: 'object',
            properties: {
              days: { type: 'integer' },
              mean_daily: { type: 'number' },
              std_daily: { type: 'number', description: 'population standard deviation' },
              cumulative_return: { type: 'number' },
              annualized_return: { type: 'number', description: 'mean_daily × trading_days_per_year' },
              annualized_volatility: { type: 'number' },
              sharpe: { type: 'number', description: 'risk-free rate 0; 0 when the series has no variance' },
              sortino: { type: 'number' },
              max_drawdown: { type: 'number', description: 'peak-to-trough of the added returns, as a fraction of the starting balance' },
              var_99: { type: 'number', description: 'absolute 1 % quantile of a day' },
              cvar_95: { type: 'number', description: 'absolute mean of the worst 5 % of days' },
              worst_day: { type: 'number' },
              best_day: { type: 'number' },
              positive_days_ratio: { type: 'number' },
              autocorr_lag1: { type: ['number', 'null'] },
              skewness: { type: ['number', 'null'] },
              excess_kurtosis: { type: ['number', 'null'] },
              p_value_mean_gt_zero: { type: 'number', description: 'share of 2,000 i.i.d. resampled means at or below zero' },
            },
          },
          challenge: {
            type: 'object',
            properties: {
              pass_probability: { type: 'number' },
              bust_probability: { type: 'number' },
              undecided_probability: { type: 'number', description: 'neither target nor a rule within max_days' },
              bust_by: { type: 'object', properties: { daily_loss: { type: 'number' }, max_loss: { type: 'number' } } },
              days_to_target: { type: ['object', 'null'], properties: { median: { type: 'number' }, p25: { type: 'number' }, p75: { type: 'number' } }, description: 'trading days until the target, over the passing paths; null when no path passed' },
              terminal_return: { type: 'object', description: 'cumulative return where each path stopped (target, bust or day max_days)', properties: { p5: { type: 'number' }, p25: { type: 'number' }, p50: { type: 'number' }, p75: { type: 'number' }, p95: { type: 'number' } } },
              path_max_drawdown: { type: 'object', properties: { p50: { type: 'number' }, p95: { type: 'number' } } },
              simulations: { type: 'integer' },
              block_length: { type: 'number' },
              seed: { type: 'integer' },
            },
          },
          method: { type: 'string' },
          caveats: { type: 'array', items: { type: 'string' } },
          computed_at: { type: 'string', format: 'date-time' },
        },
      },
      example_input: { daily_returns: EXAMPLE_RETURNS, scale: 3, target: 0.1, max_loss: 0.1, daily_loss: 0.05, max_days: 42, simulations: 10000, block_length: 5, seed: 0 },
      example_output: EXAMPLE_OUTPUT,
      turnaround_seconds: 120,
      accept_timeout_seconds: 600,
      max_open_jobs: 10,
    },
    validate(input) {
      const parsed = parseInput(input)
      return typeof parsed === 'string' ? parsed : null
    },
    async run(input) {
      const parsed = parseInput(input)
      if (typeof parsed === 'string') throw new Error(parsed)
      const out = await analyse(parsed, { now: opts.now })
      const c = out.challenge
      const pct = (x: number) => `${(x * 100).toFixed(1)} %`
      return {
        output: out,
        preview: { days: out.stats.days, pass_probability: c.pass_probability, bust_probability: c.bust_probability, undecided_probability: c.undecided_probability, days_to_target_median: c.days_to_target?.median ?? null, sharpe: out.stats.sharpe, max_drawdown: out.stats.max_drawdown, worst_day: out.stats.worst_day, simulations: c.simulations, block_length: c.block_length, seed: c.seed },
        message: `${out.stats.days} days: pass ${pct(c.pass_probability)}, bust ${pct(c.bust_probability)} (daily rule ${pct(c.bust_by.daily_loss)}, overall ${pct(c.bust_by.max_loss)}), undecided ${pct(c.undecided_probability)} within ${parsed.max_days} trading days; ${c.days_to_target ? `median ${c.days_to_target.median} days to target; ` : ''}Sharpe ${out.stats.sharpe}, max drawdown ${pct(out.stats.max_drawdown)}. ${c.simulations.toLocaleString('en-US')} paths, block length ${c.block_length}, seed ${c.seed}.`,
      }
    },
  }
}

/**
 * 60 trading days of a fictitious, mildly profitable, fat-tailed strategy: what the listing shows. The example
 * input scales it by 3, which is where the daily-loss rule starts to bite (the -2.33 % day becomes -7 %).
 */
export const EXAMPLE_RETURNS: number[] = [
  0.0042, -0.0018, 0.0031, 0.0007, -0.0125, 0.0058, 0.0021, -0.0033, 0.0089, -0.0006, 0.0014, 0.0037, -0.0071, 0.0052, 0.0009, -0.0022, 0.0066, 0.0018, -0.0154, 0.0047, 0.0029, -0.0011, 0.0073, 0.0003, -0.0041, 0.0038, 0.0016, -0.0088, 0.0061, 0.0024, -0.0019, 0.0045, 0.0012, -0.0233, 0.0079, 0.0033, -0.0008, 0.0056, 0.0021, -0.0047, 0.0068, 0.0015, -0.0027, 0.0041, 0.0009, -0.0112, 0.0063, 0.0028, -0.0016, 0.0049, 0.0011, -0.0059, 0.0072, 0.0026, -0.0013, 0.0044, 0.0019, -0.0092, 0.0057, 0.0031,
]

/** produced by analyse(parseInput(example_input)) with the seed 0; the test checks it stays true */
export const EXAMPLE_OUTPUT: StrategyOutput = {
  input_summary: { days: 60, scale: 3, target: 0.1, max_loss: 0.1, daily_loss: 0.05, max_days: 42, simulations: 10000, block_length: 5, seed: 0, trading_days_per_year: 252 },
  stats: { days: 60, mean_daily: 0.001595, std_daily: 0.0179154, cumulative_return: 0.0957, annualized_return: 0.40194, annualized_volatility: 0.284399, sharpe: 1.4133, sortino: 1.75713, max_drawdown: 0.0699, var_99: 0.055917, cvar_95: 0.0512, worst_day: -0.0699, best_day: 0.0267, positive_days_ratio: 0.666667, autocorr_lag1: -0.345107, skewness: -1.62491, excess_kurtosis: 3.28487, p_value_mean_gt_zero: 0.2375 },
  challenge: { pass_probability: 0.3433, bust_probability: 0.4571, undecided_probability: 0.1996, bust_by: { daily_loss: 0.4548, max_loss: 0.0023 }, days_to_target: { median: 28, p25: 21, p75: 34 }, terminal_return: { p5: -0.0699, p25: -0.0336, p50: 0.0282, p75: 0.102, p95: 0.1098 }, path_max_drawdown: { p50: 0.0699, p95: 0.0963 }, simulations: 10000, block_length: 5, seed: 0 },
  method: METHOD,
  caveats: CAVEATS,
  computed_at: '2026-09-16T00:00:00.000Z',
}
