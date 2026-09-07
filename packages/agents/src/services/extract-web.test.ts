import { describe, it, expect } from 'vitest'
import { extractWeb } from './extract-web.js'

const page = `<html lang="en"><head><title>Example Domain</title><meta property="og:description" content="Illustrative"></head><body><main><h1>Example Domain</h1><p>This domain is for use in illustrative examples.</p><p>${'It is documented in RFC 2606 and may be used freely. '.repeat(4)}</p><p><a href="https://www.iana.org/domains/example">More information...</a></p></main><script>x()</script></body></html>`
const fetchImpl: typeof fetch = (async (input: string | URL | Request) => {
  const url = String(input)
  if (url === 'http://93.184.216.34/') return new Response(page, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
  if (url === 'http://93.184.216.34/data.json') return new Response('{"a":1,"b":[1,2]}', { status: 200, headers: { 'content-type': 'application/json' } })
  if (url === 'http://93.184.216.34/missing') return new Response('<html><body><p>gone</p></body></html>', { status: 404, headers: { 'content-type': 'text/html' } })
  return new Response('nope', { status: 500 })
}) as typeof fetch

describe('extract-web service', () => {
  const svc = extractWeb({ fetchImpl })
  it('validates input before accepting', () => {
    expect(svc.validate({})).toMatch(/url/)
    expect(svc.validate({ url: 'ftp://x' })).toMatch(/http/)
    expect(svc.validate({ url: 'http://93.184.216.34/', max_chars: 5 })).toMatch(/max_chars/)
    expect(svc.validate({ url: 'http://93.184.216.34/' })).toBeNull()
  })
  it('extracts title, description, text and links from HTML', async () => {
    const r = await svc.run({ url: 'http://93.184.216.34/' })
    const out = r.output as Record<string, unknown>
    expect(out).toMatchObject({ final_url: 'http://93.184.216.34/', http_status: 200, title: 'Example Domain', description: 'Illustrative', lang: 'en', clipped: false, redirects: 0 })
    expect(out.text).toContain('This domain is for use in illustrative examples.')
    expect(out.text).not.toContain('x()')
    expect(out.links).toEqual([{ href: 'https://www.iana.org/domains/example', text: 'More information...' }])
    expect(r.preview).toMatchObject({ title: 'Example Domain', links: 1 })
    expect(r.message).toMatch(/Extracted \d+ words/)
  })
  it('pretty-prints JSON, clips long text, and passes error pages through with a note', async () => {
    const j = await svc.run({ url: 'http://93.184.216.34/data.json' })
    expect((j.output as { text: string }).text).toBe('{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}')
    const clipped = await svc.run({ url: 'http://93.184.216.34/', max_chars: 100 })
    expect((clipped.output as { clipped: boolean; text_chars: number }).clipped).toBe(true)
    expect((clipped.output as { text_chars: number }).text_chars).toBe(100)
    const missing = await svc.run({ url: 'http://93.184.216.34/missing' })
    expect((missing.output as { http_status: number }).http_status).toBe(404)
    expect(missing.message).toContain('HTTP 404')
  })
  it('refuses private targets at run time even if validate passed the shape', async () => {
    await expect(svc.run({ url: 'http://127.0.0.1:8787/health' })).rejects.toThrow(/refused/)
  })
})
