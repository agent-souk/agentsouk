import { describe, it, expect } from 'vitest'
import { analyse, EXAMPLE_OUTPUT, EXAMPLE_RETURNS, maxDrawdown, MAX_HORIZON, MAX_SIMULATIONS, parseInput, quantile, Rng, seriesStats, simulateChallenge, strategyStats, type StrategyInput } from './strategy-stats.js'

const base = (over: Partial<StrategyInput> = {}): StrategyInput => ({ daily_returns: EXAMPLE_RETURNS, scale: 1, target: 0.1, max_loss: 0.1, daily_loss: 0.05, max_days: 42, simulations: 2000, block_length: 5, seed: 0, trading_days_per_year: 252, ...over })

describe('Rng', () => {
  it('is deterministic per seed and differs between seeds', () => {
    const a = new Rng(7)
    const b = new Rng(7)
    const c = new Rng(8)
    const xs = Array.from({ length: 5 }, () => a.next32())
    expect(Array.from({ length: 5 }, () => b.next32())).toEqual(xs)
    expect(Array.from({ length: 5 }, () => c.next32())).not.toEqual(xs)
    for (let i = 0; i < 10_000; i++) {
      const f = a.float()
      expect(f).toBeGreaterThanOrEqual(0)
      expect(f).toBeLessThan(1)
      const k = a.int(7)
      expect(k).toBeGreaterThanOrEqual(0)
      expect(k).toBeLessThan(7)
    }
  })
  it('seed 0 is not a dead state', () => {
    const r = new Rng(0)
    const xs = Array.from({ length: 4 }, () => r.next32())
    expect(new Set(xs).size).toBe(4)
  })
})

describe('statistics', () => {
  it('quantile interpolates linearly like numpy', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5)
    expect(quantile([1, 2, 3, 4], 0)).toBe(1)
    expect(quantile([1, 2, 3, 4], 1)).toBe(4)
    expect(quantile([10, 20, 30], 0.25)).toBe(15)
    expect(quantile([5], 0.9)).toBe(5)
  })
  it('max drawdown is peak-to-trough on the added returns, and a first loss counts', () => {
    expect(maxDrawdown([0.1, -0.05, -0.05, 0.2])).toBeCloseTo(0.1, 12)
    expect(maxDrawdown([-0.03, 0.01])).toBeCloseTo(0.03, 12)
    expect(maxDrawdown([0.01, 0.02])).toBe(0)
  })
  it('computes the series statistics with population std, rf 0 and the stated annualisation', () => {
    const r = [0.01, -0.01, 0.02, 0.0, 0.01, -0.02, 0.03, 0.01, -0.01, 0.0, 0.01, 0.02, -0.03, 0.01, 0.0, 0.01, 0.02, -0.01, 0.01, 0.0]
    const n = r.length
    const mean = r.reduce((a, b) => a + b, 0) / n
    const std = Math.sqrt(r.reduce((a, b) => a + (b - mean) ** 2, 0) / n)
    const s = seriesStats(r, 252, new Rng(1), 200)
    expect(s.days).toBe(n)
    // every figure is rounded to six significant digits
    expect(s.mean_daily).toBe(Number(mean.toPrecision(6)))
    expect(s.std_daily).toBe(Number(std.toPrecision(6)))
    expect(s.sharpe).toBe(Number(((mean / std) * Math.sqrt(252)).toPrecision(6)))
    expect(s.annualized_return).toBe(Number((mean * 252).toPrecision(6)))
    expect(s.max_drawdown).toBeCloseTo(0.03, 9) // the -0.03 day after a peak
    expect(s.worst_day).toBe(-0.03)
    expect(s.best_day).toBe(0.03)
    expect(s.positive_days_ratio).toBeCloseTo(11 / 20, 6)
    expect(s.var_99).toBeGreaterThan(0)
    expect(s.cvar_95).toBeGreaterThanOrEqual(s.var_99 * 0) // defined
    expect(s.p_value_mean_gt_zero).toBeGreaterThanOrEqual(0)
    expect(s.p_value_mean_gt_zero).toBeLessThanOrEqual(1)
    expect(s.autocorr_lag1).not.toBeNull()
  })
  it('a constant series has zero variance: sharpe/sortino 0, no skew, p-value 0 or 1', () => {
    const s = seriesStats(new Array(30).fill(0.001), 252, new Rng(1), 50)
    expect(s.sharpe).toBe(0)
    expect(s.sortino).toBe(0)
    expect(s.skewness).toBeNull()
    expect(s.autocorr_lag1).toBeNull()
    expect(s.p_value_mean_gt_zero).toBe(0)
    const z = seriesStats(new Array(30).fill(-0.001), 252, new Rng(1), 50)
    expect(z.p_value_mean_gt_zero).toBe(1)
  })
})

