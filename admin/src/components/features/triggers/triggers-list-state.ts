import { DEFAULT_PAGE_LIMIT } from '@nessie/schemas'

// The Triggers page's page number and page size, held across the unmount that
// opening a trigger causes (the shell renders a single <Outlet>), exactly as
// the agents and executors lists hold theirs. It resets on a full reload, by
// design. The status and type filters are not here: they are `?status=` and
// `?type=` on the URL, which is where anything linkable belongs.
export type TriggersListState = {
  page: number
  pageSize: number
}

const createInitialState = (): TriggersListState => ({
  page: 0,
  pageSize: DEFAULT_PAGE_LIMIT,
})

let saved: TriggersListState = createInitialState()

export const loadTriggersListState = (): TriggersListState => ({ ...saved })

export const saveTriggersListState = (state: TriggersListState): void => {
  saved = { page: state.page, pageSize: state.pageSize }
}

// Test-only: reset the module store between cases.
export const __resetTriggersListState = (): void => {
  saved = createInitialState()
}
