/**
 * `/dashboards/:dashboardId` — view and edit one dashboard.
 *
 * View is the default and is chrome-free. Edit adds the grid affordances and
 * saves the layout explicitly, which also appends a version — so every
 * rearrangement is recoverable and attributable. Deliberately NOT a debounced
 * server auto-save: each save appends a `DashboardVersion`, and one row per
 * drag would bury the history the versions panel exists for. The arrangement
 * is still never lost — it is buffered as a local draft under
 * `draft:dashboard-layout:<id>` — and Done carries `If-Match`, so a save that
 * lost a race is refused and the choice is offered in place
 * (docs/navigation/overview.md → "Drafts").
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import type { DashboardLayout, DashboardWidgetKind } from '@nessie/schemas'
import { Skeleton } from '../components/primitives/Skeleton'
import { DashboardCanvas } from '../components/features/dashboards/DashboardCanvas'
import { DashboardVersionsPanel } from '../components/features/dashboards/DashboardVersionsPanel'
import { AddWidgetPanel } from '../components/features/dashboards/AddWidgetPanel'
import {
  useDashboard,
  useSaveLayout,
} from '../facades/dashboards/hooks'
import { QueryState } from '../components/shared/QueryState'
import { ScreenHeader } from '../components/shared/ScreenHeader'
import { LOCAL_BACK_PRIORITY } from '../layouts/admin-shell/local-back/LocalBackContext'
import { dashboardKeys } from '../lib/query-keys'
import { draftKey, useDraft } from '../navigation/useDraft'
import { NestedStage } from '../navigation/NestedStage'

export const DashboardDetailPage = () => {
  const { dashboardId } = useParams<{ dashboardId: string }>()
  const dashboardQuery = useDashboard(dashboardId)
  const { data: dashboard, isLoading } = dashboardQuery
  const saveLayout = useSaveLayout(dashboardId ?? '')
  const queryClient = useQueryClient()

  const [editing, setEditing] = useState(false)
  const [showVersions, setShowVersions] = useState(false)
  const [showAddWidget, setShowAddWidget] = useState(false)
  // The revision the current edit started from; `If-Match` on the save.
  const baseRevisionRef = useRef<number | null>(null)
  const [conflictRevision, setConflictRevision] = useState<number | null>(null)

  const layoutDraft = useDraft<DashboardLayout | null>(
    draftKey('dashboard-layout', dashboardId),
    {
      initial: null,
      // An arrangement identical to the server's is not a draft, so opening a
      // dashboard and leaving stores nothing.
      isEmpty: (value) =>
        value === null
        || JSON.stringify(value) === JSON.stringify(dashboard?.layout ?? null),
    },
  )
  const draftLayout = layoutDraft.draft
  const setDraftLayout = layoutDraft.setDraft

  // Guarded by id, not merely by presence: the query keeps the previous
  // dashboard on screen during a sibling swap (docs/navigation/overview.md §"Arriving
  // with content"), and seeding the draft from it would let a Save write one
  // dashboard's layout onto another.
  useEffect(() => {
    if (dashboard && dashboard.id === dashboardId && draftLayout === null) {
      setDraftLayout(dashboard.layout)
    }
  }, [dashboard, dashboardId, draftLayout, setDraftLayout])

  const widgetKinds = useMemo(() => {
    const map = new Map<string, DashboardWidgetKind>()
    for (const widget of dashboard?.widgets ?? []) {
      map.set(widget.id, widget.kind as DashboardWidgetKind)
    }
    return map
  }, [dashboard])

  const layout = draftLayout ?? { lg: [], md: [], sm: [] }

  // Never a blocking dialog: a refused save renders the choice as a bar over the
  // grid, and the arrangement stays in the draft either way.
  const saveArrangement = (revision?: number) => {
    saveLayout.mutate(
      { layout, ...(revision === undefined ? {} : { revision }) },
      {
        onError: (error) => {
          const details = (error as { details?: { currentRevision?: number } }).details
          setConflictRevision(
            typeof details?.currentRevision === 'number' ? details.currentRevision : null,
          )
        },
        onSuccess: () => {
          layoutDraft.clear()
          setConflictRevision(null)
          setEditing(false)
        },
      },
    )
  }

  const takeTheirs = () => {
    layoutDraft.clear()
    setConflictRevision(null)
    setEditing(false)
    void queryClient.invalidateQueries({ queryKey: dashboardKeys.detail(dashboardId ?? '') })
  }

  // Both waiting states render under the same header, so a phone keeps its
  // Back while a dashboard loads or turns out not to exist. A dashboard is a
  // grid of cards, so its first load shows one rather than the word Loading.
  if (isLoading || !dashboard) {
    return (
      <div className="flex h-full min-h-0 flex-col" data-testid="dashboard-detail">
        <ScreenHeader title="Dashboard" />
        {isLoading ? (
          <Skeleton className="p-6" count={6} variant="board" />
        ) : (
          <QueryState
            emptyLabel="This dashboard is not available."
            errorLabel="Failed to load this dashboard."
            isEmpty
            loadingLabel="Loading…"
            query={dashboardQuery}
          >
            {() => null}
          </QueryState>
        )}
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
                onSelect: () => saveArrangement(baseRevisionRef.current ?? undefined),
                primary: true,
                priority: 100,
              }
              : {
                id: 'dashboard-edit',
                label: 'Edit',
                onSelect: () => {
                  baseRevisionRef.current = dashboard.revision
                  setConflictRevision(null)
                  setEditing(true)
                },
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

        {conflictRevision !== null || saveLayout.isError ? (
          <div
            className="flex flex-wrap items-center gap-3 border-b px-6 py-2 text-xs"
            role="status"
            style={{ borderColor: 'var(--sep)', background: 'var(--overlay-weak)' }}
          >
            <span style={{ color: 'var(--tx2)' }}>
              Somebody else rearranged this dashboard while you were editing.
              Your arrangement is kept.
            </span>
            <button
              className="rounded px-2.5 py-1 font-medium"
              onClick={() => saveArrangement()}
              style={{ background: 'var(--accent)', color: 'var(--on-accent, #fff)' }}
              type="button"
            >
              Keep mine
            </button>
            <button
              className="rounded px-2.5 py-1"
              onClick={takeTheirs}
              style={{ background: 'var(--overlay-weak)', color: 'var(--tx2)' }}
              type="button"
            >
              Take theirs
            </button>
          </div>
        ) : null}

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
            <div className="admin-card p-8 text-center" data-testid="dashboard-empty">
              <p className="text-sm font-medium text-[color:var(--tx)]">No widgets yet</p>
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
            <DashboardCanvas
              dashboard={dashboard}
              editable={editing}
              layout={layout}
              onLayoutChange={setDraftLayout}
              widgetKinds={widgetKinds}
            />
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
