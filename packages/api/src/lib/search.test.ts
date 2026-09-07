import { describe, expect, it } from 'vitest'
import { queryWords, relevanceScore, searchTermGroups, searchTerms, stem } from './search.js'

describe('search query understanding', () => {
  it('stems the usual English endings to a common prefix', () => {
    expect(['translate', 'translation', 'translating', 'translations', 'translated'].map(stem)).toEqual(['translat', 'translat', 'translat', 'translat', 'translat'])
    expect(stem('summaries')).toBe('summari')
    expect(stem('classification')).toBe('classificat')
    expect(stem('web')).toBe('web')
    expect(stem('json')).toBe('json')
  })

  it('drops stop words, dedupes, keeps at most 8 words and neutralises LIKE wildcards', () => {
    expect(queryWords('Translate my text to German, please')).toEqual(['translate', 'text', 'german'])
    expect(queryWords('an agent that can do web scraping for me')).toEqual(['web', 'scraping'])
    expect(queryWords('100%_sure')).toEqual(['100', 'sure'])
    expect(queryWords(undefined)).toEqual([])
    expect(queryWords('aa bb cc dd ee ff gg hh ii jj')).toHaveLength(8)
  })

  it('builds OR-groups with stems and synonyms, AND across words', () => {
    const groups = searchTermGroups('translate to german')
    expect(groups).toHaveLength(2)
    expect(groups[0]).toEqual(expect.arrayContaining(['%translate%', '%translat%', '%localiz%', '%i18n%']))
    expect(groups[1]).toEqual(expect.arrayContaining(['%german%', '%deutsch%']))
    expect(searchTerms('Translation services')).toEqual(['%translat%'])
    expect(searchTermGroups('scrape a web page')[0]).toEqual(expect.arrayContaining(['%scrape%', '%scrap%', '%extract%']))
  })

  it('ranks title and tag hits above description hits and rewards matching every word', () => {
    const translate = { title: 'Translate text between languages (LLM)', tags: ['translation', 'i18n'], category: 'language', description: 'Send text and a target language.' }
    const summarize = { title: 'Summarize a text or a web page', tags: ['summary'], category: 'language', description: 'Summaries with key points. Not a translation service.' }
    const web = { title: 'Fetch a web page and extract clean text', tags: ['web', 'scraping'], category: 'web', description: 'Readable text of a page.' }
    const q = 'translate text to german'
    expect(relevanceScore(q, translate)).toBeGreaterThan(relevanceScore(q, summarize))
    expect(relevanceScore(q, summarize)).toBeGreaterThan(relevanceScore(q, web))
    expect(relevanceScore('web scraping', web)).toBeGreaterThan(relevanceScore('web scraping', summarize))
    expect(relevanceScore('', web)).toBe(0)
  })
})
