/**
 * A complete dashboard presented in a conversation.
 *
 * This is not an iframe: the conversation and the dashboard both use the
 * authenticated API client, so a preview continues to enforce the viewer's
 * ordinary dashboard entitlement. The compact view literally transforms the
 * same DashboardCanvas that the full-screen dialog renders at normal scale.
 */

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  DashboardPresentationMessageMetadataSchema,
  type DashboardWidgetKind,
} from '@nessie/schemas'
import { useDashboard, type DashboardDetailRecord } from '../../../facades/dashboards/hooks'
import { Dialog } from '../../shared/Dialog'
import { SkeletonBlock } from '../../primitives/Skeleton'
import { DashboardCanvas } from './DashboardCanvas'

const PREVIEW_CANVAS_WIDTH = 1120
const PREVIEW_MAX_HEIGHT = 380
const PREVIEW_MAX_SCALE = 0.48

const widgetKindsOf = (dashboard: DashboardDetailRecord): Map<string, DashboardWidgetKind> =>
  new Map(
    dashboard.widgets.map((widget) => [widget.id, widget.kind as DashboardWidgetKind]),
  )

const UnavailableDashboard = () => (
  <div
    className="rounded-lg border border-[color:var(--sep)] bg-[color:var(--panel)] px-3 py-2.5 text-xs text-[color:var(--tx3)]"
    data-testid="dashboard-presentation-unavailable"
  >
    Dashboard unavailable — you may not have access to it any more.
  </div>
)

const ScaledDashboardCanvas = ({
  dashboard,
  onOpen,
}: {
  dashboard: DashboardDetailRecord
  onOpen: () => void
}) => {
  const frameRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLDivElement | null>(null)
  const [canvasHeight, setCanvasHeight] = useState(0)
  const [frameWidth, setFrameWidth] = useState(0)
  const widgetKinds = useMemo(() => widgetKindsOf(dashboard), [dashboard])
  const scale = Math.min(PREVIEW_MAX_SCALE, frameWidth / PREVIEW_CANVAS_WIDTH || PREVIEW_MAX_SCALE)
  const height = Math.min(
    PREVIEW_MAX_HEIGHT,
    Math.max(176, Math.ceil(canvasHeight * scale)),
  )

  const measure = useCallback(() => {
    if (frameRef.current) setFrameWidth(frameRef.current.clientWidth)
    if (canvasRef.current) setCanvasHeight(canvasRef.current.scrollHeight)
  }, [])

  useLayoutEffect(() => {
    measure()
    const observer = new ResizeObserver(measure)
    if (frameRef.current) observer.observe(frameRef.current)
    if (canvasRef.current) observer.observe(canvasRef.current)
    return () => observer.disconnect()
  }, [measure])

  return (
    <div
      aria-label={`Open ${dashboard.title} full screen`}
      className="cursor-zoom-in overflow-hidden rounded-[var(--radius-lg)] border border-[color:var(--line)] bg-[color:var(--panel-soft)]"
      data-testid="dashboard-presentation-preview"
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen()
        }
      }}
      ref={frameRef}
      role="button"
      style={{ height }}
      tabIndex={0}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none"
        ref={canvasRef}
        style={{
          transform: `scale(${scale})`,
          transformOrigin: 'top left',
          width: PREVIEW_CANVAS_WIDTH,
        }}
      >
        <DashboardCanvas
          dashboard={dashboard}
          layout={dashboard.layout}
          widgetKinds={widgetKinds}
        />
      </div>
    </div>
  )
}

const PresentedDashboard = ({ dashboard }: { dashboard: DashboardDetailRecord }) => {
  const [open, setOpen] = useState(false)
  const widgetKinds = useMemo(() => widgetKindsOf(dashboard), [dashboard])

  return (
    <div className="mt-2">
      <ScaledDashboardCanvas dashboard={dashboard} onOpen={() => setOpen(true)} />
      <Dialog
        description="Review the dashboard at its normal size."
        onClose={() => setOpen(false)}
        open={open}
        size="full"
        title={dashboard.title}
      >
        <div className="min-h-0 flex-1 overflow-auto p-4">
          <DashboardCanvas
            dashboard={dashboard}
            layout={dashboard.layout}
            widgetKinds={widgetKinds}
          />
        </div>
      </Dialog>
    </div>
  )
}

export const DashboardPresentation = ({
  metadata,
}: {
  metadata: Record<string, unknown> | undefined
}) => {
  const parsed = DashboardPresentationMessageMetadataSchema.safeParse(metadata)
  const dashboardId = parsed.success ? parsed.data.dashboardPresentation.dashboardId : undefined
  const dashboardQuery = useDashboard(dashboardId)

  if (!dashboardId) return null
  if (dashboardQuery.isLoading) {
    return <SkeletonBlock className="mt-2 h-48 w-full rounded-lg border border-[color:var(--sep)]" />
  }
  if (!dashboardQuery.data) {
    return (
      <div className="mt-2">
        <UnavailableDashboard />
      </div>
    )
  }

  return <PresentedDashboard dashboard={dashboardQuery.data} />
}
