/** Minimal HTML → text conversion without a DOM dependency. Good enough for articles, docs and product pages. */

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', euro: '€', pound: '£', yen: '¥' }

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m
    }
    return ENTITIES[code.toLowerCase()] ?? m
  })
}

const DROP = /<(script|style|noscript|template|svg|iframe|head|nav|footer|aside)\b[\s\S]*?<\/\1\s*>/gi
/** A block start opens a new paragraph; a block end ends a line; list items and table rows end lines only. */
const OPEN_BLOCK = /<(p|div|section|article|main|header|h[1-6]|ul|ol|table|blockquote|pre|figure|figcaption|address|form|fieldset)\b[^>]*>/gi
const CLOSE_BLOCK = /<\/(p|div|section|article|main|header|h[1-6]|li|ul|ol|tr|table|blockquote|pre|dt|dd|figure|figcaption|address|form|fieldset)\s*>/gi
const LINE_BREAK = /<(br|hr)\b[^>]*\/?>/gi

export type Extracted = { title: string | null; description: string | null; text: string; links: { href: string; text: string }[]; lang: string | null }

function meta(html: string, name: string): string | null {
  const re = new RegExp(`<meta\\s+[^>]*(?:name|property)=["']${name}["'][^>]*>`, 'i')
  const m = html.match(re)
  if (!m) return null
  const c = m[0].match(/content=["']([^"']*)["']/i)
  return c ? decodeEntities(c[1]).trim() || null : null
}

export function htmlToText(html: string, baseUrl?: string, maxLinks = 50): Extracted {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const lang = html.match(/<html[^>]*\blang=["']([^"']+)["']/i)
  const description = meta(html, 'description') ?? meta(html, 'og:description')
  const stripped = html.replace(/<!--[\s\S]*?-->/g, ' ').replace(DROP, ' ')
  const links: { href: string; text: string }[] = []
  const seen = new Set<string>()
  for (const m of stripped.matchAll(/<a\s+[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    if (links.length >= maxLinks) break
    let href = decodeEntities(m[1]).trim()
    if (/^(javascript|mailto|tel|data):/i.test(href)) continue
    try {
      href = baseUrl ? new URL(href, baseUrl).toString() : href
    } catch {
      continue
    }
    if (seen.has(href)) continue
    seen.add(href)
    links.push({ href, text: decodeEntities(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 120) })
  }
  let body = stripped
  const main = body.match(/<(main|article)\b[^>]*>([\s\S]*?)<\/\1\s*>/i)
  if (main && main[2].replace(/<[^>]+>/g, '').trim().length > 400) body = main[2]
  body = body.replace(OPEN_BLOCK, '\n').replace(CLOSE_BLOCK, '\n').replace(LINE_BREAK, '\n').replace(/<[^>]+>/g, ' ')
  const text = decodeEntities(body)
    .replace(/\r/g, '')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { title: title ? decodeEntities(title[1]).replace(/\s+/g, ' ').trim() || null : null, description, text, links, lang: lang ? lang[1] : null }
}
