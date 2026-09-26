import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
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
  const { t } = useTranslation('projects')
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
          setError(cause instanceof Error ? cause.message : t('sourceSettings.signInError')),
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
          setError(cause instanceof Error ? cause.message : t('sourceSettings.keyError')),
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
          setError(cause instanceof Error ? cause.message : t('sourceSettings.attachError')),
        onSuccess: (source) => {
          onCreated(source.id)
          onClose()
        },
      },
    )
  }

  return (
    <Dialog
      description={t('sourceSettings.connectDescription')}
      onClose={onClose}
      open={open}
      title={t('sourceSettings.connectTitle')}
    >
      <div className="grid gap-4">
        {providers.length === 0 ? (
          <EmptyState title={t('sourceSettings.noToolsTitle')}>
            {t('sourceSettings.noToolsBody')}
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
            <div className="flex flex-wrap justify-end gap-2">
              <button
                className="admin-button h-11"
                onClick={() => {
                  setKeyProvider(null)
                  setValues({})
                  setError(null)
                }}
                type="button"
              >
                {t('common.back')}
              </button>
              <button
                className="admin-button admin-button-primary h-11"
                disabled={connectWithApiKey.isPending}
                onClick={submitKey}
                type="button"
              >
                {connectWithApiKey.isPending
                  ? t('sourceSettings.checking')
                  : t('sourceSettings.connectProvider', { provider: PROVIDER_LABEL[keyProvider] })}
              </button>
            </div>
          </>
        ) : (
          <>
            <FormField
              help={t('sourceSettings.accountHelp')}
              label={t('sourceSettings.account')}
            >
              {ownConnections.length > 0 ? (
                <Select
                  className="h-11"
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
                  {t('sourceSettings.noAccount')}
                </div>
              )}
            </FormField>

            <div className="flex flex-wrap gap-2">
              {providers.map((entry) => (
                <span className="flex gap-2" key={entry.provider}>
                  {entry.apiKeyForm ? (
                    <button
                      className="admin-button h-11 max-w-full"
                      onClick={() => {
                        setKeyProvider(entry.provider)
                        setValues({})
                        setError(null)
                      }}
                      type="button"
                    >
                      {t('sourceSettings.providerWithKey', { provider: PROVIDER_LABEL[entry.provider] })}
                    </button>
                  ) : null}
                  {entry.methods.includes('oauth') ? (
                    <button
                      className="admin-button h-11 max-w-full"
                      onClick={() => connect(entry.provider)}
                      type="button"
                    >
                      {t('sourceSettings.signInProvider', { provider: PROVIDER_LABEL[entry.provider] })}
                    </button>
                  ) : null}
                </span>
              ))}
            </div>

            {connectionId ? (
              <FormField label={t('sourceSettings.whatToBringIn')}>
                <Select
                  className="h-11"
                  disabled={containersQuery.isPending}
                  onChange={(event) => setContainerKey(event.target.value)}
                  value={containerKey}
                >
                  <option value="">
                    {containersQuery.isPending ? t('sourceSettings.loading') : t('sourceSettings.choose')}
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

            <div className="flex flex-wrap justify-end gap-2">
              <button className="admin-button h-11" onClick={onClose} type="button">
                {t('common.cancel')}
              </button>
              <button
                className="admin-button admin-button-primary h-11"
                disabled={!containerKey || createSource.isPending}
                onClick={attach}
                type="button"
              >
                {t('sourceSettings.addSource')}
              </button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  )
}
