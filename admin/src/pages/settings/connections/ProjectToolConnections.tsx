import { useState } from 'react'
import {
  PROVIDER_LABEL,
  useBoardSourceConnections,
  useBoardSourceProviders,
  useDeleteConnection,
  useStartConnection,
  type BoardSourceConnectionRecord,
} from '../../../facades/board-sources/hooks'
import { ConfirmDialog } from '../../../components/shared/ConfirmDialog'
import { EmptyState } from '../../../components/shared/EmptyState'
import { FormError } from '../../../components/shared/FormActions'
import { Pill } from '../../../components/primitives/Pill'

const STATUS: Record<
  BoardSourceConnectionRecord['status'],
  { tone: 'danger' | 'success' | 'warning'; label: string }
> = {
  active: { tone: 'success', label: 'Connected' },
  needs_reauthorization: { tone: 'danger', label: 'Needs reconnecting' },
  revoked: { tone: 'warning', label: 'Revoked' },
}

/**
 * The accounts a person has connected for project boards, and where they take
 * them away again.
 *
 * This is the connection's home: a source in a project *names* one of these,
 * but the authority is the person's, so it is managed here beside their other
 * connected accounts rather than inside somebody's project.
 */
export const ProjectToolConnections = () => {
  const { data: providers = [] } = useBoardSourceProviders()
  const { data: connections = [] } = useBoardSourceConnections()
  const startConnection = useStartConnection()
  const removeConnection = useDeleteConnection()
  const [error, setError] = useState<string | null>(null)
  const [removeTarget, setRemoveTarget] = useState<BoardSourceConnectionRecord | null>(null)

  const mine = connections.filter((connection) => connection.isOwnedByViewer)

  const connect = (provider: BoardSourceConnectionRecord['provider'], reconnect?: string) => {
    setError(null)
    startConnection.mutate(
      { provider, ...(reconnect ? { reauthorizeConnectionId: reconnect } : {}) },
      {
        onError: (cause) =>
          setError(cause instanceof Error ? cause.message : 'Could not start the sign-in'),
        onSuccess: ({ authorizeUrl }) => {
          window.open(authorizeUrl, 'nessie-board-source', 'width=620,height=760')
        },
      },
    )
  }

  // Only providers this deployment can actually sign in to. One that is
  // reachable by a pasted key alone gets no button here: the key is pasted
  // where it is aimed, in a project's Settings → Sources, and a button that
  // could only answer "no sign-in app is configured" is a dead end.
  const signInProviders = providers.filter((entry) => entry.methods.includes('oauth'))
  const keyOnly = providers.filter(
    (entry) => !entry.methods.includes('oauth') && entry.apiKeyForm,
  )

  if (providers.length === 0) return null

  return (
    <section className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold text-[color:var(--tx)]">Project tools</h2>
          <p className="mt-1 text-sm text-[color:var(--tx2)]">
            Connect an account once, then bring any of its boards into a project from
            that project&rsquo;s Settings → Sources. Syncing runs as you, and sees exactly
            what you can see.
          </p>
          {keyOnly.length > 0 ? (
            <p className="mt-1 text-sm text-[color:var(--tx3)]">
              {keyOnly.map((entry) => PROVIDER_LABEL[entry.provider]).join(', ')}
              {keyOnly.length === 1 ? ' connects' : ' connect'} with an API key, pasted
              from a project&rsquo;s Settings → Sources. The connection appears here
              afterwards.
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {signInProviders.map(({ provider }) => (
            <button
              className="admin-button admin-button-compact"
              key={provider}
              onClick={() => connect(provider)}
              type="button"
            >
              Connect {PROVIDER_LABEL[provider]}
            </button>
          ))}
        </div>
      </div>

      <FormError>{error ?? undefined}</FormError>

      {mine.length === 0 ? (
        <EmptyState title="No project tools connected">
          Nothing is syncing yet. Connecting an account here does not change any board on
          its own — a project administrator points it at a project afterwards.
        </EmptyState>
      ) : (
        <div className="grid gap-2">
          {mine.map((connection) => (
            <div className="flex flex-wrap items-center gap-2" key={connection.id}>
              <span className="min-w-0 flex-1 truncate text-sm text-[color:var(--tx)]">
                {PROVIDER_LABEL[connection.provider]} · {connection.externalAccountId}
              </span>
              <Pill size="sm" tone={STATUS[connection.status].tone} uppercase={false}>
                {STATUS[connection.status].label}
              </Pill>
              <button
                className="text-xs text-[color:var(--tx3)] hover:text-[color:var(--tx)]"
                onClick={() => connect(connection.provider, connection.id)}
                type="button"
              >
                Reconnect
              </button>
              <button
                className="text-xs text-[color:var(--tx3)] hover:text-[color:var(--danger-text)]"
                onClick={() => setRemoveTarget(connection)}
                type="button"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        body="Any project still syncing under this account will refuse the removal and name itself, so nothing stops updating without somebody deciding it should."
        confirmLabel="Remove"
        destructive
        onCancel={() => setRemoveTarget(null)}
        onConfirm={() => {
          const target = removeTarget
          setRemoveTarget(null)
          if (!target) return
          removeConnection.mutate(target.id, {
            onError: (cause) =>
              setError(cause instanceof Error ? cause.message : 'Could not remove the connection'),
          })
        }}
        open={removeTarget !== null}
        title={`Remove your ${removeTarget ? PROVIDER_LABEL[removeTarget.provider] : ''} account?`}
      />
    </section>
  )
}
