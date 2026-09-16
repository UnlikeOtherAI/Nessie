/**
 * A complete dashboard presented in a conversation.
 *
 * The scaled rendering itself is `ScaledDashboard` — shared with the project
 * Overview, where a project's dashboards are tiles in the navigation grid. It
 * is not an iframe: the conversation and the dashboard both use the
 * authenticated API client, so a preview continues to enforce the viewer's
 * ordinary dashboard entitlement. The URL owns which panel is open, so Back
 * and a cold deep link work.
 */

import { useCallback } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { DashboardPresentationMessageMetadataSchema } from '@nessie/schemas'
import { useDashboard, type DashboardDetailRecord } from '../../../facades/dashboards/hooks'
import { SkeletonBlock } from '../../primitives/Skeleton'
import { ScaledDashboard } from './ScaledDashboard'
import { useDashboardRealtime } from './DashboardRealtimeProvider'

const PREVIEW_MAX_HEIGHT = 380

const UnavailableDashboard = () => (
  <div
    className="rounded-lg border border-[color:var(--sep)] bg-[color:var(--panel)] px-3 py-2.5 text-xs text-[color:var(--tx3)]"
    data-testid="dashboard-presentation-unavailable"
  >
    Dashboard unavailable — you may not have access to it any more.
  </div>
)

const PresentedDashboard = ({ dashboard, threadId }: { dashboard: DashboardDetailRecord; threadId: string }) => {
  const navigate = useNavigate()
  const { channelId } = useParams()
  const open = useCallback(() => {
    if (!channelId) return
    void navigate(`/channels/${channelId}/threads/${threadId}/dashboards/${dashboard.id}`)
  }, [channelId, dashboard.id, navigate, threadId])

  return (
    <div className="mt-2">
      <ScaledDashboard
        ariaLabel={`Open ${dashboard.title} in workspace`}
        data-testid="dashboard-presentation-preview"
        dashboard={dashboard}
        maxHeight={PREVIEW_MAX_HEIGHT}
        minHeight={176}
        onOpen={open}
      />
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
