import { useEffect, useRef, useState } from 'react'
import { faFolderPlus } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  useConvertToDocument,
  useUploadFileNode,
  useUploadFileVersion,
  useUploadPageAttachment,
} from '../../../facades/knowledge/file-hooks'
import { useKnowledgeVersions, type KnowledgePageRecord } from '../../../facades/knowledge/hooks'
import { getCookie, setCookie } from '../../../lib/storage'
import type { UploadProgress } from '../../../lib/upload-xhr'
import { AttachmentsDrawer } from './AttachmentsDrawer'
import { DropZoneOverlay } from './DropZoneOverlay'
import { isMarkdownFilename } from './file-icons'
import { FileNodeViewer } from './FileNodeViewer'
import { FileVersionUploadDialog } from './FileVersionUploadDialog'
import { KnowledgeFilesystemBrowser } from './KnowledgeFilesystemBrowser'
import { useKnowledge } from './KnowledgeProvider'
import { KnowledgePane } from './KnowledgePane'
import {
  isKnowledgeViewMode,
  KnowledgeViewToggle,
  type KnowledgeViewMode,
} from './KnowledgeViewToggle'
import { PageEditor } from './PageEditor'
import { PagePreview } from './PagePreview'
import { useFileDrop } from './useFileDrop'
import { VersionHistory } from './VersionHistory'

const VIEW_MODE_COOKIE = 'knowledgeViewMode'

export const KnowledgeWorkspace = () => {
  const {
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
  } = useKnowledge()
  const [viewMode, setViewMode] = useState<KnowledgeViewMode>(() => {
    const stored = getCookie(VIEW_MODE_COOKIE)
    return isKnowledgeViewMode(stored) ? stored : 'column'
  })
  const [creatingFolder, setCreatingFolder] = useState(false)

  const versionsQuery = useKnowledgeVersions(historyPageId)
  const pathPages = pagePath
    .map((pageId) => pageById(pageId))
    .filter((page): page is NonNullable<typeof page> => Boolean(page))
  const current = openPageId ? pageById(openPageId) : undefined
  const depth = current ? pathPages.findIndex((page) => page.id === current.id) : -1
  const currentFolder = openPageId ? null : pathPages.at(-1)

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

  // Markdown is the KB's native document format: when a markdown file node is
  // opened, convert it to a real document once so it renders + edits like one.
  const convertToDocument = useConvertToDocument(selectedSpaceId)
  const convertAttempted = useRef<Set<string>>(new Set())
  const isMarkdownFileNode = Boolean(
    current && current.kind === 'file' && isMarkdownFilename(current.title),
  )
  useEffect(() => {
    if (!current || !isMarkdownFileNode) return
    if (convertAttempted.current.has(current.id)) return
    convertAttempted.current.add(current.id)
    convertToDocument.mutate(current.id)
  }, [current, isMarkdownFileNode, convertToDocument])

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

  const fileNodeDrop = useFileDrop(uploadFileNode, !selectedSpaceId)
  const attachmentDrop = useFileDrop(uploadPageAttachment, !current)

  const updateViewMode = (nextMode: KnowledgeViewMode) => {
    setViewMode(nextMode)
    setCookie(VIEW_MODE_COOKIE, nextMode)
  }

  const versionDialog = versionDialogFor ? (
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

  // Full-width editor (create or edit) — takes the whole main area.
  if (editor) {
    return (
      <KnowledgePane onBack={closeEditor} title={editor.mode === 'edit' ? 'Edit page' : 'Create page'}>
        <div className="flex h-full w-full flex-col">
          <PageEditor
            mode={editor.mode}
            onCancel={closeEditor}
            onSubmit={savePage}
            page={editor.mode === 'edit' ? editor.page : null}
            parentPageId={editor.mode === 'create' ? editor.parentPageId : null}
            pending={savePending}
          />
        </div>
      </KnowledgePane>
    )
  }

  // Full-width version history.
  const historyPage = historyPageId ? pageById(historyPageId) : undefined
  if (historyPage) {
    return (
      <KnowledgePane onBack={closeHistory} title={`History — ${historyPage.title}`}>
        <div className="mx-auto w-full max-w-3xl px-6 py-6">
          <VersionHistory
            onRestore={(versionId) => restoreVersion({ pageId: historyPage.id, versionId })}
            page={historyPage}
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
        {isMarkdownFileNode && !convertToDocument.isError ? (
          <KnowledgePane onBack={() => popTo(depth)} title={current.title}>
            <div className="flex h-full items-center justify-center text-sm text-[color:var(--tx3)]">
              Opening as document…
            </div>
          </KnowledgePane>
        ) : current.kind === 'file' ? (
          <FileNodeViewer
            onBack={() => popTo(depth)}
            onOpenHistory={() => openHistory(current.id)}
            onToggleAttachments={() => setAttachmentsPageId(current.id)}
            onUploadVersion={() => setVersionDialogFor(current)}
            page={current}
          />
        ) : (
          <PagePreview
            onBack={() => popTo(depth)}
            onCreateChild={() => openCreate(current.id)}
            onDrill={(childPageId) => drillTo(depth, childPageId)}
            onEdit={() => openEdit(current)}
            onOpenHistory={() => openHistory(current.id)}
            onPublish={() => publishPage(current.id)}
            onToggleAttachments={() => setAttachmentsPageId(current.id)}
            page={current}
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
        actions={
          selectedSpaceId ? (
            <>
              <button
                className="admin-button admin-button-secondary rounded-md px-3 py-1 text-xs"
                onClick={() => fileInputRef.current?.click()}
                type="button"
              >
                Upload file
              </button>
              <button
                className="admin-button admin-button-secondary flex items-center gap-1.5 rounded-md px-3 py-1 text-xs"
                onClick={() => {
                  updateViewMode('column')
                  setCreatingFolder(true)
                }}
                type="button"
              >
                <FontAwesomeIcon className="h-3 w-3" icon={faFolderPlus} />
                New folder
              </button>
              <button
                className="admin-button admin-button-primary rounded-md px-3 py-1 text-xs"
                onClick={() => openCreate(currentFolder?.id ?? null)}
                type="button"
              >
                New page
              </button>
            </>
          ) : undefined
        }
        center={<KnowledgeViewToggle mode={viewMode} onChange={updateViewMode} />}
        title={selectedSpace?.name ?? 'Pages'}
      >
        <div className="h-full w-full">
          {!selectedSpaceId ? (
            <div className="py-16 text-center text-sm text-[color:var(--tx3)]">Select a space</div>
          ) : rootPages.length === 0 && !creatingFolder ? (
            <div className="py-16 text-center text-sm text-[color:var(--tx3)]">
              No pages yet — create one with “New page”, or drop a file to upload.
            </div>
          ) : (
            <KnowledgeFilesystemBrowser
              childrenOf={childrenOf}
              creatingFolder={creatingFolder}
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
              rootPages={rootPages}
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
    </div>
  )
}
