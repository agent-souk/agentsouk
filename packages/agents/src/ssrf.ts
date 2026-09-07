/**
 * Safe outbound fetch for a service that fetches URLs on behalf of strangers: no private networks, no odd schemes,
 * bounded size and time, redirects re-checked hop by hop.
 */
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsafeUrlError'
  }
}

const BLOCKED_HOSTS = new Set(['localhost', 'metadata.google.internal', 'metadata', 'instance-data'])

function ipv4Private(ip: string): boolean {
  const p = ip.split('.').map(Number)
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b] = p
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && p[2] === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224
}

function ipv6Private(ip: string): boolean {
  const s = ip.toLowerCase().replace(/^\[|\]$/g, '')
  if (s === '::' || s === '::1') return true
  if (s.startsWith('::ffff:')) {
    const v4 = s.slice(7)
    return isIP(v4) === 4 ? ipv4Private(v4) : true
  }
  const first = parseInt(s.split(':')[0] || '0', 16)
  if ((first & 0xfe00) === 0xfc00) return true // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true // fe80::/10 link local
  if ((first & 0xff00) === 0xff00) return true // multicast
  if (first === 0x2001 && (s.split(':')[1] || '') === 'db8') return true
  return false
}

export function isPrivateIp(ip: string): boolean {
  const v = isIP(ip)
  if (v === 4) return ipv4Private(ip)
  if (v === 6) return ipv6Private(ip)
  return true
}

export async function assertPublicUrl(raw: string): Promise<URL> {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new UnsafeUrlError('url is not a valid absolute URL')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new UnsafeUrlError('only http and https URLs are fetched')
  if (u.username || u.password) throw new UnsafeUrlError('URLs with credentials are not fetched')
  const host = u.hostname.toLowerCase().replace(/\.$/, '')
  if (!host || BLOCKED_HOSTS.has(host) || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.arpa')) throw new UnsafeUrlError('private or local hosts are not fetched')
  if (u.port && !['80', '443', '8080', '8443', ''].includes(u.port)) throw new UnsafeUrlError('only ports 80, 443, 8080 and 8443 are fetched')
  const literal = host.replace(/^\[|\]$/g, '')
  if (isIP(literal)) {
    if (isPrivateIp(literal)) throw new UnsafeUrlError('private network addresses are not fetched')
    return u
  }
  let addrs: { address: string }[]
  try {
    addrs = await lookup(host, { all: true, verbatim: true })
  } catch {
    throw new UnsafeUrlError(`could not resolve host ${host}`)
  }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new UnsafeUrlError('host resolves to a private network address')
  return u
}

export type SafeFetchResult = { url: string; finalUrl: string; status: number; contentType: string; body: string; truncated: boolean; redirects: number }

export type SafeFetchOptions = { timeoutMs?: number; maxBytes?: number; maxRedirects?: number; fetchImpl?: typeof fetch; userAgent?: string }

export async function safeFetch(raw: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const timeoutMs = opts.timeoutMs ?? 15_000
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024
  const maxRedirects = opts.maxRedirects ?? 5
  const fetchImpl = opts.fetchImpl ?? fetch
  const deadline = Date.now() + timeoutMs
  let current = await assertPublicUrl(raw)
  let redirects = 0
  for (;;) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()))
    let res: Response
    try {
      res = await fetchImpl(current.toString(), { redirect: 'manual', signal: controller.signal, headers: { 'user-agent': opts.userAgent ?? 'agentsouk-extract-web/1.0 (+https://api.agentsouk.dev)', accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5', 'accept-language': 'en, *;q=0.5' } })
    } catch (e) {
      clearTimeout(timer)
      throw new Error(controller.signal.aborted ? `fetch timed out after ${timeoutMs} ms` : `fetch failed: ${(e as Error).message}`)
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      clearTimeout(timer)
      await res.body?.cancel().catch(() => undefined)
      if (++redirects > maxRedirects) throw new Error(`too many redirects (> ${maxRedirects})`)
      current = await assertPublicUrl(new URL(res.headers.get('location')!, current).toString())
      continue
    }
    const contentType = (res.headers.get('content-type') ?? '').toLowerCase()
    const chunks: Uint8Array[] = []
    let size = 0
    let truncated = false
    if (res.body) {
      const reader = res.body.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (!value) continue
          if (size + value.byteLength > maxBytes) {
            chunks.push(value.subarray(0, maxBytes - size))
            size = maxBytes
            truncated = true
            await reader.cancel().catch(() => undefined)
            break
          }
          chunks.push(value)
          size += value.byteLength
        }
      } finally {
        clearTimeout(timer)
      }
    } else clearTimeout(timer)
    const merged = new Uint8Array(size)
    let off = 0
    for (const c of chunks) {
      merged.set(c, off)
      off += c.byteLength
    }
    const charset = contentType.match(/charset=([\w-]+)/)?.[1]
    let body: string
    try {
      body = new TextDecoder(charset ?? 'utf-8', { fatal: false }).decode(merged)
    } catch {
      body = new TextDecoder('utf-8').decode(merged)
    }
    return { url: raw, finalUrl: current.toString(), status: res.status, contentType, body, truncated, redirects }
  }
}
