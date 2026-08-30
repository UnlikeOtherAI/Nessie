import { useState } from 'react'
import type {
  CommsConnectionSummary,
  CommsConnectionStatus,
  CommsProvider,
} from '../../../lib/api-client'
import { Pill, type PillTone } from '../../../components/primitives/Pill'
import { Switch } from '../../../components/primitives/Switch'
import {
  useCommsConnection,
  useDeleteCommsData,
  useDisconnectCommsConnection,
  useResyncCommsConnection,
  useUpdateCommsResources,
} from '../../../facades/connections/hooks'
import { sectionTitleClass } from '../settings-shared'

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

const DangerButton = ({
  idleLabel,
  confirmLabel,
  onConfirm,
  disabled,
}: {
  idleLabel: string
  confirmLabel: string
  onConfirm: () => void
  disabled?: boolean
}) => {
  const [armed, setArmed] = useState(false)
  return (
    <button
      className="admin-button admin-button-secondary admin-button-danger"
      disabled={disabled}
      onClick={() => {
        if (armed) {
          onConfirm()
          setArmed(false)
        } else {
          setArmed(true)
        }
      }}
      onBlur={() => setArmed(false)}
      type="button"
    >
      {armed ? confirmLabel : idleLabel}
    </button>
  )
}

export const ConnectionCard = ({
  connection,
}: {
  connection: CommsConnectionSummary
}) => {
  const [expanded, setExpanded] = useState(false)
  const detail = useCommsConnection(expanded ? connection.id : null)
  const updateResources = useUpdateCommsResources()
  const resync = useResyncCommsConnection()
  const disconnect = useDisconnectCommsConnection()
  const deleteData = useDeleteCommsData()

  const isDisconnected = connection.status === 'disconnected'

  return (
    <section className="admin-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-[color:var(--tx)]">
              {PROVIDER_LABEL[connection.provider]}
            </h2>
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
            {connection.externalUserId} · workspace {connection.externalTenantId}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            className="admin-button admin-button-secondary"
            disabled={isDisconnected || resync.isPending}
            onClick={() => resync.mutate(connection.id)}
            type="button"
          >
            {resync.isPending ? 'Resyncing…' : 'Resync'}
          </button>
          <DangerButton
            confirmLabel="Confirm disconnect"
            disabled={isDisconnected || disconnect.isPending}
            idleLabel="Disconnect"
            onConfirm={() => disconnect.mutate(connection.id)}
          />
          <DangerButton
            confirmLabel="Confirm delete"
            disabled={deleteData.isPending}
            idleLabel="Delete imported data"
            onConfirm={() => deleteData.mutate(connection.id)}
          />
        </div>
      </div>

      <dl className="mt-3 grid gap-2 sm:grid-cols-2">
        <div className="rounded border border-[color:var(--sep)] px-2 py-1.5">
          <dt className={sectionTitleClass}>Imported history</dt>
          <dd className="mt-0.5 text-xs text-[color:var(--tx)]">
            {connection.initialSyncCompletedAt
              ? `Imported ${formatDate(connection.initialSyncCompletedAt)}`
              : 'Import pending'}
          </dd>
        </div>
        <div className="rounded border border-[color:var(--sep)] px-2 py-1.5">
          <dt className={sectionTitleClass}>Last successful sync</dt>
          <dd className="mt-0.5 text-xs text-[color:var(--tx)]">
            {formatDate(connection.lastSuccessfulSyncAt)}
          </dd>
        </div>
        <div className="rounded border border-[color:var(--sep)] px-2 py-1.5">
          <dt className={sectionTitleClass}>Granted permissions</dt>
          <dd className="mt-0.5 text-xs text-[color:var(--tx)]">
            {connection.grantedScopes.length > 0
              ? `${connection.grantedScopes.length} scopes`
              : 'None reported'}
          </dd>
        </div>
        <div className="rounded border border-[color:var(--sep)] px-2 py-1.5">
          <dt className={sectionTitleClass}>Included resources</dt>
          <dd className="mt-0.5 text-xs text-[color:var(--tx)]">
            {connection.syncedResourceCount} of {connection.resourceCount} on
          </dd>
        </div>
      </dl>

      {connection.grantedScopes.length > 0 ? (
        <p className="mt-2 break-words text-[11px] text-[color:var(--tx3)]">
          {connection.grantedScopes.join(', ')}
        </p>
      ) : null}

      <button
        className="mt-3 text-xs font-semibold text-[color:var(--accent)]"
        onClick={() => setExpanded((value) => !value)}
        type="button"
      >
        {expanded ? 'Hide channels & labels' : 'Manage channels & labels'}
      </button>

      {expanded ? (
        <div className="mt-2 grid gap-1.5">
          {detail.isLoading ? (
            <p className="text-xs text-[color:var(--tx3)]">Loading resources…</p>
          ) : detail.data && detail.data.resources.length > 0 ? (
            detail.data.resources.map((resource) => (
              <div
                className="flex items-center justify-between gap-3 rounded border border-[color:var(--sep)] px-2 py-1.5"
                key={resource.id}
              >
                <div className="min-w-0">
                  <div className="truncate text-xs text-[color:var(--tx)]">
                    {resource.name ?? resource.externalId}
                  </div>
                  <div className="truncate text-[11px] text-[color:var(--tx3)]">
                    {resource.resourceType}
                    {resource.visibility ? ` · ${resource.visibility}` : ''}
                  </div>
                </div>
                <Switch
                  checked={resource.syncEnabled}
                  disabled={updateResources.isPending || !resource.userHasAccess}
                  label={`Include ${resource.name ?? resource.externalId}`}
                  onChange={(next) =>
                    updateResources.mutate({
                      id: connection.id,
                      resources: [{ resourceId: resource.id, syncEnabled: next }],
                    })
                  }
                />
              </div>
            ))
          ) : (
            <p className="text-xs text-[color:var(--tx3)]">
              No resources discovered yet. Run a resync after the initial import
              completes.
            </p>
          )}
        </div>
      ) : null}
    </section>
  )
}
