import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ColumnBrowserColumn } from '../components/shared/column-browser/ColumnBrowserColumn'
import { ColumnBrowserViewport } from '../components/shared/column-browser/ColumnBrowserViewport'
import { AddServerWizard } from '../components/features/mcp-app-store/AddServerWizard'
import { CatalogDetailPanel } from '../components/features/mcp-app-store/CatalogDetailPanel'
import { CatalogList } from '../components/features/mcp-app-store/CatalogList'
import { CredentialsDialog } from '../components/features/mcp-app-store/CredentialsDialog'
import { InstallScopeDialog } from '../components/features/mcp-app-store/InstallScopeDialog'
import { InstanceList } from '../components/features/mcp-app-store/InstanceList'
import { LibraryDetailPanel } from '../components/features/mcp-app-store/LibraryDetailPanel'
import { LibraryInstallDialog } from '../components/features/mcp-app-store/LibraryInstallDialog'
import { LibraryPanel } from '../components/features/mcp-app-store/LibraryPanel'
import { RejectDialog } from '../components/features/mcp-app-store/RejectDialog'
import {
  useApproveCatalogEntry,
  useCreateCatalogEntry,
  useDeleteCatalogEntry,
  useDeprecateCatalogEntry,
  useLockCatalogEntry,
  useMcpCatalog,
  usePublishCatalogEntry,
  useRejectCatalogEntry,
  useSubmitCatalogEntry,
  useUnlockCatalogEntry,
  type CatalogView,
  type McpCatalogEntryRecord,
} from '../facades/mcp-catalog/hooks'
import {
  useCreateInstance,
  useMcpInstances,
  useTestInstance,
  type McpServerInstanceRecord,
} from '../facades/mcp-instances/hooks'
import {
  useMcpLibrary,
  useSetInstanceSecret,
  type McpLibraryEntryRecord,
} from '../facades/mcp-library/hooks'
import { useAuthSession } from '../providers/AuthSessionProvider'

/**
 * `/mcp-app-store` — the MCP App Store. Open to every signed-in user:
 * - "Store" lists approved public connectors anyone can install;
 * - "My connectors" holds the viewer's own private connectors (self-publish,
 *   install, or submit for public review);
 * - "Approval queue" (superusers only) is the pending-review queue where public
 *   submissions are approved or rejected.
 */

type PageView = CatalogView | 'library'

type TabConfig = { view: PageView; label: string }

const tabClass = (active: boolean): string =>
  [
    'rounded-md px-3 py-1 text-xs font-semibold',
    active
      ? 'bg-[color:var(--accent)] text-[color:var(--on-accent)]'
      : 'border border-[color:var(--sep)] text-[color:var(--tx2)] hover:bg-[color:var(--overlay-weak)]',
  ].join(' ')

