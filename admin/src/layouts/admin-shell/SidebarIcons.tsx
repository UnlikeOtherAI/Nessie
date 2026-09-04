import { forwardRef, type ComponentPropsWithoutRef } from 'react'
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import { faStar as faRegularStar } from '@fortawesome/free-regular-svg-icons'
import { faStar as faSolidStar } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'

type SidebarIconButtonProps = Omit<ComponentPropsWithoutRef<'button'>, 'children'> & {
  icon: IconDefinition
  iconClassName?: string
  placement?: 'row' | 'section'
}

export const SidebarIconButton = forwardRef<HTMLButtonElement, SidebarIconButtonProps>(({
  className,
  icon,
  iconClassName = 'h-3.5 w-3.5',
  placement = 'row',
  type = 'button',
  ...props
}, ref) => (
  <button
    className={[
      placement === 'section' ? 'admin-sidebar-plus' : 'admin-sidebar-more',
      className,
    ].filter(Boolean).join(' ')}
    ref={ref}
    type={type}
    {...props}
  >
    <FontAwesomeIcon aria-hidden="true" className={iconClassName} fixedWidth icon={icon} />
  </button>
))

SidebarIconButton.displayName = 'SidebarIconButton'

export const SidebarStarIcon = ({ starred }: { starred: boolean }) => (
  <FontAwesomeIcon
    aria-hidden="true"
    className="h-3 w-3"
    fixedWidth
    icon={starred ? faSolidStar : faRegularStar}
  />
)
