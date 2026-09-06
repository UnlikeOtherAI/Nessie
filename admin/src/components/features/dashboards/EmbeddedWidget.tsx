/**
 * A widget embedded outside its dashboard — in a message, or in a knowledge
 * page.
 *
 * It renders through the SAME `DashboardWidgetCard` the canvas uses, just with
 * a different `surface`, so there is one renderer rather than three that drift
 * (Rule zero §4).
 *
 * It resolves by embed id, never by widget id. The server runs both access
 * checks on that id — container and resource — so a viewer who has lost access
 * to either gets an inert card instead of data, and nothing here needs to
 * decide anything about permission.
 */

import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import type { DashboardWidgetProjection } from '@nessie/schemas'
import { dashboardKeys } from '../../../facades/dashboards/keys'
import { SkeletonBlock } from '../../primitives/Skeleton'
import { useApiClient } from '../../../providers/ApiClientProvider'
import { DashboardWidgetCard, type WidgetSurface } from './DashboardWidgetCard'

type EmbedResponse =
  | { visible: false }
  | { visible: true; mode: 'live' | 'static'; projection: DashboardWidgetProjection }

const UnavailableCard = ({ surface }: { surface: WidgetSurface }) => (
  <div
    className="rounded-lg border border-[color:var(--sep)] bg-[color:var(--panel)] px-3 py-2.5 text-xs text-[color:var(--tx3)]"
    style={{ maxWidth: surface === 'message' ? 520 : undefined }}
    data-testid="embedded-widget-unavailable"
  >
    Dashboard widget unavailable — you may not have access to it any more.
  </div>
)

export const EmbeddedWidget = ({
  embedId,
  surface,
}: {
  embedId: string
  surface: WidgetSurface
}) => {
  const client = useApiClient()
  const { data, isLoading } = useQuery({
    queryKey: dashboardKeys.embed(embedId),
    queryFn: () => client.get<EmbedResponse>(`/api/dashboard-embeds/${embedId}`),
    // A live embed follows its source's cache; a static one never changes, but
    // one poll interval for both keeps this component free of mode branching.
    refetchInterval: 60_000,
  })

  if (isLoading) {
    return (
      <div style={{ maxWidth: surface === 'message' ? 520 : undefined }}>
        <SkeletonBlock className="h-32 w-full rounded-lg border border-[color:var(--sep)]" />
      </div>
    )
  }
  if (!data?.visible) return <UnavailableCard surface={surface} />

  return (
    <div
      className="flex flex-col gap-1"
      style={{ maxWidth: surface === 'message' ? 520 : undefined }}
      data-testid="embedded-widget"
      data-embed-mode={data.mode}
    >
      <div style={{ height: surface === 'message' ? 200 : 240 }}>
        <DashboardWidgetCard projection={data.projection} surface={surface} />
      </div>
      <div className="flex items-center gap-2 px-0.5 text-[11px] text-[color:var(--tx3)]">
        {/* The card's own footer already states frozen-vs-live, so this row
            carries only the way back to the dashboard. */}
        <Link
          className="ml-auto text-[color:var(--lnk)] underline"
          to={`/dashboards/${data.projection.dashboardId}`}
        >
          Open dashboard →
        </Link>
      </div>
    </div>
  )
}

/**
 * Reads embed ids off a message's server-populated metadata.
 *
 * Only the server writes this key. A client cannot submit embed metadata, so a
 * message cannot claim to carry a widget it was never given.
 */
export const readMessageEmbedIds = (
  metadata: Record<string, unknown> | undefined,
): string[] => {
  const raw = metadata?.dashboardEmbeds
  if (!Array.isArray(raw)) return []
  return raw
    .map((entry) =>
      entry && typeof entry === 'object' && typeof (entry as { embedId?: unknown }).embedId === 'string'
        ? (entry as { embedId: string }).embedId
        : null,
    )
    .filter((value): value is string => value !== null)
}
