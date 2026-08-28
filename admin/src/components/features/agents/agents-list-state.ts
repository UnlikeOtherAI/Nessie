import type { AgentScope } from './agent-scope'

// The Agents page keeps its active tab and per-tab page in local state, which
// resets whenever the page unmounts — and it unmounts every time the reader
// switches rail tabs and back (the shell renders a single <Outlet>). This
// session-scoped ledger holds that across the unmount so returning restores the
// tab and page the reader left on, matching the scroll/selection restoration the
// rest of the section already has. It resets on a full page reload, by design.
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
