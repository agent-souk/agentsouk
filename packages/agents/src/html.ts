/**
 * Minimal HTML → text conversion without a DOM dependency. Good enough for articles, docs and product pages.
 *
 * Nothing here may depend on the goodwill of the page it reads, and the history of this file is the history of that
 * sentence. ADR-73 found regular expressions that restarted a scan to the end of the page at every opener (156 KB of
 * "<p" took 18.6 s) and bounded their attribute scans. The review of 2026-09-23 found four more of the same kind
 * (`<meta\s+[^>]*`, `<html[^>]*`, `<a\s+[^>]*`, the comment `<!--[\s\S]*?-->`: 12-15 s for 200 KB, S-DOS-2), and the
 * review of ADR-80 showed that bounding was not enough: a bounded pattern still rescans its window at every `<`, so
 * 2 MB of "<a " (extract-web's fetch cap) cost 18 s, and a cap of 400 attribute characters lost the `lang` of every
 * Wikipedia page (RX-11, RX-12).
 *
 * So the page is read ONCE, as tags: `tags()` walks it with indexOf and keeps the position of the next `>` until it
 * has been passed, which makes the walk linear whatever the page contains. Everything else - title, lang, meta
 * description, links, the main/article choice, the text - is read from that list, and every attribute pattern runs
 * inside one tag of at most 4 KB. A test feeds each former trap 2 MB of the input that used to hang it.
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

/** A `<` whose `>` is further away than this is text, not a tag. */
const MAX_TAG = 4096
/** Markup without a tag name (`<!doctype …>`, `< b >`) is stripped only when this short, as the old `<[^>]{1,400}>` did. */
const MAX_BARE_MARKUP = 400
/** How many anchors the link walk looks at before it stops looking. */
const MAX_ANCHORS = 2000
/** How many tags a page may have before the rest is read as text (2 MB of tiny tags was 112 MB of tag objects, R3-HTML-2). */
const MAX_TAGS = 200_000
/** Elements whose content is raw text to a browser: a `<` inside them never starts a tag (R3-HTML-1). */
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title'])

/** One tag: [start, end] are the positions of its `<` and `>`; `name` is lowercase, '' for markup without a name. */
export type Tag = { start: number; end: number; name: string; closing: boolean; attrs: string }

/** Sticky: read at the `<` itself, never scanning ahead. */
const TAG_NAME = /(\/?)([a-zA-Z][a-zA-Z0-9]*)\b/y

/**
 * Every tag of the page, in one linear pass. The next `>` is looked up only once it has been passed, the name is read
 * in place, and text is cut out only for a real tag, after which the walk jumps past it - so no character is looked
 * at more than a bounded number of times, whatever the page contains.
 */
export function tags(html: string): Tag[] {
  const out: Tag[] = []
  const unclosed = new Set<string>()
  let gt = -1
  for (let i = html.indexOf('<'); i >= 0 && out.length < MAX_TAGS; ) {
    if (gt <= i) {
      gt = html.indexOf('>', i + 1)
      if (gt < 0) break
    }
    const inner = gt - i - 1
    let next = i + 1
    if (inner >= 1 && inner <= MAX_TAG) {
      TAG_NAME.lastIndex = i + 1
      const m = TAG_NAME.exec(html)
      if (m && m.index === i + 1 && TAG_NAME.lastIndex <= gt) {
        const name = m[2]!.toLowerCase()
        const closing = m[1] === '/'
        out.push({ start: i, end: gt, name, closing, attrs: html.slice(TAG_NAME.lastIndex, gt) })
        next = gt + 1
        if (!closing && RAW_TEXT.has(name) && !unclosed.has(name)) {
          // Raw text, as a browser reads it: the content runs to the matching closer, whatever `<` it contains - an
          // `if (a < b)` inside a script used to swallow the `</script>` and leak the whole script into the text. One
          // forward search per raw element, and the walk resumes behind it. A name with no closer further on has none
          // after any later opener either: remembered, so a page of unclosed <title> is not searched to its end again
          // and again, and its markup is read as tags, as before.
          const closer = new RegExp(`</${name}(?=[\\s/>])`, 'gi')
          closer.lastIndex = gt + 1
          const c = closer.exec(html)
          if (c) {
            next = c.index
            if (gt < c.index) gt = -1 // the next '>' has to be found again, behind the raw text
          } else unclosed.add(name)
        }
      } else if (inner <= MAX_BARE_MARKUP) {
        out.push({ start: i, end: gt, name: '', closing: false, attrs: html.slice(i + 1, gt) })
        next = gt + 1
      }
    }
    i = html.indexOf('<', next)
  }
  return out
}

