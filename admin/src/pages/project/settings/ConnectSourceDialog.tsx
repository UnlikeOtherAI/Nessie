import { useEffect, useState } from 'react'
import {
  PROVIDER_LABEL,
  useBoardSourceConnections,
  useBoardSourceProviders,
  useConnectWithApiKey,
  useConnectionContainers,
  useCreateProjectSource,
  useStartConnection,
  type BoardSourceProvider,
} from '../../../facades/board-sources/hooks'
import { Dialog } from '../../../components/shared/Dialog'
import { EmptyState } from '../../../components/shared/EmptyState'
import { FormError } from '../../../components/shared/FormActions'
import { Select } from '../../../components/shared/FormControls'
import { FormField } from '../../../components/shared/FormField'
import { CredentialFormFields } from './CredentialFormFields'

type ConnectSourceDialogProps = {
  onClose: () => void
  onCreated: (sourceId: string) => void
  open: boolean
  projectId: string
}

/**
 * Connect an account, then choose which of its containers feeds this project.
 *
 * Two steps rather than one because they are two different authorities: the
 * account is the person's own, and pointing it at a project is administering
 * that project. Whoever attaches must own the connection — a sync carries their
 * delegated authority, so attaching somebody else's would run under a credential
 * its owner never aimed here.
 *
 * The key is offered before the sign-in wherever a provider has both. A pasted
 * key works on every deployment; the sign-in works only where somebody
 * registered an app with the vendor, and leading with the one that might not be
 * there is how this dialog used to be empty.
 */
