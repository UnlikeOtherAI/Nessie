import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { isValidElement, type ReactElement } from 'react'

export type MenuGlyphIcon = IconDefinition | ReactElement

export const MenuGlyph = ({
  className,
  icon,
}: {
  className: string
  icon: MenuGlyphIcon
}) => (
  <span aria-hidden="true" className={`${className} inline-flex shrink-0 items-center justify-center`}>
    {isValidElement(icon) ? icon : <FontAwesomeIcon className="h-full w-full" icon={icon} />}
  </span>
)
