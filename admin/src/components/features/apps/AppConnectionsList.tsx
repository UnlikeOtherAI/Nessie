import type { AppDetailRecord } from '@nessie/schemas'
import { Pill } from '../../primitives/Pill'
import { EmptyState } from '../../shared/EmptyState'
import {
  connectionConnectedLabel,
  connectionStatusPill,
} from './app-connection-presentation'
import { connectionsEmptyMessage } from './app-detail-view'

type AppConnectionsListProps = {
  app: AppDetailRecord
  onConnectAnother: () => void
}

// The accounts this app is reachable through, and who each one works for.
// Never a token, a secret reference, or a masked variant of one — a member's
// only credential fact is that it is stored encrypted.
//
// `displayName` is already the server's wording for who the account works for,
// so each row says it once: the name, the status pill, and — only when there is
// one — how recently it was reached.
export const AppConnectionsList = ({ app, onConnectAnother }: AppConnectionsListProps) => {
  const now = Date.now()

  if (app.connections.length === 0) {
    return (
      <EmptyState>
        <div className="font-medium text-[color:var(--tx2)]">{connectionsEmptyMessage.title}</div>
        <p className="mt-1">{connectionsEmptyMessage.body}</p>
      </EmptyState>
    )
  }

  return (
    <div className="grid gap-3" data-testid="app-connections">
      <ul className="grid gap-2">
        {app.connections.map((connection) => {
          const pill = connectionStatusPill(connection.status)
          const connectedLabel = connectionConnectedLabel(connection, now)
          return (
            <li
              className={[
                'rounded-[var(--radius-md)] border border-[color:var(--sep)]',
                'bg-[color:var(--panel-soft)] px-4 py-3',
              ].join(' ')}
              key={connection.id}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 truncate text-sm font-medium text-[color:var(--tx)]">
                  {connection.displayName}
                </span>
                <Pill tone={pill.tone}>{pill.label}</Pill>
              </div>
              {connectedLabel ? (
                <div className="mt-1 text-xs text-[color:var(--tx3)]">{connectedLabel}</div>
              ) : null}
              {/* A switched-off account has no control here and none anywhere
                  else either — nothing in the product moves an install out of
                  `paused`. Saying so, and naming the one route that does work,
                  is the difference between a status and a dead end. */}
              {connection.status === 'disabled' ? (
                <div className="mt-1 text-xs text-[color:var(--tx3)]">
                  Switched off. Connecting an account below is the way to use this app again.
                </div>
              ) : null}
              {connection.errorMessage ? (
                <p
                  className={[
                    'mt-2 rounded-md border border-[color:var(--danger-border)]',
                    'bg-[color:var(--danger-soft)] px-3 py-2 text-xs',
                    'text-[color:var(--danger-text)]',
                  ].join(' ')}
                  role="alert"
                >
                  {connection.errorMessage}
                </p>
              ) : null}
            </li>
          )
        })}
      </ul>
      <div>
        <button
          className="admin-button admin-button-secondary"
          data-testid="app-connect-another"
          onClick={onConnectAnother}
          type="button"
        >
          Connect another account
        </button>
      </div>
    </div>
  )
}
