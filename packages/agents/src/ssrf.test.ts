import { describe, it, expect } from 'vitest'
import { assertPublicUrl, isPrivateIp, safeFetch, UnsafeUrlError } from './ssrf.js'

describe('isPrivateIp', () => {
  it('classifies the usual ranges', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '224.0.0.1', '::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1']) expect(isPrivateIp(ip), ip).toBe(true)
    for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700::1111', '::ffff:8.8.8.8']) expect(isPrivateIp(ip), ip).toBe(false)
  })
})

describe('assertPublicUrl', () => {
  it('rejects private, local and odd URLs without touching the network', async () => {
    for (const u of ['http://localhost/', 'http://127.0.0.1/', 'http://10.0.0.1/x', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data', 'ftp://example.com/', 'http://user:pw@93.184.216.34/', 'http://foo.internal/', 'http://93.184.216.34:22/', 'not a url', 'http://metadata.google.internal/']) {
      await expect(assertPublicUrl(u), u).rejects.toBeInstanceOf(UnsafeUrlError)
    }
  })
  it('accepts a public IP literal', async () => {
    const u = await assertPublicUrl('https://93.184.216.34/path?q=1')
    expect(u.hostname).toBe('93.184.216.34')
  })
})

function fakeFetch(routes: Record<string, { status: number; headers?: Record<string, string>; body?: string }>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const r = routes[url]
    if (!r) return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } })
    return new Response(r.body ?? '', { status: r.status, headers: r.headers ?? {} })
  }) as typeof fetch
}

describe('safeFetch', () => {
  it('follows redirects between public hosts and re-checks every hop', async () => {
    const f = fakeFetch({
      'http://93.184.216.34/a': { status: 302, headers: { location: '/b' } },
      'http://93.184.216.34/b': { status: 200, headers: { 'content-type': 'text/plain' }, body: 'hello' },
    })
    const r = await safeFetch('http://93.184.216.34/a', { fetchImpl: f })
    expect(r.body).toBe('hello')
    expect(r.finalUrl).toBe('http://93.184.216.34/b')
    expect(r.redirects).toBe(1)
  })
  it('refuses a redirect into a private network', async () => {
    const f = fakeFetch({ 'http://93.184.216.34/a': { status: 301, headers: { location: 'http://127.0.0.1:8787/admin' } } })
    await expect(safeFetch('http://93.184.216.34/a', { fetchImpl: f })).rejects.toBeInstanceOf(UnsafeUrlError)
  })
  it('stops after too many redirects', async () => {
    const f = fakeFetch({ 'http://93.184.216.34/loop': { status: 302, headers: { location: '/loop' } } })
    await expect(safeFetch('http://93.184.216.34/loop', { fetchImpl: f, maxRedirects: 3 })).rejects.toThrow(/too many redirects/)
  })
  it('caps the body size and reports truncation', async () => {
    const f = fakeFetch({ 'http://93.184.216.34/big': { status: 200, headers: { 'content-type': 'text/plain' }, body: 'y'.repeat(5000) } })
    const r = await safeFetch('http://93.184.216.34/big', { fetchImpl: f, maxBytes: 1000 })
    expect(r.truncated).toBe(true)
    expect(r.body.length).toBe(1000)
  })
  it('times out', async () => {
    const slow: typeof fetch = ((_: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as typeof fetch
    await expect(safeFetch('http://93.184.216.34/slow', { fetchImpl: slow, timeoutMs: 50 })).rejects.toThrow(/timed out/)
  })
})
