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
 * ADR-80: every pattern that reads a page, fed 200 KB of the input that used to hang it. The review of 2026-09-23
 * measured 12-15 s for the first four on this machine class; one Node thread serves all thirteen services, so each
 * of these was a free way to stop them (x402 bills only after a delivery that then never comes).
 */
describe('htmlToText against pages written to hang it (ADR-80)', () => {
  const N = 200_000
  const cases: [string, string][] = [
    ['unclosed <meta', '<meta '.repeat(N / 6)],
    ['unclosed <html', '<html '.repeat(N / 6)],
    ['unclosed <a', '<a '.repeat(N / 3)],
    ['unclosed <a href', ('<a href="' + 'x'.repeat(1990)).repeat(N / 2000)],
    ['unclosed comments', '<!--'.repeat(N / 4)],
    ['unclosed <title>', '<title>'.repeat(N / 7)],
    ['unclosed <main>', '<main>'.repeat(N / 6) + '<article>'.repeat(N / 9)],
    ['closers without >', '<main>x' + '</main'.repeat(N / 6)],
    ['<br without >', '<br '.repeat(N / 4)],
    ['</p and a sea of spaces', '</p'.repeat(1000) + ' '.repeat(N)],
  ]
  for (const [name, page] of cases) {
    it(`reads 200 KB of ${name} in well under a second`, () => {
      const t = Date.now()
      htmlToText(page, 'https://example.com/')
      expect(Date.now() - t).toBeLessThan(1000)
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
})
