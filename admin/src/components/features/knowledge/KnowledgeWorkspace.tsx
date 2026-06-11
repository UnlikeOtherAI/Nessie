import type { ReactNode } from 'react'
import { ColumnBrowserColumn } from '../../shared/column-browser/ColumnBrowserColumn'
import { ColumnBrowserViewport } from '../../shared/column-browser/ColumnBrowserViewport'
import { useKnowledgeVersions } from '../../../facades/knowledge/hooks'
import { useKnowledge } from './KnowledgeProvider'
import { PageColumn } from './PageColumn'
import { PageEditor } from './PageEditor'
import { VersionHistory } from './VersionHistory'
import { pageStatusTone } from './page-status'

export const KnowledgeWorkspace = () => {
  const {
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

  const columns: ReactNode[] = []

  // First main column: the selected space's top-level pages.
  columns.push(
    <ColumnBrowserColumn
      headerAction={
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
      key="pages"
      title="Pages"
    >
      {!selectedSpaceId ? (
        <div className="flex h-full items-center justify-center text-sm text-[color:var(--tx3)]">
          Select a space
        </div>
      ) : rootPages.length === 0 ? (
        <div className="flex h-full items-center justify-center text-sm text-[color:var(--tx3)]">
          No pages yet
        </div>
      ) : (
        <div className="grid gap-1">
          {rootPages.map((page) => (
            <button
              className={[
                'flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
                pagePath[0] === page.id
                  ? 'bg-[color:var(--accent)] text-[var(--on-accent)]'
                  : 'text-[color:var(--tx2)] hover:bg-[var(--overlay-weak)] hover:text-[var(--tx)]',
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
    </ColumnBrowserColumn>,
  )

  pathPages.forEach((page, depth) => {
    columns.push(
      <PageColumn
        activeChildId={pagePath[depth + 1]}
        key={`page-${page.id}`}
        onBack={() => popTo(depth)}
        onCreateChild={() => openCreate(page.id)}
        onDrill={(childPageId) => drillTo(depth, childPageId)}
        onEdit={() => openEdit(page)}
        onOpenHistory={() => openHistory(page.id)}
        onPublish={() => publishPage(page.id)}
        page={page}
        publishPending={publishPending}
        subPages={childrenOf(page.id)}
      />,
    )
  })

  const historyPage = historyPageId ? pageById(historyPageId) : undefined
  if (historyPage) {
    columns.push(
      <ColumnBrowserColumn
        key={`history-${historyPage.id}`}
        onBack={closeHistory}
        showBack
        title="History"
      >
        <VersionHistory
          onRestore={(versionId) => restoreVersion({ pageId: historyPage.id, versionId })}
          page={historyPage}
          pending={restorePending}
          versions={versionsQuery.data ?? []}
        />
      </ColumnBrowserColumn>,
    )
  }

  if (editor) {
    columns.push(
      <ColumnBrowserColumn
        key="editor"
        onBack={closeEditor}
        showBack
        title={editor.mode === 'edit' ? 'Edit page' : 'Create page'}
      >
        <PageEditor
          mode={editor.mode}
          onCancel={closeEditor}
          onSubmit={savePage}
          page={editor.mode === 'edit' ? editor.page : null}
          parentPageId={editor.mode === 'create' ? editor.parentPageId : null}
          pending={savePending}
        />
      </ColumnBrowserColumn>,
    )
  }

  const activeColumn = editor || historyPage ? columns.length - 1 : pathPages.length

  return (
    <div className="h-full w-full">
      <ColumnBrowserViewport activeColumn={activeColumn} columns={columns} />
    </div>
  )
}