export const ConnectSourceDialog = ({
  onClose,
  onCreated,
  open,
  projectId,
}: ConnectSourceDialogProps) => {
  const { data: providers = [] } = useBoardSourceProviders()
  const connectionsQuery = useBoardSourceConnections()
  const startConnection = useStartConnection()
  const connectWithApiKey = useConnectWithApiKey()
  const createSource = useCreateProjectSource(projectId)

  const [connectionId, setConnectionId] = useState('')
  const [containerKey, setContainerKey] = useState('')
  const [keyProvider, setKeyProvider] = useState<BoardSourceProvider | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)

  const ownConnections = (connectionsQuery.data ?? []).filter(
    (connection) => connection.isOwnedByViewer && connection.status === 'active',
  )
  const containersQuery = useConnectionContainers(connectionId || undefined)
  const keyForm = providers.find((entry) => entry.provider === keyProvider)?.apiKeyForm ?? null

  useEffect(() => {
    if (!connectionId && ownConnections[0]) setConnectionId(ownConnections[0].id)
  }, [connectionId, ownConnections])

  const connect = (provider: BoardSourceProvider) => {
    setError(null)
    startConnection.mutate(
      { provider },
      {
        onError: (cause) =>
          setError(cause instanceof Error ? cause.message : 'Could not start the sign-in'),
        onSuccess: ({ authorizeUrl }) => {
          // A popup so the person keeps this dialog and its project context;
          // the callback page posts back to it and closes.
          window.open(authorizeUrl, 'nessie-board-source', 'width=620,height=760')
        },
      },
    )
  }

  const submitKey = () => {
    if (!keyProvider) return
    setError(null)
    connectWithApiKey.mutate(
      { provider: keyProvider, values },
      {
        onError: (cause) =>
          setError(cause instanceof Error ? cause.message : 'Could not use that key'),
        onSuccess: ({ connectionId: created }) => {
          // The key itself is not kept here for a moment longer than the
          // request needed it.
          setValues({})
          setKeyProvider(null)
          setConnectionId(created)
          setContainerKey('')
          void connectionsQuery.refetch()
        },
      },
    )
  }

  // The callback page posts to whatever opened it. Nothing else is trusted:
  // the message must come from this origin and carry our own marker.
  useEffect(() => {
    if (!open) return
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return
      const data = event.data as { source?: string; ok?: boolean } | null
      if (data?.source !== 'nessie-board-source') return
      if (data.ok) void connectionsQuery.refetch()
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [connectionsQuery, open])

  const attach = () => {
    const container = (containersQuery.data ?? []).find(
      (candidate) => candidate.key === containerKey,
    )
    if (!container) return
    setError(null)
    createSource.mutate(
      { connectionId, container: container.container, name: container.label },
      {
        onError: (cause) =>
          setError(cause instanceof Error ? cause.message : 'Could not attach that container'),
        onSuccess: (source) => {
          onCreated(source.id)
          onClose()
        },
      },
    )
  }

  return (
    <Dialog
      description="Its work appears on this project's boards as ordinary tasks."
      onClose={onClose}
      open={open}
      title="Connect a source"
    >
      <div className="grid gap-4">
        {providers.length === 0 ? (
          <EmptyState title="No project tools are available on this deployment.">
            No connector is registered. An operator enables one in the server configuration.
          </EmptyState>
        ) : keyForm && keyProvider ? (
          <>
            <CredentialFormFields
              disabled={connectWithApiKey.isPending}
              form={keyForm}
              onChange={(key, value) => setValues((prior) => ({ ...prior, [key]: value }))}
              values={values}
            />
            <FormError>{error ?? undefined}</FormError>
            <div className="flex justify-end gap-2">
              <button
                className="admin-button"
                onClick={() => {
                  setKeyProvider(null)
                  setValues({})
                  setError(null)
                }}
                type="button"
              >
                Back
              </button>
              <button
                className="admin-button admin-button-primary"
                disabled={connectWithApiKey.isPending}
                onClick={submitKey}
                type="button"
              >
                {connectWithApiKey.isPending
                  ? 'Checking…'
                  : `Connect ${PROVIDER_LABEL[keyProvider]}`}
              </button>
            </div>
          </>
        ) : (
          <>
            <FormField
              help="Connect the account whose work should appear here. The sync runs as you."
              label="Account"
            >
              {ownConnections.length > 0 ? (
                <Select
                  onChange={(event) => {
                    setConnectionId(event.target.value)
                    setContainerKey('')
                  }}
                  value={connectionId}
                >
                  {ownConnections.map((connection) => (
                    <option key={connection.id} value={connection.id}>
                      {PROVIDER_LABEL[connection.provider]} · {connection.externalAccountId}
                    </option>
                  ))}
                </Select>
              ) : (
                <div className="text-sm text-[color:var(--tx3)]">
                  You have not connected an account yet.
                </div>
              )}
            </FormField>

            <div className="flex flex-wrap gap-2">
              {providers.map((entry) => (
                <span className="flex gap-2" key={entry.provider}>
                  {entry.apiKeyForm ? (
                    <button
                      className="admin-button admin-button-compact"
                      onClick={() => {
                        setKeyProvider(entry.provider)
                        setValues({})
                        setError(null)
                      }}
                      type="button"
                    >
                      {PROVIDER_LABEL[entry.provider]} with a key…
                    </button>
                  ) : null}
                  {entry.methods.includes('oauth') ? (
                    <button
                      className="admin-button admin-button-compact"
                      onClick={() => connect(entry.provider)}
                      type="button"
                    >
                      Sign in to {PROVIDER_LABEL[entry.provider]}…
                    </button>
                  ) : null}
                </span>
              ))}
            </div>

            {connectionId ? (
              <FormField label="What to bring in">
                <Select
                  disabled={containersQuery.isPending}
                  onChange={(event) => setContainerKey(event.target.value)}
                  value={containerKey}
                >
                  <option value="">
                    {containersQuery.isPending ? 'Loading…' : 'Choose…'}
                  </option>
                  {(containersQuery.data ?? []).map((container) => (
                    <option key={container.key} value={container.key}>
                      {container.label}
                      {container.hint ? ` · ${container.hint}` : ''}
                    </option>
                  ))}
                </Select>
              </FormField>
            ) : null}

            <FormError>{error ?? undefined}</FormError>

            <div className="flex justify-end gap-2">
              <button className="admin-button" onClick={onClose} type="button">
                Cancel
              </button>
              <button
                className="admin-button admin-button-primary"
                disabled={!containerKey || createSource.isPending}
                onClick={attach}
                type="button"
              >
                Add source
              </button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  )
}
