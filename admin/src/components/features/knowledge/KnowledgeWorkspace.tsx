import { useState } from 'react'
import { useKnowledgePage, useKnowledgeVersions } from '../../../facades/knowledge/hooks'
import { useProjects } from '../../../facades/projects/hooks'
import { LOCAL_BACK_PRIORITY } from '../../../navigation/LocalBackContext'
import { NestedStage, useNestedStageHosted } from '../../../navigation/NestedStage'
import { Dialog } from '../../shared/Dialog'
import { CreateSpaceDialog } from './CreateSpaceDialog'
import { KnowledgeDocumentPane } from './KnowledgeDocumentPane'
import { knowledgePageAncestors } from './page-ancestors'
import { ProductDocumentsView } from './ProductDocumentsView'
import { QueryState } from '../../shared/QueryState'
import { useKnowledge } from './KnowledgeProvider'
import { DocumentsFinder } from './finder/DocumentsFinder'
import type { FinderScope } from './finder/documents-finder-types'
import { PageEditor } from './PageEditor'
import { SpaceSettingsDialog } from './SpaceSettingsDialog'
import { FolderSettingsDialog } from './FolderSettingsDialog'
import { VersionHistory } from './VersionHistory'

/**
 * The Knowledge work surface: the Finder, the open document beside it, and the
 * full-width editor a document opens into. Version history opens in a modal
 * over the document, using the same shell as Upload a new version.
 *
 * The document and editor are nested stages (docs/navigation/overview.md §6).
 * Where a single-column stack hosts them each is a real layer: it slides in, Back
 * unwinds exactly one level and the edge swipe drives the top one. Where no
 * stack hosts stages (a split layout, an isolated render) they render inline.
 * The Finder places documents beside the hierarchy in Tree and over its whole
 * browser in Columns/List; the editor remains a full-width stage.
 * Keeping the Finder mounted preserves its folder, scroll and selection.
 *
 * `knowledge:folder` is **gone**: the Finder sits on `ColumnBrowserViewport`,
 * whose columns are already `column:<k>` stages on `single`, so a folder is a
 * layer without this file knowing anything about it.
 */
type KnowledgeWorkspaceProps = {
  canManageSpace?: boolean
  /** Which browser this is: the section, a project's tab, an agent's. */
  scope?: FinderScope
}

