import { Prisma, type PrismaClient } from '@prisma/client'
import type { AppCategory } from '@nessie/schemas'

/**
 * Ranking and slicing for the store's one search box — done entirely in
 * Postgres.
 *
 * **The candidate set is never materialised in Node.** The visibility predicate
 * is compiled into the ranking query itself, which orders by relevance and
 * applies its `LIMIT` there, so one search costs a fixed handful of bind
 * parameters however large the catalogue grows. The shape this replaced
 * hydrated every store-visible row and handed its id list back as
 * `id IN ($1, $2, …)` — one bind parameter per catalogue row. At the registry's
 * ~2,000 rows that pulled the whole catalogue into the API process on every
 * 150 ms-debounced keystroke (twice when the trigram fallback ran), and past
 * PostgreSQL's 65,535-parameter ceiling it stopped answering at all rather than
 * degrading — a ceiling four 20,000-row sweeps can reach.
 *
 * **The visibility predicate is compiled from `storeCatalogWhere`, never
 * restated.** This is the one place a hand-written `WHERE` could quietly drop
 * the tenancy floor and list another organisation's rows, so the SQL is
 * *derived* from the same Prisma clause the rest of the store reads with: the
 * compiler below walks that clause and refuses anything it does not understand
 * rather than skipping it, because a dropped term widens the result set.
 * `test/app-search-visibility.test.ts` runs both against the same rows and
 * asserts identical id sets.
 *
 * Every value is a bound parameter — the query text is never interpolated.
 * `websearch_to_tsquery` and `plainto_tsquery` parse arbitrary user text
 * safely, which is exactly why they are used instead of assembling a tsquery by
 * hand.
 *
 * The document being ranked is the trigger-maintained `search_vector`
 * (`api/prisma/migrations/20260829090000_mcp_app_store_catalogue`), whose
 * weights encode the ranking the store needs: name and curated aliases are A,
 * the provider B, tags C, prose D — so an alias match always outranks any
 * number of description hits.
 */

/** Every compiled fragment addresses the catalogue table under this alias. */
const ENTRY = 'e'

/**
 * How one catalogue column is compared in raw SQL.
 *
 * Prisma binds every JS string as `text`, so an enum or uuid column needs the
 * *parameter* cast to its own type — `moderation_state = $1` fails outright
 * with `operator does not exist: "McpAppModerationState" = text`. The cast sits
 * on the parameter rather than on the column so the composite indexes the store
 * migration created stay usable (the plan keeps
 * `Index Cond: moderation_state = …` rather than falling back to a filter).
 *
 * `nullable` exists because SQL `<>` and Prisma's `not` disagree about NULL
 * rows, and a silent disagreement here is a silent change to who can see what.
 * A `not` on a nullable column is refused rather than guessed.
 */
type ColumnBinding = {
  column: Prisma.Sql
  bind: (value: string) => Prisma.Sql
  nullable: boolean
}

const uuidBinding = (column: string): ColumnBinding => ({
  column: Prisma.raw(`"${ENTRY}"."${column}"`),
  bind: (value) => Prisma.sql`${value}::uuid`,
  nullable: true,
})

const enumBinding = (column: string, type: string): ColumnBinding => ({
  column: Prisma.raw(`"${ENTRY}"."${column}"`),
  bind: (value) => Prisma.sql`${value}::${Prisma.raw(`"${type}"`)}`,
  nullable: false,
})

/**
 * The columns `storeCatalogWhere` is allowed to mention. A field missing here
 * throws, so a future term added to the Prisma clause fails loudly in the
 * ranking query instead of being dropped from it.
 */
const STORE_COLUMNS: Readonly<Record<string, ColumnBinding>> = {
  id: { ...uuidBinding('id'), nullable: false },
  organizationId: uuidBinding('organization_id'),
  ownerUserId: uuidBinding('owner_user_id'),
  moderationState: enumBinding('moderation_state', 'McpAppModerationState'),
  trustLevel: enumBinding('trust_level', 'McpAppTrustLevel'),
  status: enumBinding('status', 'McpCatalogStatus'),
  visibility: enumBinding('visibility', 'McpCatalogVisibility'),
}

