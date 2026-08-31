import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  useConvertToDocument,
  useUploadFileNode,
  useUploadFileVersion,
  useUploadPageAttachment,
} from '../../../facades/knowledge/file-hooks'
import {
  useKnowledgePage,
  useKnowledgeVersions,
  type KnowledgePageRecord,
} from '../../../facades/knowledge/hooks'
import { getCookie, setCookie } from '../../../lib/storage'
import { usePhoneLayout } from '../../../lib/mobile-shell'
import {
  LOCAL_BACK_PRIORITY,
  useLocalBack,
} from '../../../layouts/admin-shell/local-back/LocalBackContext'
import type { UploadProgress } from '../../../lib/upload-xhr'
import { AttachmentsDrawer } from './AttachmentsDrawer'
import { DropZoneOverlay } from '../../shared/DropZoneOverlay'
import { isMarkdownFilename } from './file-icons'
import { FileNodeViewer } from './FileNodeViewer'
import { FileVersionUploadDialog } from './FileVersionUploadDialog'
import { KnowledgeFilesystemBrowser } from './KnowledgeFilesystemBrowser'
import { useKnowledge } from './KnowledgeProvider'
import { KnowledgePane } from './KnowledgePane'
import { ProductDocumentsView } from './ProductDocumentsView'
import { isAgentDraft } from './page-status'
import {
  isKnowledgeViewMode,
  type KnowledgeViewMode,
} from './KnowledgeViewToggle'
import { PageEditor } from './PageEditor'
import { PagePreview } from './PagePreview'
import { SpaceSettingsDialog } from './SpaceSettingsDialog'
import { firstFileOnly, useFileDrop } from '../../../hooks/useFileDrop'
import { VersionHistory } from './VersionHistory'
import { buildKnowledgeWorkspaceActions } from './knowledge-workspace-actions'

const VIEW_MODE_COOKIE = 'knowledgeViewMode'

// On a phone the outer route header (KnowledgeBasePage's MobileSectionHeader,
// ProjectView's own header) stays painted above every pane and owns the single
// doorway, so the workspace registers one unwind action with the shell's
// local-back registry and passes onBack to its inner panes only on wider
// layouts. Priority: editor > history > open document/file > folder depth —
// exactly one level per press; at the space base nothing is active and the
// route Back owns the doorway again.
type KnowledgeWorkspaceProps = {
  canManageSpace?: boolean
}

