/**
 * `/dashboards` — the owning surface.
 *
 * Every row answers a choice: what it is, where it lives, whether its data is
 * trustworthy right now, and when it last changed. Request counts, storage
 * bytes and other operational telemetry are deliberately absent — they belong
 * on the owner-only /ops/usage surface, not here (Rule zero §3).
 */

import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Pill } from '../components/primitives/Pill'
import { QueryState } from '../components/shared/QueryState'
import { useCreateDashboard, useDashboards } from '../facades/dashboards/hooks'
import { prewarmRowHandlers, usePrewarm } from '../navigation/prewarm'
import { ScreenHeader } from '../components/shared/ScreenHeader'

const HOME_LABEL: Record<string, string> = {
  organization: 'Organisation',
  project: 'Project',
  team: 'Team',
  channel: 'Channel',
  personal: 'Personal',
}

export const DashboardsPage = () => {
  const prewarm = usePrewarm()
  const dashboardsQuery = useDashboards()
  const dashboards = dashboardsQuery.data
  const createDashboard = useCreateDashboard()
  const [search, setSearch] = useState('')

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return dashboards ?? []
    return (dashboards ?? []).filter((dashboard) =>
      dashboard.title.toLowerCase().includes(term),
    )
  }, [dashboards, search])

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="dashboards-page">
      {/* The hero's title and subtitle are the one header's; the search field
          moved out of the title row into the body, where a text input belongs
          — the actions lane measures buttons, not fields. */}
      <ScreenHeader
        actions={[{
          disabled: createDashboard.isPending,
          id: 'create-dashboard',
          label: 'Create dashboard',
          onSelect: () => createDashboard.mutate({ title: 'Untitled dashboard', home: 'personal' }),
          primary: true,
          priority: 100,
        }]}
        subtitle={
          <p className="text-xs text-[color:var(--tx3)]">
            Live data from the services you connect.
          </p>
        }
        title="Dashboards"
      />

      <div className="flex min-h-0 flex-1 flex-col gap-4 px-[var(--page-gutter)] py-6">
        <input
          className="admin-input w-56"
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search dashboards"
          value={search}
        />

      {/* This page had no error branch at all: a failed read fell straight
          through to "Ask your assistant to build one", which states that the
          team has no dashboards when the truth is that nothing was read.
          The two facts now render differently, and the failure offers a Retry.
          Declared pixel change: the loading line moves from left-aligned to
          QueryState's centred py-8 — the price of the error state sharing its
          shape. The empty state stays hand-written: it is a card with a call
          to action, not a line. */}
      <QueryState
        errorLabel="Failed to load dashboards."
        loadingLabel="Loading…"
        query={dashboardsQuery}
      >
        {() =>
          filtered.length === 0 ? (
            <div className="admin-card p-8 text-center" data-testid="dashboards-empty">
              <p className="text-sm font-medium text-[color:var(--tx)]">
                Ask your assistant to build one
              </p>
              <p className="mx-auto mt-1 max-w-md text-xs text-[color:var(--tx3)]">
                Describe what you want to watch and it will connect the data and lay out the
                widgets — the same controls you get here.
              </p>
              <button
                className="admin-button admin-button-secondary mt-4"
                onClick={() =>
                  createDashboard.mutate({ title: 'Untitled dashboard', home: 'personal' })
                }
                type="button"
              >
                Or start with a blank canvas
              </button>
            </div>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {filtered.map((dashboard) => (
                <li key={dashboard.id}>
                  <Link
                    className="flex items-center gap-3 rounded-lg border border-[color:var(--sep)] bg-[color:var(--panel)] px-3 py-2.5 transition-colors hover:bg-[color:var(--overlay-weak)]"
                    to={`/dashboards/${dashboard.id}`}
                    {...prewarmRowHandlers(prewarm, `/dashboards/${dashboard.id}`)}
                  >
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-[color:var(--tx)]">
                      {dashboard.title}
                    </span>
                    <Pill size="sm" tone="muted">
                      {HOME_LABEL[dashboard.home] ?? dashboard.home}
                    </Pill>
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
    </div>
  )
}

export default DashboardsPage
