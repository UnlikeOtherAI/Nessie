import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { isReactNativeWebView } from '../../lib/native-shell'

type TransientMenuContextValue = {
  activeMenuId: string | null
  closeAllMenus: () => void
  closeMenu: (id: string) => void
  openMenu: (id: string) => void
  toggleMenu: (id: string) => void
}

type NativeTransientMenuWindow = Window & {
  ReactNativeWebView?: { postMessage: (data: string) => void }
  __nessieCloseTransientMenus?: () => void
}

const TransientMenuContext = createContext<TransientMenuContextValue | null>(null)

export const nextTransientMenuId = (activeMenuId: string | null, id: string): string | null =>
  activeMenuId === id ? null : id

const useTransientMenuContext = (): TransientMenuContextValue => {
  const context = useContext(TransientMenuContext)
  if (!context) throw new Error('Transient menus must be rendered within TransientMenuProvider')
  return context
}

// Menus and popovers are a single interaction lane: opening one replaces the
// previous surface, and the native frame is told to dismiss its own create sheet.
export const TransientMenuProvider = ({ children }: { children: ReactNode }) => {
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null)
  const closeAllMenus = useCallback(() => setActiveMenuId(null), [])
  const closeMenu = useCallback((id: string) => {
    setActiveMenuId((active) => active === id ? null : active)
  }, [])
  const openMenu = useCallback((id: string) => setActiveMenuId(id), [])
  const toggleMenu = useCallback((id: string) => {
    setActiveMenuId((active) => nextTransientMenuId(active, id))
  }, [])

  useEffect(() => {
    const target = window as NativeTransientMenuWindow
    target.__nessieCloseTransientMenus = closeAllMenus
    return () => {
      delete target.__nessieCloseTransientMenus
    }
  }, [closeAllMenus])

  useEffect(() => {
    if (!isReactNativeWebView()) return
    ;(window as NativeTransientMenuWindow).ReactNativeWebView?.postMessage(
      JSON.stringify({ type: 'nessie:transient-menu', active: activeMenuId !== null }),
    )
  }, [activeMenuId])

  const value = useMemo<TransientMenuContextValue>(() => ({
    activeMenuId,
    closeAllMenus,
    closeMenu,
    openMenu,
    toggleMenu,
  }), [activeMenuId, closeAllMenus, closeMenu, openMenu, toggleMenu])

  return <TransientMenuContext.Provider value={value}>{children}</TransientMenuContext.Provider>
}

export const useTransientMenu = () => {
  const { activeMenuId, closeMenu, openMenu, toggleMenu } = useTransientMenuContext()
  const id = useId()
  const close = useCallback(() => closeMenu(id), [closeMenu, id])
  const open = useCallback(() => openMenu(id), [id, openMenu])
  const toggle = useCallback(() => toggleMenu(id), [id, toggleMenu])

  useEffect(() => close, [close])

  return {
    close,
    isOpen: activeMenuId === id,
    open,
    toggle,
  }
}

export const useCloseTransientMenus = (): (() => void) =>
  useTransientMenuContext().closeAllMenus
