import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { faChevronRight } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { KnowledgePageRecord } from '../../../../facades/knowledge/hooks'
import { formatBytes } from '../../../../lib/upload-xhr'
import { EmptyState } from '../../../shared/EmptyState'
import { RowList } from '../../../shared/RowList'
import { familyTone, iconForFamily } from '../../../shared/file-icons'
import { AgentDraftBadge } from '../AgentDraftBadge'
import { isAgentDraft } from '../page-status'
import { FinderRow } from './FinderRow'
import type {
  FinderBackgroundMenuProps,
  FinderRowMenuProps,
} from './FinderContextMenus'
import { ResponsivePageHeader, type PageHeaderAction } from '../../../shared/ResponsivePageHeader'
import type { FinderFolderLevel } from './FinderFolderColumn'
import {
  clickModifier,
  type FinderSelection,
  type FinderSelectionEvent,
} from './finder-selection'
import { useFinderKeyboard } from './useFinderKeyboard'
import {
  composeFinderSort,
  familyForRow,
  FINDER_SORT_LABELS,
  finderSortDirection,
  finderSortKey,
  formatFinderDate,
  kindLabelForRow,
  type FinderSort,
  type FinderSortKey,
} from './finder-sort'

/**
 * List view (browser-ui.md §4): one folder at a time, full width, with the
 * four columns Finder shows — Name, Date modified, Size, Kind — and a header
 * row that sorts.
 *
 * Everything else is the same `FinderRow` in the same states, because a view
 * is a layout, not a second browser.
 *
 * Which columns fit is **measured**, never a breakpoint: the same folder is
 * narrow behind a chat shell on a desktop and wide on a phone in landscape,
 * and only measuring tells those apart. A value a hidden column would have
 * shown is in Get Info, so nothing is lost with the pixels.
 */

/** Below this the Kind column goes; below the second, Size goes too. */
const KIND_MIN = 640
const SIZE_MIN = 480

export type FinderBreadcrumbCrumb = { id: string | null; title: string }

type FinderListViewProps = {
  /** The folder's own menu, off the list's empty background. */
  backgroundProps?: FinderBackgroundMenuProps
  columnActive: boolean
  crumbs: FinderBreadcrumbCrumb[]
  emptyLabel: string
  focusedRowId?: string
  onBrowseTo: (pageId: string | null) => void
  /** `useFinderMenus().rowProps`, spread on each row. */
  rowProps?: (page: KnowledgePageRecord) => FinderRowMenuProps
  onOpen: (page: KnowledgePageRecord) => void
  onRowKeyDown?: (event: KeyboardEvent<HTMLElement>, id: string) => void
  onSelect: (page: KnowledgePageRecord, event: MouseEvent<HTMLElement>) => void
  onSelectSort: (sort: FinderSort) => void
  rows: KnowledgePageRecord[]
  selectedIds: readonly string[]
  sort: FinderSort
}

const Breadcrumb = ({
  crumbs,
  onBrowseTo,
}: {
  crumbs: FinderBreadcrumbCrumb[]
  onBrowseTo: (pageId: string | null) => void
}) => (
  <nav
    aria-label="Current folder"
    className="flex min-w-0 flex-wrap items-center gap-1 px-[var(--page-gutter)] py-2 text-sm"
  >
    {crumbs.map((crumb, index) => (
      <span className="flex min-w-0 items-center gap-1" key={crumb.id ?? 'root'}>
        {index > 0 ? (
          <FontAwesomeIcon className="h-2.5 w-2.5 text-[color:var(--tx3)]" icon={faChevronRight} />
        ) : null}
        <button
          className="max-w-52 truncate rounded px-1.5 py-1 text-[color:var(--tx2)] hover:bg-[color:var(--overlay)] hover:text-[color:var(--tx)]"
          onClick={() => onBrowseTo(crumb.id)}
          type="button"
        >
          {crumb.title}
        </button>
      </span>
    ))}
  </nav>
)

