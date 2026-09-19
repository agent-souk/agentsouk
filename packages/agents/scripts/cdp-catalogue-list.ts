/**
 * Welche unserer Dienste führt Coinbases x402-Bazaar? (ADR-78)
 *
 * Der Katalog ist der einzige Kanal, über den je ein Fremder zu uns gefunden hat: 52 von 52 Fremdkäufen liefen
 * auf katalogisierte Listings, keiner auf ein nicht katalogisiertes. Coinbase nimmt eine Ressource erst auf,
 * nachdem eine Zahlung dafür über den CDP-Facilitator abgewickelt wurde (siehe cdp-catalogue-settle-once.ts),
 * und lässt sie nach 30 Tagen ohne Abwicklung wieder fallen - dieser Lauf zeigt, was heute wirklich drinsteht.
 *
 *   cd packages/agents && npx tsx scripts/cdp-catalogue-list.ts
 *
 * Liest nur (GET /discovery/resources mit CDP-Schlüssel aus ~/.agentsouk-ops/cdp_api_key.json), bewegt nichts.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { cdpJwt } from '../src/operator/bazaar.js'

async function main() {
  const keyFile = join(homedir(), '.agentsouk-ops', 'cdp_api_key.json')
  if (!existsSync(keyFile)) throw new Error('kein CDP-Schluessel')
  const k = JSON.parse(readFileSync(keyFile, 'utf8')) as Record<string, string>
  const id = k.id ?? k.name ?? k.apiKeyId ?? ''
  const secret = k.privateKey ?? k.secret ?? k.apiKeySecret ?? ''
  let offset = 0
  let total = 0
  const ours: string[] = []
  for (let page = 0; page < 40; page++) {
    const path = `/platform/v2/x402/discovery/resources?limit=500&offset=${offset}`
    const jwt = cdpJwt({ keyId: id, keySecret: secret, method: 'GET', host: 'api.cdp.coinbase.com', path })
    const r = await fetch(`https://api.cdp.coinbase.com${path}`, { headers: { authorization: `Bearer ${jwt}` } })
    if (!r.ok) {
      console.log('http', r.status, (await r.text()).slice(0, 200))
      break
    }
    const d = (await r.json()) as { items?: unknown[]; resources?: unknown[]; data?: unknown[] }
    const items = (d.items ?? d.resources ?? d.data ?? []) as Record<string, unknown>[]
    total += items.length
    for (const it of items) {
      const s = JSON.stringify(it)
      if (s.includes('agentsouk')) ours.push(String(it.resource ?? '').split('/').pop() ?? '?')
    }
    if (items.length < 500) break
    offset += 500
  }
  console.log('Coinbase-Eintraege gelesen:', total, '| unsere:', ours.length)
  for (const o of ours) console.log('  ', o)
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
