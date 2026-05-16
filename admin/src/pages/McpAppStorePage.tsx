import { useMemo, useState } from 'react'
import { ColumnBrowserColumn } from '../components/shared/column-browser/ColumnBrowserColumn'
import { ColumnBrowserViewport } from '../components/shared/column-browser/ColumnBrowserViewport'
import { AddServerWizard } from '../components/features/mcp-app-store/AddServerWizard'
import { CatalogList } from '../components/features/mcp-app-store/CatalogList'
import { CredentialsDialog } from '../components/features/mcp-app-store/CredentialsDialog'
import { InstallScopeDialog } from '../components/features/mcp-app-store/InstallScopeDialog'
import { InstanceList } from '../components/features/mcp-app-store/InstanceList'
import {
  useDeprecateCatalogEntry,
  useMcpCatalog,
  usePublishCatalogEntry,
  useCreateCatalogEntry,
} from '../facades/mcp-catalog/hooks'
import {
  useCreateInstance,
  useMcpInstances,
  useTestInstance,
  type McpServerInstanceRecord,
} from '../facades/mcp-instances/hooks'
import { useAuthSession } from '../providers/AuthSessionProvider'

/**
 * `/mcp-app-store` — admin-only surface for the MCP catalog (plan §7 surface 1).
 * Owner-gated by `requireOwner` on the backend, mirrored client-side so
 * non-owners get a clear empty state instead of a 403 cascade.
 */

const noticeClass = [
  'admin-card mx-auto mt-8 max-w-xl rounded-xl border border-amber-400/40',
  'bg-amber-400/10 p-6 text-amber-100',
].join(' ')

