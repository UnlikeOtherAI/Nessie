import { useCallback, useState } from 'react'
import type { ReactNode } from 'react'
import { getCookie, setCookie } from '../../lib/storage'
import { SidebarTreeSectionHeader } from '../../components/primitives/SidebarTree'

type SidebarMenuSectionProps = {
  action?: ReactNode
  children: ReactNode
  className?: string
  id: string
  isCollapsed: boolean
  onToggle: () => void
  title: string
  titleIcon?: ReactNode
}

export const useCookieBackedSidebarSections = <SectionId extends string>(
  ids: readonly SectionId[],
  cookieName: (id: SectionId) => string,
) => {
  const [collapsedSections, setCollapsedSections] = useState<Record<SectionId, boolean>>(
    () =>
      ids.reduce<Record<SectionId, boolean>>((state, id) => {
        state[id] = getCookie(cookieName(id)) === '1'
        return state
      }, {} as Record<SectionId, boolean>),
  )

  const toggleSection = useCallback((id: SectionId) => {
    setCollapsedSections((prev) => {
      const nextCollapsed = !prev[id]
      setCookie(cookieName(id), nextCollapsed ? '1' : '0')
      return { ...prev, [id]: nextCollapsed }
    })
  }, [cookieName])

  return { collapsedSections, toggleSection }
}

export const SidebarMenuSection = ({
  action,
  children,
  className,
  id,
  isCollapsed,
  onToggle,
  title,
  titleIcon,
}: SidebarMenuSectionProps) => (
  <div className={className}>
    <SidebarTreeSectionHeader action={action} collapsed={isCollapsed} controls={id} onToggle={onToggle}>
      {titleIcon}
      {title}
    </SidebarTreeSectionHeader>
    {!isCollapsed ? <div id={id}>{children}</div> : null}
  </div>
)
