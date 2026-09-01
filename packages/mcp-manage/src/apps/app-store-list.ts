import type { Prisma, PrismaClient } from '@prisma/client'
import {
  APP_CATEGORY_LABELS,
  APP_CATEGORY_ORDER,
  type AppCategory,
  type AppCategoryCountRecord,
  type AppListResponse,
  type AppSummaryRecord,
  type AuthorizedActionContext,
  type McpServerLifecycleState,
} from '@nessie/schemas'

import { listInstancesVisibleToUser } from '../mcp-instances.js'
import { deriveConnectionStatus, groupConnectionsByApp } from './app-connections.js'
import { loadUnreachableAppIds } from './app-health.js'
import {
  presentAppSummary,
  STORE_CATALOG_SELECT,
  type StoreCatalogRow,
} from './app-presenter.js'
import { searchStoreApps } from './app-search.js'
import {
  appHomeSuggestionRegistryNames,
  prioritizeHomeShelf,
} from './app-home-suggestions.js'
import { storeCatalogWhere } from './app-store-visibility.js'

/**
 * The App Store catalogue read.
 *
 * Two properties decide the shape of everything below.
 *
 * **It is bounded.** The official registry holds thousands of installable
 * servers, so no request may hydrate the whole catalogue: the default view is a
 * shelf of `CATEGORY_SHELF_LIMIT` per category, `?category=` is a page of
 * `CATEGORY_PAGE_LIMIT`, and `?query=` is the server-ranked top
 * `SEARCH_RESULT_LIMIT`. Phase 2 returned every row and the admin rendered
 * every card — fine for five apps, a broken page at two thousand.
 *
 * **Its counts are exact.** Every number on the wire — `totalCount`,
 * `installedCount`, and each `categories[].count` — is a SQL aggregate over the
 * *unsliced* set, never `apps.length`. These counts are what the screen says
 * out loud ("Show all 412", "340 results"), and a count derived from a
 * truncated array is a lie. The slice and the count are two different queries
 * on purpose.
 *
 * Connection counts still come from `listInstancesVisibleToUser` — what this
 * caller is *entitled* to see, never what the session's project/team happens to
 * say (`AGENTS.md` rule zero #2), so the number on a card is the number the
 * detail view enumerates.
 */

export type StoreAppFilters = {
  category?: AppCategory
  installed?: boolean
  query?: string
  /** Category paging only. The shelf and search have fixed sizes. */
  limit?: number
  offset?: number
}

/** Two rows on the widest grid: enough of a shelf to judge it, never a wall. */
export const CATEGORY_SHELF_LIMIT = 12

/** One "Show all" / "Load more" step inside a category. */
export const CATEGORY_PAGE_LIMIT = 48
export const CATEGORY_PAGE_LIMIT_MAX = 100

/**
 * Relevance decays fast and nobody scrolls a thousand ranked cards. The true
 * match total travels separately in `categories`, so a capped list is never
 * presented as a complete one.
 */
export const SEARCH_RESULT_LIMIT = 100

/** How many apps stand in for a Featured row that nobody has curated. */
const FEATURED_LIMIT = 5

/**
 * The shelf's total order, computed by the database because paging depends on
 * it: an `OFFSET` over a non-deterministic order both repeats and skips rows
 * between pages.
 *
 * `label` is the sort key rather than `displayName`: it is NOT NULL on every
 * row and is the app's own name from its source (the seed and registry
 * ingestion both write it), while `displayName` is a nullable curator override
 * of the *rendered* text. Prisma cannot order by `coalesce(display_name,
 * label)`, and sorting on the nullable column instead would file every
 * un-renamed registry app after every curated one. `id` breaks ties so two apps
 * sharing a label cannot swap places between two pages of the same list.
 */
const SHELF_ORDER: Prisma.McpCatalogEntryOrderByWithRelationInput[] = [
  { label: 'asc' },
  { id: 'asc' },
]

const byDisplayName = (a: AppSummaryRecord, b: AppSummaryRecord): number =>
  a.displayName.localeCompare(b.displayName)

const clampPageLimit = (limit: number | undefined): number =>
  Math.min(Math.max(1, Math.trunc(limit ?? CATEGORY_PAGE_LIMIT)), CATEGORY_PAGE_LIMIT_MAX)

const clampOffset = (offset: number | undefined): number =>
  Math.max(0, Math.trunc(offset ?? 0))

/**
 * Composed under `AND`, never spread: `storeCatalogWhere` carries a top-level
 * `OR`, and merging one object over another would silently drop it.
 */
const and = (
  ...clauses: Prisma.McpCatalogEntryWhereInput[]
): Prisma.McpCatalogEntryWhereInput => ({ AND: clauses })

const countRecord = (category: AppCategory, count: number): AppCategoryCountRecord => ({
  category,
  label: APP_CATEGORY_LABELS[category],
  count,
})

/**
 * An app appears under its `primaryCategory` alone, so a count and the section
 * it labels are the same apps counted once. Empty categories are omitted: a
 * filter that leads to an empty grid is a filter that should not be offered.
 */
