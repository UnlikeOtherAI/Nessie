import { createContext, useContext, type ReactNode } from 'react'
import { UserMenuTrigger } from './UserMenuTrigger'

type AccountMenuContextValue = {
  onLogout: () => void
  showHeaderAccountMenu: boolean
}

const AccountMenuContext = createContext<AccountMenuContextValue | null>(null)

export const AccountMenuProvider = ({
  children,
  onLogout,
  showHeaderAccountMenu,
}: {
  children: ReactNode
  onLogout: () => void
  showHeaderAccountMenu: boolean
}) => (
  <AccountMenuContext.Provider value={{ onLogout, showHeaderAccountMenu }}>
    {children}
  </AccountMenuContext.Provider>
)

export const useHeaderAccountMenuVisible = (): boolean =>
  useContext(AccountMenuContext)?.showHeaderAccountMenu ?? false

// A mobile shell without the web top bar supplies the desktop rail's canonical
// account trigger in every shared page header instead.
export const HeaderAccountMenu = () => {
  const accountMenu = useContext(AccountMenuContext)

  if (!accountMenu?.showHeaderAccountMenu) return null

  return <UserMenuTrigger onLogout={accountMenu.onLogout} placement="topbar" />
}
