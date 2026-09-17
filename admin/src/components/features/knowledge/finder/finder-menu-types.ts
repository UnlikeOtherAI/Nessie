import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import type {
  KnowledgeAccessSummary,
  KnowledgeIndexingState,
} from '@nessie/schemas'
import type { KnowledgePageRecord } from '../../../../facades/knowledge/hooks'
import type { GetInfoTarget } from './GetInfoDialog'
import type { FinderRowRename } from './RenameRow'
import type { FinderMenuColumnRef, FinderMenuRowRef } from './finder-menu-target'

/**
 * The shapes `useFinderMenus` hands out and takes in.
 *
 * They live apart from the hook because they are a contract three other waves
 * compile against — the columns spread `FinderRowMenuProps` onto a row, the
 * browser mounts `FinderMenus`, and the transfer wave supplies the picker
 * through `FinderMoveToRequest` — and a contract is easier to read, and harder
 * to change by accident, when it is not buried in the wiring that satisfies it.
 */

/** Spread straight onto a `FinderRow`. Both props are ones no column computes. */
export type FinderRowMenuProps = {
  onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void
  rename?: FinderRowRename
}

export type FinderBackgroundMenuProps = {
  onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void
}

/** The whole hook, as a type a column can take as one prop. */
export type FinderMenus = {
  rowProps: (row: FinderMenuRowRef) => FinderRowMenuProps
  backgroundProps: (column: FinderMenuColumnRef) => FinderBackgroundMenuProps
  dialogs: ReactNode
}

/**
 * Everything the host contributes. All of it is optional, and an item whose
 * doorway is missing is **absent from the menu** rather than inert — so a host
 * that mounts the hook bare still gets a correct menu, just a shorter one.
 */
export type UseFinderMenusOptions = {
  /** The rows selected in the active column; a menu on one of them acts on all. */
  selectedIds?: readonly string[]
  /** Starts the inline "new folder" row in a folder the browser owns. */
  onNewFolderIn?: (parentPageId: string | null) => void
  /** Opens the hidden file input for this folder; the input lives with the host. */
  onUploadFiles?: (parentPageId: string | null) => void
  /** The root column's "New shared folder…" — a dialog, because visibility. */
  onCreateRootFolder?: () => void
  /** Asks a virtual column's query again; it has no other way to be refreshed. */
  onRefresh?: () => void
  /**
   * Opens "New spreadsheet" for a folder. Absent where the host has not
   * mounted the spreadsheet dialogs, and the registry then offers no
   * spreadsheet row — never an inert one.
   */
  onCreateSpreadsheet?: (parentPageId: string | null) => void
  /** Opens "Import spreadsheet…" for a folder; absent under the same rule. */
  onImportSpreadsheet?: (parentPageId: string | null) => void
  /** Builds a spreadsheet page from an uploaded `.xlsx`/`.csv`/`.tsv` file node. */
  onConvertToSpreadsheet?: (page: KnowledgePageRecord) => void
  /**
   * The destination picker "Move to…" opens — 2D's `MoveToDialog`, injected
   * rather than imported so the menu owns *when* it opens and the transfer
   * wave owns what it does. Without it the item is absent, never inert.
   */
  renderMoveTo?: (request: FinderMoveToRequest) => ReactNode
}

/** What the menu knows about a move when it hands it to the picker. */
export type FinderMoveToRequest = {
  currentParentPageId: string | null
  onClose: () => void
  open: true
  pages: KnowledgePageRecord[]
  sourceSpaceId: string
}

export type FinderDialogState =
  | {
      kind: 'info'
      target: GetInfoTarget
      pageId?: string
      spaceId?: string
      indexing?: KnowledgeIndexingState
    }
  | {
      kind: 'share'
      pageId: string
      spaceId?: string
      title: string
      subjectKind: 'folder' | 'document' | 'file' | 'spreadsheet'
    }
  | {
      kind: 'readout'
      access: KnowledgeAccessSummary
      projectName?: string | null
      spaceId?: string
      pageId?: string
    }
  | { kind: 'delete'; pages: KnowledgePageRecord[] }
  | { kind: 'move'; pages: KnowledgePageRecord[] }
  | null