/** One attribute, read in place: a name, then optionally `=` and a quoted or bare value. */
const ATTR = /\s*([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/y

/**
 * The attributes of one tag (at most MAX_TAG characters), parsed one after the other - a search for `href=` found it
 * inside the value of another attribute too (R3-HTML-3). The first occurrence of a name wins, as in a browser.
 */
function attrsOf(attrs: string): Map<string, string> {
  const out = new Map<string, string>()
  for (let i = 0; i < attrs.length; ) {
    ATTR.lastIndex = i
    const m = ATTR.exec(attrs)
    if (!m || ATTR.lastIndex === i) {
      i++
      continue
    }
    const name = m[1]!.toLowerCase()
    if (!out.has(name)) out.set(name, m[2] ?? m[3] ?? m[4] ?? '')
    i = ATTR.lastIndex
  }
  return out
}
function attr(attrs: string, name: string): string | null {
  return attrsOf(attrs).get(name) ?? null
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

/** Tags whose CONTENT never belongs in readable text. */
const DROP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'head', 'nav', 'footer', 'aside'])

/** Removes each dropped element with its content; an opener that is never closed keeps its text instead of swallowing the rest of the document. */
export function dropBlocks(html: string, list: Tag[] = tags(html)): string {
  let out = ''
  let last = 0
  let depth = 0
  let open = ''
  let openAt = 0
  for (const t of list) {
    if (!DROP_TAGS.has(t.name)) continue
    if (!t.closing) {
      if (depth === 0) {
        open = t.name
        openAt = t.start
        depth = 1
      } else if (t.name === open) depth++
    } else if (depth > 0 && t.name === open) {
      depth--
      if (depth === 0) {
        out += html.slice(last, openAt) + ' '
        last = t.end + 1
      }
    }
  }
  return out + html.slice(last)
}

/** For each tag, the index of the next closing tag of `name` after it (walked forward once, never rescanned). */
function nextClosing(list: Tag[], from: number, name: string, cursor: { at: number }): Tag | null {
  if (cursor.at < from) cursor.at = from
  while (cursor.at < list.length && !(list[cursor.at]!.closing && list[cursor.at]!.name === name)) cursor.at++
  return cursor.at < list.length ? list[cursor.at]! : null
}

/** A block start opens a new paragraph; a block end ends a line; list items and table rows end lines only. */
const OPEN_BLOCK = new Set(['p', 'div', 'section', 'article', 'main', 'header', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'table', 'blockquote', 'pre', 'figure', 'figcaption', 'address', 'form', 'fieldset'])
const CLOSE_BLOCK = new Set(['p', 'div', 'section', 'article', 'main', 'header', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'ul', 'ol', 'tr', 'table', 'blockquote', 'pre', 'dt', 'dd', 'figure', 'figcaption', 'address', 'form', 'fieldset'])

/** The readable text of a fragment: tags become line breaks or spaces, entities are decoded, whitespace is tidied. */
function textOf(html: string): string {
  let out = ''
  let from = 0
  for (const t of tags(html)) {
    out += html.slice(from, t.start)
    if (t.name === 'br' || t.name === 'hr') out += '\n'
    else if (t.name && !t.closing && OPEN_BLOCK.has(t.name)) out += '\n'
    else if (t.name && t.closing && CLOSE_BLOCK.has(t.name)) out += '\n'
    else out += ' '
    from = t.end + 1
  }
  return out + html.slice(from)
}

export type Extracted = { title: string | null; description: string | null; text: string; links: { href: string; text: string }[]; lang: string | null }

export function htmlToText(html: string, baseUrl?: string, maxLinks = 50): Extracted {
  const page = dropComments(html)
  const all = tags(page)

  const titleOpen = all.findIndex((t) => t.name === 'title' && !t.closing)
  const titleClose = titleOpen >= 0 ? nextClosing(all, titleOpen + 1, 'title', { at: 0 }) : null
  const title = titleOpen >= 0 && titleClose ? decodeEntities(page.slice(all[titleOpen]!.end + 1, titleClose.start)).replace(/\s+/g, ' ').trim() || null : null

  const htmlTag = all.find((t) => t.name === 'html' && !t.closing)
  const htmlAttrs = htmlTag ? attrsOf(htmlTag.attrs) : null
  const langValue = (htmlAttrs?.get('lang') || htmlAttrs?.get('xml:lang') || '').trim().replace(/_/g, '-')
  const lang = /^[A-Za-z0-9-]{1,40}$/.test(langValue) ? langValue : null

  const metaContent = (name: string): string | null => {
    for (const t of all) {
      if (t.name !== 'meta' || t.closing) continue
      const a = attrsOf(t.attrs)
      const key = a.get('name') ?? a.get('property')
      if (key?.toLowerCase() !== name) continue
      const c = a.get('content') ?? null
      return c ? decodeEntities(c).trim() || null : null
    }
    return null
  }
  const description = metaContent('description') ?? metaContent('og:description')

  const stripped = dropBlocks(page, all)
  const inBody = tags(stripped)

  const links: { href: string; text: string }[] = []
  const seen = new Set<string>()
  const closerA = { at: 0 }
  // a page of 200,000 identical anchors is a page, not 200,000 links: the walk looks at a bounded number of them
  let anchorsSeen = 0
  for (let k = 0; k < inBody.length && links.length < maxLinks && anchorsSeen < MAX_ANCHORS; k++) {
    const t = inBody[k]!
    if (t.name !== 'a' || t.closing) continue
    anchorsSeen++
    const raw = attr(t.attrs, 'href')
    if (!raw || raw.startsWith('#')) continue
    const close = nextClosing(inBody, k + 1, 'a', closerA)
    if (!close) break
    let href = decodeEntities(raw).trim()
    if (/^(javascript|mailto|tel|data):/i.test(href)) continue
    try {
      href = baseUrl ? new URL(href, baseUrl).toString() : href
    } catch {
      continue
    }
    if (seen.has(href)) continue
    seen.add(href)
    links.push({ href, text: decodeEntities(textOf(stripped.slice(t.end + 1, Math.min(close.start, t.end + 1 + 4000)))).replace(/\s+/g, ' ').trim().slice(0, 120) })
  }

  // the first <main> or <article> that is closed, if it carries the content
  let body = stripped
  const closers = { main: { at: 0 }, article: { at: 0 } }
  for (let k = 0; k < inBody.length; k++) {
    const t = inBody[k]!
    if (t.closing || (t.name !== 'main' && t.name !== 'article')) continue
    const close = nextClosing(inBody, k + 1, t.name, closers[t.name])
    if (!close) continue
    const inner = stripped.slice(t.end + 1, close.start)
    if (textOf(inner).trim().length > 400) body = inner
    break
  }

  const text = decodeEntities(textOf(body))
    .replace(/\r/g, '')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { title, description, text, links, lang }
}
