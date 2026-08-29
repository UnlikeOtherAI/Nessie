import type {
  AppCategory,
  AppCategoryCountRecord,
  AppListResponse,
  AppSummaryRecord,
} from '@nessie/schemas'

/**
 * How the catalogue arranges itself: which apps a section holds, how much of it
 * a person sees before asking for the rest, and what an empty grid says.
 *
 * The shaping is local; the *facts* are not. Every count here comes from the
 * server's aggregates (`totalCount`, `installedCount`, `categories[].count`) and
 * never from the length of the array beside it, because the array is a bounded
 * slice of a catalogue that holds thousands of apps. "Show all 412" has to be
 * 412 whether the response carried twelve cards or forty-eight.
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

/**
 * The grid is narrowed by the *server* — a filter applied to a bounded slice
 * hides apps that are simply on another page, and contradicts the count printed
 * on the control that applied it.
 *
 * This survives for the Featured strip alone, which the server draws from
 * everything visible (at most five records, all of them present) so that it
 * outlives a search or a category narrowing the grid to nothing. Filtering that
 * one small, complete list locally drops nothing.
 */
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
  /** The slice the server sent for this category — never the whole category. */
  apps: AppSummaryRecord[]
  category: AppCategory
  label: string
  /**
   * Apps in this category under the active narrowing, counted in SQL over the
   * unsliced set. `apps.length` is what arrived; this is what exists, and it is
   * the number "Show all N" says out loud.
   */
  total: number
}

/**
 * One section per category the server counted, in the taxonomy's fixed order —
 * fixed so an app does not move down the page because somebody else in the
 * organisation connected something.
 *
 * The **counts** decide which sections exist, not the returned cards: a
 * category with 300 apps and a twelve-card shelf is one section either way, and
 * deriving the set from the slice would silently drop a shelf whose page had
 * not arrived. Cards keep the server's order — that order is the one paging
 * cuts on, so re-sorting here would make the boundary between page one and page
 * two meaningless.
 *
 * An app appears only under its `primaryCategory`. Listing GitHub under both
 * Development and Project Management doubles the page and makes every count a
 * lie; its secondary categories still match in search.
 */
export const buildCategorySections = (
  apps: readonly AppSummaryRecord[],
  categories: readonly AppCategoryCountRecord[],
): AppCategorySectionModel[] =>
  categories.map((entry) => ({
    apps: apps.filter((app) => app.primaryCategory === entry.category),
    category: entry.category,
    // The server labels its own counts from the one taxonomy constant, so the
    // heading and the count it sits beside can never name different categories.
    label: entry.label,
    total: entry.count,
  }))

/** How many cards a collapsed section shows: two rows of whatever arrived. */
export const sectionVisibleApps = (
  section: AppCategorySectionModel,
  pageSize: number,
  expanded: boolean,
): AppSummaryRecord[] =>
  expanded ? section.apps : section.apps.slice(0, pageSize)

/**
 * There is more of this category than a collapsed shelf shows — decided against
 * the SQL total, so the offer is right whether the rest is on this page or on
 * the next one.
 *
 * `other` used to be exempt on the grounds that the long tail is short. Registry
 * ingestion inverted that: uncategorised is now the largest shelf, and the one
 * that most needs paging.
 */
export const sectionOffersShowAll = (
  section: AppCategorySectionModel,
  pageSize: number,
): boolean => section.total > Math.min(pageSize, section.apps.length)

export const sectionToggleLabel = (
  section: AppCategorySectionModel,
  expanded: boolean,
): string => (expanded ? 'Show less ↑' : `Show all ${section.total} →`)

/** "Load more" only while the server says pages remain. */
export const sectionRemainingLabel = (loaded: number, total: number): string =>
  `Load more (${Math.max(0, total - loaded)} left)`

// ─── Search results ─────────────────────────────────────────────────────────

/**
 * How many apps matched, all of them, however few were sent. The server ranks
 * and returns its best hundred; the per-category counts are aggregates over the
 * whole match set, so summing them is the exact total rather than an estimate
 * from the truncated array.
 */
export const catalogueMatchTotal = (
  categories: readonly AppCategoryCountRecord[],
): number => categories.reduce((sum, entry) => sum + entry.count, 0)

/**
 * Said under the results count when the list is capped. Without it "340
 * results" sits above a hundred cards and a person concludes the page is broken
 * rather than that it is bounded.
 */
export const searchTruncationNote = (shown: number, total: number): string | null =>
  total > shown
    ? `Showing the ${shown} closest matches — narrow the search to see the rest.`
    : null

// ─── Empty grid ─────────────────────────────────────────────────────────────

export type AppCatalogueEmptyModel = { actionLabel: string; message: string }

const ADD_CUSTOM_LABEL = 'Add custom app'

/**
 * The nudge under the grid, present even with nothing typed: the escape hatch
 * has to exist before a person has already failed to find what they came for.
 */
export const CATALOGUE_FOOTER_NUDGE: AppCatalogueEmptyModel = {
  actionLabel: ADD_CUSTOM_LABEL,
  message: "Can't find what you need? Connect a tool by its address.",
}

/**
 * Which nothing this is. "No results" and "nothing published yet" and "you have
 * connected nothing" are three different situations with three different next
 * moves, and one generic sentence answers none of them.
 *
 * `query` must be the query the *rendered* response answers, not whatever the
 * search box currently holds: while "git" is in flight the page is still
 * showing the results for "g", and naming the pending query here asserts an
 * answer nobody has given yet.
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
        + 'Connect a tool by its address to add the first one.',
    }
  }
  if (query.length > 0) {
    return {
      actionLabel: ADD_CUSTOM_LABEL,
      message:
        `No apps match "${query}". Try a different word — `
        + 'or connect a tool by its address.',
    }
  }
  if (input.filter === 'installed') {
    // The sentence used to say "Switch to All" while the only button said "Add
    // custom app" — an instruction that was not clickable, beside a control
    // that did something else. Now the words describe the state and the button
    // is the action they name.
    return {
      actionLabel: ADD_CUSTOM_LABEL,
      message:
        "You haven't connected any apps yet. Browse the catalogue with the All "
        + 'filter above, or connect a tool by its address.',
    }
  }
  return CATALOGUE_FOOTER_NUDGE
}
