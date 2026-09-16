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
/** the p-value bootstrap releases the loop every this many resamples (each resample walks the whole series) */
const P_SLICE = 200
/**
 * Tolerance for the rule comparisons: ten days of +0.01 add up to 0.09999999999999999 in doubles, and a buyer whose
 * series reaches the target exactly must see a pass, not an undecided path with a terminal return that prints as 0.1.
 * Far below anything tradable, far above the rounding of a few hundred additions.
 */
export const EPS = 1e-12

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
  sharpe: number | null
  sortino: number | null
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
  standard_error: { pass_probability: number; bust_probability: number }
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

export async function seriesStats(returns: number[], tradingDaysPerYear: number, rng: Rng, pResamples = P_VALUE_RESAMPLES, yieldEvery = P_SLICE): Promise<SeriesStats> {
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
  // bootstrap p-value of "mean > 0": share of i.i.d. resampled means at or below zero, with the lab's pseudo-count of
  // one ((k + 1) / (B + 1)), so a series that never resamples to a loss reports a small p, never an impossible 0
  let atOrBelow = 0
  for (let b = 0; b < pResamples; b++) {
    if (b > 0 && b % yieldEvery === 0) await yieldToLoop()
    let s = 0
    for (let i = 0; i < n; i++) s += returns[rng.int(n)]
    if (s <= 0) atOrBelow++
  }
  const tailMean = tail.length ? tail.reduce((a, b) => a + b, 0) / tail.length : 0
  return {
    days: n,
    mean_daily: r6(mean),
    std_daily: r6(std),
    cumulative_return: r6(returns.reduce((a, b) => a + b, 0)),
    annualized_return: r6(mean * tradingDaysPerYear),
    annualized_volatility: r6(std * sqrtN),
    sharpe: std < 1e-12 ? null : r6((mean / std) * sqrtN),
    sortino: downside < 1e-12 ? null : r6((mean / downside) * sqrtN),
    max_drawdown: r6(maxDrawdown(returns)),
    // loss magnitudes: a tail made of gains is a loss of 0, not a gain reported as a loss
    var_99: r6(Math.max(0, -quantile(sorted, 0.01))),
    cvar_95: r6(Math.max(0, -tailMean)),
    worst_day: r6(sorted[0]),
    best_day: r6(sorted[n - 1]),
    positive_days_ratio: r6(returns.filter((r) => r > 0).length / n),
    autocorr_lag1: ac1 == null ? null : r6(ac1),
    skewness: skew == null ? null : r6(skew),
    excess_kurtosis: kurt == null ? null : r6(kurt),
    p_value_mean_gt_zero: r6((atOrBelow + 1) / (pResamples + 1)),
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
      if (cum >= p.target - EPS) {
        outcome = 'pass'
        daysToTarget.push(t + 1)
        break
      }
      if (p.daily_loss > 0 && r <= -p.daily_loss + EPS) {
        outcome = 'daily'
        break
      }
      if (cum <= -p.max_loss + EPS) {
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
  // rounded parts first, totals from the rounded parts: the split sums to the bust figure and the three to 1
  const bustBy = { daily_loss: r6(bustDaily / N), max_loss: r6(bustMax / N) }
  const pass = r6(passes / N)
  const bust = r6(bustBy.daily_loss + bustBy.max_loss)
  const se = (k: number) => r6(Math.sqrt(((k / N) * (1 - k / N)) / N))
  return {
    pass_probability: pass,
    bust_probability: bust,
    undecided_probability: r6(Math.max(0, 1 - pass - bust)),
    standard_error: { pass_probability: se(passes), bust_probability: se(bustDaily + bustMax) },
    bust_by: bustBy,
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
  // a mean block longer than the series is a valid stationary bootstrap: the walk wraps around, as in the lab
  return { daily_returns: raw.map((r) => Number(r)), ...f }
}

export const METHOD =
  'Scaled returns added, not compounded. Stationary block bootstrap (Politis & Romano 1994): a simulated day continues the previous historical day with probability 1 - 1/block_length, else restarts at a random day; wrap-around; block_length 1 = i.i.d. Pass = cumulative return reaches target; bust = cumulative at or below -max_loss, or a day at or below -daily_loss (daily_loss > 0; both on one day count as daily_loss); else undecided at max_days. Population std, risk-free rate 0, linear quantiles, p-value (k + 1) / (B + 1). Six significant digits; standard_error is the sampling error. Deterministic per seed.'

export const CAVEATS = [
  'Statistics of the numbers you sent, not a forecast: a bootstrap assumes the sent days are representative and cannot see regimes outside the sample.',
  'Not investment advice, no recommendation of any instrument, strategy or account; costs and slippage are whatever your returns already contain.',
]

/** The whole answer for a parsed input. No clock in the output: the same input and seed give the same bytes (the job record carries the delivery time). */
export async function analyse(parsed: StrategyInput, opts: { yieldEvery?: number; pResamples?: number } = {}): Promise<StrategyOutput> {
  const scaled = parsed.daily_returns.map((r) => r * parsed.scale)
  const params = { scale: parsed.scale, target: parsed.target, max_loss: parsed.max_loss, daily_loss: parsed.daily_loss, max_days: parsed.max_days, simulations: parsed.simulations, block_length: parsed.block_length, seed: parsed.seed, trading_days_per_year: parsed.trading_days_per_year }
  // two independent streams from one seed: the statistics never shift the simulation and vice versa
  const stats = await seriesStats(scaled, parsed.trading_days_per_year, new Rng(parsed.seed ^ 0x5bd1e995), opts.pResamples)
  const challenge = await simulateChallenge(scaled, params, new Rng(parsed.seed), opts.yieldEvery)
  return {
    input_summary: { ...params, days: parsed.daily_returns.length },
    stats,
    challenge,
    method: METHOD,
    caveats: CAVEATS,
  }
}

export function strategyStats(): ServiceDef {
  return {
    key: 'strategy-stats',
    listing: {
      title: 'Prop-firm challenge pass probability and risk statistics from daily returns (block-bootstrap Monte Carlo, no LLM)',
      description:
        'Send {"daily_returns": [0.004, -0.002, ...]} - your strategy\'s daily results as fractions of the starting balance (20 to 5,000 trading days) - and get (1) the probability of passing a prop-firm style challenge before busting: target (default 0.10 = +10 %), max_loss (overall loss limit, default 0.10), daily_loss (single-day loss limit, default 0.05, 0 = off) within max_days trading days (default 42), with its sampling error, the split of busts by rule, the days to target (median, p25, p75), the distribution of the terminal return and of the worst drawdown per path; (2) the risk statistics of the series: mean and standard deviation per day, annualized return and volatility, Sharpe, Sortino, max drawdown, VaR 99 and CVaR 95 as loss magnitudes, best and worst day, share of positive days, lag-1 autocorrelation, skewness, excess kurtosis and a bootstrap p-value for "mean > 0". Optional scale multiplies every return (position size; statistics and challenge both use the scaled returns), simulations (100-50,000, default 10,000), block_length (mean length of the resampled blocks, default 5; 1 = i.i.d.; may exceed the number of days, the walk wraps around), seed (default 0; same input and seed give the identical output), trading_days_per_year (default 252). Returns are added, not compounded, the way prop-firm rules count closed P&L. Method: stationary block bootstrap, taken from a prop-firm research lab that found on its own series that i.i.d. resampling understated the bust risk; which way it goes for yours depends on the autocorrelation the output reports, and block_length 1 gives the i.i.d. figure for comparison. Statistics of the numbers you send, not a forecast, not advice. Deterministic, no LLM, no data of ours. Operated by Agent Souk (first_party).',
      category: 'data',
      tags: ['trading', 'backtest', 'monte-carlo', 'prop-firm', 'risk', 'deterministic'],
      price: 10_000,
      input_schema: {
        type: 'object',
        required: ['daily_returns'],
        properties: {
          daily_returns: { type: 'array', minItems: MIN_DAYS, maxItems: MAX_DAYS_INPUT, items: { type: 'number', minimum: -1, maximum: 1 }, description: 'Daily results as fractions of the starting balance, in order (0.004 = +0.4 %)' },
          scale: { type: 'number', minimum: 0.001, maximum: MAX_SCALE, default: 1, description: 'Multiplies every return (position size)' },
          target: { type: 'number', minimum: 0.0001, maximum: 5, default: 0.1, description: 'Profit target, fraction of the starting balance' },
          max_loss: { type: 'number', minimum: 0.0001, maximum: 1, default: 0.1, description: 'Overall loss limit (cumulative at or below -max_loss busts)' },
          daily_loss: { type: 'number', minimum: 0, maximum: 1, default: 0.05, description: 'Single-day loss limit (a day at or below -daily_loss busts); 0 = off' },
          max_days: { type: 'integer', minimum: 1, maximum: MAX_HORIZON, default: DEFAULT_HORIZON, description: 'Trading days the challenge may take' },
          simulations: { type: 'integer', minimum: MIN_SIMULATIONS, maximum: MAX_SIMULATIONS, default: DEFAULT_SIMULATIONS },
          block_length: { type: 'number', minimum: 1, maximum: MAX_BLOCK_LENGTH, default: DEFAULT_BLOCK_LENGTH, description: 'Mean block length; 1 = i.i.d.; may exceed the number of days' },
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
            description: 'of the scaled returns; every figure rounded to six significant digits',
            properties: {
              days: { type: 'integer' },
              mean_daily: { type: 'number' },
              std_daily: { type: 'number', description: 'population standard deviation' },
              cumulative_return: { type: 'number' },
              annualized_return: { type: 'number', description: 'mean_daily × trading_days_per_year' },
              annualized_volatility: { type: 'number' },
              sharpe: { type: ['number', 'null'], description: 'risk-free rate 0; null without variance' },
              sortino: { type: ['number', 'null'], description: 'null without a losing day' },
              max_drawdown: { type: 'number', description: 'peak-to-trough of the added returns' },
              var_99: { type: 'number', description: 'loss at the 1 % quantile of a day; 0 when it is a gain' },
              cvar_95: { type: 'number', description: 'mean loss of the worst 5 % of days; 0 when they are gains' },
              worst_day: { type: 'number' },
              best_day: { type: 'number' },
              positive_days_ratio: { type: 'number' },
              autocorr_lag1: { type: ['number', 'null'] },
              skewness: { type: ['number', 'null'] },
              excess_kurtosis: { type: ['number', 'null'] },
              p_value_mean_gt_zero: { type: 'number', description: '(k + 1) / (B + 1), B = 2,000 i.i.d. resamples, k means at or below zero' },
            },
          },
          challenge: {
            type: 'object',
            properties: {
              pass_probability: { type: 'number' },
              bust_probability: { type: 'number' },
              undecided_probability: { type: 'number', description: 'neither target nor a rule within max_days' },
              standard_error: { type: 'object', description: 'sampling error sqrt(p (1 - p) / simulations)', properties: { pass_probability: { type: 'number' }, bust_probability: { type: 'number' } } },
              bust_by: { type: 'object', description: 'a day breaking both rules counts under daily_loss', properties: { daily_loss: { type: 'number' }, max_loss: { type: 'number' } } },
              days_to_target: { type: ['object', 'null'], properties: { median: { type: 'number' }, p25: { type: 'number' }, p75: { type: 'number' } }, description: 'trading days until the target over the passing paths; null when none passed' },
              terminal_return: { type: 'object', description: 'cumulative return where each path stopped', properties: { p5: { type: 'number' }, p25: { type: 'number' }, p50: { type: 'number' }, p75: { type: 'number' }, p95: { type: 'number' } } },
              path_max_drawdown: { type: 'object', properties: { p50: { type: 'number' }, p95: { type: 'number' } } },
              simulations: { type: 'integer' },
              block_length: { type: 'number' },
              seed: { type: 'integer' },
            },
          },
          method: { type: 'string' },
          caveats: { type: 'array', items: { type: 'string' } },
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
      const out = await analyse(parsed)
      const c = out.challenge
      const pct = (x: number) => `${(x * 100).toFixed(1)} %`
      return {
        output: out,
        preview: { days: out.stats.days, pass_probability: c.pass_probability, bust_probability: c.bust_probability, undecided_probability: c.undecided_probability, days_to_target_median: c.days_to_target?.median ?? null, sharpe: out.stats.sharpe, max_drawdown: out.stats.max_drawdown, worst_day: out.stats.worst_day, simulations: c.simulations, block_length: c.block_length, seed: c.seed },
        message: `${out.stats.days} days${parsed.scale !== 1 ? ` at scale ${parsed.scale}` : ''}: pass ${pct(c.pass_probability)}, bust ${pct(c.bust_probability)} (daily rule ${pct(c.bust_by.daily_loss)}, overall ${pct(c.bust_by.max_loss)}), undecided ${pct(c.undecided_probability)} within ${parsed.max_days} trading days (±${pct(c.standard_error.pass_probability)} sampling error); ${c.days_to_target ? `median ${c.days_to_target.median} days to target; ` : ''}Sharpe ${out.stats.sharpe ?? 'n/a'}, max drawdown ${pct(out.stats.max_drawdown)}. ${c.simulations.toLocaleString('en-US')} paths, block length ${c.block_length}, seed ${c.seed}.`,
      }
    },
  }
}

/**
 * 40 trading days of a fictitious, mildly profitable, fat-tailed strategy: what the listing shows. The example
 * input scales it by 3, which is where the daily-loss rule starts to bite (the -2.33 % day becomes -7 %). Kept
 * short on purpose: the whole listing travels base64-encoded in one PAYMENT-REQUIRED header, and Node clients
 * stop reading response headers at 16 KB.
 */
export const EXAMPLE_RETURNS: number[] = [
  0.0042, -0.0018, 0.0031, 0.0007, -0.0125, 0.0058, 0.0021, -0.0033, 0.0089, -0.0006, 0.0014, 0.0037, -0.0071, 0.0052, 0.0009, -0.0022, 0.0066, 0.0018, -0.0154, 0.0047, 0.0029, -0.0011, 0.0073, 0.0003, -0.0041, 0.0038, 0.0016, -0.0088, 0.0061, 0.0024, -0.0019, 0.0045, 0.0012, -0.0233, 0.0079, 0.0033, -0.0008, 0.0056, 0.0021, -0.0047,
]

/** produced by analyse(parseInput(example_input)) with the seed 0; the test checks it stays true */
export const EXAMPLE_OUTPUT: StrategyOutput = {
  input_summary: { days: 40, scale: 3, target: 0.1, max_loss: 0.1, daily_loss: 0.05, max_days: 42, simulations: 10000, block_length: 5, seed: 0, trading_days_per_year: 252 },
  stats: { days: 40, mean_daily: 0.0007875, std_daily: 0.01918, cumulative_return: 0.0315, annualized_return: 0.19845, annualized_volatility: 0.304474, sharpe: 0.651781, sortino: 0.784758, max_drawdown: 0.0699, var_99: 0.060657, cvar_95: 0.05805, worst_day: -0.0699, best_day: 0.0267, positive_days_ratio: 0.65, autocorr_lag1: -0.331302, skewness: -1.69243, excess_kurtosis: 3.34271, p_value_mean_gt_zero: 0.368816 },
  challenge: { pass_probability: 0.1937, bust_probability: 0.6357, undecided_probability: 0.1706, standard_error: { pass_probability: 0.00395197, bust_probability: 0.00481233 }, bust_by: { daily_loss: 0.6321, max_loss: 0.0036 }, days_to_target: { median: 28, p25: 21, p75: 35 }, terminal_return: { p5: -0.078, p25: -0.0525, p50: -0.0168, p75: 0.0615, p95: 0.108 }, path_max_drawdown: { p50: 0.0699, p95: 0.1038 }, simulations: 10000, block_length: 5, seed: 0 },
  method: METHOD,
  caveats: CAVEATS,
}