describe('simulateChallenge', () => {
  const p = (over: Partial<StrategyInput> = {}) => {
    const { daily_returns: _d, ...rest } = base(over)
    return rest
  }
  it('always passes on a steadily profitable series, and counts days to target 1-based', async () => {
    const r = new Array(30).fill(0.005)
    const c = await simulateChallenge(r, p({ target: 0.1, simulations: 500 }), new Rng(1))
    expect(c.pass_probability).toBe(1)
    expect(c.bust_probability).toBe(0)
    expect(c.undecided_probability).toBe(0)
    expect(c.days_to_target).toEqual({ median: 20, p25: 20, p75: 20 })
    expect(c.terminal_return.p50).toBeCloseTo(0.1, 9)
    expect(c.path_max_drawdown.p95).toBe(0)
  })
  it('always busts on the overall limit on a steadily losing series, on the day the limit is reached', async () => {
    const r = new Array(30).fill(-0.006)
    const c = await simulateChallenge(r, p({ max_loss: 0.1, daily_loss: 0.05, simulations: 500 }), new Rng(1))
    expect(c.bust_probability).toBe(1)
    expect(c.bust_by).toEqual({ daily_loss: 0, max_loss: 1 })
    expect(c.days_to_target).toBeNull()
    expect(c.terminal_return.p50).toBeCloseTo(-0.102, 9) // 17 days × -0.006
    expect(c.path_max_drawdown.p50).toBeCloseTo(0.102, 9)
  })
  it('the daily rule is an instant stop and is off at 0', async () => {
    // a series that loses 6 % on one day out of 30 and otherwise gains 1 %; the overall limit is out of reach (50 %),
    // so with the daily rule at 5 % a path busts exactly when it draws that day, and never with the rule off
    const r = [...new Array(29).fill(0.01), -0.06]
    const on = await simulateChallenge(r, p({ daily_loss: 0.05, max_loss: 0.5, target: 5, simulations: 2000, block_length: 1 }), new Rng(3))
    expect(on.bust_by.daily_loss).toBeGreaterThan(0.5) // 1 - (29/30)^42 ≈ 0.76
    expect(on.bust_by.max_loss).toBe(0)
    const off = await simulateChallenge(r, p({ daily_loss: 0, max_loss: 0.5, target: 5, simulations: 2000, block_length: 1 }), new Rng(3))
    expect(off.bust_probability).toBe(0)
    expect(off.undecided_probability).toBe(1)
  })
  it('undecided paths are those that neither pass nor bust inside the window', async () => {
    const c = await simulateChallenge(new Array(40).fill(0.001), p({ target: 0.1, max_days: 10, simulations: 300 }), new Rng(1))
    expect(c.undecided_probability).toBe(1)
    expect(c.terminal_return.p50).toBeCloseTo(0.01, 9)
  })
  it('a block length of 1 resamples i.i.d. and a long block preserves runs', async () => {
    // alternating +1 % / -1 %: i.i.d. paths mix freely, long blocks keep the alternation, so drawdowns stay tiny
    const r = Array.from({ length: 40 }, (_, i) => (i % 2 ? -0.01 : 0.01))
    const iid = await simulateChallenge(r, p({ block_length: 1, target: 5, max_loss: 5, daily_loss: 0, simulations: 3000, max_days: 40 }), new Rng(5))
    const blk = await simulateChallenge(r, p({ block_length: 100, target: 5, max_loss: 5, daily_loss: 0, simulations: 3000, max_days: 40 }), new Rng(5))
    expect(blk.path_max_drawdown.p95).toBeLessThan(iid.path_max_drawdown.p95)
    expect(blk.path_max_drawdown.p95).toBeLessThanOrEqual(0.02 + 1e-9)
  })
  it('probabilities add up and quantiles are ordered', async () => {
    const c = await simulateChallenge(EXAMPLE_RETURNS.map((x) => x * 3), p({ scale: 3, simulations: 3000 }), new Rng(11))
    expect(c.pass_probability + c.bust_probability + c.undecided_probability).toBeCloseTo(1, 5)
    expect(c.bust_by.daily_loss + c.bust_by.max_loss).toBeCloseTo(c.bust_probability, 5)
    const t = c.terminal_return
    expect(t.p5).toBeLessThanOrEqual(t.p25)
    expect(t.p25).toBeLessThanOrEqual(t.p50)
    expect(t.p50).toBeLessThanOrEqual(t.p75)
    expect(t.p75).toBeLessThanOrEqual(t.p95)
    expect(c.path_max_drawdown.p50).toBeLessThanOrEqual(c.path_max_drawdown.p95)
  })
})