export const FinderListView = ({
  backgroundProps,
  columnActive,
  crumbs,
  emptyLabel,
  focusedRowId,
  onBrowseTo,
  onOpen,
  onRowKeyDown,
  onSelect,
  onSelectSort,
  rows,
  rowProps,
  selectedIds,
  sort,
}: FinderListViewProps) => {
  const gridRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(KIND_MIN)

  useEffect(() => {
    const element = gridRef.current
    if (!element || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width)
    })
    observer.observe(element)
    setWidth(element.getBoundingClientRect().width)
    return () => observer.disconnect()
  }, [])

  const showKind = width >= KIND_MIN
  const showSize = width >= SIZE_MIN
  // The leading glyph and the trailing chevron are lanes of the same track, so
  // a row and the header above it are laid out on one grid rather than two
  // that happen to be near each other.
  // Every row is its own grid, so an intrinsic track (`max-content`, `auto`)
  // resolves against that row's own content and lands in a different place on
  // each one — measured at 858px on the header and 826px on the first row.
  // Only `1fr` and fixed tracks resolve identically across separate grids, so
  // Date modified is a fixed 168px: wider than the longest short-form date,
  // and it is the first thing to go when the grid narrows anyway.
  const template = [
    '20px',
    'minmax(200px, 1fr)',
    '168px',
    showSize ? '88px' : null,
    showKind ? '160px' : null,
    '16px',
  ]
    .filter(Boolean)
    .join(' ')

  const activeKey = finderSortKey(sort)
  const direction = finderSortDirection(sort)
  const headerCell = (key: FinderSortKey, className = '') => (
    <button
      aria-sort={activeKey === key
        ? direction === 'asc' ? 'ascending' : 'descending'
        : 'none'}
      className={[
        'flex h-9 items-center gap-1 rounded px-1 text-left text-xs font-semibold',
        'text-[color:var(--tx2)] hover:bg-[color:var(--overlay-weak)]',
        className,
      ].join(' ')}
      onClick={() =>
        onSelectSort(
          activeKey === key
            ? composeFinderSort(key, direction === 'asc' ? 'desc' : 'asc')
            : composeFinderSort(key, 'asc'),
        )
      }
      type="button"
    >
      <span className="truncate">{FINDER_SORT_LABELS[key]}</span>
      {activeKey === key ? (
        <span aria-hidden="true" className="text-[10px]">{direction === 'asc' ? '▲' : '▼'}</span>
      ) : null}
    </button>
  )

  const tabbableId = focusedRowId ?? selectedIds[0] ?? rows[0]?.id

  return (
    <div className="flex h-full min-h-0 flex-col bg-[color:var(--main)]">
      <Breadcrumb crumbs={crumbs} onBrowseTo={onBrowseTo} />
      <div
        className="min-h-0 flex-1 overflow-y-auto px-1.5"
        ref={gridRef}
        {...backgroundProps}
        style={{ ['--finder-grid-columns' as string]: template }}
      >
        <div
          className="finder-grid-row sticky top-0 z-[var(--layer-stack)] border-b border-[color:var(--sep)] bg-[color:var(--main)] px-3"
          role="row"
        >
          <span />
          {headerCell('name')}
          {headerCell('modified')}
          {showSize ? headerCell('size', 'justify-end') : null}
          {showKind ? headerCell('kind') : null}
          <span />
        </div>
        {rows.length === 0 ? (
          <EmptyState className="mt-3">{emptyLabel}</EmptyState>
        ) : (
          // Flush: the columns view's list insets itself so a selected pill
          // stands off the column edge, but here every row has to line up with
          // the sortable header above it, to the pixel.
          <RowList className="finder-rows-flush" label="Items" role="listbox" variant="finder">
            {rows.map((page) => {
              const family = familyForRow(page)
              const folder = page.kind === 'folder'
              return (
                <FinderRow
                  {...(rowProps ? rowProps(page) : {})}
                  ariaLabel={folder ? `Open folder ${page.title}` : undefined}
                  chevron={folder}
                  columnActive={columnActive}
                  icon={iconForFamily(family)}
                  iconTone={familyTone[family]}
                  id={page.id}
                  indexing={page.indexing}
                  key={page.id}
                  kind={page.kind}
                  gridCells={(
                    <>
                      <span className="finder-row-meta truncate text-xs text-[color:var(--tx3)]">
                        {formatFinderDate(page.updatedAt)}
                      </span>
                      {showSize ? (
                        <span className="finder-row-meta finder-grid-size text-xs text-[color:var(--tx3)]">
                          {folder || !page.sizeBytes ? '—' : formatBytes(Number(page.sizeBytes))}
                        </span>
                      ) : null}
                      {showKind ? (
                        <span className="finder-row-meta truncate text-xs text-[color:var(--tx3)]">
                          {kindLabelForRow(page)}
                        </span>
                      ) : null}
                    </>
                  )}
                  gridTemplate={template}
                  onKeyDown={onRowKeyDown
                    ? (event) => onRowKeyDown(event, page.id)
                    : undefined}
                  onOpen={() => onOpen(page)}
                  onSelect={(event) => onSelect(page, event)}
                  selected={selectedIds.includes(page.id)}
                  shareCount={page.shareCount}
                  tabIndex={tabbableId === page.id ? 0 : -1}
                  title={page.title}
                  trailing={isAgentDraft(page) ? <AgentDraftBadge /> : undefined}
                  transfer={page.transfer ? page.transfer.operation : null}
                  variant="item"
                />
              )
            })}
          </RowList>
        )}
      </div>
    </div>
  )
}

