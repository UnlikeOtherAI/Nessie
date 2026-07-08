// Pure helpers for highlighting matched query terms inside a knowledge-base
// passage. Kept dependency-free (no React) so it can be unit tested in
// isolation from the rendering layer.

export interface PassageSegment {
  text: string
  matched: boolean
}

const MIN_TERM_LENGTH = 3

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Query words shorter than MIN_TERM_LENGTH are dropped — short words (like
// "the", "a", "of") would otherwise highlight nearly every passage.
const extractTerms = (query: string): string[] => {
  const seen = new Set<string>()
  for (const rawTerm of query.split(/\s+/)) {
    const term = rawTerm.trim()
    if (term.length >= MIN_TERM_LENGTH) {
      seen.add(term.toLowerCase())
    }
  }
  return Array.from(seen)
}

/**
 * Splits `passage` into segments, marking the ones that match a query term
 * (case-insensitive, whole-substring match) so callers can render matches
 * with emphasis. Returns the whole passage as a single unmatched segment when
 * there are no usable query terms.
 */
export const splitPassageMatches = (passage: string, query: string): PassageSegment[] => {
  const terms = extractTerms(query)
  if (!passage || terms.length === 0) {
    return [{ text: passage, matched: false }]
  }

  const pattern = new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'gi')
  const parts = passage.split(pattern).filter((part) => part.length > 0)

  return parts.map((part) => ({
    text: part,
    matched: terms.includes(part.toLowerCase()),
  }))
}

// Picks the highest-scoring passage from a hybrid-search hit's passage list.
export const selectBestPassage = <T extends { score: number }>(
  passages: T[] | undefined,
): T | null => {
  if (!passages || passages.length === 0) {
    return null
  }
  return passages.reduce((best, candidate) => (candidate.score > best.score ? candidate : best))
}
