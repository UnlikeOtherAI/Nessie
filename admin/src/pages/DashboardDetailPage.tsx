/**
 * `/dashboards/:dashboardId` — view and edit one dashboard.
 *
 * View is the default and is chrome-free. Edit adds the grid affordances and
 * saves the layout explicitly, which also appends a version — so every
 * rearrangement is recoverable and attributable.
 */

import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import type { DashboardLayout, DashboardWidgetKind } from '@nessie/schemas'
import { DashboardGrid } from '../components/features/dashboards/DashboardGrid'
import { DashboardWidgetCard } from '../components/features/dashboards/DashboardWidgetCard'
import { DashboardVersionsPanel } from '../components/features/dashboards/DashboardVersionsPanel'
import {
  useDashboard,
  useSaveLayout,
  useWidgetData,
  type DashboardWidgetRecord,
} from '../facades/dashboards/hooks'
import { PhoneNavigationButton } from '../layouts/admin-shell/PhoneNavigationButton'

/**
 * Each widget loads its own data so one inaccessible widget degrades to a lock
 * tile instead of failing the page.
 */
const WidgetSlot = ({
  widget,
  editable,
}: {
  widget: DashboardWidgetRecord
  editable: boolean
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
        <div
          className="h-full animate-pulse rounded-lg border"
          style={{ background: 'var(--panel)', borderColor: 'var(--sep)' }}
        />
      )}
    </div>
  )
}

export const DashboardDetailPage = () => {
  const { dashboardId } = useParams<{ dashboardId: string }>()
  const { data: dashboard, isLoading } = useDashboard(dashboardId)
  const saveLayout = useSaveLayout(dashboardId ?? '')

  const [editing, setEditing] = useState(false)
  const [showVersions, setShowVersions] = useState(false)
  const [draftLayout, setDraftLayout] = useState<DashboardLayout | null>(null)

  useEffect(() => {
    if (dashboard) setDraftLayout(dashboard.layout)
  }, [dashboard])

  const widgetKinds = useMemo(() => {
    const map = new Map<string, DashboardWidgetKind>()
    for (const widget of dashboard?.widgets ?? []) {
      map.set(widget.id, widget.kind as DashboardWidgetKind)
    }
    return map
  }, [dashboard])

  /**
   * A widget with no rect yet (just added, or added by an agent) still has to
   * appear, so it is placed at the end rather than silently omitted.
   */
  const layout = useMemo<DashboardLayout>(() => {
    const base = draftLayout ?? { lg: [], md: [], sm: [] }
    const widgets = dashboard?.widgets ?? []
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
  }, [draftLayout, dashboard, widgetKinds])

  if (isLoading) {
    return (
      <p className="p-6 text-sm" style={{ color: 'var(--tx3)' }}>
        Loading…
      </p>
    )
  }
  if (!dashboard) {
    return (
      <p className="p-6 text-sm" style={{ color: 'var(--tx3)' }}>
        This dashboard is not available.
      </p>
    )
  }

  return (
    <div className="flex h-full min-h-0" data-testid="dashboard-detail">
      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className="flex items-center gap-3 border-b px-6 py-3"
          style={{ borderColor: 'var(--sep)' }}
        >
          <PhoneNavigationButton />
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold" style={{ color: 'var(--tx)' }}>
              {dashboard.title}
            </h1>
            {dashboard.description ? (
              <p className="truncate text-xs" style={{ color: 'var(--tx3)' }}>
                {dashboard.description}
              </p>
            ) : null}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button
              className="rounded px-2.5 py-1.5 text-xs"
              onClick={() => setShowVersions((open) => !open)}
              style={{ background: 'var(--overlay-weak)', color: 'var(--tx2)' }}
              type="button"
            >
              History
            </button>
            {editing ? (
              <button
                className="rounded px-3 py-1.5 text-xs font-medium"
                disabled={saveLayout.isPending}
                onClick={() => {
                  saveLayout.mutate(layout, { onSuccess: () => setEditing(false) })
                }}
                style={{ background: 'var(--accent)', color: 'var(--on-accent, #fff)' }}
                type="button"
              >
                {saveLayout.isPending ? 'Saving…' : 'Done'}
              </button>
            ) : (
              <button
                className="rounded px-3 py-1.5 text-xs font-medium"
                onClick={() => setEditing(true)}
                style={{ background: 'var(--overlay-weak)', color: 'var(--tx2)' }}
                type="button"
                data-testid="dashboard-edit"
              >
                Edit
              </button>
            )}
          </div>
        </header>

        <div
          className="min-h-0 flex-1 overflow-auto p-4"
          style={
            editing
              ? {
                backgroundImage: 'radial-gradient(var(--overlay-weak) 1px, transparent 1px)',
                backgroundSize: '24px 24px',
              }
              : undefined
          }
        >
          {dashboard.widgets.length === 0 ? (
            <div
              className="rounded-lg border p-8 text-center"
              style={{ borderColor: 'var(--sep)', background: 'var(--panel)' }}
              data-testid="dashboard-empty"
            >
              <p className="text-sm font-medium" style={{ color: 'var(--tx)' }}>
                No widgets yet
              </p>
              <p className="mt-1 text-xs" style={{ color: 'var(--tx3)' }}>
                Ask your assistant to add one, or connect a data source to get started.
              </p>
            </div>
          ) : (
            <DashboardGrid
              editable={editing}
              layout={layout}
              onLayoutChange={setDraftLayout}
              widgetKinds={widgetKinds}
            >
              {dashboard.widgets.map((widget) => (
                <div key={widget.id}>
                  <WidgetSlot editable={editing} widget={widget} />
                </div>
              ))}
            </DashboardGrid>
          )}
        </div>
      </div>

      {showVersions ? (
        <DashboardVersionsPanel
          dashboardId={dashboard.id}
          onClose={() => setShowVersions(false)}
        />
      ) : null}
    </div>
  )
}

export default DashboardDetailPage
