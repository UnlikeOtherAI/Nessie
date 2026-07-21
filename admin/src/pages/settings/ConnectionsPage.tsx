import { useCommsConnections } from '../../facades/connections/hooks'
import { SettingsPanel } from './settings-shared'
import { ConnectionCard } from './connections/ConnectionCard'

/**
 * "Connected accounts" — the user's Individual Communications Connector control
 * surface. Lists the caller's own Slack / Gmail / Microsoft connections with
 * identity, workspace, granted permissions, imported-history status, last sync,
 * a health pill, per-resource include toggles, and Resync / Disconnect / Delete
 * imported data controls. New connections are started from chat (the Chief of
 * Staff posts a connect card), so the empty state points there.
 */
export const ConnectionsPage = () => {
  const connections = useCommsConnections()
  const rows = connections.data?.connections ?? []

  return (
    <SettingsPanel eyebrow="Account" title="Connected accounts">
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <p className="text-sm text-[color:var(--tx2)]">
          Link your Slack, Gmail, or Microsoft account so your Chief of Staff can
          work across your messages. You choose exactly what is imported, and you
          can disconnect or delete imported data at any time.
        </p>

        {connections.isLoading ? (
          <p className="text-sm text-[color:var(--tx3)]">Loading connections…</p>
        ) : connections.isError ? (
          <div className="rounded-md border border-[color:var(--danger-border)] bg-[color:var(--danger-soft)] px-3 py-2 text-sm text-[color:var(--danger-text)]">
            Could not load your connections. Please refresh and try again.
          </div>
        ) : rows.length === 0 ? (
          <section className="admin-card p-6 text-center">
            <div className="text-sm font-semibold text-[color:var(--tx)]">
              No connected accounts yet
            </div>
            <p className="mx-auto mt-1 max-w-md text-sm text-[color:var(--tx3)]">
              Ask your Chief of Staff in chat to connect an account — it will post
              a card with a one-click Connect button for Slack and Gmail.
            </p>
          </section>
        ) : (
          rows.map((connection) => (
            <ConnectionCard connection={connection} key={connection.id} />
          ))
        )}
      </div>
    </SettingsPanel>
  )
}
