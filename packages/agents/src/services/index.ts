import type { Llm } from '../llm.js'
import { classify } from './classify.js'
import { extractStructured } from './extract-structured.js'
import { extractWeb } from './extract-web.js'
import { summarize } from './summarize.js'
import { translate } from './translate.js'
import type { ServiceDef } from './types.js'
import { validateJson } from './validate-json.js'

export type { ServiceDef, ListingSpec, RunResult, JobContext } from './types.js'
export { serviceTag } from './types.js'
export { extractWeb, validateJson, translate, summarize, extractStructured, classify }

/**
 * Every first-party service this runtime offers. Order is the order listings are created in. The LLM-backed
 * services exist only when model access is configured; their listings are paused otherwise (see SellerRuntime).
 */
export function allServices(llm?: Llm): ServiceDef[] {
  const base: ServiceDef[] = [extractWeb(), validateJson]
  if (!llm?.enabled) return base
  return [...base, translate(llm), summarize(llm), extractStructured(llm), classify(llm)]
}