type FinderListHostProps = {
  /** Project and agent scope only: the org root column carries them instead. */
  actions?: PageHeaderAction[]
  backgroundProps?: FinderBackgroundMenuProps
  rowProps?: (page: KnowledgePageRecord) => FinderRowMenuProps
  dispatch: (event: FinderSelectionEvent) => void
  level: FinderFolderLevel
  onBrowseTo: (pageId: string | null) => void
  onCreateFolder: () => void
  onOpen: (page: KnowledgePageRecord) => void
  onSelectSort: (sort: FinderSort) => void
  pageById: (pageId: string) => KnowledgePageRecord | undefined
  pathPages: KnowledgePageRecord[]
  rootLabel: string
  rows: KnowledgePageRecord[]
  selection: FinderSelection
  sort: FinderSort
}

/**
 * List view's wiring, as a component for the same reason the folder column has
 * one: the key table is a hook, and this is rendered inside a branch.
 *
 * Where the browser has no root column to carry them — a project's Docs tab,
 * an agent's — the toolbar renders here through the *shared* header, measured
 * and overflowed like every other. It is not a second strip: in that scope it
 * is the only one this browser has.
 */
export const FinderListHost = ({
  actions,
  backgroundProps,
  dispatch,
  level,
  onBrowseTo,
  onCreateFolder,
  onOpen,
  onSelectSort,
  pageById,
  pathPages,
  rootLabel,
  rows,
  rowProps,
  selection,
  sort,
}: FinderListHostProps) => {
  const order = rows.map((page) => page.id)
  const selectedIds = selection.columnKey === level.key ? selection.ids : []
  const onRowKeyDown = useFinderKeyboard({
    columnKey: level.key,
    dispatch,
    isFolder: (id) => pageById(id)?.kind === 'folder',
    onBack: level.depth > 0 ? () => onBrowseTo(pathPages.at(-2)?.id ?? null) : undefined,
    onNewFolder: onCreateFolder,
    onOpen: (id) => {
      const page = pageById(id)
      if (page) onOpen(page)
    },
    order,
    selectedIds,
    titleOf: (id) => pageById(id)?.title ?? '',
  })

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {actions && actions.length > 0 ? (
        <ResponsivePageHeader
          actions={actions}
          heading="h2"
          title={rootLabel}
          titleTone="section"
        />
      ) : null}
      <FinderListView
        backgroundProps={backgroundProps}
        columnActive
        crumbs={[
          { id: null, title: rootLabel },
          ...pathPages.map((page) => ({ id: page.id, title: page.title })),
        ]}
        emptyLabel="This folder is empty."
        onBrowseTo={onBrowseTo}
        onOpen={onOpen}
        onRowKeyDown={onRowKeyDown}
        onSelect={(page, event) => dispatch({
          columnKey: level.key,
          id: page.id,
          modifier: clickModifier(event),
          order,
          type: 'click',
        })}
        onSelectSort={onSelectSort}
        rowProps={rowProps}
        rows={rows}
        selectedIds={selectedIds}
        sort={sort}
      />
    </div>
  )
}
