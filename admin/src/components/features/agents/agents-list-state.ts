import { DEFAULT_PAGE_LIMIT } from '@nessie/schemas'
import type { AgentListTab } from './agents-list-tabs'

// The Agents page's per-tab page number is local state, which resets whenever
// the page unmounts — and it unmounts every time the reader switches rail tabs
// and back (the shell renders a single <Outlet>). This session-scoped ledger
// holds it across the unmount so returning restores the page the reader left
// on, matching the scroll/selection restoration the rest of the section already
// has. It resets on a full page reload, by design.
//
// The active tab itself lives in `?scope=` (docs/navigation/overview.md §1,
// "Tab hosts"); the copy kept here is the *default* the hook falls back to when
// the URL names none, which is what makes returning from an agent's page land
// on the tab the reader left rather than on Shared.
export type AgentsListState = {
  activeTab: AgentListTab
  pageByTab: Record<AgentListTab, number>
  pageSize: number
}

const createInitialState = (): AgentsListState => ({
  activeTab: 'shared',
  pageByTab: { 'built-in': 0, mine: 0, shared: 0 },
  pageSize: DEFAULT_PAGE_LIMIT,
})

let saved: AgentsListState = createInitialState()

export const loadAgentsListState = (): AgentsListState => ({
  activeTab: saved.activeTab,
  pageByTab: { ...saved.pageByTab },
  pageSize: saved.pageSize,
})

export const saveAgentsListState = (state: AgentsListState): void => {
  saved = {
    activeTab: state.activeTab,
    pageByTab: { ...state.pageByTab },
    pageSize: state.pageSize,
  }
}

// Test-only: reset the module store between cases.
export const __resetAgentsListState = (): void => {
  saved = createInitialState()
}
