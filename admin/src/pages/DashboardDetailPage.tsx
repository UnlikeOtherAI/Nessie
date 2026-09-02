/**
 * `/dashboards/:dashboardId` — view and edit one dashboard.
 *
 * View is the default and is chrome-free. Edit adds the grid affordances and
 * saves the layout explicitly, which also appends a version — so every
 * rearrangement is recoverable and attributable.
 */

import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import type { DashboardLayout, DashboardWidgetKind } from '@nessie/schemas'
import { DashboardGrid } from '../components/features/dashboards/DashboardGrid'
import { DashboardWidgetCard } from '../components/features/dashboards/DashboardWidgetCard'
import { DashboardVersionsPanel } from '../components/features/dashboards/DashboardVersionsPanel'
import { AddWidgetPanel } from '../components/features/dashboards/AddWidgetPanel'
import { Skeleton } from '../components/primitives/Skeleton'
import { QueryState } from '../components/shared/QueryState'
import {
  useDashboard,
  useSaveLayout,
  useWidgetData,
  type DashboardWidgetRecord,
} from '../facades/dashboards/hooks'
import { PhoneNavigationButton } from '../layouts/admin-shell/PhoneNavigationButton'
import { dashboardKeys } from '../lib/query-keys'

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
        <Skeleton className="rounded-lg" height="h-full" />
      )}
    </div>
  )
}

export const DashboardDetailPage = () => {
  const { dashboardId } = useParams<{ dashboardId: string }>()
  const dashboardQuery = useDashboard(dashboardId)
  const { data: dashboard } = dashboardQuery
  const saveLayout = useSaveLayout(dashboardId ?? '')
  const queryClient = useQueryClient()

  const [editing, setEditing] = useState(false)
  const [showVersions, setShowVersions] = useState(false)
  const [showAddWidget, setShowAddWidget] = useState(false)
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

  return (
    <QueryState
      className="flex h-full items-center justify-center py-8"
      emptyLabel="This dashboard is not available."
      errorLabel="Failed to load this dashboard."
      isEmpty={!dashboard}
      loadingLabel="Loading…"
      query={dashboardQuery}
    >
      {() => dashboard && (
        <div className="flex h-full min-h-0" data-testid="dashboard-detail">
          <div className="flex min-w-0 flex-1 flex-col">
            {/* Left hand-rolled: AdminPageHeader has no subtitle slot for
                `dashboard.description` under the title — its only secondary line is
                `eyebrow`, a 10px uppercase tracking-[0.2em] rail above the title,
                which is not the same element. */}
            <header className="flex items-center gap-3 border-b border-[color:var(--sep)] px-6 py-3">
              <PhoneNavigationButton />
              <div className="min-w-0">
                <h1 className="truncate text-base font-semibold text-[color:var(--tx)]">
                  {dashboard.title}
                </h1>
                {dashboard.description ? (
                  <p className="truncate text-xs text-[color:var(--tx3)]">
                    {dashboard.description}
                  </p>
                ) : null}
              </div>
              <div className="ml-auto flex items-center gap-2">
                <button
                  className="admin-button admin-button-secondary admin-button-compact"
                  onClick={() => setShowVersions((open) => !open)}
                  type="button"
                >
                  History
                </button>
                {editing ? (
                  <button
                    className="admin-button admin-button-secondary admin-button-compact"
                    onClick={() => setShowAddWidget(true)}
                    type="button"
                    data-testid="dashboard-add-widget"
                  >
                    + Add widget
                  </button>
                ) : null}
                {editing ? (
                  <button
                    className="admin-button admin-button-primary admin-button-compact"
                    disabled={saveLayout.isPending}
                    onClick={() => {
                      saveLayout.mutate(layout, { onSuccess: () => setEditing(false) })
                    }}
                    type="button"
                  >
                    {saveLayout.isPending ? 'Saving…' : 'Done'}
                  </button>
                ) : (
                  <button
                    className="admin-button admin-button-secondary admin-button-compact"
                    onClick={() => setEditing(true)}
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
                  className="admin-card p-8 text-center"
                  data-testid="dashboard-empty"
                >
                  <p className="text-sm font-medium text-[color:var(--tx)]">
                    No widgets yet
                  </p>
                  <p className="mt-1 text-xs text-[color:var(--tx3)]">
                    Ask your assistant to add one, or connect a data source to get started.
                  </p>
                  <button
                    className="admin-button admin-button-secondary mt-4"
                    onClick={() => {
                      setEditing(true)
                      setShowAddWidget(true)
                    }}
                    type="button"
                  >
                    Add a widget yourself
                  </button>
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

          {showAddWidget ? (
            <AddWidgetPanel
              dashboardId={dashboard.id}
              onAdded={() => queryClient.invalidateQueries({ queryKey: dashboardKeys.detail(dashboard.id) })}
              onClose={() => setShowAddWidget(false)}
            />
          ) : null}

          {showVersions ? (
            <DashboardVersionsPanel
              dashboardId={dashboard.id}
              onClose={() => setShowVersions(false)}
            />
          ) : null}
        </div>
      )}
    </QueryState>
  )
}

export default DashboardDetailPage