const ALWAYS = Prisma.sql`TRUE`
const NEVER = Prisma.sql`FALSE`

const combine = (terms: readonly Prisma.Sql[], operator: 'AND' | 'OR'): Prisma.Sql => {
  if (terms.length === 0) return operator === 'AND' ? ALWAYS : NEVER
  if (terms.length === 1) return terms[0] as Prisma.Sql
  return Prisma.sql`(${Prisma.join([...terms], ` ${operator} `)})`
}

type CatalogClause = Record<string, unknown>

const compileTerm = (field: string, value: unknown): Prisma.Sql => {
  const binding = STORE_COLUMNS[field]
  if (!binding) throw new Error(`app search: catalogue field "${field}" has no SQL binding`)
  if (value === null) return Prisma.sql`${binding.column} IS NULL`
  if (typeof value === 'string') return Prisma.sql`${binding.column} = ${binding.bind(value)}`
  if (typeof value === 'object') {
    const operator = value as { not?: unknown; in?: unknown }
    if (typeof operator.not === 'string') {
      if (binding.nullable) {
        throw new Error(`app search: "not" on nullable field "${field}" would change NULL handling`)
      }
      return Prisma.sql`${binding.column} <> ${binding.bind(operator.not)}`
    }
    if (Array.isArray(operator.in)) {
      const members = operator.in.filter((entry): entry is string => typeof entry === 'string')
      if (members.length !== operator.in.length) {
        throw new Error(`app search: "in" on field "${field}" carries a non-string member`)
      }
      if (members.length === 0) return NEVER
      return Prisma.sql`${binding.column} IN (${Prisma.join(members.map(binding.bind))})`
    }
  }
  throw new Error(`app search: unsupported operator on catalogue field "${field}"`)
}

const compileClause = (clause: CatalogClause): Prisma.Sql =>
  combine(
    Object.entries(clause).map(([key, value]) => {
      if (key !== 'AND' && key !== 'OR') return compileTerm(key, value)
      if (!Array.isArray(value)) throw new Error(`app search: "${key}" must be an array of clauses`)
      return combine(value.map((entry) => compileClause(entry as CatalogClause)), key)
    }),
    'AND',
  )

/**
 * The store's Prisma visibility clause as a SQL predicate over the alias `e`.
 *
 * Exported so the agreement test can put the two side by side on one set of
 * rows; the ranking queries below are its only production callers.
 */
export const compileCatalogWhere = (where: Prisma.McpCatalogEntryWhereInput): Prisma.Sql =>
  compileClause(where as CatalogClause)

/**
 * A ranked, still-unbounded match set, always used as a CTE. `sort_name` is
 * materialised here so the outer `ORDER BY` breaks rank ties on the rendered
 * name without recomputing the coalesce.
 */
const fullTextMatches = (where: Prisma.McpCatalogEntryWhereInput, query: string): Prisma.Sql =>
  Prisma.sql`
    SELECT e."id",
           e."primary_category",
           ts_rank_cd(e."search_vector", tsq.q)::float8 AS rank,
           lower(coalesce(e."display_name", e."label")) AS sort_name
    FROM "mcp_catalog_entries" e
    CROSS JOIN LATERAL (
      SELECT websearch_to_tsquery('simple', ${query})
             || plainto_tsquery('english', ${query}) AS q
    ) tsq
    WHERE ${compileCatalogWhere(where)}
      AND e."search_vector" @@ tsq.q
  `

/**
 * Nothing matched as words — so the query was probably mistyped ("githb").
 * Trigram similarity over the displayed name answers that, using the
 * `gin_trgm_ops` index the migration created. It runs only as a fallback: a
 * real word match must never be reordered by fuzzy noise.
 */
