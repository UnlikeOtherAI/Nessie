import { useState } from 'react'
import type { KnowledgePageRecord } from '../../../facades/knowledge/hooks'
import { getCookie, setCookie } from '../../../lib/storage'
import { ColumnBrowserColumn } from '../../shared/column-browser/ColumnBrowserColumn'
import { ColumnBrowserViewport } from '../../shared/column-browser/ColumnBrowserViewport'
import { RowList } from '../../shared/RowList'
import {
  EmptyFolder,
  isFolderPage,
  KnowledgeItemRow,
  NewFolderRow,
  sortFilesystemPages,
} from './KnowledgeFilesystemRows'

const COLUMN_WIDTH_COOKIE = 'knowledgeColumnWidth'
const MIN_COLUMN_WIDTH = 300
const MAX_COLUMN_WIDTH = 720
const DEFAULT_COLUMN_WIDTH = 320

type ColumnModel = {
  key: string
  title: string
  pages: KnowledgePageRecord[]
  pathPrefix: string[]
  selectedId?: string
}

type KnowledgeColumnsProps = {
  childrenOf: (parentPageId: string) => KnowledgePageRecord[]
  creatingFolder: boolean
  createFolderPending: boolean
  onBrowsePath: (path: string[]) => void
  onCancelFolder: () => void
  onOpenDocumentPath: (path: string[]) => void
  onSubmitFolder: (name: string) => void
  pathPages: KnowledgePageRecord[]
  rootPages: KnowledgePageRecord[]
  selectedSpaceName: string
}

const clampWidth = (value: number): number =>
  Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, value))

const readStoredWidth = (): number => {
  const stored = Number(getCookie(COLUMN_WIDTH_COOKIE))
  return Number.isFinite(stored) && stored > 0 ? clampWidth(stored) : DEFAULT_COLUMN_WIDTH
}

// One column of the drill-down browser, on the shared `ColumnBrowserColumn`
// shell — the same one Tools/Triggers/Workflows/Integrations use — with its
// trailing edge wired to the shared resize handle so every column tracks the
// one width the browser persists.
const KnowledgeColumn = ({
  childrenOf,
  column,
  columnWidth,
  onBrowsePath,
  onCancelFolder,
  onOpenDocumentPath,
  onResizeWidth,
  onSubmitFolder,
  pending,
  showNewFolder,
}: {
  childrenOf: (parentPageId: string) => KnowledgePageRecord[]
  column: ColumnModel
  columnWidth: number
  onBrowsePath: (path: string[]) => void
  onCancelFolder: () => void
  onOpenDocumentPath: (path: string[]) => void
  onResizeWidth: (width: number, commit: boolean) => void
  onSubmitFolder: (name: string) => void
  pending: boolean
  showNewFolder: boolean
}) => {
  const items = sortFilesystemPages(column.pages, childrenOf)
  const emptyLabel = column.pathPrefix.length ? 'No files in this folder.' : 'No pages yet.'

  return (
    <ColumnBrowserColumn
      resize={{ max: MAX_COLUMN_WIDTH, min: MIN_COLUMN_WIDTH, onResize: onResizeWidth, width: columnWidth }}
      title={column.title}
    >
      {showNewFolder ? (
        <div className="mb-0.5">
          <NewFolderRow onCancel={onCancelFolder} onSubmit={onSubmitFolder} pending={pending} />
        </div>
      ) : null}
      {items.length === 0 && !showNewFolder ? (
        <EmptyFolder label={emptyLabel} />
      ) : items.length === 0 ? null : (
        <RowList>
          {items.map((page) => {
            const folder = isFolderPage(page, childrenOf)
            const path = [...column.pathPrefix, page.id]
            return (
              <KnowledgeItemRow
                childCount={childrenOf(page.id).length}
                isSelected={column.selectedId === page.id}
                key={page.id}
                kind={folder ? 'folder' : 'file'}
                onClick={() => (folder ? onBrowsePath(path) : onOpenDocumentPath(path))}
                page={page}
              />
            )
          })}
        </RowList>
      )}
    </ColumnBrowserColumn>
  )
}

export const KnowledgeColumns = ({
  childrenOf,
  creatingFolder,
  createFolderPending,
  onBrowsePath,
  onCancelFolder,
  onOpenDocumentPath,
  onSubmitFolder,
  pathPages,
  rootPages,
  selectedSpaceName,
}: KnowledgeColumnsProps) => {
  const [columnWidth, setColumnWidth] = useState(readStoredWidth)

  const onResizeWidth = (width: number, commit: boolean) => {
    setColumnWidth(width)
    if (commit) setCookie(COLUMN_WIDTH_COOKIE, String(width))
  }

  const columns: ColumnModel[] = [
    {
      key: 'root',
      title: selectedSpaceName,
      pages: rootPages,
      pathPrefix: [],
      selectedId: pathPages[0]?.id,
    },
    ...pathPages.map((folder, index) => ({
      key: folder.id,
      title: folder.title,
      pages: childrenOf(folder.id),
      pathPrefix: pathPages.slice(0, index + 1).map((page) => page.id),
      selectedId: pathPages[index + 1]?.id,
    })),
  ]

  return (
    <div className="animate-kb-view-slide h-full w-full">
      <ColumnBrowserViewport
        activeColumn={columns.length - 1}
        columnWidth={columnWidth}
        columns={columns.map((column, index) => (
          <KnowledgeColumn
            childrenOf={childrenOf}
            column={column}
            columnWidth={columnWidth}
            key={column.key}
            onBrowsePath={onBrowsePath}
            onCancelFolder={onCancelFolder}
            onOpenDocumentPath={onOpenDocumentPath}
            onResizeWidth={onResizeWidth}
            onSubmitFolder={onSubmitFolder}
            pending={createFolderPending}
            showNewFolder={creatingFolder && index === columns.length - 1}
          />
        ))}
      />
    </div>
  )
}
