import { Fragment, useEffect, useRef, useState, type PointerEvent } from 'react'
import type { KnowledgePageRecord } from '../../../facades/knowledge/hooks'
import { getCookie, setCookie } from '../../../lib/storage'
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
// The leftmost (root/space) column is rendered a little wider than the rest.
const ROOT_COLUMN_EXTRA = 56

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

// A draggable divider. Dragging adjusts the single shared column width, so every
// column stretches or shrinks together (never below MIN_COLUMN_WIDTH).
const ResizeHandle = ({
  onPointerDown,
}: {
  onPointerDown: (event: PointerEvent<HTMLDivElement>) => void
}) => (
  <div
    aria-orientation="vertical"
    className="group flex h-full w-4 flex-shrink-0 cursor-col-resize items-center justify-center"
    onPointerDown={onPointerDown}
    role="separator"
  >
    <div className="h-full w-px bg-[color:var(--sep)] transition-colors group-hover:bg-[color:var(--accent)]" />
  </div>
)

const ColumnCard = ({
  childrenOf,
  column,
  onBrowsePath,
  onCancelFolder,
  onOpenDocumentPath,
  onSubmitFolder,
  pending,
  showNewFolder,
  width,
}: {
  childrenOf: (parentPageId: string) => KnowledgePageRecord[]
  column: ColumnModel
  onBrowsePath: (path: string[]) => void
  onCancelFolder: () => void
  onOpenDocumentPath: (path: string[]) => void
  onSubmitFolder: (name: string) => void
  pending: boolean
  showNewFolder: boolean
  width: number
}) => {
  const items = sortFilesystemPages(column.pages, childrenOf)
  const emptyLabel = column.pathPrefix.length ? 'No files in this folder.' : 'No pages yet.'

  return (
    <div className="admin-card flex h-full flex-shrink-0 flex-col overflow-hidden" style={{ width }}>
      <div className="flex h-[50px] flex-shrink-0 items-center border-b border-[color:var(--sep)] px-4">
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-[color:var(--tx)]">
          {column.title}
        </h3>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {showNewFolder ? (
          <NewFolderRow onCancel={onCancelFolder} onSubmit={onSubmitFolder} pending={pending} />
        ) : null}
        {items.length === 0 && !showNewFolder ? (
          <EmptyFolder label={emptyLabel} />
        ) : (
          <div className="grid grid-cols-1 gap-0.5">
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
          </div>
        )}
      </div>
    </div>
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
  const scrollRef = useRef<HTMLDivElement>(null)

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
  const activeIndex = columns.length - 1

  // Keep the deepest column in view as the user drills in.
  useEffect(() => {
    const element = scrollRef.current
    if (element) element.scrollTo({ left: element.scrollWidth, behavior: 'smooth' })
  }, [columns.length])

  const startResize = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = columnWidth
    let lastWidth = startWidth

    const move = (moveEvent: globalThis.PointerEvent) => {
      lastWidth = clampWidth(startWidth + (moveEvent.clientX - startX))
      setColumnWidth(lastWidth)
    }
    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      setCookie(COLUMN_WIDTH_COOKIE, String(lastWidth))
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  return (
    <div className="animate-kb-view-slide h-full w-full">
      <div
        className="flex h-full items-stretch overflow-x-auto overflow-y-hidden px-3 pb-2 pt-3"
        ref={scrollRef}
      >
        {columns.map((column, index) => (
          <Fragment key={column.key}>
            <ColumnCard
              childrenOf={childrenOf}
              column={column}
              onBrowsePath={onBrowsePath}
              onCancelFolder={onCancelFolder}
              onOpenDocumentPath={onOpenDocumentPath}
              onSubmitFolder={onSubmitFolder}
              pending={createFolderPending}
              showNewFolder={creatingFolder && index === activeIndex}
              width={index === 0 ? columnWidth + ROOT_COLUMN_EXTRA : columnWidth}
            />
            <ResizeHandle onPointerDown={startResize} />
          </Fragment>
        ))}
      </div>
    </div>
  )
}
