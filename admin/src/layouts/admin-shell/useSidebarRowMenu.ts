import { useCallback, useEffect, useLayoutEffect, useState } from 'react'

export type SidebarRowMenuPosition = {
  left: number
  top: number
}

type MenuAnchorRect = {
  bottom: number
  left: number
}

/**
 * Shared portal-menu positioning for a sidebar row's "⋯" action menu:
 * computes where to draw the menu from the trigger's `getBoundingClientRect()`
 * and closes it on Escape, scroll, or resize. `ProjectsSidebarNav.tsx` (via
 * `ProjectRow.tsx`) and `SidebarProjectsSection.tsx` each re-implemented this
 * exact positioning + dismiss wiring for their own project row; this hook is
 * the one copy both use now.
 *
 * The caller still owns *which* row's menu is open — that identity is local
 * state in `ProjectRow` but lifted, cross-menu-type state (`sidebarMenu`) in
 * `SidebarProjectsSection` — so this hook takes that as `isOpen` and only
 * owns the position value and the dismiss listeners.
 */
export const useSidebarRowMenu = (isOpen: boolean, onClose: () => void) => {
  const [position, setPosition] = useState<SidebarRowMenuPosition | null>(null)

  const openAt = useCallback((rect: MenuAnchorRect) => {
    setPosition({ left: rect.left, top: rect.bottom + 4 })
  }, [])

  // The identity of the open row can change (or close) through means other
  // than this hook's own listeners — e.g. another row's menu opening in
  // lifted-state callers — so the position always follows `isOpen` rather
  // than only ever being cleared by `onClose`.
  useEffect(() => {
    if (!isOpen) setPosition(null)
  }, [isOpen])

  useLayoutEffect(() => {
    if (!isOpen) return undefined

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('scroll', onClose, true)
    window.addEventListener('resize', onClose)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', onClose, true)
      window.removeEventListener('resize', onClose)
    }
  }, [isOpen, onClose])

  return { openAt, position }
}
