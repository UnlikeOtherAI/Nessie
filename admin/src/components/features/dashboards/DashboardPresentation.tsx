/**
 * A complete dashboard presented in a conversation.
 *
 * This is not an iframe: the conversation and the dashboard both use the
 * authenticated API client, so a preview continues to enforce the viewer's
 * ordinary dashboard entitlement. The compact view literally transforms the
 * same DashboardCanvas that the right-hand workspace panel renders at normal
 * scale. The URL owns which panel is open, so Back and a cold deep link work.
 */

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  DashboardPresentationMessageMetadataSchema,
  type DashboardWidgetKind,
} from '@nessie/schemas'
import { useDashboard, type DashboardDetailRecord } from '../../../facades/dashboards/hooks'
import { SkeletonBlock } from '../../primitives/Skeleton'
import { DashboardCanvas } from './DashboardCanvas'
import { useDashboardRealtime } from './DashboardRealtimeProvider'

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
      className="relative overflow-hidden rounded-[var(--radius-lg)] border border-[color:var(--line)] bg-[color:var(--panel-soft)]"
      data-testid="dashboard-presentation-preview"
      ref={frameRef}
      style={{ height }}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none"
        inert
        ref={canvasRef}
        style={{
          transform: `scale(${scale})`,
          transformOrigin: 'top left',
          width: PREVIEW_CANVAS_WIDTH,
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
        aria-label={`Open ${dashboard.title} in workspace`}
        className="absolute inset-0 cursor-zoom-in rounded-[var(--radius-lg)] border-0 bg-transparent p-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-[color:var(--accent)]"
        onClick={onOpen}
        type="button"
      />
    </div>
  )
}

const PresentedDashboard = ({ dashboard, threadId }: { dashboard: DashboardDetailRecord; threadId: string }) => {
  const navigate = useNavigate()
  const { channelId } = useParams()
  const open = useCallback(() => {
    if (!channelId) return
    void navigate(`/channels/${channelId}/threads/${threadId}/dashboards/${dashboard.id}`)
  }, [channelId, dashboard.id, navigate, threadId])

  return (
    <div className="mt-2">
      <ScaledDashboardCanvas dashboard={dashboard} onOpen={open} />
    </div>
  )
}

export const DashboardPresentation = ({
  metadata,
  threadId,
}: {
  metadata: Record<string, unknown> | undefined
  threadId: string
}) => {
  const parsed = DashboardPresentationMessageMetadataSchema.safeParse(metadata)
  const dashboardId = parsed.success ? parsed.data.dashboardPresentation.dashboardId : undefined
  const realtime = useDashboardRealtime(dashboardId)
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

  return (
    <div data-dashboard-realtime={realtime}>
      <PresentedDashboard dashboard={dashboardQuery.data} threadId={threadId} />
    </div>
  )
}
