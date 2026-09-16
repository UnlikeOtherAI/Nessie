import type { KeyboardEvent, MouseEvent } from 'react'
import { faChevronDown } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type {
  KnowledgeHome,
  KnowledgeIndexingState,
  KnowledgePageKind,
  KnowledgePageShareAccess,
} from '@nessie/schemas'
import { EmptyState } from '../../../shared/EmptyState'
import { QueryState } from '../../../shared/QueryState'
import { RowList } from '../../../shared/RowList'
import { familyTone, iconForFamily } from '../../../shared/file-icons'
import { FinderRow } from './FinderRow'
import { familyForRow } from './finder-sort'
import type { FinderSelection, FinderSelectionEvent } from './finder-selection'

/**
 * Latest and Shared with me (browser-ui.md §11): a listing the server
 * computes, whose rows are real pages living somewhere else.
 *
 * Every row therefore says where it *does* live — a virtual row with no home
 * line is a name with no way back to the thing it names. The ordering is the
 * server's (newest first), so Sort is disabled while one of these is active
 * rather than silently ignored.
 */

export type FinderVirtualRow = {
  id: string
  kind: KnowledgePageKind
  title: string
  indexing: KnowledgeIndexingState
  home: KnowledgeHome
  /** Shared with me only: what the viewer may do with it. */
  access?: KnowledgePageShareAccess
}

/** "My Documents › Contracts" — the root folder, then the folders under it. */
export const homeLine = (home: KnowledgeHome): string =>
  [home.spaceName, ...home.parentPath.map((crumb) => crumb.title)].join(' › ')

type FinderVirtualColumnProps = {
  columnActive: boolean
  emptyLabel: string
  focusedRowId?: string
  hasMore: boolean
  loadingMore: boolean
  onLoadMore: () => void
  onOpen: (row: FinderVirtualRow) => void
  onRowKeyDown?: (event: KeyboardEvent<HTMLElement>, id: string) => void
  onSelect: (row: FinderVirtualRow, event: MouseEvent<HTMLElement>) => void
  /** Wave 2's menu. A virtual row's menu is the short one: Open, Get Info. */
  onContextMenu?: (row: FinderVirtualRow, event: MouseEvent<HTMLElement>) => void
  query: { isError: boolean; isLoading: boolean; refetch: () => unknown }
  rows: FinderVirtualRow[]
  selectedIds: readonly string[]
}

export const FinderVirtualColumn = ({
  columnActive,
  emptyLabel,
  focusedRowId,
  hasMore,
  loadingMore,
  onContextMenu,
  onLoadMore,
  onOpen,
  onRowKeyDown,
  onSelect,
  query,
  rows,
  selectedIds,
}: FinderVirtualColumnProps) => {
  const tabbableId = focusedRowId ?? selectedIds[0] ?? rows[0]?.id

  return (
    <QueryState
      className="py-6"
      errorLabel="Couldn’t load these documents."
      loadingLabel="Loading documents…"
      query={query}
    >
      {() =>
        rows.length === 0 ? (
          <EmptyState className="mt-2">{emptyLabel}</EmptyState>
        ) : (
          <RowList label="Items" role="listbox" variant="finder">
            {rows.map((row) => {
              const family = familyForRow(row)
              return (
                <FinderRow
                  columnActive={columnActive}
                  icon={iconForFamily(family)}
                  iconTone={familyTone[family]}
                  id={row.id}
                  indexing={row.indexing}
                  key={row.id}
                  kind={row.kind}
                  onContextMenu={onContextMenu
                    ? (event) => onContextMenu(row, event)
                    : undefined}
                  onKeyDown={onRowKeyDown
                    ? (event) => onRowKeyDown(event, row.id)
                    : undefined}
                  onOpen={() => onOpen(row)}
                  onSelect={(event) => onSelect(row, event)}
                  selected={selectedIds.includes(row.id)}
                  subtitle={row.access === 'edit'
                    ? `${homeLine(row.home)} · You can edit`
                    : homeLine(row.home)}
                  tabIndex={tabbableId === row.id ? 0 : -1}
                  title={row.title}
                  variant="virtual"
                />
              )
            })}
            {hasMore ? (
              // A row rather than a button under the list: the cursor is
              // another page of the same column, and a control outside the
              // listbox would leave the keyboard's roving focus behind.
              <li>
                <button
                  className="finder-row flex w-full items-center justify-center gap-2 px-3 text-xs text-[color:var(--tx2)]"
                  disabled={loadingMore}
                  onClick={onLoadMore}
                  type="button"
                >
                  <FontAwesomeIcon className="h-3 w-3" icon={faChevronDown} />
                  {loadingMore ? 'Loading…' : 'Load more'}
                </button>
              </li>
            ) : null}
          </RowList>
        )
      }
    </QueryState>
  )
}

type VirtualQuery = {
  fetchNextPage: () => unknown
  hasNextPage?: boolean
  isError: boolean
  isFetchingNextPage: boolean
  isLoading: boolean
  refetch: () => unknown
}

type FinderVirtualHostProps = {
  columnKey: string
  dispatch: (event: FinderSelectionEvent) => void
  kind: 'latest' | 'shared-with-me'
  onOpen: (row: FinderVirtualRow) => void
  query: VirtualQuery
  rows: FinderVirtualRow[]
  selection: FinderSelection
}

const EMPTY_LABEL: Record<FinderVirtualHostProps['kind'], string> = {
  latest: 'Nothing here yet — documents you and your team edit show up here.',
  'shared-with-me': 'Nobody has shared a document with you yet.',
}

/** The virtual column's wiring: the paging, the selection and the empty line. */
export const FinderVirtualHost = ({
  columnKey,
  dispatch,
  kind,
  onOpen,
  query,
  rows,
  selection,
}: FinderVirtualHostProps) => (
  <FinderVirtualColumn
    columnActive={selection.columnKey === columnKey}
    emptyLabel={EMPTY_LABEL[kind]}
    hasMore={Boolean(query.hasNextPage)}
    loadingMore={query.isFetchingNextPage}
    onLoadMore={() => void query.fetchNextPage()}
    onOpen={onOpen}
    onSelect={(row) => dispatch({
      columnKey,
      id: row.id,
      modifier: 'none',
      order: rows.map((item) => item.id),
      type: 'click',
    })}
    query={{ isError: query.isError, isLoading: query.isLoading, refetch: query.refetch }}
    rows={rows}
    selectedIds={selection.columnKey === columnKey ? selection.ids : []}
  />
)