const toCountRecords = (counts: Map<AppCategory, number>): AppCategoryCountRecord[] =>
  APP_CATEGORY_ORDER.filter((category) => (counts.get(category) ?? 0) > 0).map((category) =>
    countRecord(category, counts.get(category) ?? 0),
  )

/**
 * Counted by the database over the whole narrowed set. This is the number the
 * "Show all N" affordance says out loud, and the one thing that must never come
 * from the bounded slice beside it.
 */
const countCategories = async (
  prisma: PrismaClient,
  where: Prisma.McpCatalogEntryWhereInput,
): Promise<AppCategoryCountRecord[]> => {
  const groups = await prisma.mcpCatalogEntry.groupBy({
    by: ['primaryCategory'],
    where,
    _count: { _all: true },
  })
  return toCountRecords(
    new Map(groups.map((group) => [group.primaryCategory, group._count._all])),
  )
}

/** The same counts over everything visible, for a surface that wants only them. */
export const listStoreAppCategories = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
): Promise<AppCategoryCountRecord[]> =>
  countCategories(prisma, storeCatalogWhere(actorContext))

type ConnectionsByApp = Map<string, Array<{ lifecycleState: McpServerLifecycleState }>>

/**
 * Rows → wire records. Health is asked about the rendered slice only: the state
 * of an app nobody is looking at is not this request's business.
 */
const presentRows = (
  rows: readonly StoreCatalogRow[],
  connections: ConnectionsByApp,
  unreachable: ReadonlySet<string>,
): AppSummaryRecord[] =>
  rows.map((row) =>
    presentAppSummary(row, {
      connectionStatuses: (connections.get(row.id) ?? []).map((instance) =>
        deriveConnectionStatus(instance.lifecycleState),
      ),
      serverUnreachable: unreachable.has(row.id),
    }),
  )

type FeaturedRows = {
  /** True once a human has curated the strip, so no reordering is wanted. */
  curated: boolean
  rows: StoreCatalogRow[]
}

/**
 * Curation first. Without it the strip falls back to the apps this caller has
 * actually connected — it still renders, and it renders something true about
 * this workspace rather than an arbitrary five.
 *
 * With nothing curated *and* nothing connected the strip is empty rather than
 * the first five apps alphabetically. Across a registry-sized catalogue those
 * five are an accident of the alphabet, and a Featured shelf that means nothing
 * is worse than no shelf.
 */
const loadFeaturedRows = async (
  prisma: PrismaClient,
  storeWhere: Prisma.McpCatalogEntryWhereInput,
  connectedIds: readonly string[],
): Promise<FeaturedRows> => {
  const curated = await prisma.mcpCatalogEntry.findMany({
    where: and(storeWhere, { featured: true }),
    orderBy: [{ featuredOrder: 'asc' }, ...SHELF_ORDER],
    take: FEATURED_LIMIT,
    select: STORE_CATALOG_SELECT,
  })
  if (curated.length > 0) return { curated: true, rows: curated }
  if (connectedIds.length === 0) return { curated: true, rows: [] }
  // Bounded by what this caller has actually installed — tens of rows at most,
  // so "most connected first" can be decided after presentation.
  const connected = await prisma.mcpCatalogEntry.findMany({
    where: and(storeWhere, { id: { in: [...connectedIds] } }),
    orderBy: SHELF_ORDER,
    select: STORE_CATALOG_SELECT,
  })
  return { curated: false, rows: connected }
}

const orderFeatured = (
  apps: readonly AppSummaryRecord[],
  curated: boolean,
): AppSummaryRecord[] =>
  curated
    ? [...apps]
    : [...apps]
      .sort((a, b) => b.connectionCount - a.connectionCount || byDisplayName(a, b))
      .slice(0, FEATURED_LIMIT)

type PageResult = {
  categories: AppCategoryCountRecord[]
  rows: StoreCatalogRow[]
}

/**
 * The default view: one bounded query per shelf rather than one unbounded query
 * for the page. Only the categories the count query reports as non-empty are
 * asked for, so an instance with three populated categories issues three reads.
 */
const loadShelfPage = async (
  prisma: PrismaClient,
  where: Prisma.McpCatalogEntryWhereInput,
  includeSuggestions: boolean,
): Promise<PageResult> => {
  const [categories, suggestions] = await Promise.all([
    countCategories(prisma, where),
    includeSuggestions
      ? prisma.mcpCatalogEntry.findMany({
        where: and(where, { registryName: { in: appHomeSuggestionRegistryNames() } }),
        select: STORE_CATALOG_SELECT,
      })
      : Promise.resolve([]),
  ])
  const shelves = await Promise.all(
    categories.map((entry) =>
      prisma.mcpCatalogEntry.findMany({
        where: and(where, { primaryCategory: entry.category }),
        orderBy: SHELF_ORDER,
        take: CATEGORY_SHELF_LIMIT,
        select: STORE_CATALOG_SELECT,
      }),
    ),
  )
  return {
    categories,
    rows: categories.flatMap((entry, index) =>
      prioritizeHomeShelf(
        entry.category,
        suggestions,
        shelves[index] ?? [],
        CATEGORY_SHELF_LIMIT,
      ),
    ),
  }
}