export const KnowledgeWorkspace = ({
  canManageSpace,
  scope = { kind: 'org' },
}: KnowledgeWorkspaceProps = {}) => {
  const {
    activeProductView,
    selectedSpace,
    selectedSpaceId,
    pages,
    pagePath,
    openPageId,
    pageById,
    createSpace,
    createSpacePending,
    editor,
    closeEditor,
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
    browseTo,
  } = useKnowledge()
  // The stack's presence — never a breakpoint — decides whether the stages are
  // layers over this route or panes composed in place.
  const stacked = useNestedStageHosted()

  const versionsQuery = useKnowledgeVersions(historyPageId)
  const pathPages = pagePath
    .map((pageId) => pageById(pageId))
    .filter((page): page is NonNullable<typeof page> => Boolean(page))
  const current = openPageId ? pageById(openPageId) : undefined
  const breadcrumbPages = knowledgePageAncestors(current, pageById)
  const depth = current ? pathPages.findIndex((page) => page.id === current.id) : -1
  const historyPage = historyPageId ? pageById(historyPageId) : undefined
  const parentPage = depth > 0 ? pathPages[depth - 1] : undefined

  // A folder is a browser location, not a document detail. Closing a document
  // from one must remove only the open page and leave its folder column in
  // place; a real parent document still uses the shared parent-detail Back.
  const closeDocument = parentPage?.kind === 'folder'
    ? () => browseTo(pagePath.slice(0, -1))
    : () => popTo(depth)
  const documentBackLabel = parentPage?.kind === 'folder'
    ? 'Back to folder'
    : depth > 0 ? 'Back to parent page' : 'Back to space'

  const canWrite = selectedSpace?.canWrite ?? false
  const canManageAccess = selectedSpace?.canManageAccess ?? false
  const projectRootSelected = selectedSpace?.metadata?.projectDocuments === true
  const projectsQuery = useProjects(projectRootSelected)
  const projectRootName = projectRootSelected
    ? projectsQuery.data?.find((project) => project.id === selectedSpace?.projectId)?.name ?? 'Project'
    : undefined
  const spaceDisplayName = projectRootName ?? selectedSpace?.name ?? 'Documents'
  // A space administrator must retain the settings doorway after enabling
  // writeRestricted, even when that switch removes ordinary content writes.
  const canManage = (canWrite && (canManageSpace ?? true)) || canManageAccess

  // Which stages are open. A stack shows them all at once, one layer each. On
  // wider layouts the Finder owns document placement: Tree keeps it in the
  // reading pane beside the hierarchy, while Columns and List cover their
  // browser with the same document surface.
  const editorOpen = Boolean(editor) && canWrite
  const documentOpen = Boolean(current) && (stacked || !editorOpen)
  const browserVisible = stacked || !editorOpen

  // The space-pages list omits page bodies (they're large and the browser never
  // shows them). Fetch the full body on demand for whichever page actually
  // needs it — the editor is gated on this so it never opens, and therefore can
  // never save, with an empty body.
  const fullBodyPageId =
    editor?.mode === 'edit'
      ? editor.page.id
      : historyPageId ?? (current && current.kind !== 'file' ? current.id : undefined)
  const fullPageQuery = useKnowledgePage(fullBodyPageId)
  const fullPage =
    fullPageQuery.data && fullPageQuery.data.id === fullBodyPageId ? fullPageQuery.data : undefined

  // Uploading is the Finder's own (uploads-and-indexing.md §2): one queue, one
  // file picker and one set of placeholder rows, all inside `DocumentsFinder`.
  // The single-file doorway that stood here until Wave 2 landed is gone —
  // two file inputs on one screen is two answers to one question.
  const [createSpaceOpen, setCreateSpaceOpen] = useState(false)
  const [settingsFolder, setSettingsFolder] = useState<NonNullable<typeof current> | null>(null)

  // The open document or file node, with its attachments and versions.
  const documentPane = current ? (
    <KnowledgeDocumentPane
      bodyQuery={fullPageQuery}
      breadcrumbPages={breadcrumbPages}
      canWrite={canWrite}
      fullPage={fullPage}
      onBack={stacked ? undefined : closeDocument}
      page={current}
      selectedSpaceId={selectedSpaceId}
      spaceName={spaceDisplayName}
    />
  ) : null

  const browser = (
    <div className="relative h-full w-full">
      <DocumentsFinder
        canManageSpace={canManage}
        documentPane={!stacked && documentOpen ? documentPane : undefined}
        onCreateRootFolder={scope.kind === 'org' ? () => setCreateSpaceOpen(true) : undefined}
        onOpenSettings={(folder) => {
          if (folder?.kind === 'folder') setSettingsFolder(folder)
          else openSpaceSettings()
        }}
        scope={scope}
        spaceDisplayName={spaceDisplayName}
      />
      {selectedSpace && canManage ? (
        <SpaceSettingsDialog
          canManageAccess={canManageAccess}
          onClose={closeSpaceSettings}
          onSave={updateSpace}
          open={spaceSettingsOpen}
          pending={updateSpacePending}
          projectRootName={projectRootName}
          space={selectedSpace}
        />
      ) : null}
      {settingsFolder && selectedSpaceId ? (
        <FolderSettingsDialog
          folder={settingsFolder}
          onClose={() => setSettingsFolder(null)}
          open
          spaceId={selectedSpaceId}
        />
      ) : null}
      {/* A new space needs a visibility choice, which an inline folder-name
          field cannot carry — so the Knowledge root uses this dialog. */}
      <CreateSpaceDialog
        onClose={() => setCreateSpaceOpen(false)}
        onCreate={async (name, memberAgentIds, visibility) => {
          await createSpace(name, memberAgentIds, visibility)
        }}
        open={createSpaceOpen}
        pending={createSpacePending}
      />
    </div>
  )

  // Full-width editor (create or edit). Editing waits for the on-demand full
  // body so the editor never initialises from an empty (list-stripped) body and
  // overwrites real content on save.
  const editorPane = editor ? (
    <div className="h-full w-full">
      {editor.mode === 'edit' ? (
        <QueryState
          className="flex h-full items-center justify-center py-0"
          errorLabel="Couldn’t load this page."
          loadingLabel="Loading…"
          query={fullPageQuery}
        >
          {() => (
            <PageEditor
              mode="edit"
              onBack={stacked ? undefined : closeEditor}
              onCancel={closeEditor}
              onSubmit={savePage}
              page={fullPage ?? null}
              pages={pages}
              pending={savePending}
              spaceName={spaceDisplayName}
            />
          )}
        </QueryState>
      ) : (
        <PageEditor
          initialTitle={editor.initialTitle}
          mode="create"
          onBack={stacked ? undefined : closeEditor}
          onCancel={closeEditor}
          onSubmit={savePage}
          page={null}
          pages={pages}
          parentPageId={editor.parentPageId}
          pending={savePending}
          spaceName={spaceDisplayName}
        />
      )}
    </div>
  ) : null

  return (
    <>
      {activeProductView ? (
        // A product Documents view (e.g. DeepWater Research) owns the whole
        // main area instead of a folder's pages.
        <ProductDocumentsView view={activeProductView} />
      ) : browserVisible ? (
        <div className="relative h-full min-h-0 w-full">{browser}</div>
      ) : null}
      <NestedStage
        active={stacked && documentOpen}
        id="knowledge:document"
        label={documentBackLabel}
        onBack={closeDocument}
        priority={LOCAL_BACK_PRIORITY.knowledgeDocument}
      >
        {documentPane}
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
      {historyPage && !editorOpen ? (
        <Dialog
          description={historyPage.title}
          onClose={closeHistory}
          open
          size={historyPage.kind === 'file' ? 'md' : 'xl'}
          title="Version history"
        >
          <VersionHistory
            canRestore={canWrite}
            onRestore={(versionId) => restoreVersion({ pageId: historyPage.id, versionId })}
            page={fullPage ?? historyPage}
            pending={restorePending}
            versions={versionsQuery.data ?? []}
          />
        </Dialog>
      ) : null}
    </>
  )
}
