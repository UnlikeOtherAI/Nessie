import { DEFAULT_PAGE_LIMIT } from '@nessie/schemas'

// The Executors page's page number and page size are local state, which resets
// whenever the page unmounts — and it unmounts every time the reader opens an
// executor and comes back (the shell renders a single <Outlet>). This
// session-scoped ledger holds them across that unmount, exactly as the agents
// list does, so returning from a detail page lands on the page you left. It
// resets on a full reload, by design.
export type ExecutorsListState = {
  page: number
  pageSize: number
}

const createInitialState = (): ExecutorsListState => ({
  page: 0,
  pageSize: DEFAULT_PAGE_LIMIT,
})

let saved: ExecutorsListState = createInitialState()

export const loadExecutorsListState = (): ExecutorsListState => ({ ...saved })

export const saveExecutorsListState = (state: ExecutorsListState): void => {
  saved = { page: state.page, pageSize: state.pageSize }
}

// Test-only: reset the module store between cases.
export const __resetExecutorsListState = (): void => {
  saved = createInitialState()
}
