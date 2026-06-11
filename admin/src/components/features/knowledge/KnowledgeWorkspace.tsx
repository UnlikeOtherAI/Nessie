import { useKnowledgeVersions } from '../../../facades/knowledge/hooks'
import { useKnowledge } from './KnowledgeProvider'
import { KnowledgePane } from './KnowledgePane'
import { PageEditor } from './PageEditor'
import { PagePreview } from './PagePreview'
import { pageStatusTone } from './page-status'
import { VersionHistory } from './VersionHistory'

export const KnowledgeWorkspace = () => {
  const {
    selectedSpace,
    selectedSpaceId,
    rootPages,
    pagePath,
    pageById,
    childrenOf,
    editor,
    openCreate,
    openEdit,
    openRootPage,
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

  const versionsQuery = useKnowledgeVersions(historyPageId)
  const pathPages = pagePath
    .map((pageId) => pageById(pageId))
    .filter((page): page is NonNullable<typeof page> => Boolean(page))
  const current = pathPages[pathPages.length - 1]
  const depth = pathPages.length - 1

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

  // No page open → the selected space's pages list.
  return (
    <KnowledgePane
      actions={
        selectedSpaceId ? (
          <button
            className="admin-button admin-button-primary rounded-md px-3 py-1 text-xs"
            onClick={() => openCreate(null)}
            type="button"
          >
            New page
          </button>
        ) : undefined
      }
      title={selectedSpace?.name ?? 'Pages'}
    >
      <div className="mx-auto w-full max-w-3xl px-6 py-6">
        {!selectedSpaceId ? (
          <div className="py-16 text-center text-sm text-[color:var(--tx3)]">Select a space</div>
        ) : rootPages.length === 0 ? (
          <div className="py-16 text-center text-sm text-[color:var(--tx3)]">
            No pages yet — create one with “New page”.
          </div>
        ) : (
          <div className="grid gap-1">
            {rootPages.map((page) => (
              <button
                className={[
                  'flex items-center gap-2 rounded-md px-3 py-2.5 text-left text-sm',
                  'text-[color:var(--tx2)] hover:bg-[var(--overlay-weak)] hover:text-[var(--tx)]',
                ].join(' ')}
                key={page.id}
                onClick={() => openRootPage(page.id)}
                type="button"
              >
                <span className="min-w-0 flex-1 truncate">{page.title}</span>
                <span className={`text-[10px] uppercase tracking-[0.14em] ${pageStatusTone[page.status]}`}>
                  {page.status}
                </span>
                <span aria-hidden className="opacity-60">
                  →
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </KnowledgePane>
  )
}
