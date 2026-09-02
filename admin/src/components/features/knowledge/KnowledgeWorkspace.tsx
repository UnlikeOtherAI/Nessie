import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  useConvertToDocument,
  useUploadFileNode,
} from '../../../facades/knowledge/file-hooks'
import {
  useKnowledgePage,
  useKnowledgeVersions,
  type KnowledgePageRecord,
} from '../../../facades/knowledge/hooks'
import { getCookie, setCookie } from '../../../lib/storage'
import { LOCAL_BACK_PRIORITY } from '../../../layouts/admin-shell/local-back/LocalBackContext'
import { NestedStage, useNestedStageHosted } from '../../../navigation/NestedStage'
import { useTabParam } from '../../../navigation/useTabParam'
import type { UploadProgress } from '../../../lib/upload-xhr'
import { DropZoneOverlay } from '../../shared/DropZoneOverlay'
import { isMarkdownFilename } from './file-icons'
import { KnowledgeDocumentPane } from './KnowledgeDocumentPane'
import { KnowledgeFilesystemBrowser } from './KnowledgeFilesystemBrowser'
import { useKnowledge } from './KnowledgeProvider'
import { KnowledgePane } from './KnowledgePane'
import { ProductDocumentsView } from './ProductDocumentsView'
import { isAgentDraft } from './page-status'
import {
  isKnowledgeViewMode,
  KNOWLEDGE_VIEW_MODES,
  type KnowledgeViewMode,
} from './KnowledgeViewToggle'
import { PageEditor } from './PageEditor'
import { SpaceSettingsDialog } from './SpaceSettingsDialog'
import { firstFileOnly, useFileDrop } from '../../../hooks/useFileDrop'
import { VersionHistory } from './VersionHistory'
import { buildKnowledgeWorkspaceActions } from './knowledge-workspace-actions'

const VIEW_MODE_COOKIE = 'knowledgeViewMode'

