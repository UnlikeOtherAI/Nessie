import { useState } from 'react'
import { useKnowledgeVersions } from '../../../facades/knowledge/hooks'
import { getCookie, setCookie } from '../../../lib/storage'
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

  const versionsQuery = useKnowledgeVersions(historyPageId)
  const pathPages = pagePath
    .map((pageId) => pageById(pageId))
    .filter((page): page is NonNullable<typeof page> => Boolean(page))
  const current = openPageId ? pageById(openPageId) : undefined
  const depth = current ? pathPages.findIndex((page) => page.id === current.id) : -1
  const currentFolder = openPageId ? null : pathPages.at(-1)

  const updateViewMode = (nextMode: KnowledgeViewMode) => {
    setViewMode(nextMode)
    setCookie(VIEW_MODE_COOKIE, nextMode)
  }

  // Full-width editor (create or edit) — takes the whole main area.
  if (editor) {
    return (
      <KnowledgePane onBack={closeEditor} title={editor.mode === 'edit' ? 'Edit page' : 'Create page'}>
        <div className="mx-auto flex h-full w-full max-w-4xl flex-col">
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

  // Full-width page preview. Back pops the navigation stack (to the parent page,
  // or to the pages list at the top level).
  if (current) {
    return (
      <PagePreview
        onBack={() => popTo(depth)}
        onCreateChild={() => openCreate(current.id)}
        onDrill={(childPageId) => drillTo(depth, childPageId)}
        onEdit={() => openEdit(current)}
        onOpenHistory={() => openHistory(current.id)}
        onPublish={() => publishPage(current.id)}
        page={current}
        publishPending={publishPending}
        subPages={childrenOf(current.id)}
      />
    )
  }

  // No document open → the selected space's filesystem browser.
  return (
    <KnowledgePane
      actions={
        selectedSpaceId ? (
          <button
            className="admin-button admin-button-primary rounded-md px-3 py-1 text-xs"
            onClick={() => openCreate(currentFolder?.id ?? null)}
            type="button"
          >
            New page
          </button>
        ) : undefined
      }
      center={<KnowledgeViewToggle mode={viewMode} onChange={updateViewMode} />}
      title={selectedSpace?.name ?? 'Pages'}
    >
      <div className="h-full w-full">
        {!selectedSpaceId ? (
          <div className="py-16 text-center text-sm text-[color:var(--tx3)]">Select a space</div>
        ) : rootPages.length === 0 ? (
          <div className="py-16 text-center text-sm text-[color:var(--tx3)]">
            No pages yet — create one with “New page”.
          </div>
        ) : (
          <KnowledgeFilesystemBrowser
            childrenOf={childrenOf}
            mode={viewMode}
            onBrowsePath={browseTo}
            onOpenDocumentPath={openPagePath}
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
  )
}
