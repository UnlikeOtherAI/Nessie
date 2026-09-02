/**
 * Version history.
 *
 * Rows are identical for people and agents; only the glyph and the run link
 * differ. An agent row deep-links the run that made the change, so "why did
 * this move?" is answered by the conversation that caused it.
 */

import { SidePanel } from '../../shared/SidePanel'
import { QueryState } from '../../shared/QueryState'
import { useDashboardVersions } from '../../../facades/dashboards/hooks'

export const DashboardVersionsPanel = ({
  dashboardId,
  onClose,
}: {
  dashboardId: string
  onClose: () => void
}) => {
  const versionsQuery = useDashboardVersions(dashboardId)
  const versions = versionsQuery.data ?? []

  return (
    <SidePanel className="shrink-0" onClose={onClose} title="Versions">
      <div data-testid="dashboard-versions">
        <QueryState
          className="py-2"
          emptyLabel="No changes recorded yet."
          errorLabel="Failed to load version history."
          isEmpty={versions.length === 0}
          loadingLabel="Loading…"
          query={versionsQuery}
        >
          {() => (
            <ol className="flex flex-col gap-3">
              {versions.map((version) => (
                <li key={version.id} className="flex flex-col gap-0.5">
                  <div className="flex items-center gap-1.5 text-[11px] text-[color:var(--tx3)]">
                    <span>{new Date(version.createdAt).toLocaleString()}</span>
                    {version.authorType === 'agent' ? (
                      <span className="text-[color:var(--thinking)]">· agent</span>
                    ) : null}
                  </div>
                  {/* Composed deterministically from the op log — structural
                      fact, never a reading of content. */}
                  <p className="text-xs text-[color:var(--tx2)]">
                    {version.summary}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </QueryState>
      </div>
    </SidePanel>
  )
}
