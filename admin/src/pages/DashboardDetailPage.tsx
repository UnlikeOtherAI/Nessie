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
import {
  useDashboard,
  useSaveLayout,
  useWidgetData,
  type DashboardWidgetRecord,
} from '../facades/dashboards/hooks'
import { ScreenHeader } from '../components/shared/ScreenHeader'
import { LOCAL_BACK_PRIORITY } from '../layouts/admin-shell/local-back/LocalBackContext'
import { dashboardKeys } from '../lib/query-keys'
import { NestedStage } from '../navigation/NestedStage'

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

  // Both waiting states render under the same header, so a phone keeps its
  // Back while a dashboard loads or turns out not to exist.
  if (isLoading || !dashboard) {
    return (
      <div className="flex h-full min-h-0 flex-col" data-testid="dashboard-detail">
        <ScreenHeader title="Dashboard" />
        <p className="p-6 text-sm" style={{ color: 'var(--tx3)' }}>
          {isLoading ? 'Loading…' : 'This dashboard is not available.'}
        </p>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0" data-testid="dashboard-detail">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* The description line is the header's subtitle slot; History,
            Add widget and Edit/Done are its measured actions. */}
        <ScreenHeader
          actions={[
            {
              id: 'dashboard-history',
              label: 'History',
              onSelect: () => setShowVersions((open) => !open),
              priority: 30,
            },
            ...(editing ? [{
              id: 'dashboard-add-widget',
              label: '+ Add widget',
              onSelect: () => setShowAddWidget(true),
              priority: 60,
            }] : []),
            editing
              ? {
                disabled: saveLayout.isPending,
                id: 'dashboard-done',
                label: saveLayout.isPending ? 'Saving…' : 'Done',
                onSelect: () => {
                  saveLayout.mutate(layout, { onSuccess: () => setEditing(false) })
                },
                primary: true,
                priority: 100,
              }
              : {
                id: 'dashboard-edit',
                label: 'Edit',
                onSelect: () => setEditing(true),
                priority: 100,
              },
          ]}
          subtitle={dashboard.description ? (
            <p className="truncate text-xs" style={{ color: 'var(--tx3)' }}>
              {dashboard.description}
            </p>
          ) : null}
          title={dashboard.title}
        />

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
              <button
                className="mt-4 rounded px-3 py-1.5 text-sm"
                onClick={() => {
                  setEditing(true)
                  setShowAddWidget(true)
                }}
                style={{ background: 'var(--overlay-weak)', color: 'var(--tx2)' }}
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

      <NestedStage
        active={showAddWidget}
        id="dashboard:add-widget"
        label="Back to dashboard"
        onBack={() => setShowAddWidget(false)}
        priority={LOCAL_BACK_PRIORITY.dashboardPanel}
      >
        <AddWidgetPanel
          dashboardId={dashboard.id}
          onAdded={() => queryClient.invalidateQueries({ queryKey: dashboardKeys.detail(dashboard.id) })}
          onClose={() => setShowAddWidget(false)}
        />
      </NestedStage>

      <NestedStage
        active={showVersions}
        id="dashboard:versions"
        label="Back to dashboard"
        onBack={() => setShowVersions(false)}
        priority={LOCAL_BACK_PRIORITY.dashboardVersions}
      >
        <DashboardVersionsPanel
          dashboardId={dashboard.id}
          onClose={() => setShowVersions(false)}
        />
      </NestedStage>
    </div>
  )
}

export default DashboardDetailPage
