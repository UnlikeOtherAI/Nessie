import { useLayoutEffect, useMemo, useRef, useState } from 'react'
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

  return (
    <span
      aria-label={label}
      className="relative min-w-0 flex-1 truncate"
      ref={labelRef}
      title={label}
    >
      {displayLabel}
      <span
        aria-hidden="true"
        className="pointer-events-none fixed left-[-9999px] top-[-9999px] whitespace-pre opacity-0"
        ref={measurementRef}
      />
    </span>
  )
}