export const KnowledgeWorkspace = ({ canManageSpace }: KnowledgeWorkspaceProps = {}) => {
  const {
    activeProductView,
    scopeAgentId,
    selectedSpace,
    selectedSpaceId,
    pages,
    rootPages,
    pagePath,
    openPageId,
    pageById,
    childrenOf,
    browseTo,
    openPagePath,
    editor,
    openCreate,
    openEdit,
    closeEditor,
    createFolder,
    createFolderPending,
    savePage,
    savePending,
    drillTo,
    popTo,
    openHistory,
    closeHistory,
    historyPageId,
    publishPage,
    publishPending,
    restoreVersion,
    restorePending,
    spaceSettingsOpen,
    openSpaceSettings,
    closeSpaceSettings,
    updateSpace,
    updateSpacePending,
  } = useKnowledge()
  const navigate = useNavigate()
  const phoneLayout = usePhoneLayout()
  const [viewMode, setViewMode] = useState<KnowledgeViewMode>(() => {
    const stored = getCookie(VIEW_MODE_COOKIE)
    return isKnowledgeViewMode(stored) ? stored : 'column'
  })
  const [creatingFolder, setCreatingFolder] = useState(false)

  // "Needs review" filters the current space's tree down to agent drafts (and
  // their ancestor folders, so the tree stays navigable) — a client-side
  // filter over the already-loaded pages list, no extra request.
  const [needsReviewOnly, setNeedsReviewOnly] = useState(false)
  useEffect(() => setNeedsReviewOnly(false), [selectedSpaceId])

  const agentDraftCount = useMemo(() => pages.filter(isAgentDraft).length, [pages])
  const reviewVisibleIds = useMemo(() => {
    if (!needsReviewOnly) return null
    const byId = new Map(pages.map((page) => [page.id, page]))
    const visible = new Set<string>()
    for (const page of pages) {
      if (!isAgentDraft(page)) continue
      let current: KnowledgePageRecord | undefined = page
      while (current) {
        visible.add(current.id)
        current = current.parentPageId ? byId.get(current.parentPageId) : undefined
      }
    }
    return visible
  }, [needsReviewOnly, pages])

  const visibleRootPages = reviewVisibleIds
    ? rootPages.filter((page) => reviewVisibleIds.has(page.id))
    : rootPages
  const visibleChildrenOf = (parentPageId: string) =>
    reviewVisibleIds
      ? childrenOf(parentPageId).filter((page) => reviewVisibleIds.has(page.id))
      : childrenOf(parentPageId)

  const versionsQuery = useKnowledgeVersions(historyPageId)
  const pathPages = pagePath
    .map((pageId) => pageById(pageId))
    .filter((page): page is NonNullable<typeof page> => Boolean(page))
  const current = openPageId ? pageById(openPageId) : undefined
  const depth = current ? pathPages.findIndex((page) => page.id === current.id) : -1
  const currentFolder = openPageId ? null : pathPages.at(-1)

  const localBackLabel = editor
    ? 'Back from page editor'
    : historyPageId
      ? 'Back from version history'
      : current
        ? depth > 0
          ? 'Back to parent page'
          : 'Back to space'
        : 'Back to parent folder'
  const localBackPriority = editor
    ? LOCAL_BACK_PRIORITY.knowledgeEditor
    : historyPageId
      ? LOCAL_BACK_PRIORITY.knowledgeHistory
      : current
        ? LOCAL_BACK_PRIORITY.knowledgeDocument
        : LOCAL_BACK_PRIORITY.knowledgeFolder
  // browseTo takes the path's string ids, never page records.
  const localBackAction = editor
    ? closeEditor
    : historyPageId
      ? closeHistory
      : current
        ? () => popTo(depth)
        : pathPages.length > 0
          ? () => browseTo(pathPages.slice(0, -1).map((page) => page.id))
          : null
  useLocalBack({
    active: phoneLayout && localBackAction !== null,
    id: 'knowledge-workspace',
    label: localBackLabel,
    onBack: localBackAction ?? (() => undefined),
    priority: localBackPriority,
  })

  // The space-pages list omits page bodies (they're large and the tree/column
  // views never show them). Fetch the full body on demand for whichever page
  // actually needs it — the editor is gated on this so it never opens, and
  // therefore can never save, with an empty body.
  const fullBodyPageId =
    editor?.mode === 'edit'
      ? editor.page.id
      : historyPageId ?? (current && current.kind !== 'file' ? current.id : undefined)
  const fullPageQuery = useKnowledgePage(fullBodyPageId)
  const fullPage =
    fullPageQuery.data && fullPageQuery.data.id === fullBodyPageId ? fullPageQuery.data : undefined

  // ─── File upload wiring (file nodes, page attachments, new versions) ───────
  const [attachmentsPageId, setAttachmentsPageId] = useState<string | null>(null)
  const [versionDialogFor, setVersionDialogFor] = useState<KnowledgePageRecord | null>(null)
  const [attachProgress, setAttachProgress] = useState<UploadProgress | null>(null)
  const [fileNodeProgress, setFileNodeProgress] = useState<UploadProgress | null>(null)
  const [versionProgress, setVersionProgress] = useState<UploadProgress | null>(null)
  const [versionError, setVersionError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const fileNodeUpload = useUploadFileNode(selectedSpaceId, currentFolder?.id ?? null)
  const pageAttachmentUpload = useUploadPageAttachment(current?.id)
  const fileVersionUpload = useUploadFileVersion(versionDialogFor?.id, selectedSpaceId)
  const canWrite = selectedSpace?.canWrite ?? false
  const canManage = canWrite && (canManageSpace ?? true)

  const updateViewMode = (nextMode: KnowledgeViewMode) => {
    setViewMode(nextMode)
    setCookie(VIEW_MODE_COOKIE, nextMode)
  }
  const workspaceActions = buildKnowledgeWorkspaceActions({
    agentDraftCount,
    canManageSpace: canManage,
    canWrite,
    needsReviewOnly,
    onCreateFolder: () => {
      updateViewMode('column')
      setCreatingFolder(true)
    },
    onCreatePage: () => openCreate(currentFolder?.id ?? null),
    onOpenAgent: selectedSpace?.ownerAgentId && selectedSpace.ownerAgentId !== scopeAgentId
      ? () => void navigate(`/agents/${selectedSpace.ownerAgentId}`)
      : undefined,
    onOpenSettings: openSpaceSettings,
    onSelectView: updateViewMode,
    onToggleNeedsReview: () => setNeedsReviewOnly((value) => !value),
    onUploadFile: () => fileInputRef.current?.click(),
    selectedSpaceId,
    viewMode,
  })

  // Markdown is the KB's native document format: when a markdown file node is
  // opened, convert it to a real document once so it renders + edits like one.
  const convertToDocument = useConvertToDocument(selectedSpaceId)
  const convertAttempted = useRef<Set<string>>(new Set())
  const isMarkdownFileNode = Boolean(
    current && current.kind === 'file' && isMarkdownFilename(current.title),
  )
  useEffect(() => {
    if (!canWrite || !current || !isMarkdownFileNode) return
    if (convertAttempted.current.has(current.id)) return
    convertAttempted.current.add(current.id)
    convertToDocument.mutate(current.id)
  }, [canWrite, current, isMarkdownFileNode, convertToDocument])

  const uploadFileNode = (file: File) => {
    if (!selectedSpaceId) return
    setFileNodeProgress({ loaded: 0, total: file.size, pct: 0 })
    fileNodeUpload.mutate(
      { file, onProgress: setFileNodeProgress },
      { onSettled: () => setFileNodeProgress(null) },
    )
  }
  const uploadPageAttachment = (file: File) => {
    if (!current) return
    setAttachmentsPageId(current.id)
    setAttachProgress({ loaded: 0, total: file.size, pct: 0 })
    pageAttachmentUpload.mutate(
      { file, onProgress: setAttachProgress },
      { onSettled: () => setAttachProgress(null) },
    )
  }

  const fileNodeDrop = useFileDrop(firstFileOnly(uploadFileNode), !selectedSpaceId || !canWrite)
  const attachmentDrop = useFileDrop(firstFileOnly(uploadPageAttachment), !current || !canWrite)

  const versionDialog = versionDialogFor && canWrite ? (
    <FileVersionUploadDialog
      error={versionError}
      onClose={() => {
        setVersionDialogFor(null)
        setVersionError(null)
      }}
      onPick={(file) => {
        setVersionError(null)
        setVersionProgress({ loaded: 0, total: file.size, pct: 0 })
        fileVersionUpload.mutate(
          { file, onProgress: setVersionProgress },
          {
            onError: (error) => setVersionError((error as Error).message),
            onSuccess: () => setVersionDialogFor(null),
            onSettled: () => setVersionProgress(null),
          },
        )
      }}
      progressPct={versionProgress?.pct ?? 0}
      title={versionDialogFor.title}
      uploading={fileVersionUpload.isPending}
    />
  ) : null

  // A product Documents view (e.g. DeepWater Research) is selected in the
  // sidebar — it owns the whole main area instead of a space's pages.
  if (activeProductView) {
    return <ProductDocumentsView view={activeProductView} />
  }

  // Full-width editor (create or edit) — takes the whole main area. Editing waits
  // for the on-demand full body so the editor never initialises from an empty
  // (list-stripped) body and overwrites real content on save.
  if (editor && canWrite) {
    const editLoading = editor.mode === 'edit' && !fullPage
    return (
      <KnowledgePane
        onBack={phoneLayout ? undefined : closeEditor}
        title={editor.mode === 'edit' ? 'Edit page' : 'Create page'}
      >
        <div className="flex h-full w-full flex-col">
          {editLoading ? (
            <div className="flex h-full items-center justify-center text-sm text-[color:var(--tx3)]">
              Loading…
            </div>
          ) : (
            <PageEditor
              initialTitle={editor.mode === 'create' ? editor.initialTitle : undefined}
              mode={editor.mode}
              onCancel={closeEditor}
              onSubmit={savePage}
              page={editor.mode === 'edit' ? (fullPage ?? null) : null}
              parentPageId={editor.mode === 'create' ? editor.parentPageId : null}
              pending={savePending}
            />
          )}
        </div>
      </KnowledgePane>
    )
  }

  // Full-width version history.
  const historyPage = historyPageId ? pageById(historyPageId) : undefined
  if (historyPage) {
    return (
      <KnowledgePane
        onBack={phoneLayout ? undefined : closeHistory}
        title={`History — ${historyPage.title}`}
      >
        <div className="mx-auto w-full max-w-3xl px-6 py-6">
          <VersionHistory
            canRestore={canWrite}
            onRestore={(versionId) => restoreVersion({ pageId: historyPage.id, versionId })}
            page={fullPage ?? historyPage}
            pending={restorePending}
            versions={versionsQuery.data ?? []}
          />
        </div>
      </KnowledgePane>
    )
  }

  // Full-width page preview / file viewer. Dropping a file here adds an
  // attachment to the open page (document or file node).
  if (current) {
    return (
      <div className="relative h-full w-full" {...attachmentDrop.dropHandlers}>
        {canWrite && isMarkdownFileNode && !convertToDocument.isError ? (
          <KnowledgePane
            onBack={phoneLayout ? undefined : () => popTo(depth)}
            title={current.title}
          >
            <div className="flex h-full items-center justify-center text-sm text-[color:var(--tx3)]">
              Opening as document…
            </div>
          </KnowledgePane>
        ) : current.kind === 'file' ? (
          <FileNodeViewer
            canWrite={canWrite}
            onBack={phoneLayout ? undefined : () => popTo(depth)}
            onOpenHistory={() => openHistory(current.id)}
            onToggleAttachments={() => setAttachmentsPageId(current.id)}
            onUploadVersion={() => setVersionDialogFor(current)}
            page={current}
          />
        ) : (
          <PagePreview
            bodyPending={!fullPage}
            canWrite={canWrite}
            onBack={phoneLayout ? undefined : () => popTo(depth)}
            onCreateChild={() => openCreate(current.id)}
            onDrill={(childPageId) => drillTo(depth, childPageId)}
            onEdit={() => openEdit(current)}
            onOpenHistory={() => openHistory(current.id)}
            onPublish={() => publishPage(current.id)}
            onToggleAttachments={() => setAttachmentsPageId(current.id)}
            page={fullPage ?? current}
            publishPending={publishPending}
            subPages={childrenOf(current.id)}
          />
        )}
        <DropZoneOverlay
          active={attachmentDrop.isDragging}
          label="Drop to attach to this page"
          progressPct={attachProgress?.pct}
          uploading={pageAttachmentUpload.isPending}
        />
        {attachmentsPageId ? (
          <AttachmentsDrawer
            canWrite={canWrite}
            onClose={() => setAttachmentsPageId(null)}
            open={Boolean(attachmentsPageId)}
            pageId={attachmentsPageId}
          />
        ) : null}
        {versionDialog}
      </div>
    )
  }

  // No document open → the selected space's filesystem browser. Dropping a file
  // here uploads it as a new file node in the current folder.
  return (
    <div className="relative h-full w-full" {...fileNodeDrop.dropHandlers}>
      <KnowledgePane
        actions={workspaceActions}
        title={selectedSpace?.name ?? 'Pages'}
      >
        <div className="h-full w-full">
          {!selectedSpaceId ? (
            <div className="py-16 text-center text-sm text-[color:var(--tx3)]">Select a space</div>
          ) : rootPages.length === 0 && (!creatingFolder || !canWrite) ? (
            <div className="py-16 text-center text-sm text-[color:var(--tx3)]">
              {canWrite
                ? 'No pages yet — create one with “New page”, or drop a file to upload.'
                : 'No pages yet.'}
            </div>
          ) : (
            <KnowledgeFilesystemBrowser
              childrenOf={visibleChildrenOf}
              creatingFolder={canWrite && creatingFolder}
              createFolderPending={createFolderPending}
              mode={viewMode}
              onBrowsePath={browseTo}
              onCancelFolder={() => setCreatingFolder(false)}
              onOpenDocumentPath={openPagePath}
              onSubmitFolder={(name) => {
                void createFolder(currentFolder?.id ?? null, name).finally(() =>
                  setCreatingFolder(false),
                )
              }}
              pageById={pageById}
              pagePath={pagePath}
              pages={pages}
              rootPages={visibleRootPages}
              selectedSpaceId={selectedSpaceId}
              selectedSpaceName={selectedSpace?.name ?? 'Pages'}
            />
          )}
        </div>
      </KnowledgePane>
      <DropZoneOverlay
        active={fileNodeDrop.isDragging}
        label="Drop a file to upload"
        progressPct={fileNodeProgress?.pct}
        uploading={fileNodeUpload.isPending}
      />
      <input
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) uploadFileNode(file)
          event.target.value = ''
        }}
        ref={fileInputRef}
        type="file"
      />
      {versionDialog}
      {selectedSpace && canManage ? (
        <SpaceSettingsDialog
          canManageAccess={canManage}
          onClose={closeSpaceSettings}
          onSave={updateSpace}
          open={spaceSettingsOpen}
          pending={updateSpacePending}
          space={selectedSpace}
        />
      ) : null}
    </div>
  )
}
