import { faArrowUpRightFromSquare } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { AppDetailRecord } from '@nessie/schemas'
import { Link } from 'react-router-dom'
import { KeyValueList } from '../../shared/KeyValueList'
import { StatGrid, StatTile } from '../../shared/StatTile'
import { appDetailLinks, appDetailStats } from './app-detail-view'

type AppOverviewTabProps = {
  app: AppDetailRecord
}

// "What did I get, and who can already use it?" Health probes and failure
// counts are owner-ops facts and do not render on this member surface.
export const AppOverviewTab = ({ app }: AppOverviewTabProps) => {
  const stats = appDetailStats(app)
  const links = appDetailLinks(app)

  const detailItems = [
    ...(app.vendor ? [{ label: 'Provider', value: app.vendor }] : []),
    ...links.map((link) => ({
      label: link.label,
      value: (
        <a
          className="inline-flex items-center gap-1.5 text-[color:var(--lnk)] hover:underline"
          href={link.href}
          rel="noreferrer noopener"
          target="_blank"
        >
          <span className="min-w-0 truncate">{link.href}</span>
          <FontAwesomeIcon className="h-2.5 w-2.5" icon={faArrowUpRightFromSquare} />
        </a>
      ),
    })),
  ]

  return (
    <div className="grid gap-6" data-testid="app-overview">
      {stats.length > 0 ? (
        <StatGrid>
          {stats.map((stat) => (
            <StatTile key={stat.label} label={stat.label} value={stat.value} />
          ))}
        </StatGrid>
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

      {detailItems.length > 0 ? (
        <section>
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]">
            Details
          </h3>
          <KeyValueList className="mt-2" items={detailItems} layout="rows" />
        </section>
      ) : null}
    </div>
  )
}
