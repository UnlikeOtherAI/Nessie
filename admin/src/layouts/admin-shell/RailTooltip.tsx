import { useLayoutEffect, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'

type RailTooltipProps = {
  anchorRef: RefObject<HTMLElement | null>
  description?: string
  id: string
  open: boolean
  title: string
}

// Rail controls are clipped by their narrow column, so their explanation is
// portalled beside it. This measures presentation geometry only; it does not
// choose a responsive layout or device form factor.
export const RailTooltip = ({
  anchorRef,
  description,
  id,
  open,
  title,
}: RailTooltipProps) => {
  const [position, setPosition] = useState({ left: 0, top: 0 })

  useLayoutEffect(() => {
    if (!open) return undefined

    const updatePosition = () => {
      const anchor = anchorRef.current
      if (!anchor) return
      const rect = anchor.getBoundingClientRect()
      setPosition({
        left: rect.right + 10,
        top: rect.top + rect.height / 2,
      })
    }
    updatePosition()
    window.addEventListener('resize', updatePosition)
    return () => window.removeEventListener('resize', updatePosition)
  }, [anchorRef, open])

  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <span
      className="rail-tooltip pointer-events-none"
      id={id}
      role="tooltip"
      style={position}
    >
      <strong>{title}</strong>
      {description ? <span>{description}</span> : null}
    </span>,
    document.body,
  )
}
