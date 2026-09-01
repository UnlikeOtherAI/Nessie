import { useState } from 'react'
import type { AppConnectionSummaryRecord, AppDetailRecord } from '@nessie/schemas'
import { Pill } from '../../primitives/Pill'
import { ConfirmDialog } from '../../shared/ConfirmDialog'
import { EmptyState } from '../../shared/EmptyState'
import { useDisconnectAppConnection } from '../../../facades/apps/connect-hooks'
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
  const disconnect = useDisconnectAppConnection()
  const [disconnecting, setDisconnecting] = useState<AppConnectionSummaryRecord | null>(null)

  const closeDisconnect = () => {
    if (disconnect.isPending) return
    disconnect.reset()
    setDisconnecting(null)
  }

  if (app.connections.length === 0) {
    return (
      <EmptyState>
        <div className="font-medium text-[color:var(--tx2)]">{connectionsEmptyMessage.title}</div>
        <p className="mt-1">{connectionsEmptyMessage.body}</p>
      </EmptyState>
    )
  }

  return (
    <div className="grid min-w-0 gap-3" data-testid="app-connections">
      <ul className="grid min-w-0 gap-2">
        {app.connections.map((connection) => {
          const pill = connectionStatusPill(connection.status)
          const connectedLabel = connectionConnectedLabel(connection, now)
          return (
            <li
              className={[
                'rounded-[var(--radius-md)] border border-[color:var(--sep)]',
                'min-w-0 bg-[color:var(--panel-soft)] px-4 py-3',
              ].join(' ')}
              key={connection.id}
            >
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-[color:var(--tx)]">
                  {connection.displayName}
                </span>
                <div className="flex max-w-full flex-wrap items-center justify-end gap-2">
                  <Pill tone={pill.tone}>{pill.label}</Pill>
                  {connection.canDisconnect ? (
                    <button
                      className="admin-button admin-button-secondary admin-button-danger admin-button-compact"
                      data-testid={`app-disconnect-${connection.id}`}
                      onClick={() => {
                        disconnect.reset()
                        setDisconnecting(connection)
                      }}
                      type="button"
                    >
                      Disconnect
                    </button>
                  ) : null}
                </div>
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
      <ConfirmDialog
        body={(
          <>
            <p>
              This account will no longer be available to the agents that use it.
            </p>
            {disconnect.isError ? (
              <p className="mt-3 text-sm text-[color:var(--danger-text)]" role="alert">
                We couldn&apos;t disconnect this account. Try again.
              </p>
            ) : null}
          </>
        )}
        confirmLabel={disconnect.isPending ? 'Disconnecting…' : 'Disconnect'}
        destructive
        onCancel={closeDisconnect}
        onConfirm={() => {
          if (!disconnecting) return
          disconnect.mutate(disconnecting.id, {
            onSuccess: () => setDisconnecting(null),
          })
        }}
        open={disconnecting !== null}
        pending={disconnect.isPending}
        title={`Disconnect ${disconnecting?.displayName ?? 'this account'}?`}
      />
    </div>
  )
}
