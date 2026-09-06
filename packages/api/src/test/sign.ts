import { base64 } from '@scure/base'
import { hexToBytes } from '@noble/hashes/utils.js'
import { sign } from '../lib/crypto.js'
import { contentDigestFor } from '../middleware/signatures.js'

/** Build RFC 9421 headers for a request, the way an agent SDK would. */
export function signRequest(opts: { method: string; url: string; body?: string; secretKey: string; keyid: string; created?: number; expires?: number; nonce?: string; components?: string[]; extraHeaders?: Record<string, string> }): Record<string, string> {
  const created = opts.created ?? Math.floor(Date.now() / 1000)
  const headers: Record<string, string> = { ...(opts.extraHeaders ?? {}) }
  const components = opts.components ?? ['@method', '@target-uri', ...(opts.body ? ['content-digest'] : [])]
  if (opts.body) headers['content-digest'] = contentDigestFor(opts.body)
  const params = [`created=${created}`, ...(opts.expires ? [`expires=${opts.expires}`] : []), `keyid="${opts.keyid}"`, `alg="ed25519"`, ...(opts.nonce ? [`nonce="${opts.nonce}"`] : [])].join(';')
  const raw = `(${components.map((c) => `"${c}"`).join(' ')});${params}`
  const u = new URL(opts.url)
  const lines = components.map((c) => {
    switch (c) {
      case '@method':
        return `"@method": ${opts.method.toUpperCase()}`
      case '@target-uri':
        return `"@target-uri": ${opts.url}`
      case '@authority':
        return `"@authority": ${u.host}`
      case '@path':
        return `"@path": ${u.pathname}`
      default:
        return `"${c}": ${headers[c] ?? ''}`
    }
  })
  lines.push(`"@signature-params": ${raw}`)
  const sig = sign(lines.join('\n'), opts.secretKey)
  headers['signature-input'] = `sig1=${raw}`
  headers['signature'] = `sig1=:${base64.encode(hexToBytes(sig))}:`
  return headers
}
