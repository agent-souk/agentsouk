/**
 * Minimal HTML → text conversion without a DOM dependency. Good enough for articles, docs and product pages.
 *
 * Every tag pattern here bounds its attribute scan (`[^>]{0,400}` instead of `[^>]*`): against a page that contains
 * no `>` at all, the unbounded form restarts at every position and runs quadratically - 156 KB of "<p" took 18.6 s
 * on one core, and the fetch cap allows far more than that. Nothing here may depend on the goodwill of the page it
 * reads (ADR-73).
 */

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

/**
 * Tags whose CONTENT never belongs in readable text. They used to be removed with one regular expression whose
 * lazy `[\s\S]*?` restarted at every opener: a page of unclosed `<script` tags took 9.3 s at 342 KB and minutes at
 * the 2 MB extract-web allows - a free way to stop this machine, because x402 settles only after a delivery that
 * then never comes (measured in the adversarial run of ADR-73). The scanner below makes one pass.
 */
const DROP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'head', 'nav', 'footer', 'aside'])
const ANY_TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]{0,400}>/g

/** Removes each dropped element with its content in a single linear pass; an opener that is never closed keeps its text instead of swallowing the rest of the document. */
export function dropBlocks(html: string): string {
  let out = ''
  let last = 0
  let depth = 0
  let open = ''
  let openAt = 0
  ANY_TAG.lastIndex = 0
  for (let m = ANY_TAG.exec(html); m; m = ANY_TAG.exec(html)) {
    const name = m[2].toLowerCase()
    if (!DROP_TAGS.has(name)) continue
    if (m[1] !== '/') {
      if (depth === 0) {
        open = name
        openAt = m.index
        depth = 1
      } else if (name === open) depth++
    } else if (depth > 0 && name === open) {
      depth--
      if (depth === 0) {
        out += html.slice(last, openAt) + ' '
        last = m.index + m[0].length
      }
    }
  }
  return out + html.slice(last)
}
/** A block start opens a new paragraph; a block end ends a line; list items and table rows end lines only. */
const OPEN_BLOCK = /<(p|div|section|article|main|header|h[1-6]|ul|ol|table|blockquote|pre|figure|figcaption|address|form|fieldset)\b[^>]{0,400}>/gi
const CLOSE_BLOCK = /<\/(p|div|section|article|main|header|h[1-6]|li|ul|ol|tr|table|blockquote|pre|dt|dd|figure|figcaption|address|form|fieldset)\s*>/gi
const LINE_BREAK = /<(br|hr)\b[^>]*\/?>/gi

export type Extracted = { title: string | null; description: string | null; text: string; links: { href: string; text: string }[]; lang: string | null }

function meta(html: string, name: string): string | null {
  const re = new RegExp(`<meta\\s+[^>]*(?:name|property)=["']${name}["'][^>]{0,400}>`, 'i')
  const m = html.match(re)
  if (!m) return null
  const c = m[0].match(/content=["']([^"']*)["']/i)
  return c ? decodeEntities(c[1]).trim() || null : null
}

export function htmlToText(html: string, baseUrl?: string, maxLinks = 50): Extracted {
  const title = html.match(/<title[^>]{0,400}>([\s\S]*?)<\/title>/i)
  const lang = html.match(/<html[^>]*\blang=["']([^"']+)["']/i)
  const description = meta(html, 'description') ?? meta(html, 'og:description')
  const stripped = dropBlocks(html.replace(/<!--[\s\S]*?-->/g, ' '))
  const links: { href: string; text: string }[] = []
  const seen = new Set<string>()
  for (const m of stripped.matchAll(/<a\s+[^>]*href=["']([^"'#][^"']*)["'][^>]{0,400}>([\s\S]*?)<\/a>/gi)) {
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
    links.push({ href, text: decodeEntities(m[2].replace(/<[^>]{1,400}>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 120) })
  }
  let body = stripped
  const main = body.match(/<(main|article)\b[^>]{0,400}>([\s\S]*?)<\/\1\s*>/i)
  if (main && main[2].replace(/<[^>]{1,400}>/g, '').trim().length > 400) body = main[2]
  body = body.replace(OPEN_BLOCK, '\n').replace(CLOSE_BLOCK, '\n').replace(LINE_BREAK, '\n').replace(/<[^>]{1,400}>/g, ' ')
  const text = decodeEntities(body)
    .replace(/\r/g, '')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { title: title ? decodeEntities(title[1]).replace(/\s+/g, ' ').trim() || null : null, description, text, links, lang: lang ? lang[1] : null }
}
