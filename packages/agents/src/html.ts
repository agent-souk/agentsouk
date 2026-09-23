/**
 * Minimal HTML → text conversion without a DOM dependency. Good enough for articles, docs and product pages.
 *
 * Every tag pattern here bounds its attribute scan (`[^>]{0,400}` instead of `[^>]*`): against a page that contains
 * no `>` at all, the unbounded form restarts at every position and runs quadratically - 156 KB of "<p" took 18.6 s
 * on one core, and the fetch cap allows far more than that. Nothing here may depend on the goodwill of the page it
 * reads (ADR-73).
 *
 * ADR-80: ADR-73 bounded the tag scans and missed the rest. The adversarial review of 2026-09-23 measured four more
 * patterns of the same kind - `<meta\s+[^>]*`, `<html[^>]*`, `<a\s+[^>]*` and the comment `<!--[\s\S]*?-->` - at
 * 12-15 s for 200 KB (S-DOS-2); the unclosed `<title>` and `<main>` lookups were quadratic the same way. Now every
 * attribute scan is bounded, every lazy content scan either has a length cap or is a linear indexOf walk, and a test
 * feeds each of them 200 KB of the input that used to hang them.
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
const CLOSE_BLOCK = /<\/(p|div|section|article|main|header|h[1-6]|li|ul|ol|tr|table|blockquote|pre|dt|dd|figure|figcaption|address|form|fieldset)\s{0,20}>/gi
const LINE_BREAK = /<(br|hr)\b[^>]{0,400}>/gi

export type Extracted = { title: string | null; description: string | null; text: string; links: { href: string; text: string }[]; lang: string | null }

function meta(html: string, name: string): string | null {
  const re = new RegExp(`<meta\\s{1,20}[^>]{0,400}?(?:name|property)=["']${name}["'][^>]{0,400}>`, 'i')
  const m = html.match(re)
  if (!m) return null
  const c = m[0].match(/content=["']([^"']*)["']/i)
  return c ? decodeEntities(c[1]).trim() || null : null
}

/** Removes `<!-- ... -->` comments in one pass; an opener that is never closed keeps the rest of the page, as the regex did. */
export function dropComments(html: string): string {
  let out = ''
  let from = 0
  for (;;) {
    const open = html.indexOf('<!--', from)
    if (open < 0) break
    const close = html.indexOf('-->', open + 4)
    if (close < 0) break
    out += html.slice(from, open) + ' '
    from = close + 3
  }
  return out + html.slice(from)
}

/**
 * The first `<main>` or `<article>` that is closed, with its content - what `/<(main|article)\b[^>]{0,400}>([\s\S]*?)<\/\1\s*>/i`
 * found, without restarting a scan to the end of the page at every unclosed opener. A name whose closing tag cannot
 * be found after one opener cannot be found after any later one, so it is given up after one look.
 */
function firstClosedBlock(html: string): string | null {
  const opener = /<(main|article)\b[^>]{0,400}>/gi
  const lower = html.toLowerCase()
  const gone = new Set<string>()
  for (let m = opener.exec(html); m; m = opener.exec(html)) {
    const name = m[1].toLowerCase()
    if (gone.has(name)) continue
    const start = m.index + m[0].length
    // sticky: tests only at `at`, never scans ahead - a page of `</main` without `>` stays one pass
    const closer = new RegExp(`</${name}\\s{0,20}>`, 'y')
    let end = -1
    for (let at = lower.indexOf(`</${name}`, start); at >= 0; at = lower.indexOf(`</${name}`, at + 2)) {
      closer.lastIndex = at
      if (closer.test(lower)) {
        end = at
        break
      }
    }
    if (end < 0) {
      gone.add(name)
      if (gone.size === 2) return null
      continue
    }
    return html.slice(start, end)
  }
  return null
}

export function htmlToText(html: string, baseUrl?: string, maxLinks = 50): Extracted {
  const title = html.match(/<title[^>]{0,400}>([\s\S]{0,2000}?)<\/title>/i)
  const lang = html.match(/<html[^>]{0,400}?\blang=["']([^"']{1,40})["']/i)
  const description = meta(html, 'description') ?? meta(html, 'og:description')
  const stripped = dropBlocks(dropComments(html))
  const links: { href: string; text: string }[] = []
  const seen = new Set<string>()
  for (const m of stripped.matchAll(/<a\s{1,20}[^>]{0,400}?href=["']([^"'#][^"']{0,2000})["'][^>]{0,400}>([\s\S]{0,2000}?)<\/a>/gi)) {
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
  const main = firstClosedBlock(body)
  if (main != null && main.replace(/<[^>]{1,400}>/g, '').trim().length > 400) body = main
  body = body.replace(OPEN_BLOCK, '\n').replace(CLOSE_BLOCK, '\n').replace(LINE_BREAK, '\n').replace(/<[^>]{1,400}>/g, ' ')
  const text = decodeEntities(body)
    .replace(/\r/g, '')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { title: title ? decodeEntities(title[1]).replace(/\s+/g, ' ').trim() || null : null, description, text, links, lang: lang ? lang[1] : null }
}
