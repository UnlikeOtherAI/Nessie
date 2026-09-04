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
  type DashboardDetailRecord,
  type DashboardWidgetRecord,
} from '../../../facades/dashboards/hooks'
import { SkeletonBlock } from '../../primitives/Skeleton'
import { DashboardGrid } from './DashboardGrid'
import { DashboardWidgetCard } from './DashboardWidgetCard'

const DashboardWidgetSlot = ({
  editable,
  widget,
}: {
  editable: boolean
  widget: DashboardWidgetRecord
}) => {
  const { data: projection, refetch } = useWidgetData(widget.id)

  return (
    <div className="relative h-full">
      {editable ? (
        <div
          className="dashboard-widget-handle absolute inset-x-0 top-0 z-10 h-6 cursor-move"
          title="Drag to move"
        />
      ) : null}
      {projection ? (
        <DashboardWidgetCard onRetry={() => void refetch()} projection={projection} />
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
  dashboard,
  editable = false,
  layout,
  onLayoutChange,
  widgetKinds,
}: {
  dashboard: DashboardDetailRecord
  editable?: boolean
  layout: DashboardLayout
  onLayoutChange?: (layout: DashboardLayout) => void
  widgetKinds: Map<string, DashboardWidgetKind>
}) => {
  const completeLayout = completeDashboardLayout(layout, dashboard.widgets, widgetKinds)

  return (
    <DashboardGrid
      editable={editable}
      layout={completeLayout}
      onLayoutChange={onLayoutChange}
      widgetKinds={widgetKinds}
    >
      {dashboard.widgets.map((widget) => (
        <div key={widget.id}>
          <DashboardWidgetSlot editable={editable} widget={widget} />
        </div>
      ))}
    </DashboardGrid>
  )
}
