import {
  useCommsConnections,
  useStartCommsConnection,
} from '../../facades/connections/hooks'
import type { CommsProvider } from '../../lib/api-client'
import { Notice } from '../../components/primitives/Notice'
import { SettingsPanel } from './settings-shared'
import { ConnectionCard } from './connections/ConnectionCard'

const CONNECTABLE: { provider: CommsProvider; label: string }[] = [
  { provider: 'slack', label: 'Connect Slack' },
  { provider: 'google', label: 'Connect Gmail' },
]

/**
 * "Connected accounts" — the user's Individual Communications Connector control
 * surface. Lists the caller's own Slack / Gmail / Microsoft connections with
 * identity, workspace, granted permissions, imported-history status, last sync,
 * a health pill, per-resource include toggles, and Resync / Disconnect / Delete
 * imported data controls. Chat (the Chief of Staff connect card) is the primary
 * connect surface; the buttons here are the secondary path.
 */
export const ConnectionsPage = () => {
  const connections = useCommsConnections()
  const start = useStartCommsConnection()
  const rows = connections.data?.connections ?? []

  const onConnect = async (provider: CommsProvider) => {
    const result = await start.mutateAsync(provider)
    window.open(result.authorizeUrl, '_blank', 'noopener,noreferrer')
  }

  return (
    <SettingsPanel eyebrow="Account" title="Connected accounts">
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <p className="text-sm text-[color:var(--tx2)]">
          Link your Slack, Gmail, or Microsoft account so your Chief of Staff can
          work across your messages. You choose exactly what is imported, and you
          can disconnect or delete imported data at any time.
        </p>

        {/* Not QueryState: the error is a Notice and the empty state is a card
            with two Connect buttons — neither is a line. */}
        {connections.isLoading ? (
          <p className="text-sm text-[color:var(--tx3)]">Loading connections…</p>
        ) : connections.isError ? (
          <Notice tone="danger">
            Could not load your connections. Please refresh and try again.
          </Notice>
        ) : rows.length === 0 ? (
          <section className="admin-card p-6 text-center">
            <div className="text-sm font-semibold text-[color:var(--tx)]">
              No connected accounts yet
            </div>
            <p className="mx-auto mt-1 max-w-md text-sm text-[color:var(--tx3)]">
              Connect an account below, or ask your Chief of Staff in chat — it
              will post a card with a one-click Connect button.
            </p>
            <div className="mt-4 flex justify-center gap-2">
              {CONNECTABLE.map((entry) => (
                <button
                  className="admin-button admin-button-primary admin-button-compact"
                  disabled={start.isPending}
                  key={entry.provider}
                  onClick={() => void onConnect(entry.provider)}
                  type="button"
                >
                  {entry.label}
                </button>
              ))}
            </div>
          </section>
        ) : (
          <>
            {rows.map((connection) => (
              <ConnectionCard connection={connection} key={connection.id} />
            ))}
            <div className="flex gap-2">
              {CONNECTABLE.map((entry) => (
                <button
                  className="admin-button admin-button-secondary admin-button-compact"
                  disabled={start.isPending}
                  key={entry.provider}
                  onClick={() => void onConnect(entry.provider)}
                  type="button"
                >
                  {entry.label}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </SettingsPanel>
  )
}
