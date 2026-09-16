/**
 * `/projects/:projectId/dashboards` — a project's dashboards, listed.
 *
 * This is the owning surface. It replaced `/dashboards`, an organisation-wide
 * list that lived under Knowledge and showed every dashboard with a chip
 * naming which of five homes it was in. A dashboard lives in a project now, so
 * the list is a project's list and the chip has nothing left to say.
 *
 * The project Overview shows the same dashboards as live tiles; this is where
 * a person makes one, finds one by name when there are many, and sees the ones
 * the Overview's grid would make too small to read.
 */

import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Pill } from '../../components/primitives/Pill'
import { QueryState } from '../../components/shared/QueryState'
import { useCreateDashboard, useDashboards } from '../../facades/dashboards/hooks'
import {
  DASHBOARD_DESIGNER_SLUG,
  useOpenGlobalAgentHome,
} from '../../facades/global-agents/hooks'
import { useCanModifyProject } from '../../facades/projects/administration'
import { prewarmRowHandlers, usePrewarm } from '../../navigation/prewarm'

type ProjectDashboardsTabProps = {
  projectId: string
}

export const ProjectDashboardsTab = ({ projectId }: ProjectDashboardsTabProps) => {
  const prewarm = usePrewarm()
  const navigate = useNavigate()
  const dashboardsQuery = useDashboards(projectId)
  const dashboards = dashboardsQuery.data
  const createDashboard = useCreateDashboard()
  const openGlobalAgentHome = useOpenGlobalAgentHome()
  const canCreate = useCanModifyProject(projectId)
  const [search, setSearch] = useState('')

  const openDashboardDesigner = () => {
    void openGlobalAgentHome
      .mutateAsync(DASHBOARD_DESIGNER_SLUG)
      .then((response) => navigate(`/channels/${response.channel.id}`))
      .catch(() => undefined)
  }

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return dashboards ?? []
    return (dashboards ?? []).filter((dashboard) =>
      dashboard.title.toLowerCase().includes(term))
  }, [dashboards, search])

  const href = (dashboardId: string) => `/projects/${projectId}/dashboards/${dashboardId}`

  return (
    <div
      className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto px-[var(--page-gutter)] py-5"
      data-testid="project-dashboards"
    >
      <div className="flex flex-wrap items-center gap-2">
        <input
          className="admin-input w-56"
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search dashboards"
          value={search}
        />
        {canCreate ? (
          <button
            className="admin-button admin-button-secondary ml-auto"
            disabled={createDashboard.isPending}
            onClick={() =>
              createDashboard.mutate(
                { projectId, title: 'Untitled dashboard' },
                { onSuccess: (created) => navigate(href(created.id)) },
              )}
            type="button"
          >
            {createDashboard.isPending ? 'Creating…' : 'Blank dashboard'}
          </button>
        ) : null}
        <button
          className="admin-button admin-button-primary"
          disabled={openGlobalAgentHome.isPending}
          onClick={openDashboardDesigner}
          type="button"
        >
          Ask Dashboard Designer
        </button>
      </div>

      {/* A failed read and an empty project are different facts and render
          differently: "this project has none" is a call to action, "we could
          not read them" offers a Retry. */}
      <QueryState
        errorLabel="Failed to load this project's dashboards."
        loadingLabel="Loading…"
        query={dashboardsQuery}
      >
        {() =>
          filtered.length === 0 ? (
            <div className="admin-card p-8 text-center" data-testid="project-dashboards-empty">
              <p className="text-sm font-medium text-[color:var(--tx)]">
                {search.trim()
                  ? 'No dashboard here matches that.'
                  : 'No dashboards in this project yet'}
              </p>
              <p className="mx-auto mt-1 max-w-md text-xs text-[color:var(--tx3)]">
                Describe what you want to watch and Dashboard Designer will connect the data
                and lay out the widgets — the same controls you get here.
              </p>
              <button
                className="admin-button admin-button-secondary mt-4"
                disabled={openGlobalAgentHome.isPending}
                onClick={openDashboardDesigner}
                type="button"
              >
                {openGlobalAgentHome.isPending
                  ? 'Opening Dashboard Designer…'
                  : 'Start a dashboard chat'}
              </button>
            </div>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {filtered.map((dashboard) => (
                <li key={dashboard.id}>
                  <Link
                    className="flex items-center gap-3 rounded-lg border border-[color:var(--sep)]
                      bg-[color:var(--panel)] px-3 py-2.5 transition-colors
                      hover:bg-[color:var(--overlay-weak)]"
                    to={href(dashboard.id)}
                    {...prewarmRowHandlers(prewarm, href(dashboard.id))}
                  >
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-[color:var(--tx)]">
                      {dashboard.title}
                    </span>
                    {dashboard.createdByType === 'agent' ? (
                      <Pill size="sm" tone="accent">built by an agent</Pill>
                    ) : null}
                    <span className="text-[11px] text-[color:var(--tx3)]">
                      {new Date(dashboard.updatedAt).toLocaleDateString()}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )
        }
      </QueryState>
    </div>
  )
}
