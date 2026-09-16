/**
 * A whole dashboard, live, rendered small.
 *
 * This is not a picture and not an iframe: it is the same `DashboardCanvas`
 * the full page renders, transformed by a CSS `scale`, reading through the
 * same authenticated API client. So a scaled dashboard enforces the viewer's
 * ordinary entitlement, updates when its widgets update, and cannot drift from
 * the full-size rendering — there is no dashboard-shaped second implementation
 * to drift.
 *
 * It grew inside `DashboardPresentation.tsx` for dashboards posted into a
 * conversation and lives here because the project Overview shows its
 * dashboards the same way, as tiles in the navigation grid.
 *
 * The inner canvas is laid out at a fixed `canvasWidth` and then scaled to the
 * frame, rather than being rendered at the frame's real width. A dashboard's
 * grid reflows across breakpoints, so rendering it 300px wide would give the
 * single-column phone layout shrunk — not a small picture of the dashboard the
 * person will open. Laying it out wide and scaling it down keeps the
 * arrangement they are looking for.
 */

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { DashboardWidgetKind } from '@nessie/schemas'

import type { DashboardDetailRecord } from '../../../facades/dashboards/hooks'
import { DashboardCanvas } from './DashboardCanvas'

/** The width the inner canvas is laid out at before scaling. `lg` territory. */
export const SCALED_CANVAS_WIDTH = 1120

const widgetKindsOf = (dashboard: DashboardDetailRecord): Map<string, DashboardWidgetKind> =>
  new Map(dashboard.widgets.map((widget) => [widget.id, widget.kind as DashboardWidgetKind]))

type ScaledDashboardProps = {
  /** Announced on the button that opens it: "Open <title>". */
  ariaLabel: string
  className?: string
  /** The `data-testid` the surface's own browser case looks for. */
  'data-testid'?: string
  dashboard: DashboardDetailRecord
  /** Tallest the frame may grow, in CSS pixels. */
  maxHeight: number
  /** Ceiling on the scale, so a wide frame does not render a near-full-size copy. */
  maxScale?: number
  /** Shortest the frame may be, so an empty dashboard is still a target. */
  minHeight?: number
  onOpen: () => void
}

export const ScaledDashboard = ({
  ariaLabel,
  className,
  'data-testid': testId = 'scaled-dashboard',
  dashboard,
  maxHeight,
  maxScale = 0.48,
  minHeight = 128,
  onOpen,
}: ScaledDashboardProps) => {
  const frameRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLDivElement | null>(null)
  const [canvasHeight, setCanvasHeight] = useState(0)
  const [frameWidth, setFrameWidth] = useState(0)
  const widgetKinds = useMemo(() => widgetKindsOf(dashboard), [dashboard])

  const scale = Math.min(maxScale, frameWidth / SCALED_CANVAS_WIDTH || maxScale)
  const height = Math.min(maxHeight, Math.max(minHeight, Math.ceil(canvasHeight * scale)))

  const measure = useCallback(() => {
    if (frameRef.current) setFrameWidth(frameRef.current.clientWidth)
    if (canvasRef.current) setCanvasHeight(canvasRef.current.scrollHeight)
  }, [])

  // Both boxes are observed: the frame changes with the column it sits in, and
  // the canvas changes as widgets resolve their data and grow.
  useLayoutEffect(() => {
    measure()
    const observer = new ResizeObserver(measure)
    if (frameRef.current) observer.observe(frameRef.current)
    if (canvasRef.current) observer.observe(canvasRef.current)
    return () => observer.disconnect()
  }, [measure])

  return (
    <div
      className={['scaled-dashboard', className ?? ''].join(' ')}
      data-testid={testId}
      ref={frameRef}
      style={{ height }}
    >
      {/* `inert` and `aria-hidden`: the real dashboard is one tap away and is
          where every control works. A scaled copy that took focus would put a
          column of unreachable half-size buttons in the tab order. */}
      <div
        aria-hidden="true"
        className="pointer-events-none"
        inert
        ref={canvasRef}
        style={{
          transform: `scale(${scale})`,
          transformOrigin: 'top left',
          width: SCALED_CANVAS_WIDTH,
        }}
      >
        <DashboardCanvas
          compact
          dashboard={dashboard}
          layout={dashboard.layout}
          widgetKinds={widgetKinds}
        />
      </div>
      <button
        aria-label={ariaLabel}
        className="scaled-dashboard-open"
        onClick={onOpen}
        type="button"
      />
    </div>
  )
}
