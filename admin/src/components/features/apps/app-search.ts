import type { AppSummaryRecord } from '@nessie/schemas'
import { APP_CATEGORY_LABELS } from '@nessie/schemas'
import { appCardMeta } from './app-card-presentation'

/**
 * Presentation for search results. **The server decides what matches and in
 * what order** — this module only explains the answer it gave.
 *
 * Searching a shelf is a "where is that one app" question, so the answer is a
 * ranking, not a re-grouping: a flat grid in one order, with the best match
 * first. Regrouping by category would re-bury the top hit under a heading and
 * make a person re-parse section chrome to answer "is GitHub here?".
 *
 * Ranking deliberately does NOT live here. Postgres holds a weighted
 * `search_vector` (name and curated aliases at weight A, publisher B, tags C,
 * prose D) plus a pg_trgm fallback that recovers typos. Re-scoring its results
 * on the client would *drop* rows: "githb" reaches GitHub only through
 * similarity, and no substring test on the loaded record can reproduce that —
 * the card would simply vanish. So the client filters nothing and re-sorts
 * nothing; it labels each row with why it matched.
 */

/** Below this the catalogue view stays; one letter matches half the store. */
export const APP_SEARCH_MIN_LENGTH = 2

export const isAppSearchActive = (query: string): boolean =>
  query.trim().length >= APP_SEARCH_MIN_LENGTH

export type AppSearchTier =
  | 'name'
  | 'alias'
  | 'provider'
  | 'tag'
  | 'category'
  | 'description'
  | 'other'

const contains = (haystack: string | null, needle: string): boolean =>
  haystack !== null && haystack.toLowerCase().includes(needle)

/**
 * Where the query is visible in this record, checked in the same order the
 * server weights them. This is a *description* of a match the server already
 * made, not a test of whether it matched — `other` is the honest answer when
 * the server matched on something the loaded record cannot show (a stemmed
 * word in the long description, or a fuzzy name match).
 */
const matchTier = (app: AppSummaryRecord, needle: string): AppSearchTier => {
  if (contains(app.displayName, needle) || contains(app.name, needle)) return 'name'
  if (app.aliases.some((alias) => alias.toLowerCase().includes(needle))) return 'alias'
  if (contains(app.vendor, needle)) return 'provider'
  if (app.tags.some((tag) => tag.toLowerCase().includes(needle))) return 'tag'
  // Secondary categories count here even though the card only prints the
  // primary one — this is where multi-category membership earns its keep.
  const categoryMatch = app.categories.some((category) =>
    APP_CATEGORY_LABELS[category].toLowerCase().includes(needle),
  )
  if (categoryMatch || APP_CATEGORY_LABELS[app.primaryCategory].toLowerCase().includes(needle)) {
    return 'category'
  }
  if (contains(app.shortDescription, needle)) return 'description'
  return 'other'
}

/**
 * A one-line hint under the description, for a match that landed somewhere the
 * card does not print. Without it a person sees a result highlighted nowhere
 * and stops trusting the ranking.
 */
export const searchProvenance = (
  app: AppSummaryRecord,
  tier: AppSearchTier,
  query: string,
): string | null => {
  if (tier === 'alias') return `Also known as "${query}"`
  if (tier === 'tag') return `Matches "${query}" in tags`
  if (tier === 'provider') {
    // The publisher is on the card only while there is no capability count to
    // print instead, so the hint is needed exactly when the meta line is taken.
    const meta = appCardMeta(app)
    return meta !== null && meta.startsWith('By ')
      ? null
      : `Matches "${query}" in the publisher name`
  }
  // `other` covers a stemmed word in the long description and a fuzzy name
  // match ("githb" → GitHub). Saying nothing would leave a card highlighted
  // nowhere, which reads as a wrong result rather than a lenient one.
  if (tier === 'other') return `Close match for "${query}"`
  return null
}

export type AppSearchResult = {
  app: AppSummaryRecord
  provenance: string | null
  tier: AppSearchTier
}

/**
 * Labels the server's already-ranked results, preserving their order exactly.
 * No filtering and no re-sorting: see the module comment — re-scoring here
 * would silently drop the rows only Postgres could find.
 */
export const describeSearchResults = (
  apps: readonly AppSummaryRecord[],
  rawQuery: string,
): AppSearchResult[] => {
  const query = rawQuery.trim()
  if (!isAppSearchActive(query)) return []
  const needle = query.toLowerCase()

  return apps.map((app) => {
    const tier = matchTier(app, needle)
    return { app, provenance: searchProvenance(app, tier, query), tier }
  })
}

export const searchResultsLabel = (count: number, query: string): string =>
  `${count} ${count === 1 ? 'result' : 'results'} for "${query.trim()}"`

// ─── Highlighting ───────────────────────────────────────────────────────────

export type HighlightSegment = { match: boolean; text: string }

/**
 * Splits a string around every case-insensitive occurrence of the query, so the
 * renderer can mark the matched runs without building a regex from user input.
 */
export const highlightSegments = (text: string, query: string): HighlightSegment[] => {
  const needle = query.trim().toLowerCase()
  if (!isAppSearchActive(needle)) return [{ match: false, text }]

  const segments: HighlightSegment[] = []
  const haystack = text.toLowerCase()
  let cursor = 0

  for (
    let found = haystack.indexOf(needle);
    found !== -1;
    found = haystack.indexOf(needle, cursor)
  ) {
    if (found > cursor) segments.push({ match: false, text: text.slice(cursor, found) })
    segments.push({ match: true, text: text.slice(found, found + needle.length) })
    cursor = found + needle.length
  }

  if (cursor < text.length) segments.push({ match: false, text: text.slice(cursor) })
  return segments.length > 0 ? segments : [{ match: false, text }]
}
