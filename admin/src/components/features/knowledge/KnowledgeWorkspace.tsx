import type { ReactNode } from 'react'
import { ColumnBrowserColumn } from '../../shared/column-browser/ColumnBrowserColumn'
import { ColumnBrowserViewport } from '../../shared/column-browser/ColumnBrowserViewport'
import { useKnowledgeVersions } from '../../../facades/knowledge/hooks'
import { useKnowledge } from './KnowledgeProvider'
import { PageColumn } from './PageColumn'
import { PageEditor } from './PageEditor'
import { VersionHistory } from './VersionHistory'

export const KnowledgeWorkspace = () => {
  const {
    selectedSpace,
    pagePath,
    pageById,
    childrenOf,
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

  const versionsQuery = useKnowledgeVersions(historyPageId)
  const pathPages = pagePath
    .map((pageId) => pageById(pageId))
    .filter((page): page is NonNullable<typeof page> => Boolean(page))

  const columns: ReactNode[] = []

  if (pathPages.length === 0) {
    columns.push(
      <ColumnBrowserColumn key="empty" title={selectedSpace?.name ?? 'Page'}>
        <div className="flex h-full items-center justify-center text-sm text-[color:var(--tx3)]">
          {selectedSpace ? 'Select a page' : 'Create or select a space'}
        </div>
      </ColumnBrowserColumn>,
    )
  } else {
    pathPages.forEach((page, depth) => {
      columns.push(
        <PageColumn
          activeChildId={pagePath[depth + 1]}
          key={`page-${page.id}`}
          onBack={depth > 0 ? () => popTo(depth) : undefined}
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
  }

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

  const activeColumn =
    editor || historyPage ? columns.length - 1 : Math.max(0, pathPages.length - 1)

  return (
    <div className="h-full w-full">
      <ColumnBrowserViewport activeColumn={activeColumn} columns={columns} />
    </div>
  )
}
