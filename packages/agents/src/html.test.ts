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
