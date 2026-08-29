import type { PrismaClient } from '@prisma/client'
import {
  APP_CATEGORY_LABELS,
  APP_CATEGORY_ORDER,
  type AppCategory,
  type AppCategoryCountRecord,
  type AppListResponse,
  type AppSummaryRecord,
  type AuthorizedActionContext,
} from '@nessie/schemas'

import { listInstancesVisibleToUser } from '../mcp-instances.js'
import { deriveConnectionStatus, groupConnectionsByApp } from './app-connections.js'
import { loadUnreachableAppIds } from './app-health.js'
import { presentAppSummary, STORE_CATALOG_SELECT } from './app-presenter.js'
import { rankStoreAppsByQuery } from './app-search.js'
import { storeCatalogWhere } from './app-store-visibility.js'

/**
 * The App Store catalogue read.
 *
 * Connection counts come from `listInstancesVisibleToUser` — what this caller
 * is *entitled* to see, never what the session's project/team happens to say
 * (`AGENTS.md` rule zero #2). The number on a card is therefore the same
 * number the detail view enumerates.
 */

export type StoreAppFilters = {
  category?: AppCategory
  installed?: boolean
  query?: string
}

/** How many apps stand in for a curated Featured row that nobody has curated. */
const FEATURED_FALLBACK_LIMIT = 5

const byDisplayName = (a: AppSummaryRecord, b: AppSummaryRecord): number =>
  a.displayName.localeCompare(b.displayName)

/**
 * Curation first. Without it the row falls back to the apps this caller has
 * actually connected — the shelf still renders, and it renders something true
 * about this workspace rather than an arbitrary five.
 */
const pickFeatured = (apps: readonly AppSummaryRecord[]): AppSummaryRecord[] => {
  const curated = apps.filter((app) => app.featured)
  if (curated.length > 0) {
    return [...curated].sort((a, b) => {
      const left = a.featuredOrder ?? Number.MAX_SAFE_INTEGER
      const right = b.featuredOrder ?? Number.MAX_SAFE_INTEGER
      return left === right ? byDisplayName(a, b) : left - right
    })
  }
  return [...apps]
    .sort((a, b) => b.connectionCount - a.connectionCount || byDisplayName(a, b))
    .slice(0, FEATURED_FALLBACK_LIMIT)
}

/**
 * An app appears under its `primaryCategory` alone, so these counts and the
 * rendered sections are the same number counted once. Empty categories are
 * omitted: a filter that leads to an empty grid is a filter that should not
 * have been offered.
 */
const countCategories = (
  primaryCategories: readonly AppCategory[],
): AppCategoryCountRecord[] => {
  const counts = new Map<AppCategory, number>()
  for (const category of primaryCategories) {
    counts.set(category, (counts.get(category) ?? 0) + 1)
  }
  return APP_CATEGORY_ORDER.filter((category) => (counts.get(category) ?? 0) > 0)
    .map((category) => ({
      category,
      label: APP_CATEGORY_LABELS[category],
      count: counts.get(category) ?? 0,
    }))
}

/**
 * Relevance decides first; among equally relevant apps the ones this caller
 * already connected come first, because "my tools" is the likelier target than
 * something new. With no query the shelf is alphabetical — a store people
 * revisit should not reorder itself under them.
 */
const sortApps = (
  apps: readonly AppSummaryRecord[],
  ranks: Map<string, number> | null,
): AppSummaryRecord[] =>
  [...apps].sort((a, b) => {
    if (ranks) {
      const byRank = (ranks.get(b.id) ?? 0) - (ranks.get(a.id) ?? 0)
      if (byRank !== 0) return byRank
      const byConnected =
        Number(b.connectionCount > 0) - Number(a.connectionCount > 0)
      if (byConnected !== 0) return byConnected
    }
    return byDisplayName(a, b)
  })

const loadStoreApps = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
): Promise<AppSummaryRecord[]> => {
  const organizationId = actorContext.tenant.organizationId
  const [rows, instances] = await Promise.all([
    prisma.mcpCatalogEntry.findMany({
      where: storeCatalogWhere(actorContext),
      select: STORE_CATALOG_SELECT,
    }),
    listInstancesVisibleToUser(
      prisma,
      organizationId,
      actorContext.actor.actorId,
    ),
  ])
  const unreachable = await loadUnreachableAppIds(prisma, rows.map((row) => row.id))
  const connections = groupConnectionsByApp(instances)

  return rows.map((row) =>
    presentAppSummary(row, {
      connectionStatuses: (connections.get(row.id) ?? []).map((instance) =>
        deriveConnectionStatus(instance.lifecycleState),
      ),
      serverUnreachable: unreachable.has(row.id),
    }),
  )
}

export const listStoreApps = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  filters: StoreAppFilters = {},
): Promise<AppListResponse> => {
  const visible = await loadStoreApps(prisma, actorContext)

  const installedOnly = filters.installed === true
    ? visible.filter((app) => app.connectionCount > 0)
    : visible
  const ranks = filters.query?.trim()
    ? await rankStoreAppsByQuery(
        prisma,
        installedOnly.map((app) => app.id),
        filters.query,
      )
    : null
  const matched = ranks
    ? installedOnly.filter((app) => ranks.has(app.id))
    : installedOnly

  return {
    // The category filter is applied last so the counts beside it describe
    // what switching to another category would actually show.
    apps: sortApps(
      filters.category
        ? matched.filter((app) => app.primaryCategory === filters.category)
        : matched,
      ranks,
    ),
    // The featured strip is drawn from everything visible, so it survives a
    // search or category filter narrowing the grid to nothing.
    featured: pickFeatured(visible),
    categories: countCategories(matched.map((app) => app.primaryCategory)),
    installedCount: visible.filter((app) => app.connectionCount > 0).length,
    totalCount: visible.length,
  }
}

/**
 * Category counts on their own, for the surface that needs the shelf labels
 * before it needs the shelf. Counted over everything this caller can see, so
 * every category offered has something behind it.
 */
export const listStoreAppCategories = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
): Promise<AppCategoryCountRecord[]> => {
  const rows = await prisma.mcpCatalogEntry.findMany({
    where: storeCatalogWhere(actorContext),
    select: { primaryCategory: true },
  })
  return countCategories(rows.map((row) => row.primaryCategory))
}
