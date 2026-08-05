/**
 * Predictive `to_tsquery` input for message search.
 *
 * Each term gets a `:*` prefix match so a partial word like "tick" finds
 * "ticket". The input is sanitized down to bare alphanumeric tokens first, so a
 * user- or model-supplied query can never inject tsquery operators (`&`, `|`,
 * `!`, `<->`, parentheses) into the expression.
 *
 * Returns null when nothing survives sanitisation, which callers should treat
 * as "no results" rather than running an unbounded query.
 *
 * Shared by the human message-search endpoint and the agent conversation-search
 * tools so the two can never drift into different matching behaviour — or, as
 * before, into one using the FTS index and the other a table-scanning ILIKE.
 */
export const buildPrefixTsQuery = (query: string): string | null => {
  const prefixQuery = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `${term}:*`)
    .join(' & ')
  return prefixQuery.length > 0 ? prefixQuery : null
}
