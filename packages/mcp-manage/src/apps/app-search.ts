import { Prisma, type PrismaClient } from '@prisma/client'

/**
 * Ranking for the store's one search box.
 *
 * The candidate ids come from the Prisma read that already applied
 * `storeCatalogWhere`, so this query only ever *orders* rows the caller was
 * already entitled to see. Restating the tenancy floor in SQL would be a
 * second copy of the rule, and a second copy is a second thing to get wrong.
 *
 * The document itself is the trigger-maintained `search_vector`
 * (`api/prisma/migrations/20260829090000_mcp_app_store_catalogue`), whose
 * weights encode the ranking the store needs: name and curated aliases are A,
 * the provider B, tags C, prose D — so a name match always outranks any number
 * of description hits.
 *
 * Every value is a bound parameter. A query string is never interpolated into
 * SQL: `websearch_to_tsquery` and `plainto_tsquery` parse arbitrary user text
 * safely, which is exactly why they are used instead of assembling a tsquery
 * by hand.
 */

type RankedRow = { id: string; rank: number }

const idList = (ids: readonly string[]): Prisma.Sql =>
  Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))

/**
 * `websearch_to_tsquery('simple', …)` keeps product names unstemmed (so
 * "Notion" does not become "notion"→"notio"-ish under an English stemmer) and
 * understands quoted phrases; it is OR'd with an English-stemmed query so
 * prose in the D-weighted description still matches ("issues" → "issue").
 */
const rankByFullText = async (
  prisma: PrismaClient,
  ids: readonly string[],
  query: string,
): Promise<RankedRow[]> =>
  prisma.$queryRaw<RankedRow[]>(Prisma.sql`
    SELECT e."id"::text AS id,
           ts_rank_cd(e."search_vector", tsq.q)::float8 AS rank
    FROM "mcp_catalog_entries" e,
         LATERAL (
           SELECT websearch_to_tsquery('simple', ${query})
                  || plainto_tsquery('english', ${query}) AS q
         ) tsq
    WHERE e."id" IN (${idList(ids)})
      AND e."search_vector" @@ tsq.q
  `)

/**
 * Nothing matched as words — so the query was probably mistyped ("githb").
 * Trigram similarity over the displayed name answers that, using the
 * `gin_trgm_ops` index the migration created. It runs only as a fallback:
 * a real word match must never be reordered by fuzzy noise.
 */
const rankByTrigram = async (
  prisma: PrismaClient,
  ids: readonly string[],
  query: string,
): Promise<RankedRow[]> =>
  prisma.$queryRaw<RankedRow[]>(Prisma.sql`
    SELECT e."id"::text AS id,
           similarity(lower(coalesce(e."display_name", e."label")), ${query})::float8 AS rank
    FROM "mcp_catalog_entries" e
    WHERE e."id" IN (${idList(ids)})
      AND lower(coalesce(e."display_name", e."label")) % ${query}
  `)

/**
 * Relevance per candidate id. An id absent from the map did not match at all,
 * which is how the caller narrows the list; ordering among matches is the
 * caller's, because "connected apps first" is a fact about the caller rather
 * than about the row.
 */
export const rankStoreAppsByQuery = async (
  prisma: PrismaClient,
  candidateIds: readonly string[],
  query: string,
): Promise<Map<string, number>> => {
  const trimmed = query.trim()
  if (trimmed.length === 0 || candidateIds.length === 0) return new Map()

  const matches = await rankByFullText(prisma, candidateIds, trimmed)
  const ranked = matches.length > 0
    ? matches
    : await rankByTrigram(prisma, candidateIds, trimmed)
  return new Map(ranked.map((row) => [row.id, row.rank]))
}
