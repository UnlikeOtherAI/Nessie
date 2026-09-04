import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type {
  CommsConnectionSummary,
  CommsConnectionStatus,
  CommsProvider,
} from '../../../lib/api-client'
import { connectionAnchorId } from '../../../lib/connection-anchor'
import { Pill, type PillTone } from '../../../components/primitives/Pill'
import { Switch } from '../../../components/primitives/Switch'
import { Card } from '../../../components/shared/Card'
import { ConfirmDialog } from '../../../components/shared/ConfirmDialog'
import { KeyValueList } from '../../../components/shared/KeyValueList'
import { QueryState } from '../../../components/shared/QueryState'
import { Row, RowList } from '../../../components/shared/RowList'
import {
  useCommsConnection,
  useDeleteCommsData,
  useDisconnectCommsConnection,
  useResyncCommsConnection,
  useUpdateCommsResources,
} from '../../../facades/connections/hooks'
import { useSendGrants } from '../../../facades/gmail/hooks'
import { ConnectionPermissions } from './ConnectionPermissions'
import { AddSendAuthorization } from './AddSendAuthorization'

const PROVIDER_LABEL: Record<CommsProvider, string> = {
  slack: 'Slack',
  google: 'Gmail',
  microsoft: 'Microsoft',
}

const STATUS_LABEL: Record<CommsConnectionStatus, string> = {
  active: 'Healthy',
  needs_reauthorization: 'Needs reauthorization',
  disconnected: 'Disconnected',
  error: 'Error',
}

const STATUS_TONE: Record<CommsConnectionStatus, PillTone> = {
  active: 'success',
  needs_reauthorization: 'warning',
  disconnected: 'muted',
  error: 'danger',
}

const formatDate = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleString() : 'Never'

type PendingAction = 'delete' | 'disconnect' | null

