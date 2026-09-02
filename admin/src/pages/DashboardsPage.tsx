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
import { QueryState } from '../components/shared/QueryState'
import { useCreateDashboard, useDashboards } from '../facades/dashboards/hooks'
import { PhoneNavigationButton } from '../layouts/admin-shell/PhoneNavigationButton'
import { prewarmRowHandlers, usePrewarm } from '../navigation/prewarm'

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
    <div className="flex h-full flex-col gap-4 p-6" data-testid="dashboards-page">
      {/* Hand-rolled: AdminPageHeader renders a page title at text-[17px]
          font-bold in an h-[50px] bordered bar, and cannot express this
          text-lg font-semibold title, the subtitle beneath it, or the search
          field sharing the title row. */}
      <header className="flex items-center gap-3">
        <PhoneNavigationButton />
        <div className="min-w-0">
          <h1 className="text-lg font-semibold" style={{ color: 'var(--tx)' }}>
            Dashboards
          </h1>
          <p className="text-xs" style={{ color: 'var(--tx3)' }}>
            Live data from the services you connect.
          </p>
        </div>
        <input
          className="ml-auto w-56 rounded border px-2 py-1.5 text-sm"
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search dashboards"
          style={{
            background: 'var(--panel)',
            borderColor: 'var(--sep)',
            color: 'var(--tx)',
          }}
          value={search}
        />
        <button
          className="rounded px-3 py-1.5 text-sm font-medium"
          disabled={createDashboard.isPending}
          onClick={() =>
            createDashboard.mutate({ title: 'Untitled dashboard', home: 'personal' })
          }
          style={{ background: 'var(--accent)', color: 'var(--on-accent, #fff)' }}
          type="button"
        >
          Create dashboard
        </button>
      </header>

      {/* This page had no error branch at all: a failed read fell straight
          through to "Ask your assistant to build one", which states that the
          workspace has no dashboards when the truth is that nothing was read.
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
            <div
              className="rounded-lg border p-8 text-center"
              style={{ borderColor: 'var(--sep)', background: 'var(--panel)' }}
              data-testid="dashboards-empty"
            >
              <p className="text-sm font-medium" style={{ color: 'var(--tx)' }}>
                Ask your assistant to build one
              </p>
              <p className="mx-auto mt-1 max-w-md text-xs" style={{ color: 'var(--tx3)' }}>
                Describe what you want to watch and it will connect the data and lay out the
                widgets — the same controls you get here.
              </p>
              <button
                className="mt-4 rounded px-3 py-1.5 text-sm"
                onClick={() =>
                  createDashboard.mutate({ title: 'Untitled dashboard', home: 'personal' })
                }
                style={{ background: 'var(--overlay-weak)', color: 'var(--tx2)' }}
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
                    className="flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors"
                    style={{ background: 'var(--panel)', borderColor: 'var(--sep)' }}
                    to={`/dashboards/${dashboard.id}`}
                    {...prewarmRowHandlers(prewarm, `/dashboards/${dashboard.id}`)}
                  >
                    <span className="min-w-0 flex-1 truncate text-sm font-medium" style={{ color: 'var(--tx)' }}>
                      {dashboard.title}
                    </span>
                    <span
                      className="rounded px-1.5 py-0.5 text-[11px]"
                      style={{ background: 'var(--overlay-weak)', color: 'var(--tx3)' }}
                    >
                      {HOME_LABEL[dashboard.home] ?? dashboard.home}
                    </span>
                    {dashboard.createdByType === 'agent' ? (
                      <span className="text-[11px]" style={{ color: 'var(--thinking)' }}>
                        built by an agent
                      </span>
                    ) : null}
                    <span className="text-[11px]" style={{ color: 'var(--tx3)' }}>
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

export default DashboardsPage