// The workspace's four inner screens — a folder browsed beyond the space root,
// an open document or file, its version history, the page editor — are nested
// stages (docs/navigation.md §6). Where a single-column stack hosts them each
// is a real layer: it slides in, Back unwinds exactly one level (the deepest
// priority owns the doorway) and the edge swipe drives the top one. Where no
// stack hosts stages (a split layout's detail column, an isolated render) they
// render inline and the workspace composes one pane at a time, exactly as the
// desktop columns and the full-width editor did before.
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
    closeEditor,
    createFolder,
    createFolderPending,
    savePage,
    savePending,
    popTo,
    closeHistory,
    historyPageId,
    restoreVersion,
    restorePending,
    spaceSettingsOpen,
    openSpaceSettings,
    closeSpaceSettings,
    updateSpace,
    updateSpacePending,
  } = useKnowledge()
  const navigate = useNavigate()
  // The stack's presence — never a breakpoint — decides whether the stages are
  // layers over this route or panes composed in place.
  const stacked = useNestedStageHosted()
  // The view mode is `?view=` like every other in-page strip
  // (docs/navigation.md §1, "Tab hosts") so a link to a space opens in the
  // layout it was shared in. The cookie stays the *default* for a URL that
  // names no view, and is rewritten on every change, so the preference still
  // follows the reader across spaces and sessions. Read once per mount: the
  // fallback must not move underneath the hook that deletes the param when the
  // fallback itself is selected.
  const [storedViewMode] = useState<KnowledgeViewMode>(() => {
    const stored = getCookie(VIEW_MODE_COOKIE)
    return isKnowledgeViewMode(stored) ? stored : 'column'
  })
  const [viewMode, selectViewMode] = useTabParam(
    'view',
    KNOWLEDGE_VIEW_MODES,
    storedViewMode,
  )
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
  const historyPage = historyPageId ? pageById(historyPageId) : undefined

  const canWrite = selectedSpace?.canWrite ?? false
  const canManageAccess = selectedSpace?.canManageAccess ?? false
  // A space administrator must retain the settings doorway after enabling
  // writeRestricted, even when that switch removes ordinary content writes.
  const canManage = (canWrite && (canManageSpace ?? true)) || canManageAccess

  // Which stages are open. A stack shows them all at once, one layer each; an
  // inline host shows only the deepest, which is what the early returns this
  // replaced did — editor over history over document over the browser.
  const editorOpen = Boolean(editor) && canWrite
  const historyOpen = Boolean(historyPage) && (stacked || !editorOpen)
  const documentOpen = Boolean(current) && (stacked || !(editorOpen || historyOpen))
  // A document's ancestors are unwound by the document stage itself ("Back to
  // parent page"), so the folder stage is the browse path with nothing open.
  const folderOpen = stacked && !current && !activeProductView && pathPages.length > 0
  const baseIsBrowser = stacked || !(editorOpen || historyOpen || documentOpen)
  // What the route layer's browser shows: the listing a stage was pushed over
  // — the space root under an open folder, the open document's ancestors under
  // an open document — and the live path wherever it is the only browser.
  const basePath = current
    ? pathPages.slice(0, Math.max(depth, 0)).map((page) => page.id)
    : folderOpen
      ? []
      : pagePath

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

  // ─── File-node upload wiring (a file dropped into the current folder) ──────
  const [fileNodeProgress, setFileNodeProgress] = useState<UploadProgress | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const fileNodeUpload = useUploadFileNode(selectedSpaceId, currentFolder?.id ?? null)

  const updateViewMode = (nextMode: KnowledgeViewMode) => {
    selectViewMode(nextMode)
    setCookie(VIEW_MODE_COOKIE, nextMode)
  }
  const workspaceActions = buildKnowledgeWorkspaceActions({
    agentDraftCount,
    canManageSpace: canManage,
    canWrite,
    needsReviewOnly,
    ownerAgentId: selectedSpace?.ownerAgentId,
    onCreateFolder: () => {
      updateViewMode('column')
      setCreatingFolder(true)
    },
    onCreatePage: () => openCreate(currentFolder?.id ?? null),
    onOpenAgent: (agentId) => void navigate(`/agents/${agentId}`),
    onOpenSettings: openSpaceSettings,
    onSelectView: updateViewMode,
    onToggleNeedsReview: () => setNeedsReviewOnly((value) => !value),
    onUploadFile: () => fileInputRef.current?.click(),
    selectedSpaceId,
    scopeAgentId,
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
  const fileNodeDrop = useFileDrop(firstFileOnly(uploadFileNode), !selectedSpaceId || !canWrite)

  // ─── Panes ────────────────────────────────────────────────────────────────
  // The browser renders twice while a folder stage is open: the space's root
  // listing stays in the route layer as the screen that folder was pushed
  // over, and the stage carries the live path. `chrome` marks the interactive
  // copy — exactly one of the two — so the actions, the upload input and the
  // dialogs they open exist once.
  const renderBrowser = (path: string[], chrome: boolean) => (
    <div className="relative h-full w-full" {...(chrome ? fileNodeDrop.dropHandlers : {})}>
      <KnowledgePane
        actions={chrome ? workspaceActions : undefined}
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
              creatingFolder={chrome && canWrite && creatingFolder}
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
              pagePath={path}
              pages={pages}
              rootPages={visibleRootPages}
              selectedSpaceId={selectedSpaceId}
              selectedSpaceName={selectedSpace?.name ?? 'Pages'}
            />
          )}
        </div>
      </KnowledgePane>
      {chrome ? (
        <>
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
          {selectedSpace && canManage ? (
            <SpaceSettingsDialog
              canManageAccess={canManageAccess}
              onClose={closeSpaceSettings}
              onSave={updateSpace}
              open={spaceSettingsOpen}
              pending={updateSpacePending}
              space={selectedSpace}
            />
          ) : null}
        </>
      ) : null}
    </div>
  )

  // The open document or file node, with its attachments and versions.
  const documentPane = current ? (
    <KnowledgeDocumentPane
      canWrite={canWrite}
      converting={canWrite && isMarkdownFileNode && !convertToDocument.isError}
      depth={depth}
      fullPage={fullPage}
      onBack={stacked ? undefined : () => popTo(depth)}
      page={current}
      selectedSpaceId={selectedSpaceId}
    />
  ) : null

  // Full-width version history.
  const historyPane = historyPage ? (
    <KnowledgePane
      onBack={stacked ? undefined : closeHistory}
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
  ) : null

  // Full-width editor (create or edit). Editing waits for the on-demand full
  // body so the editor never initialises from an empty (list-stripped) body and
  // overwrites real content on save.
  const editorPane = editor ? (
    <KnowledgePane
      onBack={stacked ? undefined : closeEditor}
      title={editor.mode === 'edit' ? 'Edit page' : 'Create page'}
    >
      <div className="flex h-full w-full flex-col">
        {editor.mode === 'edit' && !fullPage ? (
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
  ) : null

  return (
    <>
      {activeProductView ? (
        // A product Documents view (e.g. DeepWater Research) owns the whole
        // main area instead of a space's pages.
        <ProductDocumentsView view={activeProductView} />
      ) : baseIsBrowser ? (
        renderBrowser(basePath, !folderOpen)
      ) : null}
      <NestedStage
        active={folderOpen}
        id="knowledge:folder"
        label="Back to parent folder"
        onBack={() => browseTo(pathPages.slice(0, -1).map((page) => page.id))}
        priority={LOCAL_BACK_PRIORITY.knowledgeFolder}
      >
        {renderBrowser(pagePath, true)}
      </NestedStage>
      <NestedStage
        active={documentOpen}
        id="knowledge:document"
        label={depth > 0 ? 'Back to parent page' : 'Back to space'}
        onBack={() => popTo(depth)}
        priority={LOCAL_BACK_PRIORITY.knowledgeDocument}
      >
        {documentPane}
      </NestedStage>
      <NestedStage
        active={historyOpen}
        id="knowledge:history"
        label="Back from version history"
        onBack={closeHistory}
        priority={LOCAL_BACK_PRIORITY.knowledgeHistory}
      >
        {historyPane}
      </NestedStage>
      <NestedStage
        active={editorOpen}
        id="knowledge:editor"
        label="Back from page editor"
        onBack={closeEditor}
        priority={LOCAL_BACK_PRIORITY.knowledgeEditor}
        // The editor holds its draft in its own state and publishes no dirty
        // signal, so the swipe stays refused for as long as it is open: a
        // half-written page must never be lost to a stray edge gesture.
        swipeable={false}
      >
        {editorPane}
      </NestedStage>
    </>
  )
}