describe('parseInput', () => {
  it('declines what it cannot compute on, before anything is accepted', () => {
    expect(parseInput({})).toMatch(/daily_returns must be an array/)
    expect(parseInput({ daily_returns: [0.01] })).toMatch(/at least 20/)
    expect(parseInput({ daily_returns: new Array(5001).fill(0.001) })).toMatch(/at most 5000/)
    expect(parseInput({ daily_returns: [...new Array(19).fill(0.001), 'x'] })).toMatch(/\[19\] is not a finite number/)
    expect(parseInput({ daily_returns: [...new Array(19).fill(0.001), Number.NaN] })).toMatch(/\[19\]/)
    expect(parseInput({ daily_returns: [...new Array(19).fill(0.001), 1.5] })).toMatch(/between -1 and 1/)
    expect(parseInput({ daily_returns: new Array(20).fill(0.001), simulations: 99 })).toMatch(/simulations must be between/)
    expect(parseInput({ daily_returns: new Array(20).fill(0.001), simulations: 1000.5 })).toMatch(/integer/)
    expect(parseInput({ daily_returns: new Array(20).fill(0.001), simulations: MAX_SIMULATIONS + 1 })).toMatch(/simulations/)
    expect(parseInput({ daily_returns: new Array(20).fill(0.001), max_days: MAX_HORIZON + 1 })).toMatch(/max_days/)
    expect(parseInput({ daily_returns: new Array(20).fill(0.001), max_days: 0 })).toMatch(/max_days/)
    expect(parseInput({ daily_returns: new Array(20).fill(0.001), target: 0 })).toMatch(/target/)
    expect(parseInput({ daily_returns: new Array(20).fill(0.001), daily_loss: -0.1 })).toMatch(/daily_loss/)
    expect(parseInput({ daily_returns: new Array(20).fill(0.001), block_length: 21 })).toMatch(/block_length 21 is longer/)
    expect(parseInput({ daily_returns: new Array(20).fill(0.001), seed: -1 })).toMatch(/seed/)
    expect(parseInput({ daily_returns: new Array(20).fill(0.001), seed: 1e12 })).toMatch(/seed/)
    expect(parseInput({ daily_returns: new Array(20).fill(0.001), scale: '2' })).toMatch(/scale must be a number/)
    expect(parseInput({ daily_returns: new Array(20).fill(0.001), trading_days_per_year: 0 })).toMatch(/trading_days_per_year/)
  })
  it('fills the documented defaults', () => {
    const p = parseInput({ daily_returns: new Array(20).fill(0.001) })
    expect(p).toMatchObject({ scale: 1, target: 0.1, max_loss: 0.1, daily_loss: 0.05, max_days: 42, simulations: 10000, block_length: 5, seed: 0, trading_days_per_year: 252 })
  })
})

describe('strategyStats service', () => {
  const svc = strategyStats({ now: () => Date.parse('2026-09-16T00:00:00.000Z') })
  it('validate mirrors parseInput', async () => {
    expect(await svc.validate({}, { units: 1 })).toMatch(/daily_returns/)
    expect(await svc.validate({ daily_returns: EXAMPLE_RETURNS }, { units: 1 })).toBeNull()
  })
  it('is deterministic for the same input and seed, and the example output in the listing is what it computes', async () => {
    const input = svc.listing.example_input as Record<string, unknown>
    const a = await svc.run(input, { units: 1 })
    const b = await svc.run(input, { units: 1 })
    expect(a.output).toEqual(b.output)
    const out = a.output as typeof EXAMPLE_OUTPUT
    expect(out.stats).toEqual(EXAMPLE_OUTPUT.stats)
    expect(out.challenge).toEqual(EXAMPLE_OUTPUT.challenge)
    expect(out.input_summary).toEqual(EXAMPLE_OUTPUT.input_summary)
    expect(out.method).toBe(EXAMPLE_OUTPUT.method)
    expect(out.caveats).toEqual(EXAMPLE_OUTPUT.caveats)
    expect(out.computed_at).toBe('2026-09-16T00:00:00.000Z')
    expect(a.message).toMatch(/pass \d+\.\d %/)
    expect(JSON.stringify(a.preview).length).toBeLessThan(1000)
    expect(JSON.stringify(a.output).length).toBeLessThan(8000)
  })
  it('a different seed gives a different simulation but the same statistics except the p-value', async () => {
    const a = await analyse(base({ seed: 1, simulations: 1000 }))
    const b = await analyse(base({ seed: 2, simulations: 1000 }))
    expect(a.challenge.terminal_return).not.toEqual(b.challenge.terminal_return)
    const { p_value_mean_gt_zero: pa, ...sa } = a.stats
    const { p_value_mean_gt_zero: pb, ...sb } = b.stats
    expect(sa).toEqual(sb)
    expect(typeof pa).toBe('number')
    expect(typeof pb).toBe('number')
  })
  it('the largest allowed job finishes in seconds and keeps the event loop turning', async () => {
    const r = Array.from({ length: 5000 }, (_, i) => Math.sin(i / 7) * 0.02)
    let ticks = 0
    const timer = setInterval(() => ticks++, 5)
    const started = Date.now()
    const out = await analyse({ ...base({ daily_returns: r, simulations: MAX_SIMULATIONS, max_days: MAX_HORIZON, block_length: 250 }) })
    const ms = Date.now() - started
    clearInterval(timer)
    expect(out.challenge.simulations).toBe(MAX_SIMULATIONS)
    expect(ms).toBeLessThan(20_000)
    // the simulation releases the loop every 1,000 paths; a 5 ms timer must have run several times meanwhile
    expect(ticks).toBeGreaterThan(2)
  }, 30_000)
})
