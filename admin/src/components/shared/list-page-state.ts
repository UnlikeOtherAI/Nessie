import { DEFAULT_PAGE_LIMIT } from '@nessie/schemas'

/**
 * Where a paged list's page number and page size live between visits.
 *
 * A list page's pager is local state, which resets whenever the page unmounts —
 * and it unmounts every time a reader opens a row and comes back, because the
 * shell renders a single `<Outlet>`. This session-scoped ledger holds it across
 * that unmount, so returning from a detail screen lands on the page you left,
 * matching the scroll and selection restoration the rest of the section has.
 * It resets on a full reload, by design.
 *
 * It is deliberately *not* the URL. `?page=3` would make a shared link mean
 * "the third page of whatever that list holds for you", which is a different
 * list for a different reader. Everything about a list that IS linkable — the
 * tab, the search phrase, the filters — stays in the query through
 * `useTabParam` and `useSearchParams`.
 *
 * One store per list. The agents list keeps a page *per scope tab* and so
 * carries its own richer ledger; every other list wants exactly this.
 */
export type ListPageState = {
  page: number
  pageSize: number
}

export type ListPageStore = {
  load: () => ListPageState
  /** Test-only: reset the module store between cases. */
  reset: () => void
  save: (state: ListPageState) => void
}

export const createListPageStore = (): ListPageStore => {
  const initial = (): ListPageState => ({ page: 0, pageSize: DEFAULT_PAGE_LIMIT })
  let saved = initial()

  return {
    load: () => ({ ...saved }),
    reset: () => { saved = initial() },
    save: (state) => { saved = { page: state.page, pageSize: state.pageSize } },
  }
}
