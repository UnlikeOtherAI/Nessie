import { useState } from 'react'
import { useKnowledgePage, useKnowledgeVersions } from '../../../facades/knowledge/hooks'
import { LOCAL_BACK_PRIORITY } from '../../../navigation/LocalBackContext'
import { NestedStage, useNestedStageHosted } from '../../../navigation/NestedStage'
import { CreateSpaceDialog } from './CreateSpaceDialog'
import { KnowledgeDocumentPane } from './KnowledgeDocumentPane'
import { KnowledgePane } from './KnowledgePane'
import { knowledgePageAncestors } from './page-ancestors'
import { ProductDocumentsView } from './ProductDocumentsView'
import { QueryState } from '../../shared/QueryState'
import { useKnowledge } from './KnowledgeProvider'
import { DocumentsFinder, type FinderScope } from './finder/DocumentsFinder'
import { PageEditor } from './PageEditor'
import { SpaceSettingsDialog } from './SpaceSettingsDialog'
import { VersionHistory } from './VersionHistory'

/**
 * The Knowledge work surface: the Finder, the open document beside it, and the
 * two full-width screens a document opens into (its version history, its
 * editor).
 *
 * All three are nested stages (docs/navigation/overview.md §6). Where a
 * single-column stack hosts them each is a real layer: it slides in, Back
 * unwinds exactly one level and the edge swipe drives the top one. Where no
 * stack hosts stages (a split layout, an isolated render) they render inline —
 * and inline, an open document takes the whole work surface with a Back
 * button, the way the editor and the history already did. The 46% preview
 * column beside the browser was too small to read a document in; the browser
 * stays mounted underneath (covered, not unmounted) so Back lands on the same
 * folder, the same column scroll and the same selection it left.
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

  const canWrite = selectedSpace?.canWrite ?? false
  const canManageAccess = selectedSpace?.canManageAccess ?? false
  // A space administrator must retain the settings doorway after enabling
  // writeRestricted, even when that switch removes ordinary content writes.
  const canManage = (canWrite && (canManageSpace ?? true)) || canManageAccess

  // Which stages are open. A stack shows them all at once, one layer each; an
  // inline host shows the document, the editor or the history *over* the
  // browser — a covered browser keeps its folder, scroll and selection, which
  // is the whole point of the document's Back button.
  const editorOpen = Boolean(editor) && canWrite
  const historyOpen = Boolean(historyPage) && (stacked || !editorOpen)
  const documentOpen = Boolean(current) && (stacked || !(editorOpen || historyOpen))
  const browserVisible = stacked || !(editorOpen || historyOpen)
  const browserCovered = !stacked && documentOpen

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

  const browser = (
    <div className="relative h-full w-full">
      <DocumentsFinder
        canManageSpace={canManage}
        onCreateRootFolder={scope.kind === 'org' ? () => setCreateSpaceOpen(true) : undefined}
        onOpenSettings={openSpaceSettings}
        scope={scope}
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
      {/* A top-level folder needs a visibility choice, which an inline name
          field cannot carry — so the root's New folder is this dialog. */}
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

  // The open document or file node, with its attachments and versions.
  const documentPane = current ? (
    <KnowledgeDocumentPane
      bodyQuery={fullPageQuery}
      breadcrumbPages={breadcrumbPages}
      canWrite={canWrite}
      depth={depth}
      fullPage={fullPage}
      onBack={stacked ? undefined : () => popTo(depth)}
      page={current}
      selectedSpaceId={selectedSpaceId}
      spaceName={selectedSpace?.name ?? 'Documents'}
    />
  ) : null

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
              spaceName={selectedSpace?.name ?? 'Documents'}
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
          spaceName={selectedSpace?.name ?? 'Documents'}
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
        <div className="relative h-full min-h-0 w-full">
          {/* `invisible`, not unmounted and not `display: none`: the covered
              browser keeps its layout and its column scroll positions, so
              the document's Back returns to the exact browser it left. */}
          <div className={`flex h-full min-h-0 w-full${browserCovered ? ' invisible' : ''}`}>
            <div className="min-w-0 flex-1">{browser}</div>
          </div>
          {browserCovered ? (
            // On a split layout the open document is a full-surface screen
            // over the browser, the way the editor and the history are.
            <div className="absolute inset-0">{documentPane}</div>
          ) : null}
        </div>
      ) : null}
      <NestedStage
        active={stacked && documentOpen}
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
