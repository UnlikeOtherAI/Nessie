import type { AppCategory, AppListResponse, AppSummaryRecord } from '@nessie/schemas'
import { APP_CATEGORY_LABELS, APP_CATEGORY_ORDER } from '@nessie/schemas'

/**
 * How the catalogue arranges itself: which apps the current filter keeps, how
 * they fall into category sections, how much of a section a person sees before
 * asking for the rest, and what an empty grid says.
 *
 * All of it derives from the one list response, so switching filter or typing a
 * query never waits on the network — a store that stalls while you browse it is
 * a store nobody browses.
 */

// ─── Filter ─────────────────────────────────────────────────────────────────

export type AppFilter = 'all' | 'installed'

/**
 * Fixed order. "Available" and "Needs attention" join the end later; putting
 * them anywhere else would move the two options people already aim at.
 */
export const APP_FILTER_ORDER: readonly AppFilter[] = ['all', 'installed']

export const APP_FILTER_LABELS: Record<AppFilter, string> = {
  all: 'All',
  installed: 'Installed',
}

export const parseAppFilter = (raw: string | null): AppFilter =>
  raw === 'installed' ? 'installed' : 'all'

/**
 * Installed means "this caller can see at least one connected account", which
 * is the entitlement-scoped count the server sent — not everything the tenant
 * happens to hold.
 */
export const isInstalledApp = (app: AppSummaryRecord): boolean => app.connectionCount > 0

export const filterApps = (
  apps: readonly AppSummaryRecord[],
  filter: AppFilter,
): AppSummaryRecord[] =>
  filter === 'installed' ? apps.filter(isInstalledApp) : [...apps]

export type AppFilterOption = { count: number; label: string; value: AppFilter }

/**
 * Counts come from the server's own totals rather than from the loaded page, so
 * "All 47" stays 47 while a search narrows the grid to three.
 */
export const appFilterOptions = (
  totals: Pick<AppListResponse, 'installedCount' | 'totalCount'>,
): AppFilterOption[] =>
  APP_FILTER_ORDER.map((value) => ({
    count: value === 'installed' ? totals.installedCount : totals.totalCount,
    label: APP_FILTER_LABELS[value],
    value,
  }))

// ─── Grid geometry ──────────────────────────────────────────────────────────

/**
 * The grid's column ladder, stated once. `appGridColumns` below reports the
 * same ladder as a number so "show the first two rows" is computed from the
 * layout that actually rendered; the two must change together.
 *
 * Four columns at desktop, five only past 110rem — five dense columns any
 * earlier reads as a spreadsheet rather than a shelf.
 */
export const APP_GRID_CLASS = [
  'grid gap-4 grid-cols-1',
  'min-[28rem]:grid-cols-2',
  'md:grid-cols-3',
  'xl:grid-cols-4',
  'min-[110rem]:grid-cols-5',
].join(' ')

/** The two widths the named breakpoint scale cannot express. */
export const APP_GRID_TWO_COLUMN_QUERY = '(min-width: 28rem)'
export const APP_GRID_FIVE_COLUMN_QUERY = '(min-width: 110rem)'

export type AppGridBreakpointMatches = {
  /** ≥28rem, where a card still gets ~10rem of width in two columns. */
  twoColumns: boolean
  /** ≥48rem (md). */
  threeColumns: boolean
  /** ≥80rem (xl). */
  fourColumns: boolean
  /** ≥110rem. */
  fiveColumns: boolean
}

export const appGridColumns = (matches: AppGridBreakpointMatches): number => {
  if (matches.fiveColumns) return 5
  if (matches.fourColumns) return 4
  if (matches.threeColumns) return 3
  if (matches.twoColumns) return 2
  return 1
}

/** Two rows is enough of a category to judge it; more is a wall. */
export const SECTION_PAGE_ROWS = 2

export const sectionPageSize = (columns: number): number =>
  Math.max(1, columns) * SECTION_PAGE_ROWS

// ─── Category sections ──────────────────────────────────────────────────────

export type AppCategorySectionModel = {
  apps: AppSummaryRecord[]
  category: AppCategory
  label: string
}

/**
 * One section per category that still has an app, in the taxonomy's fixed
 * order — fixed so an app does not move down the page because somebody else in
 * the organisation connected something.
 *
 * An app appears only under its `primaryCategory`. Listing GitHub under both
 * Development and Project Management doubles the page and makes every count a
 * lie; its secondary categories still match in search.
 */
export const buildCategorySections = (
  apps: readonly AppSummaryRecord[],
): AppCategorySectionModel[] =>
  APP_CATEGORY_ORDER.flatMap((category) => {
    const inCategory = apps
      .filter((app) => app.primaryCategory === category)
      .sort((left, right) => left.displayName.localeCompare(right.displayName))
    return inCategory.length === 0
      ? []
      : [{ apps: inCategory, category, label: APP_CATEGORY_LABELS[category] }]
  })

/**
 * `Other` is the long tail and is usually short; a "Show all" link on it is a
 * control that saves nobody anything.
 */
const alwaysFullyShown = (category: AppCategory): boolean => category === 'other'

export const sectionVisibleApps = (
  section: AppCategorySectionModel,
  pageSize: number,
  expanded: boolean,
): AppSummaryRecord[] =>
  expanded || alwaysFullyShown(section.category) || section.apps.length <= pageSize
    ? section.apps
    : section.apps.slice(0, pageSize)

export const sectionOffersShowAll = (
  section: AppCategorySectionModel,
  pageSize: number,
): boolean => !alwaysFullyShown(section.category) && section.apps.length > pageSize

export const sectionToggleLabel = (
  section: AppCategorySectionModel,
  expanded: boolean,
): string => (expanded ? 'Show less ↑' : `Show all ${section.apps.length} →`)

// ─── Empty grid ─────────────────────────────────────────────────────────────

export type AppCatalogueEmptyModel = { actionLabel: string; message: string }

const ADD_CUSTOM_LABEL = 'Add custom app'

/**
 * The nudge under the grid, present even with nothing typed: the escape hatch
 * has to exist before a person has already failed to find what they came for.
 */
export const CATALOGUE_FOOTER_NUDGE: AppCatalogueEmptyModel = {
  actionLabel: ADD_CUSTOM_LABEL,
  message: "Can't find what you need? Add any MCP-compatible server as a custom app.",
}

/**
 * Which nothing this is. "No results" and "nothing published yet" and "you have
 * connected nothing" are three different situations with three different next
 * moves, and one generic sentence answers none of them.
 */
export const catalogueEmptyMessage = (input: {
  filter: AppFilter
  query: string
  totalCount: number
}): AppCatalogueEmptyModel => {
  const query = input.query.trim()
  if (input.totalCount === 0) {
    return {
      actionLabel: ADD_CUSTOM_LABEL,
      message:
        'No apps have been published to your catalogue yet. '
        + 'Add any MCP-compatible server as a custom app.',
    }
  }
  if (query.length > 0) {
    return {
      actionLabel: ADD_CUSTOM_LABEL,
      message:
        `No apps match "${query}". Try a different word — `
        + 'or add any MCP-compatible server as a custom app.',
    }
  }
  if (input.filter === 'installed') {
    return {
      actionLabel: ADD_CUSTOM_LABEL,
      message:
        "You haven't connected any apps yet. "
        + 'Switch to All to see what your team can connect.',
    }
  }
  return CATALOGUE_FOOTER_NUDGE
}
