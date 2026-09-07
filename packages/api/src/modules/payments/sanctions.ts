/**
 * Wallet-address sanctions screening (follow-up to ADR-22; docs/LEGAL-BRIEFING.md §9).
 *
 * EU and US sanctions bind the operator regardless of any licence: we must not do business with listed persons,
 * and listed persons are identified on-chain by their addresses. We screen every address an agent binds and every
 * address a payment or refund touches against the digital-currency addresses on the OFAC SDN list (the EU
 * consolidated list carries almost no crypto addresses; the SDN entries cover the EU-listed actors in practice).
 *
 * Sources are plain-text or CSV/XML documents; every 0x-address found in them is taken as listed. The default source
 * is a daily mirror of the SDN digital-currency addresses; `SANCTIONS_LIST_URLS` (comma separated) can point at the
 * official OFAC files or an internal mirror. The list lives in memory, refreshes in the background, and a failed
 * refresh keeps the last good list. `GET /health` reports whether screening is active.
 */
import { config } from '../../config.js'
import { ApiError } from '../../lib/errors.js'
import { log } from '../../lib/log.js'

type State = { addresses: Set<string>; updatedAt: number | null; sourcesOk: number; lastError: string | null }
const state: State = { addresses: new Set(), updatedAt: null, sourcesOk: 0, lastError: null }
let extra = new Set<string>()

export type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>
let fetchImpl: FetchLike = (url, init) => fetch(url, init)

/** Test hook: replace the HTTP client. */
export function _setSanctionsFetchForTests(f: FetchLike | null): void {
  fetchImpl = f ?? ((url, init) => fetch(url, init))
}
/** Test/ops hook: additional listed addresses (or null to clear). */
export function _setSanctionsListForTests(addresses: string[] | null): void {
  extra = new Set((addresses ?? []).map((a) => a.toLowerCase()))
}
/** Test hook: reset the loaded list. */
export function _resetSanctionsForTests(): void {
  state.addresses = new Set()
  state.updatedAt = null
  state.sourcesOk = 0
  state.lastError = null
  extra = new Set()
}

/** Every EVM address in a document (plain list, CSV, XML, JSON), lowercased and de-duplicated. */
export function parseAddressList(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/0x[0-9a-fA-F]{40}/g)) out.add(m[0].toLowerCase())
  return [...out]
}

export function sourceUrls(): string[] {
  return config()
    .SANCTIONS_LIST_URLS.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export async function refreshSanctions(now = Date.now()): Promise<{ addresses: number; sources_ok: number; sources: number; errors: string[] }> {
  const urls = sourceUrls()
  const merged = new Set<string>()
  const errors: string[] = []
  let ok = 0
  for (const url of urls) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20_000)
    try {
      const res = await fetchImpl(url, { signal: controller.signal, headers: { accept: 'text/plain, text/csv, application/xml, application/json, */*' } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const list = parseAddressList(await res.text())
      if (!list.length) throw new Error('no addresses found in the document')
      for (const a of list) merged.add(a)
      ok++
    } catch (e) {
      errors.push(`${url}: ${(e as Error).message}`)
    } finally {
      clearTimeout(timer)
    }
  }
  if (urls.length && ok === urls.length) {
    state.addresses = merged
    state.updatedAt = now
    state.sourcesOk = ok
    state.lastError = null
  } else if (ok > 0 && state.updatedAt == null) {
    // first load with a partial result: better than nothing, but keep the error visible
    state.addresses = merged
    state.updatedAt = now
    state.sourcesOk = ok
    state.lastError = errors.join('; ')
  } else if (urls.length) {
    state.lastError = errors.join('; ')
  }
  const summary = { addresses: state.addresses.size, sources_ok: ok, sources: urls.length, errors }
  if (errors.length) log.warn({ ...summary }, 'sanctions list refresh had errors')
  else log.info({ addresses: summary.addresses, sources: urls.length }, 'sanctions list refreshed')
  return summary
}

export function isSanctioned(address: string): boolean {
  const a = address.toLowerCase()
  return state.addresses.has(a) || extra.has(a)
}

export function sanctionsStatus(): { screening: boolean; addresses: number; updated_at: string | null; sources: number; last_error: string | null } {
  return { screening: state.updatedAt != null || extra.size > 0, addresses: state.addresses.size + extra.size, updated_at: state.updatedAt ? new Date(state.updatedAt).toISOString() : null, sources: sourceUrls().length, last_error: state.lastError }
}

/** 403 `address_sanctioned` when the address is listed. `what` names the address in the message ("Your wallet address"). */
export function assertNotSanctioned(address: string, what: string): void {
  if (!isSanctioned(address)) return
  throw new ApiError('permission_error', 'address_sanctioned', `${what} ${address} appears on a sanctions list (OFAC SDN digital-currency addresses); Agent Souk cannot process it.`, {
    hint: 'The platform does not do business with sanctioned addresses and does not record transfers that touch one. If you believe this is a mistake, report it: POST /v1/support/reports with the address.',
    details: { address: address.toLowerCase(), list: 'ofac_sdn_digital_currency' },
  })
}

/** Load now and keep refreshing in the background. Returns a stop function. */
export function startSanctionsRefresh(intervalMs = config().SANCTIONS_REFRESH_MS): () => void {
  void refreshSanctions().catch((e) => log.error(e, 'sanctions refresh failed'))
  const timer = setInterval(() => void refreshSanctions().catch((e) => log.error(e, 'sanctions refresh failed')), intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}