export const McpAppStorePage = () => {
  const { me } = useAuthSession()
  const [searchParams] = useSearchParams()
  const action = searchParams.get('action')
  const catalogEntryIdParam = searchParams.get('catalogEntryId') ?? undefined
  const isOwner = me?.user.roleIds.includes('owner') ?? false
  const isElevated = isOwner || (me?.user.roleIds.includes('admin') ?? false)
  const currentUserId = me?.user.id ?? ''
  const organizationId = me?.context.organizationId ?? ''

  const [view, setView] = useState<PageView>('store')
  const [selectedCatalogId, setSelectedCatalogId] = useState<string | undefined>(
    catalogEntryIdParam,
  )
  const [librarySearch, setLibrarySearch] = useState('')
  const [selectedLibraryEntry, setSelectedLibraryEntry] =
    useState<McpLibraryEntryRecord | null>(null)
  const [libraryInstallTarget, setLibraryInstallTarget] =
    useState<McpLibraryEntryRecord | null>(null)

  const catalogView: CatalogView = view === 'library' ? 'store' : view
  const catalogQuery = useMcpCatalog({ view: catalogView })
  const libraryQuery = useMcpLibrary(librarySearch, { enabled: view === 'library' })
  const instancesQuery = useMcpInstances({})
  const createCatalog = useCreateCatalogEntry()
  const publishCatalog = usePublishCatalogEntry()
  const deprecateCatalog = useDeprecateCatalogEntry()
  const submitCatalog = useSubmitCatalogEntry()
  const approveCatalog = useApproveCatalogEntry()
  const rejectCatalog = useRejectCatalogEntry()
  const deleteCatalog = useDeleteCatalogEntry()
  const lockCatalog = useLockCatalogEntry()
  const unlockCatalog = useUnlockCatalogEntry()
  const createInstance = useCreateInstance()
  const setInstanceSecret = useSetInstanceSecret()
  const testInstance = useTestInstance()

  const [wizardOpen, setWizardOpen] = useState(false)
  const [installTarget, setInstallTarget] = useState<string | null>(null)
  const autoInstallOpenedRef = useRef(false)
  const [rejectTarget, setRejectTarget] = useState<McpCatalogEntryRecord | null>(null)
  const [credentialsTarget, setCredentialsTarget] =
    useState<McpServerInstanceRecord | null>(null)

  const tabs: TabConfig[] = [
    { view: 'store', label: 'Store' },
    { view: 'library', label: 'Library' },
    { view: 'mine', label: 'My connectors' },
    ...(isOwner ? [{ view: 'queue' as const, label: 'Approval queue' }] : []),
  ]

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
  const selectedCatalogManaged = selectedCatalog?.managedByIntegration === true
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

  const busy =
    publishCatalog.isPending
    || deprecateCatalog.isPending
    || submitCatalog.isPending
    || approveCatalog.isPending
    || rejectCatalog.isPending
    || deleteCatalog.isPending
    || lockCatalog.isPending
    || unlockCatalog.isPending

  const switchView = (next: PageView) => {
    setView(next)
    setSelectedCatalogId(undefined)
    setSelectedLibraryEntry(null)
  }

  useEffect(() => {
    if (catalogEntryIdParam) {
      setSelectedCatalogId(catalogEntryIdParam)
    }
  }, [catalogEntryIdParam])

  useEffect(() => {
    if (
      action !== 'install'
      || autoInstallOpenedRef.current
      || !catalogEntryIdParam
      || !selectedCatalog
      || selectedCatalog.id !== catalogEntryIdParam
      || selectedCatalog.status !== 'published'
      || selectedCatalog.managedByIntegration
    ) {
      return
    }

    setInstallTarget(selectedCatalog.id)
    autoInstallOpenedRef.current = true
  }, [action, catalogEntryIdParam, selectedCatalog])

  const handleInstall = async (input: {
    secret?: string
    scopeType: string
    scopeId: string
    transportConfig?: Record<string, unknown>
  }) => {
    if (!installCandidate) return
    const instance = await createInstance.mutateAsync({
      catalogEntryId: installCandidate.id,
      scopeType: input.scopeType as Parameters<
        typeof createInstance.mutateAsync
      >[0]['scopeType'],
      scopeId: input.scopeId,
      transportConfig: input.transportConfig,
    })
    if (input.secret) {
      await setInstanceSecret.mutateAsync({
        instanceId: instance.id,
        secret: input.secret,
        shared: input.scopeType !== 'user',
      })
    }
    setInstallTarget(null)
  }

  const handleWizardSubmit = async (
    input: Parameters<typeof createCatalog.mutateAsync>[0],
    options: { submitForReview: boolean },
  ) => {
    const created = await createCatalog.mutateAsync(input)
    if (options.submitForReview) {
      await submitCatalog.mutateAsync(created.id)
    }
    setWizardOpen(false)
    switchView('mine')
    setSelectedCatalogId(created.id)
  }

  const tabBar = (
    <div className="flex items-center gap-2">
      {tabs.map((tab) => (
        <button
          className={tabClass(view === tab.view)}
          data-testid={`catalog-tab-${tab.view}`}
          key={tab.view}
          onClick={() => switchView(tab.view)}
          type="button"
        >
          {tab.label}
        </button>
      ))}
    </div>
  )

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
      title="Connectors"
    >
      <div className="grid gap-3">
        {tabBar}
        {view === 'library' ? (
          <LibraryPanel
            entries={libraryQuery.data?.entries ?? []}
            loading={libraryQuery.isLoading}
            onDiscovered={(entry) => setSelectedLibraryEntry(entry)}
            onSearchChange={setLibrarySearch}
            onSelect={(entry) => setSelectedLibraryEntry(entry)}
            registryError={libraryQuery.data?.registryError ?? null}
            search={librarySearch}
            selectedKey={selectedLibraryEntry?.key}
          />
        ) : (
          <CatalogList
            entries={catalogEntries}
            onSelect={setSelectedCatalogId}
            selectedId={selectedCatalog?.id}
          />
        )}
      </div>
    </ColumnBrowserColumn>,
  ]

  if (view === 'library' && selectedLibraryEntry) {
    columns.push(
      <ColumnBrowserColumn
        key={`library-${selectedLibraryEntry.key}`}
        title={selectedLibraryEntry.label}
      >
        <LibraryDetailPanel
          entry={selectedLibraryEntry}
          onAdd={() => setLibraryInstallTarget(selectedLibraryEntry)}
        />
      </ColumnBrowserColumn>,
    )
  }

  if (view !== 'library' && selectedCatalog) {
    columns.push(
      <ColumnBrowserColumn key={`detail-${selectedCatalog.id}`} title={selectedCatalog.label}>
        <CatalogDetailPanel
          busy={busy}
          entry={selectedCatalog}
          isElevated={isElevated}
          isMine={selectedCatalog.ownerUserId === currentUserId}
          isOwner={isOwner}
          managedByIntegration={selectedCatalogManaged}
          onLockToggle={() =>
            void (selectedCatalog.locked
              ? unlockCatalog.mutateAsync(selectedCatalog.id)
              : lockCatalog.mutateAsync(selectedCatalog.id))
          }
          onApprove={() => void approveCatalog.mutateAsync(selectedCatalog.id)}
          onDelete={() => {
            void deleteCatalog.mutateAsync(selectedCatalog.id)
            setSelectedCatalogId(undefined)
          }}
          onDeprecate={() => void deprecateCatalog.mutateAsync(selectedCatalog.id)}
          onInstall={() => setInstallTarget(selectedCatalog.id)}
          onPublish={() => void publishCatalog.mutateAsync(selectedCatalog.id)}
          onReject={() => setRejectTarget(selectedCatalog)}
          onSubmit={() => void submitCatalog.mutateAsync(selectedCatalog.id)}
        />
      </ColumnBrowserColumn>,
      <ColumnBrowserColumn key={`instances-${selectedCatalog.id}`} title="Installed scopes">
        <InstanceList
          instances={instancesForSelected}
          onCredentials={
            selectedCatalogManaged
              ? undefined
              : (instance) => setCredentialsTarget(instance)
          }
          onSelect={() => undefined}
          onTest={
            selectedCatalogManaged
              ? undefined
              : (instance) => testInstance.mutate(instance.id)
          }
          testingId={
            testInstance.isPending && testInstance.variables
              ? testInstance.variables
              : undefined
          }
        />
      </ColumnBrowserColumn>,
    )
  }

  const hasDetailColumn =
    view === 'library' ? Boolean(selectedLibraryEntry) : Boolean(selectedCatalog)

  return (
    <div className="h-full w-full">
      <ColumnBrowserViewport activeColumn={hasDetailColumn ? 1 : 0} columns={columns} />

      {wizardOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[color:var(--scrim-strong)] px-4">
          <div
            className={[
              'admin-card w-full max-w-2xl rounded-xl border border-[color:var(--sep)]',
              'bg-[color:var(--main)] p-6 text-[color:var(--tx)]',
            ].join(' ')}
          >
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold text-[color:var(--tx)]">Add MCP server</h2>
              <button
                className={[
                  'admin-button rounded-md border border-[color:var(--sep)]',
                  'px-3 py-1 text-xs text-[color:var(--tx2)] hover:bg-[color:var(--overlay-weak)]',
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
                onSubmit={handleWizardSubmit}
                pending={createCatalog.isPending || submitCatalog.isPending}
              />
            </div>
          </div>
        </div>
      ) : null}

      {libraryInstallTarget ? (
        <LibraryInstallDialog
          canShareToOrg={isElevated}
          currentUserId={currentUserId}
          entry={libraryInstallTarget}
          isOwner={isOwner}
          onCancel={() => setLibraryInstallTarget(null)}
          onDone={(catalogEntryId) => {
            setLibraryInstallTarget(null)
            switchView('mine')
            setSelectedCatalogId(catalogEntryId)
          }}
          organizationId={organizationId}
        />
      ) : null}

      {installCandidate ? (
        <InstallScopeDialog
          canChooseScope={isOwner}
          catalogEntry={installCandidate}
          currentUserId={currentUserId}
          onCancel={() => setInstallTarget(null)}
          onConfirm={handleInstall}
          organizationId={organizationId}
          pending={createInstance.isPending}
        />
      ) : null}

      {rejectTarget ? (
        <RejectDialog
          entry={rejectTarget}
          onCancel={() => setRejectTarget(null)}
          onConfirm={(reason) => {
            void rejectCatalog
              .mutateAsync({ id: rejectTarget.id, reason })
              .then(() => setRejectTarget(null))
          }}
          pending={rejectCatalog.isPending}
        />
      ) : null}

      {credentialsTarget && !selectedCatalogManaged ? (
        <CredentialsDialog
          instance={credentialsTarget}
          oauth2={selectedCatalog?.authMethod === 'oauth2'}
          onClose={() => setCredentialsTarget(null)}
        />
      ) : null}
    </div>
  )
}
