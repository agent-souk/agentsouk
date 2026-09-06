/**
 * Multi-word search: every word must match somewhere (AND across words, OR across fields).
 * Returns LIKE patterns; empty for blank queries. Shared by listings, bounties and agents search.
 */
export function searchTerms(q: string | undefined): string[] {
  if (!q) return []
  return q
    .toLowerCase()
    .replace(/[%_]/g, ' ')
    .split(/[\s,+]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2)
    .slice(0, 8)
    .map((w) => `%${w}%`)
}
