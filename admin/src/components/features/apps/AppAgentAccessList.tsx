import type { AppDetailRecord } from '@nessie/schemas'
import { Link } from 'react-router-dom'
import { getAgentGlyph } from '../../shared/AgentAvatar'
import { EmptyState } from '../../shared/EmptyState'
import { agentsAccessEmptyMessage } from './app-detail-view'

type AppAgentAccessListProps = {
  app: AppDetailRecord
}

/**
 * Which agents may call this app.
 *
 * Connecting an account and letting an agent use it are two decisions with two
 * controls — connecting never silently grants access. This phase renders the
 * grants that exist and links each agent to its own page; the checkbox that
 * writes a grant arrives with the connect flow, and this list is the surface it
 * lands in.
 */
export const AppAgentAccessList = ({ app }: AppAgentAccessListProps) => {
  const empty = agentsAccessEmptyMessage(app)

  return (
    <div className="grid gap-3" data-testid="app-agent-access">
      {app.agentsWithAccess.length === 0 ? (
        <EmptyState>
          <div className="font-medium text-[color:var(--tx2)]">{empty.title}</div>
          <p className="mt-1">{empty.body}</p>
        </EmptyState>
      ) : (
        <ul className="grid gap-2">
          {app.agentsWithAccess.map((agent) => (
            <li key={agent.agentId}>
              <Link
                className={[
                  'flex items-center gap-3 rounded-[var(--radius-md)]',
                  'border border-[color:var(--sep)] bg-[color:var(--panel-soft)] px-4 py-3',
                  'transition-colors duration-[var(--duration-fast)]',
                  'hover:border-[color:var(--border-strong)] hover:bg-[color:var(--overlay-weak)]',
                ].join(' ')}
                to={`/agents/${agent.agentId}`}
              >
                {/* The access record carries no avatar, so the row uses the
                    shared role glyph rather than inventing avatar fields. */}
                <span
                  aria-hidden="true"
                  className={[
                    'flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md',
                    'border border-[color:var(--accent)] bg-[color:var(--accent-soft)] text-sm',
                  ].join(' ')}
                >
                  {getAgentGlyph({ role: agent.role ?? '' })}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-[color:var(--tx)]">
                    {agent.name}
                  </span>
                  {agent.role ? (
                    <span className="block truncate text-xs text-[color:var(--tx3)]">
                      {agent.role}
                    </span>
                  ) : null}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs leading-5 text-[color:var(--tx3)]">
        Agents that are not listed here cannot see or call this app at all.
        Removing access takes effect immediately; a running agent finishes its current step.
      </p>
    </div>
  )
}