const trigramMatches = (where: Prisma.McpCatalogEntryWhereInput, query: string): Prisma.Sql =>
  Prisma.sql`
    SELECT e."id",
           e."primary_category",
           similarity(lower(coalesce(e."display_name", e."label")), ${query})::float8 AS rank,
           lower(coalesce(e."display_name", e."label")) AS sort_name
    FROM "mcp_catalog_entries" e
    WHERE ${compileCatalogWhere(where)}
      AND lower(coalesce(e."display_name", e."label")) % ${query}
  `

/**
 * Relevance decides first; among equally relevant apps the ones this caller has
 * already connected come first, because "my tools" is the likelier target. That
 * tiebreak is bound into the query rather than applied to the returned slice —
 * a tie straddling the limit would otherwise be resolved by the wrong half.
 * The id list is bounded by what the caller has installed (tens), not by the
 * catalogue.
 */
const connectedFirst = (connectedIds: readonly string[]): Prisma.Sql => {
  if (connectedIds.length === 0) return Prisma.empty
  const ids = Prisma.join(connectedIds.map((id) => Prisma.sql`${id}::uuid`))
  return Prisma.sql`(m."id" IN (${ids})) DESC,`
}

const categoryFilter = (category: AppCategory | undefined): Prisma.Sql =>
  category === undefined
    ? ALWAYS
    : Prisma.sql`m."primary_category" = ${category}::${Prisma.raw('"McpAppCategory"')}`

type MatchedIdRow = { id: string }
type CategoryCountRow = { category: string; total: number }

export type StoreSearchOptions = {
  /** The store visibility clause, exactly as the rest of the store reads it. */
  where: Prisma.McpCatalogEntryWhereInput
  query: string
  /** Narrows the slice only. The counts still describe every category. */
  category?: AppCategory
  connectedIds: readonly string[]
  limit: number
}

export type StoreSearchResult = {
  /** Ids in the server's authoritative order, already cut to `limit`. */
  ids: string[]
  /** SQL totals over the whole match set — before the category filter or limit. */
  countsByCategory: Map<AppCategory, number>
}

const EMPTY_RESULT: StoreSearchResult = { ids: [], countsByCategory: new Map() }

/**
 * One lane's answer: the bounded slice and the honest per-category totals. The
 * totals are a separate `GROUP BY` over the same match set rather than a tally
 * of the returned rows, because "Show all 412" must not be counted off a list
 * of 100.
 */
const runLane = async (
  prisma: PrismaClient,
  matches: Prisma.Sql,
  options: StoreSearchOptions,
): Promise<StoreSearchResult> => {
  const [ids, counts] = await Promise.all([
    prisma.$queryRaw<MatchedIdRow[]>(Prisma.sql`
      WITH matched AS (${matches})
      SELECT m."id"::text AS id
      FROM matched m
      WHERE ${categoryFilter(options.category)}
      ORDER BY m."rank" DESC, ${connectedFirst(options.connectedIds)} m."sort_name" ASC, m."id" ASC
      LIMIT ${options.limit}
    `),
    prisma.$queryRaw<CategoryCountRow[]>(Prisma.sql`
      WITH matched AS (${matches})
      SELECT m."primary_category"::text AS category, count(*)::int AS total
      FROM matched m
      GROUP BY m."primary_category"
    `),
  ])
  return {
    ids: ids.map((row) => row.id),
    countsByCategory: new Map(counts.map((row) => [row.category as AppCategory, row.total])),
  }
}

/**
 * The store's search, start to finish: word matches first, trigram only if the
 * words found nothing at all.
 */
export const searchStoreApps = async (
  prisma: PrismaClient,
  options: StoreSearchOptions,
): Promise<StoreSearchResult> => {
  const query = options.query.trim()
  if (query.length === 0) return EMPTY_RESULT

  const fullText = await runLane(prisma, fullTextMatches(options.where, query), options)
  // Emptiness is read off the unsliced totals, so a category filter that
  // happens to exclude every hit does not summon the fuzzy lane.
  if (fullText.countsByCategory.size > 0) return fullText
  return runLane(prisma, trigramMatches(options.where, query), options)
}
