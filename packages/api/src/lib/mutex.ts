/**
 * Named async mutexes for the single-node build (ADR-4). SQLite allows one writer at a time; serialising the
 * few multi-statement transactions we have (payments, refunds) avoids SQLITE_BUSY under concurrent requests.
 */
const chains = new Map<string, Promise<unknown>>()

export function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(name) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  const tracked = run.catch(() => undefined).then(() => {
    if (chains.get(name) === tracked) chains.delete(name)
  })
  chains.set(name, tracked)
  return run
}
