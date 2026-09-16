import { Fragment, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { faLayerGroup } from '@fortawesome/free-solid-svg-icons'
import type {
  KnowledgePageRecord,
  KnowledgeSpaceRecord,
} from '../../../../facades/knowledge/hooks'
import type { RowDragHandlers } from '../../../shared/RowList'
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
import type { useFinderDrag } from './useFinderDrag'
import { useFinderKeyboard } from './useFinderKeyboard'

/**
 * One level of one root folder (browser-ui.md §11): the rows, the inline
 * "new folder" row, the upload placeholders and the column's own drop target.
 *
 * It renders rows and nothing else. The menu, the dialogs, the upload queue
 * and the cross-root drop prompt are Wave 2's, and reach it through the four
 * props below rather than through this file learning about them.
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

  // ── Declared for Wave 2, unconnected here ────────────────────────────────
  /** A row's context menu, anchored at the pointer. */
  onContextMenu?: (page: KnowledgePageRecord, event: MouseEvent<HTMLElement>) => void
  /** The column's background menu: New folder, New file, Paste. */
  onBackgroundContextMenu?: (event: MouseEvent<HTMLElement>) => void
  /** Placeholder rows for files being uploaded into this folder. */
  uploadEntries?: FinderUploadEntry[]
  /** The file-drop overlay's handlers, which share `dragover` with the rows. */
  dropHandlers?: RowDragHandlers
}

export const FinderFolderColumn = ({
  bodyDropActive = false,
  bodyDropHandlers,
  columnActive,
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
      className="finder-drop-body h-full"
      data-drop-target={bodyDropActive ? 'true' : undefined}
      onContextMenu={onBackgroundContextMenu}
      {...bodyDropHandlers}
    >
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
}

/**
 * One column's wiring, as a component rather than a helper, because the key
 * table is a hook and a column is rendered inside a `map`.
 */
export const FinderFolderHost = ({
  canWrite,
  columnActive,
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
            {siblingSpaces.map((space) => (
              <Fragment key={space.id}>
                <FinderRow
                  chevron
                  columnActive={false}
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
      onCancelFolder={onCancelFolder}
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
    />
  )
}
