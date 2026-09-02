import { createContext, useContext, type ReactNode } from 'react'
import type { AdminShellOutletContext } from './types'

// The shell's actions a page may call (open the designer, create a channel,
// select an agent) travel as one context rather than as the outlet's props,
// so a page rendered by the navigation stack for a seeded route
// (docs/navigation/overview.md §8) reads them exactly as the routed page does.
const ShellActionsContext = createContext<AdminShellOutletContext | null>(null)

export const ShellActionsProvider = ({
  children,
  value,
}: {
  children: ReactNode
  value: AdminShellOutletContext
}) => <ShellActionsContext.Provider value={value}>{children}</ShellActionsContext.Provider>

export const useShellActions = (): AdminShellOutletContext => {
  const actions = useContext(ShellActionsContext)
  if (!actions) throw new Error('useShellActions must be used inside the admin shell')
  return actions
}
