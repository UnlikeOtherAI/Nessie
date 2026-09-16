import type { KeyboardEvent, MouseEvent } from 'react'
import { faChevronDown } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type {
  KnowledgeHome,
  KnowledgeIndexingState,
  KnowledgePageKind,
  KnowledgePageShareAccess,
} from '@nessie/schemas'
import { ActorName, useActorNames } from '../../../shared/ActorName'
import { EmptyState } from '../../../shared/EmptyState'
import { QueryState } from '../../../shared/QueryState'
import { RowList } from '../../../shared/RowList'
import { familyLabel, familyTone, iconForFamily } from '../../../shared/file-icons'
import { FinderRow } from './FinderRow'
import type {
  FinderBackgroundMenuProps,
  FinderRowMenuProps,
} from './FinderContextMenus'
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
  /** Shared with me only: who shared it, for the subtitle and the read-out. */
  sharedByUserId?: string
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
  /** Refresh: a computed listing has no other way to be asked again. */
  backgroundProps?: FinderBackgroundMenuProps
  /** `useFinderMenus().rowProps`, spread on each row. */
  rowProps?: (row: FinderVirtualRow) => FinderRowMenuProps
  query: { isError: boolean; isLoading: boolean; refetch: () => unknown }
  rows: FinderVirtualRow[]
  selectedIds: readonly string[]
}

export const FinderVirtualColumn = ({
  backgroundProps,
  columnActive,
  emptyLabel,
  focusedRowId,
  hasMore,
  loadingMore,
  onLoadMore,
  onOpen,
  onRowKeyDown,
  onSelect,
  query,
  rows,
  rowProps,
  selectedIds,
}: FinderVirtualColumnProps) => {
  const tabbableId = focusedRowId ?? selectedIds[0] ?? rows[0]?.id
  const resolveActor = useActorNames()

  return (
    <div className="h-full" {...backgroundProps}>
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
                  {...(rowProps ? rowProps(row) : {})}
                  columnActive={columnActive}
                  icon={iconForFamily(family)}
                  iconTone={familyTone[family]}
                  id={row.id}
                  indexing={row.indexing}
                  indexingFamilyLabel={familyLabel[family]}
                  key={row.id}
                  kind={row.kind}
                  onKeyDown={onRowKeyDown
                    ? (event) => onRowKeyDown(event, row.id)
                    : undefined}
                  onOpen={() => onOpen(row)}
                  onSelect={(event) => onSelect(row, event)}
                  selected={selectedIds.includes(row.id)}
                  subtitle={row.access && row.sharedByUserId
                    ? (
                      // "{Sharer} · Can edit · My Documents › Contracts": who
                      // gave it to you, what you may do, and where it lives —
                      // a virtual row with no home line is a name with no way
                      // back to the thing it names.
                      <span className="flex min-w-0 gap-1 truncate">
                        <ActorName actor={resolveActor('user', row.sharedByUserId)} />
                        {` · ${row.access === 'edit' ? 'Can edit' : 'Can view'} · ${homeLine(row.home)}`}
                      </span>
                    )
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
    </div>
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
  backgroundProps?: FinderBackgroundMenuProps
  columnKey: string
  dispatch: (event: FinderSelectionEvent) => void
  kind: 'latest' | 'shared-with-me'
  onOpen: (row: FinderVirtualRow) => void
  query: VirtualQuery
  rows: FinderVirtualRow[]
  rowProps?: (row: FinderVirtualRow) => FinderRowMenuProps
  selection: FinderSelection
}

const EMPTY_LABEL: Record<FinderVirtualHostProps['kind'], string> = {
  latest: 'Nothing here yet — documents you and your team edit show up here.',
  'shared-with-me': 'Nobody has shared a document with you yet.',
}

/** The virtual column's wiring: the paging, the selection and the empty line. */
export const FinderVirtualHost = ({
  backgroundProps,
  columnKey,
  dispatch,
  kind,
  onOpen,
  query,
  rows,
  rowProps,
  selection,
}: FinderVirtualHostProps) => (
  <FinderVirtualColumn
    backgroundProps={backgroundProps}
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
    rowProps={rowProps}
    rows={rows}
    selectedIds={selection.columnKey === columnKey ? selection.ids : []}
  />
)
