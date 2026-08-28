// The agent column browser keeps its selection in local component state, so it
// resets every time the Agents page unmounts — which happens whenever the
// reader switches to another rail tab and back. This session-scoped ledger
// holds that selection across the unmount so returning restores the columns
// exactly as they were left. The transient sub-agent popup is deliberately not
// remembered: a modal should not reopen itself on return.
export type AgentBrowserState = {
  selectionPath: string[]
  activeColumn: number
}

let saved: AgentBrowserState = { selectionPath: [], activeColumn: 0 }

export const loadAgentBrowserState = (): AgentBrowserState => ({
  selectionPath: [...saved.selectionPath],
  activeColumn: saved.activeColumn,
})

export const saveAgentBrowserState = (state: AgentBrowserState): void => {
  saved = { selectionPath: [...state.selectionPath], activeColumn: state.activeColumn }
}

// Test-only: reset the module store between cases.
export const __resetAgentBrowserState = (): void => {
  saved = { selectionPath: [], activeColumn: 0 }
}
