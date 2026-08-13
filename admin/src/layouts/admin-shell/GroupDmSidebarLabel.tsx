import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { groupDmSidebarLabelCandidates, selectGroupDmSidebarLabel } from './group-dm-sidebar-label'

type GroupDmSidebarLabelProps = {
  label: string
}

/** A measured label that keeps group-DM navigation compact without hiding who is in it. */
export const GroupDmSidebarLabel = ({ label }: GroupDmSidebarLabelProps) => {
  const labelRef = useRef<HTMLSpanElement>(null)
  const measurementRef = useRef<HTMLSpanElement>(null)
  const [availableWidth, setAvailableWidth] = useState(0)
  const candidates = useMemo(() => groupDmSidebarLabelCandidates(label), [label])
  const [displayLabel, setDisplayLabel] = useState(() => candidates[0]?.text ?? label)
  const [tooltipOpen, setTooltipOpen] = useState(false)
  const [tooltipPosition, setTooltipPosition] = useState({ left: 0, top: 0 })

  const placeTooltip = (): void => {
    const element = labelRef.current
    if (!element) return

    const rect = element.getBoundingClientRect()
    setTooltipPosition({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - 368)),
      top: Math.max(8, rect.top - 6),
    })
  }

  useLayoutEffect(() => {
    const element = labelRef.current
    if (!element) return undefined

    const updateWidth = () => setAvailableWidth(element.getBoundingClientRect().width)
    updateWidth()

    const resizeObserver = new ResizeObserver(updateWidth)
    resizeObserver.observe(element)
    return () => resizeObserver.disconnect()
  }, [])

  useLayoutEffect(() => {
    const measurement = measurementRef.current
    if (!measurement || availableWidth <= 0) return

    const selected = selectGroupDmSidebarLabel(candidates, availableWidth, (text) => {
      measurement.textContent = text
      return measurement.getBoundingClientRect().width
    })
    setDisplayLabel((current) => (current === selected.text ? current : selected.text))
  }, [availableWidth, candidates])

  useLayoutEffect(() => {
    if (!tooltipOpen) return undefined

    placeTooltip()
    window.addEventListener('resize', placeTooltip)
    return () => window.removeEventListener('resize', placeTooltip)
  }, [tooltipOpen])

  const showTooltip = (): void => {
    placeTooltip()
    setTooltipOpen(true)
  }

  return (
    <>
      <span
        aria-label={label}
        className="group-dm-sidebar-label relative min-w-0 flex-1 truncate"
        onMouseEnter={candidates.length > 1 ? showTooltip : undefined}
        onMouseLeave={candidates.length > 1 ? () => setTooltipOpen(false) : undefined}
        ref={labelRef}
      >
        {displayLabel}
        <span
          aria-hidden="true"
          className="pointer-events-none fixed left-[-9999px] top-[-9999px] whitespace-pre opacity-0"
          ref={measurementRef}
        />
      </span>
      {tooltipOpen && typeof document !== 'undefined'
        ? createPortal(
            <span
              className="group-dm-sidebar-tooltip pointer-events-none"
              role="tooltip"
              style={tooltipPosition}
            >
              {label}
            </span>,
            document.body,
          )
        : null}
    </>
  )
}
