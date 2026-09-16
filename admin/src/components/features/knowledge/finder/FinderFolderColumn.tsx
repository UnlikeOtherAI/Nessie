import {
  Fragment,
  useCallback,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react'
import { faLayerGroup } from '@fortawesome/free-solid-svg-icons'
import type {
  KnowledgePageRecord,
  KnowledgeSpaceRecord,
} from '../../../../facades/knowledge/hooks'
import type { RowDragHandlers } from '../../../shared/RowList'
import { useFileDrop, type FileDrop } from '../../../../hooks/useFileDrop'
import { DropZoneOverlay } from '../../../shared/DropZoneOverlay'
import { EmptyState } from '../../../shared/EmptyState'
import { RowList } from '../../../shared/RowList'
import { familyForFilename, familyTone, iconForFamily } from '../../../shared/file-icons'
import { AgentDraftBadge } from '../AgentDraftBadge'
import { isAgentDraft } from '../page-status'
import { FinderRow, type FinderRowUpload } from './FinderRow'
import { familyForRow } from './finder-sort'
import {
  clickModifier,
  type FinderSelection,
  type FinderSelectionEvent,
} from './finder-selection'
import { NewFolderRow } from './NewFolderRow'
import { dragCarriesFiles, type useFinderDrag } from './useFinderDrag'
import { useFinderKeyboard } from './useFinderKeyboard'
import type { FinderMenus } from './useFinderMenus'
import type { UploadQueue, UploadTarget } from './useUploadQueue'

/**
 * One level of one root folder (browser-ui.md §11): the rows, the inline
 * "new folder" row, the upload placeholders and the column's own drop target.
 *
 * It renders rows and nothing else. The menu, the dialogs and the upload queue
 * reach it through props rather than through this file learning about them.
 */

export type FinderUploadEntry = {
  id: string
  title: string
  upload: FinderRowUpload
}

export type FinderFolderColumnProps = {
  /** Rows to draw, already sorted and filtered by the browser. */
  rows: KnowledgePageRecord[]
  /** The row this column contributes to the open path, painted grey when away. */
  pathSelectionId?: string
  selectedIds: readonly string[]
  columnActive: boolean
  focusedRowId?: string
  emptyLabel: string
  /** Rows to draw above the page rows — a project tab's other root folders. */
  leadingRows?: ReactNode
  creatingFolder?: boolean
  createFolderPending?: boolean
  onCancelFolder?: () => void
  onSubmitFolder?: (name: string) => void
  onOpen: (page: KnowledgePageRecord) => void
  onSelect: (page: KnowledgePageRecord, event: MouseEvent<HTMLElement>) => void
  onRowKeyDown?: (event: KeyboardEvent<HTMLElement>, id: string) => void
  /** Drag: `undefined` where this column is not a drag source (a phone). */
  dragStartFor?: (id: string) => RowDragHandlers['onDragStart']
  onDragEnd?: () => void
  dropHandlersForRow?: (page: KnowledgePageRecord) => RowDragHandlers
  draggingIds?: readonly string[]
  dropTargetId?: string | null
  /** The column's own empty body as a drop target — "the root of this folder". */
  bodyDropHandlers?: RowDragHandlers
  bodyDropActive?: boolean

  // ── Wired in Wave 2 ──────────────────────────────────────────────────────
  /** A row's context menu, anchored at the pointer. */
  onContextMenu?: (page: KnowledgePageRecord, event: MouseEvent<HTMLElement>) => void
  /** The column's background menu: New folder, New file, Paste. */
  onBackgroundContextMenu?: (event: MouseEvent<HTMLElement>) => void
  /** Placeholder rows for files being uploaded into this folder. */
  uploadEntries?: FinderUploadEntry[]
  /**
   * The file-drop overlay's handlers, which share `dragover` with the rows:
   * they are told apart by `dataTransfer.types` carrying `'Files'`.
   */
  dropHandlers?: RowDragHandlers
  /** Drawn while a file is over this column. */
  fileDropActive?: boolean
  /** How many files the pointer is carrying, once the column can see them. */
  fileDropCount?: number
  /** The folder the drop would land in — this column's, or a folder row's. */
  fileDropDestination?: string | null
}

export const FinderFolderColumn = ({
  bodyDropActive = false,
  bodyDropHandlers,
  columnActive,
  dropHandlers,
  fileDropActive = false,
  fileDropCount,
  fileDropDestination,
  createFolderPending = false,
  creatingFolder = false,
  dragStartFor,
  draggingIds,
  dropHandlersForRow,
  dropTargetId,
  emptyLabel,
  focusedRowId,
  leadingRows,
  onBackgroundContextMenu,
  onCancelFolder,
  onContextMenu,
  onDragEnd,
  onOpen,
  onRowKeyDown,
  onSelect,
  onSubmitFolder,
  pathSelectionId,
  rows,
  selectedIds,
  uploadEntries,
}: FinderFolderColumnProps) => {
  const empty = rows.length === 0 && !creatingFolder && (uploadEntries?.length ?? 0) === 0
  const firstId = rows[0]?.id
  const tabbableId = focusedRowId
    ?? (columnActive ? selectedIds[0] : undefined)
    ?? pathSelectionId
    ?? firstId

  return (
    <div
      className="finder-drop-body relative h-full"
      data-drop-target={bodyDropActive ? 'true' : undefined}
      onContextMenu={onBackgroundContextMenu}
      {...bodyDropHandlers}
      {...dropHandlers}
    >
      <DropZoneOverlay
        active={fileDropActive}
        count={fileDropCount}
        destination={fileDropDestination}
      />
      {leadingRows}
      {creatingFolder && onSubmitFolder && onCancelFolder ? (
        <NewFolderRow
          onCancel={onCancelFolder}
          onSubmit={onSubmitFolder}
          pending={createFolderPending}
        />
      ) : null}
      {empty ? (
        <EmptyState className="mt-2">{emptyLabel}</EmptyState>
      ) : (
        <RowList label="Items" role="listbox" variant="finder">
          {rows.map((page) => {
            const family = familyForRow(page)
            const folder = page.kind === 'folder'
            const selected = columnActive
              ? selectedIds.includes(page.id)
              : pathSelectionId === page.id
            return (
              <FinderRow
                ariaLabel={folder ? `Open folder ${page.title}` : undefined}
                chevron={folder}
                columnActive={columnActive}
                dragHandlers={{
                  ...(dropHandlersForRow && folder ? dropHandlersForRow(page) : {}),
                  onDragEnd,
                  onDragStart: dragStartFor?.(page.id),
                }}
                draggable={Boolean(dragStartFor)}
                dragging={draggingIds?.includes(page.id)}
                dropTarget={dropTargetId === page.id}
                icon={iconForFamily(family)}
                iconTone={familyTone[family]}
                id={page.id}
                indexing={page.indexing}
                key={page.id}
                kind={page.kind}
                onContextMenu={onContextMenu
                  ? (event) => onContextMenu(page, event)
                  : undefined}
                onOpen={() => onOpen(page)}
                onSelect={(event) => onSelect(page, event)}
                selected={selected}
                shareCount={page.shareCount}
                tabIndex={tabbableId === page.id ? 0 : -1}
                onKeyDown={onRowKeyDown
                  ? (event) => onRowKeyDown(event, page.id)
                  : undefined}
                title={page.title}
                trailing={isAgentDraft(page) ? <AgentDraftBadge /> : undefined}
                transfer={page.transfer ? page.transfer.operation : null}
                variant="item"
              />
            )
          })}
          {/* A file on its way up is a row in the folder it is going into, so
              the column does not jump when it lands. */}
          {(uploadEntries ?? []).map((entry) => (
            <FinderRow
              columnActive={columnActive}
              disabled
              icon={iconForFamily(familyForFilename(entry.title))}
              iconTone={familyTone[familyForFilename(entry.title)]}
              id={entry.id}
              key={entry.id}
              tabIndex={-1}
              title={entry.title}
              upload={entry.upload}
              variant="upload"
            />
          ))}
        </RowList>
      )}
    </div>
  )
}

/** One level of one root folder: which folder, how deep, and what to call it. */
export type FinderFolderLevel = {
  key: string
  title: string
  parentPageId: string | null
  depth: number
}

type FinderFolderHostProps = {
  canWrite: boolean
  /** 2A's row and background menus, already built for this Finder. */
  menus?: FinderMenus
  columnActive: boolean
  createFolderPending: boolean
  creatingFolder: boolean
  dispatch: (event: FinderSelectionEvent) => void
  drag: ReturnType<typeof useFinderDrag>
  level: FinderFolderLevel
  onBack?: () => void
  onCancelFolder: () => void
  onCreateFolder: () => void
  onOpen: (page: KnowledgePageRecord) => void
  onOpenSiblingSpace: (spaceId: string) => void
  onSubmitFolder: (name: string) => void
  pageById: (pageId: string) => KnowledgePageRecord | undefined
  pathSelectionId?: string
  rows: KnowledgePageRecord[]
  selection: FinderSelection
  /** Project scope only: the project's other root folders, above its own rows. */
  siblingSpaces: KnowledgeSpaceRecord[]
  spaceId: string
  /** The Finder's one upload queue: where a drop on this column goes. */
  uploads?: UploadQueue
  /** What a column that cannot take files says instead of taking them. */
  onUploadRefused?: (message: string) => void
}

/**
 * One column's wiring, as a component rather than a helper, because the key
 * table is a hook and a column is rendered inside a `map`.
 */
export const FinderFolderHost = ({
  canWrite,
  columnActive,
  menus,
  onUploadRefused,
  uploads,
  createFolderPending,
  creatingFolder,
  dispatch,
  drag,
  level,
  onBack,
  onCancelFolder,
  onCreateFolder,
  onOpen,
  onOpenSiblingSpace,
  onSubmitFolder,
  pageById,
  pathSelectionId,
  rows,
  selection,
  siblingSpaces,
  spaceId,
}: FinderFolderHostProps) => {
  const order = rows.map((page) => page.id)
  const fileDrop = useColumnFileDrop({
    canWrite,
    columnTitle: level.title,
    enqueue: uploads?.enqueue,
    onRefused: onUploadRefused,
    target: { parentPageId: level.parentPageId, spaceId },
    titleOf: (pageId) => pageById(pageId)?.title,
  })
  const selectedIds = selection.columnKey === level.key ? selection.ids : []
  const onRowKeyDown = useFinderKeyboard({
    columnKey: level.key,
    dispatch,
    isFolder: (id) => pageById(id)?.kind === 'folder',
    onBack,
    onNewFolder: canWrite ? onCreateFolder : undefined,
    onOpen: (id) => {
      const page = pageById(id)
      if (page) onOpen(page)
    },
    order,
    selectedIds,
    titleOf: (id) => pageById(id)?.title ?? '',
  })

  return (
    <FinderFolderColumn
      {...fileDrop.columnProps}
      bodyDropActive={drag.dropTargetKey === level.key}
      bodyDropHandlers={drag.dropHandlersFor(level.key, {
        kind: 'body',
        parentPageId: level.parentPageId,
        spaceId,
      })}
      columnActive={columnActive}
      createFolderPending={createFolderPending}
      creatingFolder={creatingFolder && canWrite}
      dragStartFor={canWrite ? (id) => drag.dragStart(id) : undefined}
      draggingIds={drag.draggingIds}
      dropHandlersForRow={(page) => drag.dropHandlersFor(page.id, {
        kind: 'folder',
        parentPageId: page.id,
        spaceId,
      })}
      dropTargetId={drag.dropTargetKey}
      emptyLabel={canWrite
        ? 'Nothing here yet — use New file, or drop a file to upload.'
        : 'Nothing here yet.'}
      leadingRows={siblingSpaces.length > 0
        ? (
          <RowList label="Other folders in this project" role="listbox" variant="finder">
            {/* A sibling root folder is one of the only two places a *different*
                root can be dropped on, so it is a cross-root transfer target
                (transfer.md §1); the other is the root column. */}
            {siblingSpaces.map((space) => (
              <Fragment key={space.id}>
                <FinderRow
                  chevron
                  columnActive={false}
                  dragHandlers={drag.dropHandlersFor(space.id, {
                    kind: 'folder',
                    parentPageId: null,
                    spaceId: space.id,
                  })}
                  dropTarget={drag.dropTargetKey === space.id}
                  icon={faLayerGroup}
                  iconTone="--accent"
                  id={space.id}
                  kind="space"
                  onOpen={() => onOpenSiblingSpace(space.id)}
                  tabIndex={-1}
                  title={space.name}
                  variant="root"
                />
              </Fragment>
            ))}
            <li aria-hidden="true" className="finder-separator" role="separator" />
          </RowList>
        )
        : undefined}
      onBackgroundContextMenu={menus?.backgroundProps({
        parentPageId: level.parentPageId,
        spaceId,
      }).onContextMenu}
      onCancelFolder={onCancelFolder}
      onContextMenu={menus
        ? (page, event) => menus.rowProps(page).onContextMenu?.(event)
        : undefined}
      onDragEnd={drag.dragEnd}
      onOpen={onOpen}
      onRowKeyDown={onRowKeyDown}
      onSelect={(page, event) => dispatch({
        columnKey: level.key,
        id: page.id,
        modifier: clickModifier(event),
        order,
        type: 'click',
      })}
      onSubmitFolder={onSubmitFolder}
      pathSelectionId={pathSelectionId}
      rows={rows}
      selectedIds={selectedIds}
      uploadEntries={uploads?.placeholdersFor(level.parentPageId)}
    />
  )
}

/**
 * The column's file drop (uploads-and-indexing.md §1).
 *
 * **Where it lands**: the folder row under the pointer if there is one, the
 * column's own folder otherwise — found through `data-finder-folder`, which
 * `FinderRow` already writes, not by learning the row's geometry.
 *
 * **A read-only column** still swallows the event and sets
 * `dropEffect = 'none'`: refusing by doing nothing would let the browser take
 * the drop and navigate away from the app to the dropped file.
 */
const folderRowIdAt = (event: DragEvent<HTMLElement>): string | null => {
  const target = event.target as HTMLElement | null
  const row = target?.closest?.('[data-finder-row][data-finder-folder="true"]')
  return row?.getAttribute('data-finder-row') ?? null
}

export const READ_ONLY_DROP_COPY = "You can't add files here"

const useColumnFileDrop = ({
  canWrite,
  columnTitle,
  enqueue,
  onRefused,
  target,
  titleOf,
}: {
  canWrite: boolean
  columnTitle: string
  enqueue: ((drop: FileDrop, target: UploadTarget) => void) | undefined
  onRefused?: (message: string) => void
  target: UploadTarget
  titleOf: (pageId: string) => string | undefined
}) => {
  // The folder row under the pointer, held in a ref as well as state: the
  // entry walk is asynchronous and reads it after the drop handler returned.
  const [hovered, setHovered] = useState<string | null>(null)
  const hoveredRef = useRef<string | null>(null)
  const targetRef = useRef(target)
  targetRef.current = target

  const onDropFiles = useCallback((drop: FileDrop) => {
    const parentPageId = hoveredRef.current ?? targetRef.current.parentPageId
    enqueue?.(drop, { parentPageId, spaceId: targetRef.current.spaceId })
    hoveredRef.current = null
    setHovered(null)
  }, [enqueue])

  const drop = useFileDrop(() => undefined, !canWrite || !enqueue, { onDrop: onDropFiles })

  const track = useCallback((event: DragEvent<HTMLElement>) => {
    if (!dragCarriesFiles(event)) return
    const id = folderRowIdAt(event)
    if (id !== hoveredRef.current) {
      hoveredRef.current = id
      setHovered(id)
    }
  }, [])

  const refuse = useCallback((event: DragEvent<HTMLElement>) => {
    if (!dragCarriesFiles(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'none'
  }, [])

  const columnProps = canWrite && enqueue
    ? {
      dropHandlers: {
        ...drop.dropHandlers,
        onDragLeave: () => {
          drop.dropHandlers.onDragLeave()
          hoveredRef.current = null
          setHovered(null)
        },
        onDragOver: (event: DragEvent<HTMLElement>) => {
          drop.dropHandlers.onDragOver(event)
          track(event)
        },
      },
      fileDropActive: drop.isDragging,
      fileDropCount: drop.draggingCount,
      fileDropDestination: (hovered ? titleOf(hovered) : undefined) ?? columnTitle,
    }
    : {
      dropHandlers: {
        onDragOver: refuse,
        onDrop: (event: DragEvent<HTMLElement>) => {
          if (!dragCarriesFiles(event)) return
          event.preventDefault()
          onRefused?.(READ_ONLY_DROP_COPY)
        },
      },
      fileDropActive: false,
    }

  return { columnProps }
}