export const ConnectionCard = ({
  connection,
}: {
  connection: CommsConnectionSummary
}) => {
  const [expanded, setExpanded] = useState(false)
  const [pendingAction, setPendingAction] = useState<PendingAction>(null)
  // Permissions are the primary thing a person comes here to change, so a
  // provider with a capability catalog loads its detail without expanding.
  const hasCapabilityCatalog = connection.provider === 'google'
  const detail = useCommsConnection(
    expanded || hasCapabilityCatalog ? connection.id : null,
  )
  const sendGrants = useSendGrants()
  const updateResources = useUpdateCommsResources()
  const resync = useResyncCommsConnection()
  const disconnect = useDisconnectCommsConnection()
  const deleteData = useDeleteCommsData()
  const navigate = useNavigate()

  const isDisconnected = connection.status === 'disconnected'
  const providerLabel = PROVIDER_LABEL[connection.provider]

  const keyValueItems = [
    {
      label: 'Imported history',
      value: connection.initialSyncCompletedAt
        ? `Imported ${formatDate(connection.initialSyncCompletedAt)}`
        : 'Import pending',
    },
    { label: 'Last successful sync', value: formatDate(connection.lastSuccessfulSyncAt) },
    {
      label: 'Granted permissions',
      value: connection.grantedScopes.length > 0
        ? `${connection.grantedScopes.length} scopes`
        : 'None reported',
    },
    {
      label: 'Included resources',
      value: `${connection.syncedResourceCount} of ${connection.resourceCount} on`,
    },
  ]

  return (
    <Card as="section" id={connectionAnchorId(connection.id)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-[color:var(--tx)]">{providerLabel}</h2>
            <Pill
              className="font-semibold"
              radius="chip"
              size="sm"
              tone={STATUS_TONE[connection.status]}
              uppercase={false}
            >
              {STATUS_LABEL[connection.status]}
            </Pill>
          </div>
          <div className="mt-1 truncate text-xs text-[color:var(--tx3)]">
            {connection.externalUserId} · team {connection.externalTenantId}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {connection.provider === 'google' && connection.status === 'active' ? (
            <button
              className="admin-button admin-button-secondary"
              onClick={() => navigate(`/mail/gmail/${encodeURIComponent(connection.id)}`)}
              type="button"
            >
              Open mail
            </button>
          ) : null}
          <button
            className="admin-button admin-button-secondary"
            disabled={isDisconnected || resync.isPending}
            onClick={() => resync.mutate(connection.id)}
            type="button"
          >
            {resync.isPending ? 'Resyncing…' : 'Resync'}
          </button>
          <button
            className="admin-button admin-button-secondary admin-button-danger"
            disabled={isDisconnected || disconnect.isPending}
            onClick={() => setPendingAction('disconnect')}
            type="button"
          >
            Disconnect
          </button>
          <button
            className="admin-button admin-button-secondary admin-button-danger"
            disabled={deleteData.isPending}
            onClick={() => setPendingAction('delete')}
            type="button"
          >
            Delete imported data
          </button>
        </div>
      </div>

      <div className="mt-3">
        <KeyValueList items={keyValueItems} layout="grid" />
      </div>

      {/* Raw scope strings answer no question once the readable capability
          rows exist; they stay only for a provider with no catalog. */}
      {!hasCapabilityCatalog && connection.grantedScopes.length > 0 ? (
        <p className="mt-2 break-words text-[11px] text-[color:var(--tx3)]">
          {connection.grantedScopes.join(', ')}
        </p>
      ) : null}

      {hasCapabilityCatalog && detail.data ? (
        <>
          <ConnectionPermissions
            capabilities={detail.data.capabilities}
            connection={connection}
          />
          {/* Standing consent belongs under the account it is about, not as a
              floating page section: a grant is per mailbox. */}
          <AddSendAuthorization
            connection={connection}
            existing={sendGrants.data?.grants ?? []}
          />
        </>
      ) : null}

      <button
        className="mt-3 text-xs font-semibold text-[color:var(--accent)]"
        onClick={() => setExpanded((value) => !value)}
        type="button"
      >
        {expanded ? 'Hide channels & labels' : 'Manage channels & labels'}
      </button>

      {expanded ? (
        <div className="mt-2">
          <QueryState
            emptyLabel="No resources discovered yet. Run a resync after the initial import completes."
            errorLabel="Could not load resources."
            isEmpty={(detail.data?.resources.length ?? 0) === 0}
            loadingLabel="Loading resources…"
            query={detail}
          >
            {() => (
              <RowList label={`${providerLabel} resources`}>
                {(detail.data?.resources ?? []).map((resource) => (
                  <Row
                    key={resource.id}
                    subtitle={
                      resource.resourceType
                      + (resource.visibility ? ` · ${resource.visibility}` : '')
                    }
                    title={resource.name ?? resource.externalId}
                    trailing={
                      <Switch
                        checked={resource.syncEnabled}
                        disabled={updateResources.isPending || !resource.userHasAccess}
                        label={`Include ${resource.name ?? resource.externalId}`}
                        onChange={(next) =>
                          updateResources.mutate({
                            id: connection.id,
                            resources: [{ resourceId: resource.id, syncEnabled: next }],
                          })}
                      />
                    }
                  />
                ))}
              </RowList>
            )}
          </QueryState>
        </div>
      ) : null}

      <ConfirmDialog
        body={
          pendingAction === 'disconnect'
            ? `${providerLabel} stops syncing until you reconnect it.`
            : pendingAction === 'delete'
              ? 'Everything imported from this account is permanently removed.'
              : undefined
        }
        confirmLabel={
          pendingAction === 'disconnect' ? 'Disconnect' : 'Delete imported data'
        }
        destructive
        onCancel={() => setPendingAction(null)}
        onConfirm={() => {
          if (pendingAction === 'disconnect') disconnect.mutate(connection.id)
          if (pendingAction === 'delete') deleteData.mutate(connection.id)
          setPendingAction(null)
        }}
        open={pendingAction !== null}
        title={
          pendingAction === 'disconnect'
            ? `Disconnect ${providerLabel}?`
            : `Delete imported data?`
        }
      />
    </Card>
  )
}
