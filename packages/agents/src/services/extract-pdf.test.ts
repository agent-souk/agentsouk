import { describe, it, expect } from 'vitest'
import { extractPdf, fitOutput, memoryCeilingBytes, parsePageSelection, MAX_PAGES, MAX_PAGE_NUMBER, type PdfOutput } from './extract-pdf.js'

/** A small, valid PDF written by hand: one Helvetica text block per page, an Info dictionary, a correct xref. */
export function makePdf(pages: string[], meta: { title?: string; author?: string; created?: string } = {}): Uint8Array {
  const objs: string[] = []
  const add = (s: string) => (objs.push(s), objs.length)
  const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const pageIds: number[] = []
  const pagesId = objs.length + 1 + pages.length * 2
  for (const text of pages) {
    const esc = text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
    const content = text === '' ? '' : `BT /F1 12 Tf 50 750 Td 14 TL ${esc.split('\n').map((l) => `(${l}) Tj T*`).join(' ')} ET`
    const contentId = add(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`)
    pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`))
  }
  if (add(`<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] /Count ${pageIds.length} >>`) !== pagesId) throw new Error('pages id')
  const catalogId = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`)
  const infoId = add(`<< ${meta.title ? `/Title (${meta.title}) ` : ''}${meta.author ? `/Author (${meta.author}) ` : ''}/Producer (hand) ${meta.created ? `/CreationDate (${meta.created}) ` : ''}>>`)
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'))
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = Buffer.byteLength(out, 'latin1')
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new Uint8Array(Buffer.from(out, 'latin1'))
}

const invoice = makePdf(['Invoice 4711 from Acme GmbH\nTotal 1,250.00 EUR (net)', 'Page two: payment terms 30 days.', ''], { title: 'Invoice 4711', author: 'Acme', created: "D:20260915120000+05'30" })
const scan = makePdf(['', ''])
const tight = makePdf(['a'.repeat(99), 'b'.repeat(10)])
const many = makePdf(Array.from({ length: MAX_PAGES + 1 }, (_, i) => `Page ${i + 1}`))
/** one page whose content stream is hundreds of thousands of operators: cheap to send, slow to parse */
const bombBytes = (() => {
  const ops = 'q Q\n'.repeat(400_000)
  const base = Buffer.from(makePdf(['x'])).toString('latin1')
  return new Uint8Array(Buffer.from(base.replace(/<< \/Length \d+ >>\nstream\n[^]*?\nendstream/, `<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`), 'latin1'))
})()
const cover = makePdf(['', 'Second page text', '', 'Fourth page'])
/** page 2 of 3 points at an object that is not a page: pdf.js notices only when that page is touched */
const dangling = (() => {
  const base = Buffer.from(makePdf(['One', 'Two', 'Three'])).toString('latin1')
  return new Uint8Array(Buffer.from(base.replace(/\/Kids \[(\d+) 0 R (\d+) 0 R (\d+) 0 R\]/, (_m, a, _b, c) => `/Kids [${a} 0 R 99 0 R ${c} 0 R]`), 'latin1'))
})()
const longQuery = `?x=${'a'.repeat(1500)}`
const HOST = 'http://93.184.216.34'
const requests: string[] = []
const fetchImpl: typeof fetch = (async (input: string | URL | Request) => {
  const url = String(input)
  requests.push(url)
  if (url === `${HOST}/invoice.pdf`) return new Response(invoice, { status: 200, headers: { 'content-type': 'application/pdf; qs=0.001' } })
  if (url === `${HOST}/scan.pdf`) return new Response(scan, { status: 200, headers: { 'content-type': 'application/pdf' } })
  if (url === `${HOST}/tight.pdf`) return new Response(tight, { status: 200, headers: { 'content-type': 'application/pdf' } })
  if (url === `${HOST}/many.pdf`) return new Response(many, { status: 200, headers: { 'content-type': 'application/pdf' } })
  if (url === `${HOST}/bomb.pdf`) return new Response(bombBytes, { status: 200, headers: { 'content-type': 'application/pdf' } })
  if (url === `${HOST}/page.html`) return new Response('<html><body>not a pdf</body></html>', { status: 200, headers: { 'content-type': 'text/html' } })
  if (url === `${HOST}/missing.pdf`) return new Response('<html><body>gone</body></html>', { status: 404, headers: { 'content-type': 'text/html' } })
  if (url === `${HOST}/moved.pdf`) return new Response(null, { status: 302, headers: { location: `${HOST}/invoice.pdf` } })
  if (url === `${HOST}/broken.pdf`) return new Response('%PDF-1.4 garbage without objects', { status: 200, headers: { 'content-type': 'application/pdf' } })
  if (url === `${HOST}/huge.pdf`) return new Response(new Uint8Array(7 * 1024 * 1024).fill(0x25), { status: 200, headers: { 'content-type': 'application/pdf' } })
  if (url === `${HOST}/octet.pdf`) return new Response(invoice, { status: 200, headers: { 'content-type': 'application/octet-stream' } })
  if (url === `${HOST}/cover.pdf`) return new Response(cover, { status: 200, headers: { 'content-type': 'application/pdf' } })
  if (url === `${HOST}/dangling.pdf`) return new Response(dangling, { status: 200, headers: { 'content-type': 'application/pdf' } })
  if (url.startsWith(`${HOST}/long.pdf`)) return new Response(invoice, { status: 200, headers: { 'content-type': 'application/pdf' } })
  if (url === `${HOST}/down.pdf`) throw new TypeError('fetch failed')
  return new Response('nope', { status: 500 })
}) as typeof fetch

describe('extract-pdf service (ADR-68)', () => {
  const svc = extractPdf({ fetchImpl })

  it('parses page selections and refuses nonsense, including numbers that would never stop counting', () => {
    expect(parsePageSelection(undefined)).toBeNull()
    expect(parsePageSelection('')).toBeNull()
    expect(parsePageSelection('1-3,7')).toEqual([1, 2, 3, 7])
    expect(parsePageSelection('3,1,3')).toEqual([1, 3])
    expect(() => parsePageSelection('0-2')).toThrow(/between 1 and/)
    expect(() => parsePageSelection('5-2')).toThrow(/valid page/)
    expect(() => parsePageSelection('1-x')).toThrow(/look like/)
    expect(() => parsePageSelection(`1-${MAX_PAGES + 1}`)).toThrow(/at most/)
    expect(() => parsePageSelection(7 as unknown as string)).toThrow(/look like/)
    // a 17-digit page number once pinned the machine: p++ past 2^53 never advances
    expect(() => parsePageSelection('99999999999999999')).toThrow(/look like/)
    expect(() => parsePageSelection('999999')).toThrow(/between 1 and/)
    expect(() => parsePageSelection(`${MAX_PAGE_NUMBER + 1}`)).toThrow(/between 1 and/)
    expect(parsePageSelection(`${MAX_PAGE_NUMBER}`)).toEqual([MAX_PAGE_NUMBER])
  })

  it('declines before accepting: bad input, private hosts, and files it could not deliver on', async () => {
    expect(await svc.validate({}, { units: 1 })).toMatch(/url/)
    expect(await svc.validate({ url: 'ftp://x' }, { units: 1 })).toMatch(/http/)
    expect(await svc.validate({ url: `${HOST}/invoice.pdf`, max_chars: 5 }, { units: 1 })).toMatch(/max_chars/)
    expect(await svc.validate({ url: `${HOST}/invoice.pdf`, pages: '2-1' }, { units: 1 })).toMatch(/valid page/)
    expect(await svc.validate({ url: 'http://127.0.0.1/x.pdf' }, { units: 1 })).toMatch(/refused: private/)
    expect(await svc.validate({ url: `${HOST}/page.html` }, { units: 1 })).toMatch(/does not serve a PDF/)
    expect(await svc.validate({ url: `${HOST}/missing.pdf` }, { units: 1 })).toMatch(/HTTP 404/)
    expect(await svc.validate({ url: `${HOST}/huge.pdf` }, { units: 1 })).toMatch(/larger than 6 MB/)
    expect(await svc.validate({ url: `${HOST}/down.pdf` }, { units: 1 })).toMatch(/could not be fetched/)
    expect(await svc.validate({ url: `${HOST}/broken.pdf` }, { units: 1 })).toMatch(/could not be opened/)
    expect(await svc.validate({ url: `${HOST}/invoice.pdf`, pages: '9' }, { units: 1 })).toMatch(/none of the requested pages exist: the document has 3 pages/)
    requests.length = 0
    expect(await svc.validate({ url: `${HOST}/invoice.pdf` }, { units: 1 })).toBeNull()
    expect(await svc.validate({ url: `${HOST}/octet.pdf` }, { units: 1 })).toBeNull() // the bytes decide, not the content-type
    expect(requests).toEqual([`${HOST}/invoice.pdf`, `${HOST}/octet.pdf`])
    // run() uses what validate() fetched and opened: nothing is fetched twice
    await svc.run({ url: `${HOST}/invoice.pdf` }, { units: 1 })
    expect(requests).toEqual([`${HOST}/invoice.pdf`, `${HOST}/octet.pdf`])
    await svc.run({ url: `${HOST}/invoice.pdf` }, { units: 1 }) // and a run without a validate before it fetches on its own
    expect(requests).toEqual([`${HOST}/invoice.pdf`, `${HOST}/octet.pdf`, `${HOST}/invoice.pdf`])
  }, 30_000)

  it('extracts every page with the document info, follows redirects, counts words', async () => {
    const r = await svc.run({ url: `${HOST}/moved.pdf` }, { units: 1 })
    const out = r.output as PdfOutput
    expect(out).toMatchObject({ final_url: `${HOST}/invoice.pdf`, http_status: 200, content_type: 'application/pdf', pages_total: 3, pages_read: 3, clipped: false, text_layer: true, error: null })
    expect(out.pages).toEqual([
      { page: 1, start: 0, chars: 52 },
      { page: 2, start: 54, chars: 32 },
      { page: 3, start: 86, chars: 0 },
    ])
    expect(out.text).toBe('Invoice 4711 from Acme GmbH\nTotal 1,250.00 EUR (net)\n\nPage two: payment terms 30 days.')
    expect(out.text.slice(out.pages[1]!.start, out.pages[1]!.start + out.pages[1]!.chars)).toBe('Page two: payment terms 30 days.')
    expect(out.total_chars).toBe(84)
    // the PDF 2.0 date form without the trailing apostrophe, a half-hour offset
    expect(out.info).toEqual({ title: 'Invoice 4711', author: 'Acme', subject: null, creator: null, producer: 'hand', created_at: '2026-09-15T06:30:00.000Z', modified_at: null })
    expect(out.word_count).toBe(15)
    expect(out.bytes).toBe(invoice.byteLength)
    expect(r.preview).toMatchObject({ pages_total: 3, pages_extracted: 3, title: 'Invoice 4711', text_layer: true })
    expect(r.message).toBe('Extracted 15 words from 3 of 3 pages.')
  }, 30_000)

  it('selects pages, keeps the joined text within max_chars, reads at most 100 pages, and says when there is no text layer', async () => {
    const two = await svc.run({ url: `${HOST}/invoice.pdf`, pages: '2,9' }, { units: 1 })
    expect((two.output as PdfOutput).pages).toEqual([{ page: 2, start: 0, chars: 32 }])
    const clipped = await svc.run({ url: `${HOST}/invoice.pdf`, max_chars: 60 }, { units: 1 })
    const c = clipped.output as PdfOutput
    expect(c.clipped).toBe(true)
    expect(c.text_chars).toBe(60)
    expect(c.pages).toEqual([
      { page: 1, start: 0, chars: 52 },
      { page: 2, start: 54, chars: 6 },
      { page: 3, start: 60, chars: 0 }, // an empty page is still a page that was read
    ])
    expect(c.total_chars).toBe(84) // every page was still read for the count
    expect(clipped.message).toContain('(clipped)')
    // no room left for even one character of the next page: it is not pushed as an empty page
    const whole = (await svc.run({ url: `${HOST}/tight.pdf` }, { units: 1 })).output as PdfOutput
    const first = whole.pages[0]!.chars // what pdf.js makes of a 99-glyph line that overruns the page (its business, not ours)
    expect(first).toBeGreaterThan(50)
    const t = (await svc.run({ url: `${HOST}/tight.pdf`, max_chars: first + 1 }, { units: 1 })).output as PdfOutput
    expect(t.text_chars).toBe(first)
    expect(t.pages).toEqual([{ page: 1, start: 0, chars: first }])
    expect(t.clipped).toBe(true)
    const m = (await svc.run({ url: `${HOST}/many.pdf` }, { units: 1 })).output as PdfOutput
    expect(m.pages_total).toBe(MAX_PAGES + 1)
    expect(m.pages_read).toBe(MAX_PAGES)
    expect(m.clipped).toBe(true)
    const s = await svc.run({ url: `${HOST}/scan.pdf` }, { units: 1 })
    expect((s.output as PdfOutput).text_layer).toBe(false)
    expect(s.message).toMatch(/no text layer/)
  }, 60_000)

  it('delivers an honest error when a file beats the parse limits, and the parse runs off the main thread', async () => {
    const slow = extractPdf({ fetchImpl, parseTimeoutMs: 50 })
    let ticks = 0
    const beat = setInterval(() => ticks++, 10)
    const r = await slow.run({ url: `${HOST}/bomb.pdf` }, { units: 1 })
    clearInterval(beat)
    const out = r.output as PdfOutput
    expect(out.error).toMatch(/could not be parsed within 1 s/)
    expect(out).toMatchObject({ pages: [], text: '', text_layer: null, total_chars: null })
    expect(r.message).toMatch(/Could not extract/)
    expect(ticks).toBeGreaterThan(0) // the event loop kept turning while the thread worked
  }, 30_000)

  it('keeps the serialised output under the platform cap by cutting the text', () => {
    const text = '"'.repeat(300_000) // every quote costs two bytes serialised
    const out: PdfOutput = { url: 'u', final_url: 'u', http_status: 200, content_type: 'application/pdf', bytes: 1, pages_total: 2, pages_read: 2, pages: [{ page: 1, start: 0, chars: 200_000 }, { page: 2, start: 200_002, chars: 99_998 }], text, text_chars: text.length, total_chars: text.length, clipped: false, text_layer: true, info: { title: null, author: null, subject: null, creator: null, producer: null, created_at: null, modified_at: null }, word_count: 1, error: null, fetched_at: 'now' }
    const fit = fitOutput(out)
    expect(JSON.stringify(fit).length).toBeLessThanOrEqual(450_000)
    expect(fit.clipped).toBe(true)
    expect(fit.text_chars).toBe(fit.text.length)
    expect(fit.pages.every((p) => p.start + p.chars <= fit.text.length)).toBe(true)
    expect(fitOutput({ ...out, text: 'short', text_chars: 5, pages: [{ page: 1, start: 0, chars: 5 }] })).toMatchObject({ text: 'short', clipped: false })
  })

  it('stops a parse that would take the process past the machine\'s memory ceiling', async () => {
    expect(memoryCeilingBytes(0)).toBeNull() // no limit on a dev box: the watchdog is off
    expect(memoryCeilingBytes(512 * 1024 * 1024)).toBe(Math.round(512 * 1024 * 1024 * 0.7))
    // a ceiling below what this process already uses: every parse is stopped at once, as a limit, not as a bad file
    const tiny = extractPdf({ fetchImpl, memoryCeilingBytes: 1024 })
    expect(await tiny.validate({ url: `${HOST}/invoice.pdf` }, { units: 1 })).toMatch(/could not be opened within the limits/)
    const r = await tiny.run({ url: `${HOST}/invoice.pdf` }, { units: 1 })
    expect((r.output as PdfOutput).error).toMatch(/more memory than this service allows/)
    // and the next job is unaffected: the queue did not wedge
    expect(await svc.validate({ url: `${HOST}/invoice.pdf` }, { units: 1 })).toBeNull()
  }, 30_000)

  it('declines a document whose middle page is broken instead of delivering a paid error, and keeps the preview small', async () => {
    expect(await svc.validate({ url: `${HOST}/dangling.pdf` }, { units: 1 })).toMatch(/could not be opened/)
    // a URL long enough to blow the platform's 4 KB preview cap once it is percent-encoded
    const url = `${HOST}/long.pdf${longQuery}`
    expect(await svc.validate({ url }, { units: 1 })).toBeNull()
    const r = await svc.run({ url }, { units: 1 })
    expect(JSON.stringify(r.preview).length).toBeLessThan(4096)
    expect((r.preview as { final_url: string }).final_url.endsWith('...')).toBe(true)
    expect((r.output as PdfOutput).final_url.length).toBeGreaterThan(1000) // the full value stays in the output
  }, 30_000)

  it('puts no separator in front of the first page with text, and stops reading once the budget is spent', async () => {
    const whole = (await svc.run({ url: `${HOST}/cover.pdf` }, { units: 1 })).output as PdfOutput
    expect(whole.text.startsWith('Second page text')).toBe(true)
    expect(whole.pages[0]).toEqual({ page: 1, start: 0, chars: 0 })
    expect(whole.text_chars).toBe(whole.total_chars! + 2) // one separator between the two pages that carry text
    const small = (await svc.run({ url: `${HOST}/cover.pdf`, max_chars: 16 }, { units: 1 })).output as PdfOutput
    expect(small.clipped).toBe(true)
    expect(small.pages_read).toBe(3) // the empty page 3 counts as read; page 4 was never touched
    expect(small.pages.at(-1)).toEqual({ page: 3, start: 16, chars: 0 })
    expect(small.total_chars).toBe(27) // page 4 was read once to learn it does not fit, then the loop stopped
  }, 30_000)

  it('fails only on its own side: a private target or a file that vanished since validate()', async () => {
    await expect(svc.run({ url: `${HOST}/huge.pdf` }, { units: 1 })).rejects.toThrow(/larger than 6 MB/)
    await expect(svc.run({ url: `${HOST}/page.html` }, { units: 1 })).rejects.toThrow(/does not serve a PDF/)
    await expect(svc.run({ url: 'http://10.0.0.1/x.pdf' }, { units: 1 })).rejects.toThrow(/refused/)
  })
})
