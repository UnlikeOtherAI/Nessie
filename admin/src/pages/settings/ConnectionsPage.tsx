import {
  useCommsConnections,
  useStartCommsConnection,
} from '../../facades/connections/hooks'
import type { CommsProvider } from '../../lib/api-client'
import { EmptyState } from '../../components/shared/EmptyState'
import { CloudBrowserPanel } from '../../components/features/browser-cloud/CloudBrowserPanel'
import { QueryState } from '../../components/shared/QueryState'
import { SettingsPanel } from './settings-shared'
import { ConnectionCard } from './connections/ConnectionCard'

const CONNECTABLE: { provider: CommsProvider; label: string }[] = [
  { provider: 'slack', label: 'Connect Slack' },
  { provider: 'google', label: 'Connect Gmail' },
]

const ConnectButtons = ({
  onConnect,
  pending,
  variant,
}: {
  onConnect: (provider: CommsProvider) => void
  pending: boolean
  variant: 'primary' | 'secondary'
}) => (
  <div className="flex gap-2">
    {CONNECTABLE.map((entry) => (
      <button
        className={`admin-button admin-button-${variant} admin-button-compact`}
        disabled={pending}
        key={entry.provider}
        onClick={() => onConnect(entry.provider)}
        type="button"
      >
        {entry.label}
      </button>
    ))}
  </div>
)

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
      <div className="flex max-w-3xl flex-col gap-6">
        <p className="text-sm text-[color:var(--tx2)]">
          Link your Slack, Gmail, or Microsoft account so your Chief of Staff can
          work across your messages. You choose exactly what is imported, and you
          can disconnect or delete imported data at any time.
        </p>

        <QueryState
          errorLabel="Could not load your connections."
          loadingLabel="Loading connections…"
          query={connections}
        >
          {() => (
            rows.length === 0 ? (
              <EmptyState
                action={
                  <ConnectButtons
                    onConnect={(provider) => void onConnect(provider)}
                    pending={start.isPending}
                    variant="primary"
                  />
                }
                title="No connected accounts yet"
              >
                Connect an account below, or ask your Chief of Staff in chat — it
                will post a card with a one-click Connect button.
              </EmptyState>
            ) : (
              <div className="grid gap-4">
                {rows.map((connection) => (
                  <ConnectionCard connection={connection} key={connection.id} />
                ))}
                <ConnectButtons
                  onConnect={(provider) => void onConnect(provider)}
                  pending={start.isPending}
                  variant="secondary"
                />
              </div>
            )
          )}
        </QueryState>

        <CloudBrowserPanel scope="user" />
      </div>
    </SettingsPanel>
  )
}
