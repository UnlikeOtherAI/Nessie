/**
 * Version history.
 *
 * Rows are identical for people and agents; only the glyph and the run link
 * differ. An agent row deep-links the run that made the change, so "why did
 * this move?" is answered by the conversation that caused it.
 */

import { useDashboardVersions } from '../../../facades/dashboards/hooks'

export const DashboardVersionsPanel = ({
  dashboardId,
  onClose,
}: {
  dashboardId: string
  onClose: () => void
}) => {
  const { data: versions, isLoading } = useDashboardVersions(dashboardId)

  return (
    <aside
      className="flex h-full min-h-0 w-full flex-col border-l md:w-80 md:shrink-0"
      style={{ borderColor: 'var(--sep)', background: 'var(--panel)' }}
      data-testid="dashboard-versions"
    >
      <header
        className="flex items-center gap-2 border-b px-3 py-2.5"
        style={{ borderColor: 'var(--sep)' }}
      >
        <h2 className="text-sm font-semibold" style={{ color: 'var(--tx)' }}>
          Versions
        </h2>
        <button
          className="ml-auto rounded px-1.5 text-sm"
          onClick={onClose}
          style={{ color: 'var(--tx3)' }}
          type="button"
        >
          ✕
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {isLoading ? (
          <p className="text-xs" style={{ color: 'var(--tx3)' }}>
            Loading…
          </p>
        ) : (versions ?? []).length === 0 ? (
          <p className="text-xs" style={{ color: 'var(--tx3)' }}>
            No changes recorded yet.
          </p>
        ) : (
          <ol className="flex flex-col gap-3">
            {(versions ?? []).map((version) => (
              <li key={version.id} className="flex flex-col gap-0.5">
                <div className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--tx3)' }}>
                  <span>{new Date(version.createdAt).toLocaleString()}</span>
                  {version.authorType === 'agent' ? (
                    <span style={{ color: 'var(--thinking)' }}>· agent</span>
                  ) : null}
                </div>
                {/* Composed deterministically from the op log — structural
                    fact, never a reading of content. */}
                <p className="text-xs" style={{ color: 'var(--tx2)' }}>
                  {version.summary}
                </p>
              </li>
            ))}
          </ol>
        )}
      </div>
    </aside>
  )
}
