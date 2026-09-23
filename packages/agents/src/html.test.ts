import { describe, it, expect } from 'vitest'
import { decodeEntities, htmlToText } from './html.js'

describe('htmlToText', () => {
  it('drops scripts, styles and nav, keeps block structure, decodes entities, resolves links', () => {
    const html = `<!doctype html><html lang="de"><head><title> Hallo &amp; Welt </title><meta name="description" content="Eine &quot;Seite&quot;"><style>p{color:red}</style><script>alert(1)</script></head>
<body><nav><a href="/nav">Navigation</a></nav><main><h1>Titel</h1><p>Erster&nbsp;Absatz mit <b>fett</b> &#8212; und &#x41;.</p><ul><li>eins</li><li>zwei</li></ul>
<a href="/relativ?x=1">Relativ</a> <a href="https://example.org/abs">Absolut</a> <a href="mailto:a@b.c">Mail</a> <a href="#top">Anker</a></main><footer>Fuss</footer></body></html>`
    const x = htmlToText(html, 'https://example.com/dir/page.html')
    expect(x.title).toBe('Hallo & Welt')
    expect(x.description).toBe('Eine "Seite"')
    expect(x.lang).toBe('de')
    expect(x.text).not.toContain('alert')
    expect(x.text).not.toContain('color:red')
    expect(x.text).toContain('Titel\n')
    expect(x.text).toContain('Erster Absatz mit fett — und A.')
    expect(x.text).toContain('eins\nzwei')
    expect(x.links.map((l) => l.href)).toEqual(['https://example.com/relativ?x=1', 'https://example.org/abs'])
    expect(x.links[0].text).toBe('Relativ')
  })

  it('prefers <main>/<article> when it carries the content', () => {
    const filler = 'x'.repeat(500)
    const html = `<html><body><div>menu menu menu</div><article><p>${filler}</p></article><div>footer stuff</div></body></html>`
    const x = htmlToText(html)
    expect(x.text).toBe(filler)
  })

  it('decodes numeric and named entities and leaves unknown ones alone', () => {
    expect(decodeEntities('&lt;a&gt; &#65;&#x42; &euro; &bogus;')).toBe('<a> AB € &bogus;')
  })
})

/**
 * ADR-80: every former trap, fed 2 MB - extract-web's fetch cap - of the input that used to hang it. The review of
 * 2026-09-23 measured 12-15 s for 200 KB of the first four; bounded regexes still took 18 s at 2 MB (review of
 * ADR-80, RX-12). One Node thread serves all thirteen services, so each of these was a free way to stop them.
 */
describe('htmlToText against pages written to hang it (ADR-80)', () => {
  const N = 2_000_000
  const fill = (unit: string) => unit.repeat(Math.ceil(N / unit.length)).slice(0, N)
  const cases: [string, string][] = [
    ['unclosed <meta', fill('<meta ')],
    ['unclosed <html', fill('<html ')],
    ['unclosed <a', fill('<a ')],
    ['<a href without a closing quote', fill('<a href="' + 'x'.repeat(1990))],
    ['unclosed comments', fill('<!--')],
    ['unclosed <title>', fill('<title>')],
    ['unclosed <main> and <article>', fill('<main>').slice(0, N / 2) + fill('<article>').slice(0, N / 2)],
    ['closers without >', '<main>x' + fill('</main')],
    ['<br without >', fill('<br ')],
    ['a sea of < with a > every 4,000 characters', fill('<'.repeat(3999) + '>')],
    ['200,000 identical anchors', fill('<a href="/x">x</a>')],
    ['anchors that are never closed', fill('<a href="/x">')],
  ]
  for (const [name, page] of cases) {
    it(`reads 2 MB of ${name} in well under a second`, () => {
      const t = Date.now()
      htmlToText(page, 'https://example.com/')
      expect(Date.now() - t).toBeLessThan(1500)
    })
  }

  it('still finds comments, titles, meta, links and <main> the way the regexes did', () => {
    const page = `<html lang="de"><head><title>Preise</title><meta name="description" content="Alle Preise"></head><body><!-- versteckt --><nav>Menü</nav><main><h1>Preisliste</h1><p>${'Ein Satz über Preise. '.repeat(30)}</p><a href="/kontakt">Kontakt</a></main><!-- nie geschlossen <p>bleibt</p></body></html>`
    const r = htmlToText(page, 'https://example.com/')
    expect(r.title).toBe('Preise')
    expect(r.lang).toBe('de')
    expect(r.description).toBe('Alle Preise')
    expect(r.text).not.toContain('versteckt')
    expect(r.text).not.toContain('Menü')
    expect(r.text).toContain('Preisliste')
    expect(r.links).toEqual([{ href: 'https://example.com/kontakt', text: 'Kontakt' }])
  })

  it('reads a Wikipedia-style <html> tag with a long class list, and a link with long attributes before href (RX-11)', () => {
    const cls = 'client-nojs vector-feature-language-in-header-enabled '.repeat(12)
    const page = `<html class="${cls}" lang="tr" dir="ltr"><body><p>x</p><a class="${'mw-link '.repeat(80)}" title="t" href="/wiki/Ankara">Ankara</a></body></html>`
    const r = htmlToText(page, 'https://tr.wikipedia.org/')
    expect(r.lang).toBe('tr')
    expect(r.links).toEqual([{ href: 'https://tr.wikipedia.org/wiki/Ankara', text: 'Ankara' }])
  })

  it('keeps positions straight on text whose lowercase form is longer (İ, RX-10)', () => {
    const para = 'İstanbul İzmir İnegöl İskenderun. '.repeat(40)
    const page = `<html><body><p>Vorspann</p><main><p>${para}</p></main><p>Nachspann</p></body></html>`
    const r = htmlToText(page)
    expect(r.text.startsWith('İstanbul')).toBe(true)
    expect(r.text).not.toContain('Nachspann')
    expect(r.text).not.toContain('<')
  })
})
