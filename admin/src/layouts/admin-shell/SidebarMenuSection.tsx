import { useCallback, useState } from 'react'
import type { ReactNode } from 'react'
import { faChevronDown } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { getCookie, setCookie } from '../../lib/storage'

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
    <div className="admin-sec-row">
      <button
        aria-controls={id}
        aria-expanded={!isCollapsed}
        className="admin-sec-hdr"
        onClick={onToggle}
        type="button"
      >
        <FontAwesomeIcon
          aria-hidden="true"
          className={[
            'h-3 w-3 text-[color:var(--tx3)] transition-transform',
            isCollapsed ? '-rotate-90' : '',
          ].join(' ')}
          fixedWidth
          icon={faChevronDown}
        />
        {titleIcon}
        {title}
      </button>
      {action}
    </div>
    {!isCollapsed ? <div id={id}>{children}</div> : null}
  </div>
)
