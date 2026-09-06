import { createContext, useContext, type ReactNode } from 'react'
import { UserMenuTrigger } from './UserMenuTrigger'
import type { ShellActions } from './types'

// Three former single-purpose contexts (account-menu visibility, the mobile
// drawer's open callback, the shell's create/select actions) collapsed into
// one: each existed only to carry one prop past the captured route element,
// and each cost its own provider layer on every authenticated render
// (docs audit 07-F10). `AdminShellLayout` mounts exactly one of these with a
// memoised value.
export type ShellState = ShellActions & {
  onLogout: () => void
  openDrawer: () => void
  showHeaderAccountMenu: boolean
}

const ShellStateContext = createContext<ShellState | null>(null)

export const ShellStateProvider = ({
  children,
  value,
}: {
  children: ReactNode
  value: ShellState
}) => <ShellStateContext.Provider value={value}>{children}</ShellStateContext.Provider>

// Off-shell null-safe: `ResponsivePageHeader` and `PhoneNavigationButton`
// both render in component tests with no shell mounted above them, and must
// degrade quietly rather than throw.
export const useShellState = (): ShellState | null => useContext(ShellStateContext)

export const useHeaderAccountMenuVisible = (): boolean =>
  useShellState()?.showHeaderAccountMenu ?? false

// Returns the mobile-nav controls when rendered inside the admin shell, or
// null otherwise (so `PhoneNavigationButton` can no-op safely off-shell).
export const useMobileNav = (): Pick<ShellState, 'openDrawer'> | null => useShellState()

// A mobile shell without the web top bar supplies the desktop rail's canonical
// account trigger in every shared page header instead.
export const HeaderAccountMenu = () => {
  const shellState = useShellState()

  if (!shellState?.showHeaderAccountMenu) return null

  return <UserMenuTrigger onLogout={shellState.onLogout} placement="topbar" />
}

export const useShellActions = (): ShellActions => {
  const shellState = useContext(ShellStateContext)
  if (!shellState) throw new Error('useShellActions must be used inside the admin shell')
  return shellState
}
