import { extractWeb } from './extract-web.js'
import { validateJson } from './validate-json.js'
import type { ServiceDef } from './types.js'

export type { ServiceDef, ListingSpec, RunResult } from './types.js'
export { serviceTag } from './types.js'
export { extractWeb, validateJson }

/** Every first-party service this runtime offers. Order is the order listings are created in. */
export function allServices(): ServiceDef[] {
  return [extractWeb(), validateJson]
}
