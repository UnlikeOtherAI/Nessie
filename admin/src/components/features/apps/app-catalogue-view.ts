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

/** Device-local catalogue preference; it is a browsing choice, not account data. */
export const APPS_FILTER_STORAGE_KEY = 'nessie.apps.filter'

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

const appFilterStorage = (): Storage | null => {
  try {
    return globalThis.localStorage ?? null
  } catch {
    // Storage can be unavailable in private or constrained browser contexts.
    return null
  }
}

/** Falls back to All when browser storage is unavailable or contains stale data. */
export const readStoredAppFilter = (): AppFilter => {
  try {
    return parseAppFilter(appFilterStorage()?.getItem(APPS_FILTER_STORAGE_KEY) ?? null)
  } catch {
    return 'all'
  }
}

export const writeStoredAppFilter = (filter: AppFilter): void => {
  try {
    appFilterStorage()?.setItem(APPS_FILTER_STORAGE_KEY, filter)
  } catch {
    // The URL still preserves the active view for this browser session.
  }
}

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

/**
 * One shelf of the catalogue: the slice that arrived, and what SQL says exists.
 *
 * A shelf is usually a category, but not always. The Installed view is a single
 * shelf spanning every category (`category: null`) — a person's connected apps
 * are a list of things they own, not a store to browse, and three apps split
 * under three headings is three headings and no shelf. Both shapes page the
 * same way and render through the same component, so Installed is a *parameter*
 * of the shelf rather than a second grid beside it (`AGENTS.md` rule zero #4).
 */
export type AppShelfModel = {
  /** The slice the server sent for this shelf — never the whole shelf. */
  apps: AppSummaryRecord[]
  /** The category this shelf holds, or null for the flat Installed shelf. */
  category: AppCategory | null
  label: string
  /**
   * Apps on this shelf under the active narrowing, counted in SQL over the
   * unsliced set. `apps.length` is what arrived; this is what exists, and it is
   * the number "Show all N" says out loud.
   */
  total: number
}

/** A shelf that is a category — what the dropdown and the catalogue body use. */
export type AppCategorySectionModel = AppShelfModel & { category: AppCategory }

/**
 * The key a shelf is addressed by — in the DOM, and in its paging query. The
 * flat Installed shelf has no category, so it is named for what it is.
 */
export const shelfKey = (shelf: Pick<AppShelfModel, 'category'>): string =>
  shelf.category ?? 'installed'

/**
 * Everything this caller has connected, as one shelf.
 *
 * `total` is `installedCount` — the server's aggregate over the whole installed
 * set, which is exactly the population of this flat list — so "Load more (N
 * left)" is right even though the response carried one bounded page.
 */
export const installedShelf = (
  apps: readonly AppSummaryRecord[],
  installedCount: number,
): AppShelfModel => ({
  apps: [...apps],
  category: null,
  label: APP_FILTER_LABELS.installed,
  total: installedCount,
})

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


/**
 * The shelves the body renders. Narrowed to a category, that is only that one.
 *
 * `sections` stays whole for the dropdown — the server deliberately keeps
 * counting every category so you can switch to one you are not looking at — so
 * the narrowing belongs here, on the body, and never on the toolbar's source.
 */
export const visibleShelves = (
  sections: readonly AppCategorySectionModel[],
  activeCategory: AppCategory | null,
): AppCategorySectionModel[] =>
  activeCategory
    ? sections.filter((section) => section.category === activeCategory)
    : [...sections]


// ─── Category dropdown ─────────────────────────────────────────────────────

/** The select's value for "no category narrowing" — never a real category. */
export const ALL_CATEGORIES_VALUE = '__all__'

export type AppCategoryOption = {
  /** The label with its count spelled out: "Finance (640)". */
  label: string
  /** A category, or ALL_CATEGORIES_VALUE for the "All" first option. */
  value: AppCategory | typeof ALL_CATEGORIES_VALUE
}

