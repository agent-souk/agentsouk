import { describe, it, expect } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import { Llm, MODEL } from '../llm.js'
import { extractImage, imageInfo, imageTokens, MAX_BYTES, MAX_OUTPUT_TOKENS } from './extract-image.js'

/* ---------- minimal files of the four formats ---------- */

function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(64)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  new DataView(b.buffer).setUint32(16, width)
  new DataView(b.buffer).setUint32(20, height)
  return b
}
function gif(width: number, height: number): Uint8Array {
  const b = new Uint8Array(32)
  b.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  new DataView(b.buffer).setUint16(6, width, true)
  new DataView(b.buffer).setUint16(8, height, true)
  return b
}
function jpeg(width: number, height: number, withFrame = true): Uint8Array {
  // SOI, an APP0 segment, then SOF0 with the dimensions
  const parts: number[] = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]
  if (withFrame) parts.push(0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1)
  parts.push(0xff, 0xd9)
  return new Uint8Array(parts)
}
function webpLossy(width: number, height: number): Uint8Array {
  const b = new Uint8Array(40)
  b.set([0x52, 0x49, 0x46, 0x46, 32, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20, 20, 0, 0, 0])
  b.set([0x9d, 0x01, 0x2a], 23)
  new DataView(b.buffer).setUint16(26, width, true)
  new DataView(b.buffer).setUint16(28, height, true)
  return b
}
function webpLossless(width: number, height: number): Uint8Array {
  const b = new Uint8Array(40)
  b.set([0x52, 0x49, 0x46, 0x46, 32, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4c, 20, 0, 0, 0, 0x2f])
  const bits = (width - 1) | ((height - 1) << 14)
  new DataView(b.buffer).setUint32(21, bits >>> 0, true)
  return b
}
function webpExtended(width: number, height: number): Uint8Array {
  const b = new Uint8Array(40)
  b.set([0x52, 0x49, 0x46, 0x46, 32, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58, 10, 0, 0, 0, 0, 0, 0, 0])
  const w = width - 1
  const h = height - 1
  b.set([w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff, h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff], 24)
  return b
}

