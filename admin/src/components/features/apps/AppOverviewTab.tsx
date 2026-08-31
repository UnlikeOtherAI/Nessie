import { faArrowUpRightFromSquare } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { AppDetailRecord } from '@nessie/schemas'
import { Link } from 'react-router-dom'
import { appDetailLinks, appDetailStats } from './app-detail-view'

type AppOverviewTabProps = {
  app: AppDetailRecord
}

// "What did I get, and who can already use it?" Health probes and failure
// counts are owner-ops facts and stay on the Connectors page.
export const AppOverviewTab = ({ app }: AppOverviewTabProps) => {
  const stats = appDetailStats(app)
  const links = appDetailLinks(app)

  return (
    <div className="grid gap-6" data-testid="app-overview">
      {stats.length > 0 ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {stats.map((stat) => (
            <div
              className="rounded-[var(--radius-md)] border border-[color:var(--sep)] px-3 py-2"
              key={stat.label}
            >
              <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]">
                {stat.label}
              </div>
              <div className="mt-1 text-sm text-[color:var(--tx)]">{stat.value}</div>
            </div>
          ))}
        </div>
      ) : null}

      {app.agentsWithAccess.length > 0 ? (
        <section>
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]">
            Used by agents
          </h3>
          <div className="mt-2 flex flex-wrap gap-2">
            {app.agentsWithAccess.map((agent) => (
              <Link
                className={[
                  'rounded-full border border-[color:var(--sep)] bg-[color:var(--panel-soft)]',
                  'px-3 py-1 text-xs text-[color:var(--tx2)]',
                  'transition-colors duration-[var(--duration-fast)]',
                  'hover:border-[color:var(--border-strong)] hover:text-[color:var(--tx)]',
                ].join(' ')}
                key={agent.agentId}
                to={`/agents/${agent.agentId}`}
              >
                {agent.name}
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      <section>
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]">
          Details
        </h3>
        <dl className="mt-2 grid gap-x-6 gap-y-2 sm:grid-cols-2">
          {app.vendor ? (
            <div className="flex items-baseline justify-between gap-3 border-b border-[color:var(--sep)] py-2">
              <dt className="text-xs text-[color:var(--tx3)]">Provider</dt>
              <dd className="min-w-0 truncate text-sm text-[color:var(--tx2)]">{app.vendor}</dd>
            </div>
          ) : null}
          {links.map((link) => (
            <div
              className="flex items-baseline justify-between gap-3 border-b border-[color:var(--sep)] py-2"
              key={link.label}
            >
              <dt className="text-xs text-[color:var(--tx3)]">{link.label}</dt>
              <dd className="min-w-0 truncate text-sm">
                <a
                  className="inline-flex items-center gap-1.5 text-[color:var(--lnk)] hover:underline"
                  href={link.href}
                  rel="noreferrer noopener"
                  target="_blank"
                >
                  <span className="min-w-0 truncate">{link.href}</span>
                  <FontAwesomeIcon className="h-2.5 w-2.5" icon={faArrowUpRightFromSquare} />
                </a>
              </dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  )
}
