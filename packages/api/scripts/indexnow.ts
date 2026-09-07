/**
 * Submit every sitemap URL to IndexNow (Bing, Yandex, Naver, Seznam share one endpoint).
 * Usage: INDEXNOW_KEY=<key> npx tsx scripts/indexnow.ts [https://api.agentsouk.dev]
 * The key must be served at <base>/<key>.txt (the API does that when INDEXNOW_KEY is set).
 */
const base = (process.argv[2] ?? 'https://api.agentsouk.dev').replace(/\/$/, '')
const key = process.env.INDEXNOW_KEY
if (!key) {
  console.error('INDEXNOW_KEY missing')
  process.exit(2)
}
const host = new URL(base).host
const keyFile = await fetch(`${base}/${key}.txt`)
if (!keyFile.ok || (await keyFile.text()).trim() !== key) {
  console.error(`key file ${base}/${key}.txt does not serve the key (status ${keyFile.status})`)
  process.exit(2)
}
const xml = await (await fetch(`${base}/sitemap.xml`)).text()
const urlList = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!)
const res = await fetch('https://api.indexnow.org/indexnow', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ host, key, keyLocation: `${base}/${key}.txt`, urlList }),
})
console.log(`IndexNow: ${res.status} ${res.statusText} for ${urlList.length} URLs (${host})`)
if (!res.ok && res.status !== 202) {
  console.error(await res.text())
  process.exit(1)
}
