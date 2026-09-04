/**
 * The read/edit dashboard surface without page chrome.
 *
 * The full dashboard page and the scaled conversation preview share this
 * canvas. A preview is therefore a literal smaller rendering of the same grid
 * and widget cards, not a dashboard-shaped second implementation.
 */

import type { DashboardLayout, DashboardWidgetKind } from '@nessie/schemas'

import {
  useWidgetData,
  useRefreshWidgetData,
  type DashboardDetailRecord,
  type DashboardWidgetRecord,
} from '../../../facades/dashboards/hooks'
import { OVERLAY_LAYER } from '../../../navigation/overlay'
import { SkeletonBlock } from '../../primitives/Skeleton'
import { DashboardGrid } from './DashboardGrid'
import { DashboardWidgetCard } from './DashboardWidgetCard'

const DashboardWidgetSlot = ({
  compact = false,
  editable,
  widget,
}: {
  compact?: boolean
  editable: boolean
  widget: DashboardWidgetRecord
}) => {
  const { data: projection, refetch } = useWidgetData(widget.id, { compact })
  const refreshWidget = useRefreshWidgetData()
  const retry = () => {
    if (compact) {
      void refetch()
      return
    }
    refreshWidget.mutate(widget.id)
  }

  return (
    <div className="relative h-full">
      {editable ? (
        <div
          className="dashboard-widget-handle absolute inset-x-0 top-0 h-6 cursor-move"
          style={{ zIndex: OVERLAY_LAYER.stack }}
          title="Drag to move"
        />
      ) : null}
      {projection ? (
        <DashboardWidgetCard
          {...(!compact ? { onRetry: retry } : {})}
          projection={projection}
          surface={compact ? 'message' : 'dashboard'}
        />
      ) : (
        <SkeletonBlock className="h-full rounded-lg" />
      )}
    </div>
  )
}

/**
 * An agent can add a widget before it has arranged the dashboard. The canvas
 * appends those widgets in the same deterministic grid slot everywhere it is
 * rendered, so an unseen widget is impossible in both the full page and chat.
 */
export const completeDashboardLayout = (
  base: DashboardLayout,
  widgets: DashboardWidgetRecord[],
  widgetKinds: Map<string, DashboardWidgetKind>,
): DashboardLayout => {
  const ensure = (rects: DashboardLayout['lg'], columns: number, width: number) => {
    const placed = new Set(rects.map((rect) => rect.widgetId))
    const missing = widgets.filter((widget) => !placed.has(widget.id))
    let y = rects.reduce((max, rect) => Math.max(max, rect.y + rect.h), 0)
    return [
      ...rects.filter((rect) => widgetKinds.has(rect.widgetId)),
      ...missing.map((widget, index) => {
        const rect = {
          widgetId: widget.id,
          x: (index * width) % columns,
          y,
          w: Math.min(width, columns),
          h: 6,
        }
        if ((index + 1) * width >= columns) y += 6
        return rect
      }),
    ]
  }
  return {
    lg: ensure(base.lg, 12, 6),
    md: ensure(base.md, 8, 4),
    sm: ensure(base.sm, 4, 4),
  }
}

export const DashboardCanvas = ({
  compact = false,
  dashboard,
  editable = false,
  layout,
  onLayoutChange,
  widgetKinds,
}: {
  /** Conversation cards load bounded projections; the workspace stays full fidelity. */
  compact?: boolean
  dashboard: DashboardDetailRecord
  editable?: boolean
  layout: DashboardLayout
  onLayoutChange?: (layout: DashboardLayout) => void
  widgetKinds: Map<string, DashboardWidgetKind>
}) => {
  const completeLayout = completeDashboardLayout(layout, dashboard.widgets, widgetKinds)
  const insights = dashboard.presentation.insights

  return (
    <div className={dashboard.presentation.style === 'executive' ? 'space-y-3' : undefined}>
      {insights.length > 0 ? (
        <section aria-label="Dashboard insights" className="grid gap-2 sm:grid-cols-2">
          {insights.map((insight) => (
            <p
              className="rounded-md border border-[color:var(--sep)] bg-[color:var(--panel-soft)] px-3 py-2 text-xs text-[color:var(--tx2)]"
              key={insight.id}
            >
              {insight.text}
            </p>
          ))}
        </section>
      ) : null}
      {dashboard.presentation.filters.length > 0 ? (
        <p className="text-xs text-[color:var(--tx3)]" data-testid="dashboard-active-filters">
          Filtered: {dashboard.presentation.filters.map((filter) => filter.label).join(', ')}
        </p>
      ) : null}
      <DashboardGrid
        editable={editable}
        layout={completeLayout}
        onLayoutChange={onLayoutChange}
        widgetKinds={widgetKinds}
      >
        {dashboard.widgets.map((widget) => (
          <div key={widget.id}>
            <DashboardWidgetSlot compact={compact} editable={editable} widget={widget} />
          </div>
        ))}
      </DashboardGrid>
    </div>
  )
}