/**
 * The options of the category dropdown: "All categories" first, then one option
 * per counted category in the taxonomy's fixed order (the order `sections`
 * already carries). Counts are the server's per-category aggregates, so
 * "Finance (640)" is 640 however few cards the page actually holds.
 *
 * The first option carries no count deliberately: it would restate the total
 * already on the All/Installed filter immediately to its left, and two adjacent
 * controls reading "All (1092)" say nothing about which one narrows what.
 */
export const appCategoryOptions = (
  sections: readonly AppCategorySectionModel[],
): AppCategoryOption[] => [
  { label: 'All categories', value: ALL_CATEGORIES_VALUE },
  ...sections.map((section) => ({
    label: `${section.label} (${section.total})`,
    value: section.category,
  })),
]

/** How many cards a collapsed section shows: two rows of whatever arrived. */
export const sectionVisibleApps = (
  section: AppShelfModel,
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
  section: AppShelfModel,
  pageSize: number,
): boolean => section.total > Math.min(pageSize, section.apps.length)

export const sectionToggleLabel = (
  section: AppShelfModel,
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

const ADD_CUSTOM_LABEL = 'Add custom app'

export type AppCatalogueNudge = { actionLabel: string; message: string }

/**
 * The nudge under the grid, present even with nothing typed: the escape hatch
 * has to exist before a person has already failed to find what they came for.
 *
 * It is deliberately *not* rendered under an empty grid. The empty state says
 * the same thing with the same button one line higher, and two identical offers
 * stacked on an otherwise blank page read as a rendering fault rather than as
 * emphasis.
 */
export const CATALOGUE_FOOTER_NUDGE: AppCatalogueNudge = {
  actionLabel: ADD_CUSTOM_LABEL,
  message: "Can't find what you need? Connect a tool by its address.",
}

/**
 * What an empty grid offers. `browse-all` drops the Installed narrowing and
 * keeps whatever was typed, so a search that found nothing among six connected
 * apps can be re-asked of the whole catalogue in one press.
 */
export type AppCatalogueEmptyActionId = 'add-custom' | 'browse-all'

export type AppCatalogueEmptyAction = { id: AppCatalogueEmptyActionId; label: string }

/** The first action is the one to press; the rest are secondary. */
export type AppCatalogueEmptyModel = {
  actions: AppCatalogueEmptyAction[]
  message: string
}

const ADD_CUSTOM_ACTION: AppCatalogueEmptyAction = {
  id: 'add-custom',
  label: ADD_CUSTOM_LABEL,
}

/**
 * Which nothing this is. "No results" and "nothing published yet" and "you have
 * connected nothing" are different situations with different next moves, and
 * one generic sentence answers none of them.
 *
 * Every sentence here names a move that is a button beside it. The copy used to
 * say "Switch to All" while the only control said "Add custom app" — an
 * instruction nobody could click, next to a button that did something else.
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
      actions: [ADD_CUSTOM_ACTION],
      message:
        'No apps have been published to your catalogue yet. '
        + 'Connect a tool by its address to add the first one.',
    }
  }
  if (query.length > 0 && input.filter === 'installed') {
    // The narrowing is half the answer: the app may well be in the catalogue,
    // it is just not one of the ones this team has connected.
    return {
      actions: [{ id: 'browse-all', label: 'Search all apps' }, ADD_CUSTOM_ACTION],
      message: `None of your installed apps match "${query}".`,
    }
  }
  if (query.length > 0) {
    return {
      actions: [ADD_CUSTOM_ACTION],
      message:
        `No apps match "${query}". Try a different word — `
        + 'or connect a tool by its address.',
    }
  }
  if (input.filter === 'installed') {
    return {
      actions: [{ id: 'browse-all', label: 'Browse all apps' }, ADD_CUSTOM_ACTION],
      message: "You haven't connected any apps yet.",
    }
  }
  return { actions: [ADD_CUSTOM_ACTION], message: CATALOGUE_FOOTER_NUDGE.message }
}