export const McpAppStorePage = () => {
  const { me } = useAuthSession()
  const isOwner = me?.user.roleIds.includes('owner') ?? false
  const organizationId = me?.context.organizationId ?? ''

  const catalogQuery = useMcpCatalog()
  const [selectedCatalogId, setSelectedCatalogId] = useState<string | undefined>()
  const instancesQuery = useMcpInstances()
  const createCatalog = useCreateCatalogEntry()
  const publishCatalog = usePublishCatalogEntry()
  const deprecateCatalog = useDeprecateCatalogEntry()
  const createInstance = useCreateInstance()
  const testInstance = useTestInstance()

  const [wizardOpen, setWizardOpen] = useState(false)
  const [installTarget, setInstallTarget] = useState<string | null>(null)
  const [credentialsTarget, setCredentialsTarget] =
    useState<McpServerInstanceRecord | null>(null)

  const catalogEntries = useMemo(
    () =>
      [...(catalogQuery.data ?? [])].sort((left, right) =>
        left.label.localeCompare(right.label),
      ),
    [catalogQuery.data],
  )
  const selectedCatalog = useMemo(
    () =>
      catalogEntries.find((entry) => entry.id === selectedCatalogId)
      ?? catalogEntries[0],
    [catalogEntries, selectedCatalogId],
  )
  const instancesForSelected = useMemo(
    () =>
      (instancesQuery.data ?? []).filter(
        (instance) => instance.catalogEntryId === selectedCatalog?.id,
      ),
    [instancesQuery.data, selectedCatalog?.id],
  )
  const installCandidate = installTarget
    ? catalogEntries.find((entry) => entry.id === installTarget) ?? null
    : null

  if (!isOwner) {
    return (
      <div className={noticeClass}>
        <h2 className="text-lg font-semibold">Owner access required</h2>
        <p className="mt-2 text-sm">
          The MCP App Store catalog is admin-only. Ask an organisation owner to
          add or publish servers on your behalf.
        </p>
      </div>
    )
  }

  const handleInstall = async (input: { scopeType: string; scopeId: string }) => {
    if (!installCandidate) return
    await createInstance.mutateAsync({
      catalogEntryId: installCandidate.id,
      scopeType: input.scopeType as Parameters<
        typeof createInstance.mutateAsync
      >[0]['scopeType'],
      scopeId: input.scopeId,
    })
    setInstallTarget(null)
  }

  const columns = [
    <ColumnBrowserColumn
      headerAction={
        <button
          className="admin-button admin-button-primary rounded-md px-3 py-1 text-xs font-semibold"
          onClick={() => setWizardOpen(true)}
          type="button"
        >
          Add MCP server
        </button>
      }
      key="catalog"
      title="MCP App Store catalog"
    >
      <CatalogList
        entries={catalogEntries}
        onSelect={setSelectedCatalogId}
        selectedId={selectedCatalog?.id}
      />
    </ColumnBrowserColumn>,
  ]

  if (selectedCatalog) {
    columns.push(
      <ColumnBrowserColumn key={`detail-${selectedCatalog.id}`} title={selectedCatalog.label}>
        <div className="grid gap-4">
          <div className="rounded-xl border border-[color:var(--sep)] bg-black/10 p-4">
            <div className="text-sm text-white">{selectedCatalog.description}</div>
            <dl className="mt-3 grid grid-cols-2 gap-y-1 text-xs">
              <dt className="text-[color:var(--tx3)]">Name</dt>
              <dd className="text-white">{selectedCatalog.name}</dd>
              <dt className="text-[color:var(--tx3)]">Vendor</dt>
              <dd className="text-white">{selectedCatalog.vendor ?? '—'}</dd>
              <dt className="text-[color:var(--tx3)]">Protocol</dt>
              <dd className="text-white">{selectedCatalog.protocol}</dd>
              <dt className="text-[color:var(--tx3)]">Auth</dt>
              <dd className="text-white">{selectedCatalog.authMethod}</dd>
              <dt className="text-[color:var(--tx3)]">Status</dt>
              <dd className="text-white">{selectedCatalog.status}</dd>
            </dl>
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                className={[
                  'admin-button rounded-md border border-[color:var(--sep)]',
                  'px-3 py-1 text-xs text-[color:var(--tx2)] hover:bg-white/5',
                  'disabled:cursor-not-allowed disabled:opacity-40',
                ].join(' ')}
                disabled={selectedCatalog.status === 'published'}
                onClick={() => publishCatalog.mutateAsync(selectedCatalog.id)}
                type="button"
              >
                Publish
              </button>
              <button
                className={[
                  'admin-button rounded-md border border-[color:var(--sep)]',
                  'px-3 py-1 text-xs text-[color:var(--tx2)] hover:bg-white/5',
                  'disabled:cursor-not-allowed disabled:opacity-40',
                ].join(' ')}
                disabled={selectedCatalog.status === 'deprecated'}
                onClick={() => deprecateCatalog.mutateAsync(selectedCatalog.id)}
                type="button"
              >
                Deprecate
              </button>
              <button
                className="admin-button admin-button-primary rounded-md px-3 py-1 text-xs font-semibold"
                onClick={() => setInstallTarget(selectedCatalog.id)}
                type="button"
              >
                Install
              </button>
            </div>
          </div>
        </div>
      </ColumnBrowserColumn>,
      <ColumnBrowserColumn key={`instances-${selectedCatalog.id}`} title="Installed scopes">
        <InstanceList
          instances={instancesForSelected}
          onCredentials={(instance) => setCredentialsTarget(instance)}
          onSelect={() => undefined}
          onTest={(instance) => testInstance.mutate(instance.id)}
          testingId={testInstance.isPending ? testInstance.variables : undefined}
        />
      </ColumnBrowserColumn>,
    )
  }

  return (
    <div className="h-full w-full">
      <ColumnBrowserViewport activeColumn={selectedCatalog ? 1 : 0} columns={columns} />

      {wizardOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
          <div
            className={[
              'admin-card w-full max-w-2xl rounded-xl border border-[color:var(--sep)]',
              'bg-[color:var(--main)] p-6 text-[color:var(--tx)]',
            ].join(' ')}
          >
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold text-white">Add MCP server</h2>
              <button
                className={[
                  'admin-button rounded-md border border-[color:var(--sep)]',
                  'px-3 py-1 text-xs text-[color:var(--tx2)] hover:bg-white/5',
                ].join(' ')}
                onClick={() => setWizardOpen(false)}
                type="button"
              >
                Close
              </button>
            </div>
            <div className="mt-4">
              <AddServerWizard
                onCancel={() => setWizardOpen(false)}
                onSubmit={async (input) => {
                  await createCatalog.mutateAsync(input)
                  setWizardOpen(false)
                }}
                pending={createCatalog.isPending}
              />
            </div>
          </div>
        </div>
      ) : null}

      {installCandidate ? (
        <InstallScopeDialog
          catalogEntry={installCandidate}
          onCancel={() => setInstallTarget(null)}
          onConfirm={handleInstall}
          organizationId={organizationId}
          pending={createInstance.isPending}
        />
      ) : null}

      {credentialsTarget ? (
        <CredentialsDialog
          instance={credentialsTarget}
          oauth2={selectedCatalog?.authMethod === 'oauth2'}
          onClose={() => setCredentialsTarget(null)}
        />
      ) : null}
    </div>
  )
}