describe('imageInfo', () => {
  it('reads the four formats from their headers', () => {
    expect(imageInfo(png(320, 108))).toEqual({ mediaType: 'image/png', width: 320, height: 108 })
    expect(imageInfo(gif(64, 48))).toEqual({ mediaType: 'image/gif', width: 64, height: 48 })
    expect(imageInfo(jpeg(1024, 768))).toEqual({ mediaType: 'image/jpeg', width: 1024, height: 768 })
    expect(imageInfo(webpLossy(800, 600))).toEqual({ mediaType: 'image/webp', width: 800, height: 600 })
    expect(imageInfo(webpLossless(300, 200))).toEqual({ mediaType: 'image/webp', width: 300, height: 200 })
    expect(imageInfo(webpExtended(4000, 3000))).toEqual({ mediaType: 'image/webp', width: 4000, height: 3000 })
  })
  it('rejects what is not an image or has no readable frame', () => {
    expect(imageInfo(new TextEncoder().encode('<html><body>hi</body></html>'))).toBeNull()
    expect(imageInfo(new TextEncoder().encode('%PDF-1.4 ...'))).toBeNull()
    expect(imageInfo(jpeg(10, 10, false))).toBeNull()
    expect(imageInfo(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull()
    expect(imageInfo(new Uint8Array(0))).toBeNull()
    const badPng = png(10, 10)
    badPng.set([0x49, 0x44, 0x41, 0x54], 12) // IDAT where IHDR must be
    expect(imageInfo(badPng)).toBeNull()
  })
})

describe('imageTokens', () => {
  it('follows the provider downscaling to a 1568 px long edge, then pixels / 750, erring high for the budget guard', () => {
    expect(imageTokens(320, 108)).toBe(Math.ceil((320 * 108) / 750))
    expect(imageTokens(1092, 1092)).toBe(1590) // the figure in the vision docs
    expect(imageTokens(8000, 8000)).toBe(Math.ceil((1568 * 1568) / 750)) // 3,278: above what is billed, never below
    expect(imageTokens(3000, 500)).toBe(Math.ceil((1568 * ((500 * 1568) / 3000)) / 750))
    expect(imageTokens(1, 1)).toBe(1)
  })
})

/* ---------- the service with a fake fetch and a fake model ---------- */

const HOST = 'http://93.184.216.34'
const files: Record<string, { body: Uint8Array | string; type: string; status?: number }> = {
  '/logo.png': { body: png(320, 108), type: 'image/png' },
  '/photo.jpg': { body: jpeg(1024, 768), type: 'image/jpeg' },
  '/anim.gif': { body: gif(64, 48), type: 'image/gif' },
  '/pic.webp': { body: webpLossy(800, 600), type: 'image/webp' },
  '/octet.png': { body: png(100, 100), type: 'application/octet-stream' },
  '/page.html': { body: '<html><body>not an image</body></html>', type: 'text/html' },
  '/missing.png': { body: 'gone', type: 'text/html', status: 404 },
  '/huge.png': { body: (() => { const b = new Uint8Array(MAX_BYTES + 10); b.set(png(100, 100)); return b })(), type: 'image/png' },
  '/wide.png': { body: png(9000, 100), type: 'image/png' },
  '/tiny.png': { body: png(4, 4), type: 'image/png' },
  '/empty.png': { body: new Uint8Array(0), type: 'image/png' },
}
const requests: string[] = []
const fetchImpl: typeof fetch = (async (input: string | URL | Request) => {
  const url = String(input)
  requests.push(url)
  if (url === `${HOST}/moved.png`) return new Response(null, { status: 302, headers: { location: `${HOST}/logo.png` } })
  if (url === `${HOST}/down.png`) throw new TypeError('fetch failed')
  const f = files[url.replace(HOST, '')]
  if (!f) return new Response('nope', { status: 500 })
  return new Response(f.body as BodyInit, { status: f.status ?? 200, headers: { 'content-type': f.type } })
}) as typeof fetch

type Reply = { text?: string; stop_reason?: string; throw?: Error }
function fakeLlm(script: (params: Anthropic.Beta.MessageCreateParamsNonStreaming, n: number) => Reply, opts: { dailyBudgetUsd?: number } = {}) {
  const calls: Anthropic.Beta.MessageCreateParamsNonStreaming[] = []
  const client = {
    beta: {
      messages: {
        create: async (params: Anthropic.Beta.MessageCreateParamsNonStreaming) => {
          calls.push(params)
          const r = script(params, calls.length - 1)
          if (r.throw) throw r.throw
          return { id: 'msg', type: 'message', role: 'assistant', model: MODEL, content: [{ type: 'text', text: r.text ?? '', citations: null }], stop_reason: (r.stop_reason ?? 'end_turn') as 'end_turn', stop_sequence: null, usage: { input_tokens: 900, output_tokens: 120, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, service_tier: null } } as unknown as Anthropic.Beta.BetaMessage
        },
      },
    },
  }
  return { llm: new Llm({ client, ...opts }), calls }
}
const reading = { text: 'Google', has_text: true, language: 'en', description: 'The Google wordmark on white.' }

describe('extract-image service (ADR-70)', () => {
  it('declines bad shapes, non-images, private hosts, oversized and tiny files before accepting', async () => {
    const { llm } = fakeLlm(() => ({ text: JSON.stringify(reading) }))
    const svc = extractImage(llm, { fetchImpl })
    expect(await svc.validate({}, { units: 1 })).toMatch(/url must be/)
    expect(await svc.validate({ url: 'ftp://x/y.png' }, { units: 1 })).toMatch(/only http/)
    expect(await svc.validate({ url: `${HOST}/logo.png`, describe: 'yes' }, { units: 1 })).toMatch(/describe must be/)
    expect(await svc.validate({ url: `${HOST}/logo.png`, instructions: 'x'.repeat(501) }, { units: 1 })).toMatch(/instructions/)
    expect(await svc.validate({ url: `${HOST}/logo.png`, schema: { type: 'array' } }, { units: 1 })).toMatch(/root of schema/)
    expect(await svc.validate({ url: `${HOST}/logo.png`, schema: { type: 'object', properties: { a: { type: 'nonsense' } } } }, { units: 1 })).toMatch(/does not compile/)
    expect(await svc.validate({ url: 'http://127.0.0.1/x.png' }, { units: 1 })).toMatch(/could not be fetched.*private/)
    expect(await svc.validate({ url: `${HOST}/page.html` }, { units: 1 })).toMatch(/does not serve a PNG/)
    expect(await svc.validate({ url: `${HOST}/missing.png` }, { units: 1 })).toMatch(/HTTP 404/)
    expect(await svc.validate({ url: `${HOST}/huge.png` }, { units: 1 })).toMatch(/larger than 3.5 MB/)
    expect(await svc.validate({ url: `${HOST}/wide.png` }, { units: 1 })).toMatch(/9000×100 px; at most 8000/)
    expect(await svc.validate({ url: `${HOST}/tiny.png` }, { units: 1 })).toMatch(/too small/)
    expect(await svc.validate({ url: `${HOST}/empty.png` }, { units: 1 })).toMatch(/empty body/)
    expect(await svc.validate({ url: `${HOST}/down.png` }, { units: 1 })).toMatch(/could not be fetched/)
    // the format comes from the bytes, not from the content-type
    expect(await svc.validate({ url: `${HOST}/octet.png` }, { units: 1 })).toBeNull()
    expect(await svc.validate({ url: `${HOST}/moved.png` }, { units: 1 })).toBeNull()
  })

  it('reads an image once, sends it to the model as base64 with the token estimate, and delivers the transcription', async () => {
    const { llm, calls } = fakeLlm(() => ({ text: JSON.stringify(reading) }))
    const svc = extractImage(llm, { fetchImpl, now: () => Date.parse('2026-09-16T00:00:00.000Z') })
    requests.length = 0
    expect(await svc.validate({ url: `${HOST}/logo.png`, describe: true }, { units: 1 })).toBeNull()
    const r = await svc.run({ url: `${HOST}/logo.png`, describe: true }, { units: 1 })
    expect(requests.filter((u) => u.endsWith('/logo.png'))).toHaveLength(1) // validate fetched, run reused the bytes
    const out = r.output as Record<string, unknown>
    expect(out).toMatchObject({ content_type: 'image/png', width: 320, height: 108, bytes: 64, text: 'Google', text_chars: 6, has_text: true, language: 'en', description: 'The Google wordmark on white.', data: null, schema_valid: null, model: MODEL, fetched_at: '2026-09-16T00:00:00.000Z' })
    expect(out.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(r.message).toContain('6 characters of text (en), described')
    expect(JSON.stringify(r.preview).length).toBeLessThan(600)
    const content = calls[0].messages[0].content as { type: string; source?: { type: string; media_type: string; data: string } }[]
    expect(content[0].type).toBe('image')
    expect(content[0].source).toMatchObject({ type: 'base64', media_type: 'image/png' })
    expect(Buffer.from(content[0].source!.data, 'base64')).toHaveLength(64)
    expect(content[1]).toMatchObject({ type: 'text' })
    expect((calls[0].output_config as { format?: { type: string } }).format?.type).toBe('json_schema')
  })

  it('without describe the description is dropped even if the model wrote one, and an empty image is delivered honestly', async () => {
    const { llm } = fakeLlm(() => ({ text: JSON.stringify({ text: '', has_text: false, language: null, description: 'A blank square.' }) }))
    const svc = extractImage(llm, { fetchImpl })
    const r = await svc.run({ url: `${HOST}/pic.webp` }, { units: 1 })
    expect(r.output).toMatchObject({ content_type: 'image/webp', width: 800, height: 600, text: '', has_text: false, language: null, description: null })
    expect(r.message).toContain('no text')
  })

  it('extracts fields against the buyer schema and validates them; a non-conforming answer is an honest cancellation', async () => {
    const schema = { type: 'object', required: ['vendor', 'total'], properties: { vendor: { type: 'string' }, total: { type: 'number' } } }
    const good = fakeLlm(() => ({ text: JSON.stringify({ ...reading, data: { vendor: 'Acme', total: 12.5 } }) }))
    const svc = extractImage(good.llm, { fetchImpl })
    const r = await svc.run({ url: `${HOST}/photo.jpg`, schema }, { units: 1 })
    expect(r.output).toMatchObject({ data: { vendor: 'Acme', total: 12.5 }, schema_valid: true, content_type: 'image/jpeg' })
    expect(r.message).toContain('2 field(s) extracted and validated')
    const bad = fakeLlm(() => ({ text: JSON.stringify({ ...reading, data: { vendor: 'Acme', total: 'twelve' } }) }))
    await expect(extractImage(bad.llm, { fetchImpl }).run({ url: `${HOST}/photo.jpg`, schema }, { units: 1 })).rejects.toThrow(/did not conform to the schema/)
  })

  it('falls back to an unconstrained call when the decoder rejects the schema, and still validates', async () => {
    const schema = { type: 'object', required: ['n'], properties: { n: { type: 'integer', minimum: 1 } } }
    const { llm, calls } = fakeLlm((params, n) => {
      if (n === 0) return { throw: new Anthropic.BadRequestError(400, { error: { message: 'minimum is not supported' } }, 'bad request', new Headers()) }
      return { text: '```json\n' + JSON.stringify({ ...reading, data: { n: 3 } }) + '\n```' }
    })
    const svc = extractImage(llm, { fetchImpl })
    const r = await svc.run({ url: `${HOST}/anim.gif`, schema }, { units: 1 })
    expect(calls).toHaveLength(2)
    expect((calls[1].output_config as { format?: unknown }).format).toBeUndefined()
    expect(r.output).toMatchObject({ data: { n: 3 }, schema_valid: true, content_type: 'image/gif' })
  })

  it('a refusal or truncation by the model is a cancellation with a reason, never a delivery', async () => {
    const refused = fakeLlm(() => ({ text: '', stop_reason: 'refusal' }))
    await expect(extractImage(refused.llm, { fetchImpl }).run({ url: `${HOST}/logo.png` }, { units: 1 })).rejects.toThrow(/declined/)
    const cut = fakeLlm(() => ({ text: '{"text": "abc', stop_reason: 'max_tokens' }))
    await expect(extractImage(cut.llm, { fetchImpl }).run({ url: `${HOST}/logo.png` }, { units: 1 })).rejects.toThrow(/size limit/)
  })

  it('the budget check before accepting counts the image tokens', async () => {
    const { llm: tight } = fakeLlm(() => ({ text: JSON.stringify(reading) }), { dailyBudgetUsd: 0.05 })
    const svc = extractImage(tight, { fetchImpl })
    const reason = await svc.validate({ url: `${HOST}/photo.jpg` }, { units: 1 })
    expect(reason).toMatch(/used up|budget/i)
    expect(Llm.estimateUsd(100, MAX_OUTPUT_TOKENS, imageTokens(1024, 768))).toBeGreaterThan(Llm.estimateUsd(100, MAX_OUTPUT_TOKENS))
  })
})
