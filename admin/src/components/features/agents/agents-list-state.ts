import type { AgentScope } from './agent-scope'

// The Agents page's per-tab page number is local state, which resets whenever
// the page unmounts — and it unmounts every time the reader switches rail tabs
// and back (the shell renders a single <Outlet>). This session-scoped ledger
// holds it across the unmount so returning restores the page the reader left
// on, matching the scroll/selection restoration the rest of the section already
// has. It resets on a full page reload, by design.
//
// The active scope itself lives in `?scope=` now (docs/navigation.md §1, "Tab
// hosts"); the copy kept here is the *default* the hook falls back to when the
// URL names no scope, which is what makes returning from an agent's detail land
// on the tab the reader left rather than on Team.
export type AgentsListState = {
  activeScope: AgentScope
  pageByScope: Record<AgentScope, number>
}

const createInitialState = (): AgentsListState => ({
  activeScope: 'team',
  pageByScope: { global: 0, personal: 0, team: 0 },
})

let saved: AgentsListState = createInitialState()

export const loadAgentsListState = (): AgentsListState => ({
  activeScope: saved.activeScope,
  pageByScope: { ...saved.pageByScope },
})

export const saveAgentsListState = (state: AgentsListState): void => {
  saved = {
    activeScope: state.activeScope,
    pageByScope: { ...state.pageByScope },
  }
}

// Test-only: reset the module store between cases.
export const __resetAgentsListState = (): void => {
  saved = createInitialState()
}