/**
 * One category, paged. The counts still describe every category, so the client
 * can say how far through this one it is *and* keep offering the others.
 */
const loadCategoryPage = async (
  prisma: PrismaClient,
  where: Prisma.McpCatalogEntryWhereInput,
  category: AppCategory,
  filters: StoreAppFilters,
): Promise<PageResult> => {
  const [categories, rows] = await Promise.all([
    countCategories(prisma, where),
    prisma.mcpCatalogEntry.findMany({
      where: and(where, { primaryCategory: category }),
      orderBy: SHELF_ORDER,
      skip: clampOffset(filters.offset),
      take: clampPageLimit(filters.limit),
      select: STORE_CATALOG_SELECT,
    }),
  ])
  return { categories, rows }
}

/**
 * Search: ranked, counted, and cut to `SEARCH_RESULT_LIMIT` by Postgres.
 *
 * Nothing here sees a candidate set. `searchStoreApps` compiles this very
 * `where` into the ranking query and applies the `LIMIT` there, so the only
 * rows that reach this process are the ones about to be rendered, and the
 * per-category totals are a SQL `GROUP BY` over the whole match set rather than
 * a tally of the slice. The previous shape hydrated every visible row and sent
 * one bind parameter per catalogue row back down — thousands per keystroke, and
 * a hard failure past PostgreSQL's 65,535-parameter ceiling.
 *
 * The hydration re-applies the same Prisma clause the ids came from: it costs
 * nothing on an id lookup and keeps the store's visibility rule on the last
 * read as well as the first.
 */
const loadSearchPage = async (
  prisma: PrismaClient,
  where: Prisma.McpCatalogEntryWhereInput,
  query: string,
  filters: StoreAppFilters,
  connectedIds: readonly string[],
): Promise<PageResult> => {
  const found = await searchStoreApps(prisma, {
    where,
    query,
    // The category filter narrows the slice only, so the counts beside it still
    // describe what switching to another category would show.
    category: filters.category,
    connectedIds,
    limit: SEARCH_RESULT_LIMIT,
  })
  const categories = toCountRecords(found.countsByCategory)
  if (found.ids.length === 0) return { categories, rows: [] }

  const rows = await prisma.mcpCatalogEntry.findMany({
    where: and(where, { id: { in: found.ids } }),
    select: STORE_CATALOG_SELECT,
  })
  // The database returns the rows; the ranking decides their order.
  const byId = new Map(rows.map((row) => [row.id, row]))
  return {
    categories,
    rows: found.ids.flatMap((id) => {
      const row = byId.get(id)
      return row ? [row] : []
    }),
  }
}

const loadPage = (
  prisma: PrismaClient,
  where: Prisma.McpCatalogEntryWhereInput,
  query: string,
  filters: StoreAppFilters,
  connectedIds: readonly string[],
): Promise<PageResult> => {
  if (query.length > 0) return loadSearchPage(prisma, where, query, filters, connectedIds)
  if (filters.category) return loadCategoryPage(prisma, where, filters.category, filters)
  return loadShelfPage(prisma, where, filters.installed !== true)
}

export const listStoreApps = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  filters: StoreAppFilters = {},
): Promise<AppListResponse> => {
  const instances = await listInstancesVisibleToUser(
    prisma,
    actorContext.tenant.organizationId,
    actorContext.actor.actorId,
  )
  const connections: ConnectionsByApp = groupConnectionsByApp(instances)
  const connectedIds = [...connections.keys()]

  const storeWhere = storeCatalogWhere(actorContext)
  const connectedWhere = and(storeWhere, { id: { in: connectedIds } })
  // The narrowing the caller asked for. The category filter is deliberately not
  // folded in here: it decides the slice, never the counts beside it.
  const narrowed = filters.installed === true ? connectedWhere : storeWhere

  const query = filters.query?.trim() ?? ''
  const [totalCount, installedCount, featured, page] = await Promise.all([
    prisma.mcpCatalogEntry.count({ where: storeWhere }),
    connectedIds.length === 0
      ? Promise.resolve(0)
      : prisma.mcpCatalogEntry.count({ where: connectedWhere }),
    loadFeaturedRows(prisma, storeWhere, connectedIds),
    loadPage(prisma, narrowed, query, filters, connectedIds),
  ])

  const rendered = [...page.rows, ...featured.rows]
  const unreachable = await loadUnreachableAppIds(prisma, rendered.map((row) => row.id))

  return {
    apps: presentRows(page.rows, connections, unreachable),
    // Drawn from everything visible, so the strip survives a search or a
    // category filter narrowing the grid to nothing.
    featured: orderFeatured(
      presentRows(featured.rows, connections, unreachable),
      featured.curated,
    ),
    categories: page.categories,
    // Both totals keep their Phase 2 meaning — the whole store this caller can
    // see, before any narrowing — so the filter reads "All 1,970 / Installed 6"
    // whichever of the two is selected.
    installedCount,
    totalCount,
  }
}
