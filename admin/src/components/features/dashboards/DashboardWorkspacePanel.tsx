/** The normal-size dashboard shares the conversation's URL-driven side panel. */

import { useEffect, useMemo, useRef, useState } from 'react'
import { ApiClientError } from '@nessie/client-core'
import type { DashboardWidgetKind } from '@nessie/schemas'
import { useSidePanelGeometry } from '../../../hooks/useSidePanelGeometry'
import { usePhoneLayout } from '../../../lib/mobile-shell'
import { PhoneBackButton } from '../../../layouts/admin-shell/PhoneBackButton'
import { useDashboard, useDashboardSourceNotes, useSaveLayout } from '../../../facades/dashboards/hooks'
import { SidePanelShell } from '../channels/side-panel/SidePanelShell'
import { SkeletonBlock } from '../../primitives/Skeleton'
import { DashboardCanvas } from './DashboardCanvas'
import { useDashboardRealtime } from './DashboardRealtimeProvider'

const PANEL_WIDTH_KEY = 'nessie.dashboardWorkspacePanelWidth'

export const DashboardWorkspacePanel = ({
  dashboardId,
  onClose,
}: {
  dashboardId: string
  onClose: () => void
}) => {
  const geometry = useSidePanelGeometry(PANEL_WIDTH_KEY)
  const phoneLayout = usePhoneLayout()
  const dashboard = useDashboard(dashboardId)
  const sourceNotes = useDashboardSourceNotes(dashboardId)
  const realtime = useDashboardRealtime(dashboardId)
  const saveLayout = useSaveLayout(dashboardId)
  const [editing, setEditing] = useState(false)
  const [draftLayout, setDraftLayout] = useState<import('@nessie/schemas').DashboardLayout | null>(null)
  const baseRevision = useRef<number | null>(null)
  useEffect(() => {
    if (!editing && dashboard.data) setDraftLayout(dashboard.data.layout)
  }, [dashboard.data, editing])
  const widgetKinds = useMemo(
    () => new Map(
      (dashboard.data?.widgets ?? []).map((widget) => [widget.id, widget.kind as DashboardWidgetKind]),
    ),
    [dashboard.data?.widgets],
  )
  const saveError = saveLayout.error
  const isRevisionConflict = saveError instanceof ApiClientError
    && saveError.code === 'DASHBOARD_REVISION_CONFLICT'
  const reloadAuthoritativeLayout = () => {
    if (!dashboard.data) return
    baseRevision.current = dashboard.data.revision
    setDraftLayout(dashboard.data.layout)
    saveLayout.reset()
  }
  const retryDraftAgainstCurrentRevision = () => {
    if (!dashboard.data || !draftLayout) return
    saveLayout.reset()
    baseRevision.current = dashboard.data.revision
    saveLayout.mutate(
      { layout: draftLayout, revision: dashboard.data.revision },
      {
        onError: () => void dashboard.refetch(),
        onSuccess: () => setEditing(false),
      },
    )
  }

  return (
    <SidePanelShell
      ariaLabel="Dashboard workspace"
      isClosing={false}
      onClose={onClose}
      panelWidth={geometry.panelWidth}
      persistPanelWidth={geometry.persistPanelWidth}
      resizePanel={geometry.resizePanel}
      resizePanelWithKeyboard={geometry.resizePanelWithKeyboard}
      viewportWidth={geometry.viewportWidth}
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-[color:var(--sep)] px-4 py-3">
        {phoneLayout ? <PhoneBackButton label="Back to channel" onBack={onClose} /> : null}
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-[color:var(--tx)]">
            {dashboard.data?.title ?? 'Dashboard'}
          </h2>
          <p className="truncate text-xs text-[color:var(--tx3)]">
            {dashboard.data ? `Revision ${dashboard.data.revision} · ${realtime}` : 'Loading dashboard'}
          </p>
        </div>
        {dashboard.data ? (
          editing ? (
            <button
              className="admin-button admin-button-primary text-xs"
              disabled={saveLayout.isPending}
              onClick={() => saveLayout.mutate(
                {
                  layout: draftLayout ?? dashboard.data!.layout,
                  revision: baseRevision.current ?? dashboard.data!.revision,
                },
                {
                  // Refetch before offering a retry: no stale revision is
                  // ever silently replayed over an agent or another editor.
                  onError: () => void dashboard.refetch(),
                  onSuccess: () => setEditing(false),
                },
              )}
              type="button"
            >
              {saveLayout.isPending ? 'Saving…' : 'Done'}
            </button>
          ) : (
            <button
              className="admin-button admin-button-secondary text-xs"
              onClick={() => {
                baseRevision.current = dashboard.data!.revision
                setDraftLayout(dashboard.data!.layout)
                setEditing(true)
              }}
              type="button"
            >
              Edit layout
            </button>
          )
        ) : null}
        {phoneLayout ? null : (
          <button
            aria-label="Close dashboard workspace"
            className="admin-icon-button"
            onClick={onClose}
            type="button"
          >
            ×
          </button>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {saveError ? (
          <section
            aria-live="assertive"
            className="mb-3 rounded-md border border-[color:var(--warning-border)] bg-[color:var(--warning-soft)] p-3 text-sm text-[color:var(--warning-text)]"
          >
            <p>
              {isRevisionConflict
                ? 'This dashboard changed while you were editing. Your layout draft is still here.'
                : 'The dashboard layout could not be saved. Your layout draft is still here.'}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                className="admin-button admin-button-secondary text-xs"
                onClick={() => {
                  reloadAuthoritativeLayout()
                  setEditing(false)
                }}
                type="button"
              >
                Reload current layout
              </button>
              <button
                className="admin-button admin-button-primary text-xs"
                disabled={!dashboard.data || !draftLayout || saveLayout.isPending}
                onClick={retryDraftAgainstCurrentRevision}
                type="button"
              >
                Keep and retry
              </button>
            </div>
          </section>
        ) : null}
        {dashboard.isError ? (
          <div className="rounded-lg border border-[color:var(--sep)] bg-[color:var(--panel)] p-3 text-sm text-[color:var(--tx3)]">
            This dashboard is unavailable. Check your access or return to the conversation and try again.
          </div>
        ) : dashboard.data ? (
          <DashboardCanvas
            dashboard={dashboard.data}
            editable={editing}
            layout={draftLayout ?? dashboard.data.layout}
            onLayoutChange={setDraftLayout}
            widgetKinds={widgetKinds}
          />
        ) : (
          <SkeletonBlock className="h-64 w-full rounded-lg" />
        )}
        {sourceNotes.data && sourceNotes.data.length > 0 ? (
          <section aria-label="Source notes" className="mt-5 border-t border-[color:var(--sep)] pt-3">
            <h3 className="text-xs font-semibold text-[color:var(--tx)]">Source notes</h3>
            <ul className="mt-2 space-y-1 text-xs text-[color:var(--tx3)]">
              {sourceNotes.data.map((source) => {
                const attribution = dashboard.data?.presentation.attributions.find(
                  (entry) => entry.sourceId === source.id,
                )
                if (attribution?.visible === false) return null
                return (
                  <li key={source.id}>
                    <span className="text-[color:var(--tx2)]">{attribution?.label ?? source.name}</span>
                    {' · '}{source.kind === 'static' ? 'static import' : 'HTTPS source'}
                    {source.sourceReference ? ` · ${source.sourceReference}` : ''}
                    {source.canonicalUrl ? ` · ${source.canonicalUrl}` : ''}
                    {source.contentDigest ? ` · digest ${source.contentDigest.slice(0, 12)}` : ''}
                  </li>
                )
              })}
            </ul>
          </section>
        ) : null}
      </div>
    </SidePanelShell>
  )
}
