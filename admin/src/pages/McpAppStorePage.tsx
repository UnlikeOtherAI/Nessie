import { useMemo, useState } from 'react'
import { ColumnBrowserColumn } from '../components/shared/column-browser/ColumnBrowserColumn'
import { ColumnBrowserViewport } from '../components/shared/column-browser/ColumnBrowserViewport'
import { AddServerWizard } from '../components/features/mcp-app-store/AddServerWizard'
import { CatalogDetailPanel } from '../components/features/mcp-app-store/CatalogDetailPanel'
import { CatalogList } from '../components/features/mcp-app-store/CatalogList'
import { CredentialsDialog } from '../components/features/mcp-app-store/CredentialsDialog'
import { InstallScopeDialog } from '../components/features/mcp-app-store/InstallScopeDialog'
import { InstanceList } from '../components/features/mcp-app-store/InstanceList'
import { RejectDialog } from '../components/features/mcp-app-store/RejectDialog'
import {
  useApproveCatalogEntry,
  useCreateCatalogEntry,
  useDeleteCatalogEntry,
  useDeprecateCatalogEntry,
  useMcpCatalog,
  usePublishCatalogEntry,
  useRejectCatalogEntry,
  useSubmitCatalogEntry,
  type CatalogView,
  type McpCatalogEntryRecord,
} from '../facades/mcp-catalog/hooks'
import {
  useCreateInstance,
  useMcpInstances,
  useTestInstance,
  type McpServerInstanceRecord,
} from '../facades/mcp-instances/hooks'
import { useAuthSession } from '../providers/AuthSessionProvider'

/**
 * `/mcp-app-store` — the MCP App Store. Open to every signed-in user:
 * - "Store" lists approved public connectors anyone can install;
 * - "My connectors" holds the viewer's own private connectors (self-publish,
 *   install, or submit for public review);
 * - "Approval queue" (superusers only) is the pending-review queue where public
 *   submissions are approved or rejected.
 */

type TabConfig = { view: CatalogView; label: string }

const tabClass = (active: boolean): string =>
  [
    'rounded-md px-3 py-1 text-xs font-semibold',
    active
      ? 'bg-[color:var(--accent)] text-[color:var(--on-accent)]'
      : 'border border-[color:var(--sep)] text-[color:var(--tx2)] hover:bg-[color:var(--overlay-weak)]',
  ].join(' ')

export const McpAppStorePage = () => {
  const { me } = useAuthSession()
  const isOwner = me?.user.roleIds.includes('owner') ?? false
  const currentUserId = me?.user.id ?? ''
  const organizationId = me?.context.organizationId ?? ''

  const [view, setView] = useState<CatalogView>('store')
  const [selectedCatalogId, setSelectedCatalogId] = useState<string | undefined>()

  const catalogQuery = useMcpCatalog({ view })
  const instancesQuery = useMcpInstances({})
  const createCatalog = useCreateCatalogEntry()
  const publishCatalog = usePublishCatalogEntry()
  const deprecateCatalog = useDeprecateCatalogEntry()
  const submitCatalog = useSubmitCatalogEntry()
  const approveCatalog = useApproveCatalogEntry()
  const rejectCatalog = useRejectCatalogEntry()
  const deleteCatalog = useDeleteCatalogEntry()
  const createInstance = useCreateInstance()
  const testInstance = useTestInstance()

  const [wizardOpen, setWizardOpen] = useState(false)
  const [installTarget, setInstallTarget] = useState<string | null>(null)
  const [rejectTarget, setRejectTarget] = useState<McpCatalogEntryRecord | null>(null)
  const [credentialsTarget, setCredentialsTarget] =
    useState<McpServerInstanceRecord | null>(null)

  const tabs: TabConfig[] = [
    { view: 'store', label: 'Store' },
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

  const switchView = (next: CatalogView) => {
    setView(next)
    setSelectedCatalogId(undefined)
  }

  const handleInstall = async (input: {
    credentialRef?: string | null
    scopeType: string
    scopeId: string
    transportConfig?: Record<string, unknown>
  }) => {
    if (!installCandidate) return
    await createInstance.mutateAsync({
      catalogEntryId: installCandidate.id,
      credentialRef: input.credentialRef,
      scopeType: input.scopeType as Parameters<
        typeof createInstance.mutateAsync
      >[0]['scopeType'],
      scopeId: input.scopeId,
      transportConfig: input.transportConfig,
    })
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
        <CatalogList
          entries={catalogEntries}
          onSelect={setSelectedCatalogId}
          selectedId={selectedCatalog?.id}
        />
      </div>
    </ColumnBrowserColumn>,
  ]

  if (selectedCatalog) {
    columns.push(
      <ColumnBrowserColumn key={`detail-${selectedCatalog.id}`} title={selectedCatalog.label}>
        <CatalogDetailPanel
          busy={busy}
          entry={selectedCatalog}
          isMine={selectedCatalog.ownerUserId === currentUserId}
          isOwner={isOwner}
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
          onCredentials={(instance) => setCredentialsTarget(instance)}
          onSelect={() => undefined}
          onTest={(instance) => testInstance.mutate(instance.id)}
          testingId={
            testInstance.isPending && testInstance.variables
              ? testInstance.variables
              : undefined
          }
        />
      </ColumnBrowserColumn>,
    )
  }

  return (
    <div className="h-full w-full">
      <ColumnBrowserViewport activeColumn={selectedCatalog ? 1 : 0} columns={columns} />

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
