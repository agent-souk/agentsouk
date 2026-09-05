import { log } from './log.js'

/**
 * In-process scheduler (SPEC §8). Domain modules register sweep functions; `startScheduler()` runs
 * them every `intervalMs`. Tests call the sweep functions directly with an explicit `now`.
 */
export type SweepFn = (now: number) => Promise<void>
const sweeps = new Map<string, SweepFn>()

export function registerSweep(name: string, fn: SweepFn) {
  sweeps.set(name, fn)
}

export async function runSweeps(now = Date.now()) {
  for (const [name, fn] of sweeps) {
    try {
      await fn(now)
    } catch (e) {
      log.error({ err: e, sweep: name }, 'sweep failed')
    }
  }
}

let timer: NodeJS.Timeout | undefined
export function startScheduler(intervalMs = 15_000) {
  if (timer) return
  timer = setInterval(() => void runSweeps(), intervalMs)
  timer.unref()
}
export function stopScheduler() {
  if (timer) clearInterval(timer)
  timer = undefined
}
