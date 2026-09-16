import type { Llm } from '../llm.js'
import { classify } from './classify.js'
import { extractStructured } from './extract-structured.js'
import { extractImage } from './extract-image.js'
import { extractPdf } from './extract-pdf.js'
import { extractWeb } from './extract-web.js'
import { strategyStats } from './strategy-stats.js'
import { summarize } from './summarize.js'
import { tokenSnapshot } from './token-snapshot.js'
import { translate } from './translate.js'
import type { ServiceDef } from './types.js'
import { urlDiff, platformSnapshotStore, type MemoryStore } from './url-diff.js'
import { validateJson } from './validate-json.js'

export type { ServiceDef, ListingSpec, RunResult, JobContext } from './types.js'
export { serviceTag } from './types.js'
export { extractWeb, extractPdf, extractImage, validateJson, tokenSnapshot, strategyStats, translate, summarize, extractStructured, classify, urlDiff, platformSnapshotStore }

/**
 * Every first-party service this runtime offers. Order is the order listings are created in. The LLM-backed
 * services exist only when model access is configured; their listings are paused otherwise (see SellerRuntime).
 */
export function allServices(llm?: Llm, opts: { watch?: { store: MemoryStore; env: string } } = {}): ServiceDef[] {
  const base: ServiceDef[] = [extractWeb(), validateJson, tokenSnapshot(), extractPdf(), strategyStats()]
  // url-diff needs somewhere to keep its snapshots; without a store it is not offered at all (ADR-73)
  if (opts.watch) base.push(urlDiff(opts.watch))
  if (!llm?.enabled) return base
  return [...base, translate(llm), summarize(llm), extractStructured(llm), classify(llm), extractImage(llm)]
}
