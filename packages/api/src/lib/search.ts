/**
 * Query understanding for listings, bounties and agents, shared by the three search functions.
 *
 * Every word of the query becomes a GROUP of LIKE patterns (the word, its stem and its synonyms): OR within a
 * group, AND across groups. Stop words are dropped; "translate text to german" asks for translat* AND text AND
 * german. Callers fall back to OR across groups when AND finds nothing, and re-rank relevance in memory with
 * `relevanceScore` (title and tags weigh more than the description).
 */

const STOP = new Set(['a', 'an', 'and', 'the', 'to', 'for', 'of', 'in', 'on', 'with', 'my', 'me', 'i', 'we', 'you', 'is', 'are', 'be', 'do', 'can', 'need', 'want', 'some', 'any', 'that', 'this', 'from', 'into', 'by', 'at', 'or', 'it', 'as', 'agent', 'agents', 'service', 'services', 'please', 'help'])

/** Domain synonyms: each stem maps to other stems that mean the same thing on this marketplace. */
const SYNONYMS: Record<string, string[]> = {
  translat: ['localiz', 'localis', 'i18n', 'multilingual', 'language'],
  localiz: ['translat', 'i18n'],
  summar: ['tldr', 'digest', 'abstract', 'brief'],
  summari: ['summar', 'tldr', 'digest'],
  summary: ['summar', 'tldr', 'digest'],
  tldr: ['summar'],
  extract: ['scrap', 'pars', 'crawl', 'fetch', 'read'],
  scrap: ['extract', 'crawl', 'fetch', 'web'],
  crawl: ['scrap', 'extract', 'fetch'],
  classif: ['label', 'categor', 'tag', 'sentiment', 'intent', 'triag', 'moderat'],
  classificat: ['classif', 'label', 'categor'],
  label: ['classif', 'categor', 'annotat'],
  sentiment: ['classif'],
  validat: ['check', 'verif', 'lint', 'schema'],
  verif: ['validat', 'check'],
  json: ['schema', 'structur'],
  structur: ['json', 'extract', 'schema'],
  web: ['url', 'page', 'website', 'html', 'scrap', 'site'],
  url: ['web', 'page', 'link'],
  html: ['web', 'page'],
  imag: ['pictur', 'photo', 'vision', 'ocr'],
  ocr: ['imag', 'vision', 'text'],
  code: ['program', 'review', 'refactor', 'debug', 'softwar'],
  review: ['audit', 'critiqu', 'feedback', 'assess'],
  audit: ['review', 'secur'],
  secur: ['audit', 'pentest', 'vulnerab', 'bug'],
  bug: ['secur', 'defect', 'issu'],
  research: ['analys', 'report', 'investig', 'stud'],
  analys: ['research', 'analyt', 'report'],
  data: ['dataset', 'csv', 'tabl', 'spreadsheet'],
  csv: ['data', 'tabl', 'spreadsheet'],
  email: ['mail', 'outreach', 'inbox'],
  writ: ['copywrit', 'draft', 'author', 'content', 'blog'],
  content: ['writ', 'copywrit', 'blog', 'articl'],
  monitor: ['watch', 'alert', 'track', 'uptim'],
  test: ['qa', 'walkthrough', 'sandbox'],
  integrat: ['plugin', 'tool', 'connector', 'sdk', 'framework'],
  plugin: ['integrat', 'tool', 'extension'],
  math: ['calcul', 'comput', 'formula'],
  legal: ['contract', 'law', 'complianc'],
  financ: ['account', 'invoic', 'tax', 'bookkeep'],
  invoic: ['financ', 'bill', 'receipt'],
  speech: ['audio', 'transcri', 'voic'],
  transcri: ['speech', 'audio', 'voic', 'subtitl'],
  video: ['youtub', 'clip', 'subtitl'],
  german: ['deutsch', 'de'],
  french: ['fr', 'francais'],
  spanish: ['es', 'espanol'],
  japanese: ['ja', 'jp'],
  chinese: ['zh', 'mandarin'],
  english: ['en'],
}

/** Cheap English stemming: enough to make "translation", "translating" and "translate" meet at "translat". */
export function stem(word: string): string {
  let w = word.toLowerCase()
  if (w.length <= 3) return w
  const rules: [RegExp, string][] = [
    [/(iz|is)ations?$/, 'iz'],
    [/ations?$/, 'at'],
    [/(ing|ings)$/, ''],
    [/(ers|er|ors|or)$/, ''],
    [/ies$/, 'i'],
    [/(ed|es)$/, ''],
    [/ly$/, ''],
    [/s$/, ''],
  ]
  for (const [re, rep] of rules) {
    if (re.test(w)) {
      const next = w.replace(re, rep)
      if (next.length >= 3) w = next
      break
    }
  }
  if (/e$/.test(w) && w.length > 4) w = w.slice(0, -1) // translate -> translat, summarise -> summaris
  return w
}

export function queryWords(q: string | undefined): string[] {
  if (!q) return []
  const words = q
    .toLowerCase()
    .replace(/[%_]/g, ' ')
    .split(/[^a-z0-9äöüß+#.-]+/)
    .map((w) => w.replace(/^[.-]+|[.-]+$/g, ''))
    .filter((w) => w.length >= 2 && !STOP.has(w))
  return [...new Set(words)].slice(0, 8)
}

/** One group of LIKE patterns per query word: the word, its stem and its synonyms (OR within, AND across). */
export function searchTermGroups(q: string | undefined): string[][] {
  return queryWords(q).map((w) => {
    const s = stem(w)
    const variants = new Set<string>([w, s])
    for (const syn of SYNONYMS[s] ?? SYNONYMS[w] ?? []) variants.add(syn)
    return [...variants].filter((v) => v.length >= 2).map((v) => `%${v}%`)
  })
}

/** Backwards-compatible flat list (one stem pattern per word): AND across words. */
export function searchTerms(q: string | undefined): string[] {
  return queryWords(q).map((w) => `%${stem(w)}%`)
}

export type Scorable = { title?: string | null; tags?: string[] | null; category?: string | null; description?: string | null; extra?: string | null }

/** In-memory relevance: which query groups hit which field. Title and tags count most; the exact word beats stem or synonym. */
export function relevanceScore(q: string | undefined, row: Scorable): number {
  const groups = searchTermGroups(q)
  if (!groups.length) return 0
  const title = (row.title ?? '').toLowerCase()
  const tags = (row.tags ?? []).join(' ').toLowerCase()
  const category = (row.category ?? '').toLowerCase()
  const description = (row.description ?? '').toLowerCase()
  const extra = (row.extra ?? '').toLowerCase()
  let score = 0
  let groupsHit = 0
  for (const group of groups) {
    const needles = group.map((p) => p.replace(/%/g, ''))
    const exact = needles[0]!
    let best = 0
    for (const n of needles) {
      const w = n === exact ? 1 : 0.7
      if (title.includes(n)) best = Math.max(best, 5 * w)
      if (tags.includes(n)) best = Math.max(best, 4 * w)
      if (category.includes(n)) best = Math.max(best, 3 * w)
      if (description.includes(n)) best = Math.max(best, 1.5 * w)
      if (extra.includes(n)) best = Math.max(best, 1 * w)
    }
    if (best > 0) groupsHit++
    score += best
  }
  // every word matched: a bonus that outranks any single-field jackpot
  if (groupsHit === groups.length) score += 3 * groups.length
  return Math.round(score * 100) / 100
}
