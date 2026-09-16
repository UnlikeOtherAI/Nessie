import {
  faArrowRightArrowLeft,
  faArrowsRotate,
  faCircleInfo,
  faClockRotateLeft,
  faCloudArrowUp,
  faDownload,
  faFileArrowUp,
  faFileLines,
  faFolderOpen,
  faFolderPlus,
  faLink,
  faLocationCrosshairs,
  faPenToSquare,
  faRotate,
  faTable,
  faTrash,
  faUpRightFromSquare,
  faUserGroup,
  faUserMinus,
} from '@fortawesome/free-solid-svg-icons'
import type {
  KnowledgeAccessSummary,
  KnowledgeIndexingState,
  KnowledgePageShareAccess,
} from '@nessie/schemas'
import { LEGACY_XLS_REASON, spreadsheetSourceFor } from '../../../shared/file-icons'
import type { ContextMenuItem } from '../../../overlays/ContextMenu'
import { newFileTypeItems, type NewFileTypeContext } from './new-file-types'

/**
 * What a right-click offers, as data (menus-and-dialogs.md §2).
 *
 * A pure function of the row, the column it is in and what the viewer may do,
 * so every row of §2's tables is a unit test rather than a screenshot. The
 * hook that mounts it ({@link useFinderMenus}) owns the anchoring, the focus
 * and the dialogs; nothing about enablement or ordering lives there.
 *
 * Two rules the tables encode and this file enforces:
 *
 * 1. **"Sharing…" is one word everywhere, and what it opens is not.** The
 *    label never changes, so nobody hunts for a "Share" that is not there;
 *    {@link sharingSurfaceFor} decides whether the click lands on a surface
 *    that grants or one that reads out, and that decision is made from the
 *    item's access mode alone.
 * 2. **An item the server will refuse is not offered.** Where it has to be
 *    visible (the menu would otherwise be one item long), it is disabled with
 *    a reason on `title`, which is the design-system's cure for a grey
 *    control nobody can explain.
 */

export type FinderMenuKind = 'folder' | 'document' | 'file' | 'spreadsheet'

/** The facts a row contributes; everything else comes from the column. */
export type FinderMenuPage = {
  id: string
  title: string
  kind: FinderMenuKind
  status: 'draft' | 'published' | 'archived' | (string & {})
  indexing?: KnowledgeIndexingState
  /** A task folder names its ticket. */
  taskId?: string | null
  /** Shared with me only: the level the viewer holds over somebody else's page. */
  access?: KnowledgePageShareAccess
}

/** A row of the root column; the variants differ in what they can be asked. */
export type FinderMenuRootRow =
  | { role: 'personal' }
  | { role: 'project'; projectId: string | null }
  | { role: 'shared'; canWrite: boolean; canManageAccess: boolean }
  | { role: 'agent'; agentId: string; canManageAccess: boolean }
  | { role: 'link' }

export type FinderMenuTarget =
  /** A page row in a folder column, or in Latest / Shared with me. */
  | { kind: 'page'; page: FinderMenuPage; virtual: boolean }
  /** Two or more rows selected together. */
  | { kind: 'selection'; pages: FinderMenuPage[] }
  | { kind: 'root-row'; row: FinderMenuRootRow }
  /** The empty background of a column. */
  | { kind: 'background'; column: 'root' | 'virtual' | 'folder' }

/**
 * What the viewer may do here. `canShare` is deliberately separate from
 * `canWrite`: writing is about the folder, sharing is about who owns it.
 */
export type FinderMenuCapabilities = {
  canWrite: boolean
  canManageAccess: boolean
  /** The access mode of the item — what "Sharing…" will open. */
  accessMode: KnowledgeAccessSummary['mode'] | 'unknown'
  /** The viewer may actually grant: their own personal documents. */
  canShare: boolean
  /** Only a person publishes. An agent's draft goes through the approval. */
  actorIsPerson: boolean
}

/** Everything a menu item can do. The hook binds each to the current target. */
export type FinderMenuHandlers = {
  open: () => void
  openEditor: () => void
  getInfo: () => void
  sharing: () => void
  versionHistory: () => void
  publish: () => void
  rename: () => void
  moveTo?: () => void
  copyLink: () => void
  remove: () => void
  download: () => void
  uploadVersion: () => void
  newFolderInside: () => void
  newDocumentInside: () => void
  /**
   * "Open as spreadsheet" on an uploaded `.xlsx`/`.csv`/`.tsv` file node: a
   * new spreadsheet page beside it, the file itself untouched. Absent where
   * the host has not mounted the conversion.
   */
  openAsSpreadsheet?: () => void
  uploadFiles?: () => void
  showInFolder: () => void
  removeShare: () => void
  retryIndexing: () => void
  refresh: () => void
  openTicket: () => void
  openProject: () => void
  openAgent: () => void
  newSharedFolder?: () => void
  spaceSettings: () => void
  newFolder?: () => void
  newDocument: () => void
  /**
   * The background menu's own "New …" rows, from `new-file-types.ts`. The
   * column supplies the folder they land in; the registry decides what the
   * answers are, so a kind added there appears here and in the toolbar at
   * once.
   */
  newFileTypeContext?: NewFileTypeContext
}

export type FinderMenuInput = {
  target: FinderMenuTarget
  capabilities: FinderMenuCapabilities
  handlers: FinderMenuHandlers
}

/**
 * Whether "Sharing…" opens a surface that grants access or one that reads it
 * out. **This is the branch the owner asked for**, and it is deliberately one
 * expression: a personal document is the only thing a person hands to another
 * person, and everywhere else access follows the container's membership, so
 * the dialog reports rather than offers.
 *
 * `unknown` reads out. A surface that is not yet sure what it is looking at
 * must not show a grant control it may have to take away.
 */
export const sharingSurfaceFor = (
  accessMode: FinderMenuCapabilities['accessMode'],
  canShare: boolean,
): 'grant' | 'readout' => (accessMode === 'personal' && canShare ? 'grant' : 'readout')

const SEPARATOR: ContextMenuItem = { kind: 'separator' }

const item = (
  id: string,
  label: string,
  onSelect: () => void,
  extra: Partial<Extract<ContextMenuItem, { kind: 'item' }>> = {},
): ContextMenuItem => ({ id, kind: 'item', label, onSelect, ...extra })

/** Drops the separators a removed group left behind, at both ends and doubled. */
const tidy = (items: ContextMenuItem[]): ContextMenuItem[] => {
  const out: ContextMenuItem[] = []
  for (const next of items) {
    if (next.kind === 'separator') {
      if (out.length === 0) continue
      if (out[out.length - 1]?.kind === 'separator') continue
    }
    out.push(next)
  }
  while (out[out.length - 1]?.kind === 'separator') out.pop()
  return out
}

const RETRYABLE = (indexing: KnowledgeIndexingState | undefined): boolean =>
  indexing?.state === 'failed'

/** The accessible name of the panel — "Actions for Lease.pdf". */
export const finderMenuLabel = (target: FinderMenuTarget): string => {
  switch (target.kind) {
    case 'page':
      return `Actions for ${target.page.title}`
    case 'selection':
      return `Actions for ${target.pages.length} items`
    case 'root-row':
      return 'Actions for this folder'
    case 'background':
      return target.column === 'root' ? 'Actions for Documents' : 'Actions for this folder'
  }
}

// ── A page row ──────────────────────────────────────────────────────────────

const pageItems = (
  page: FinderMenuPage,
  virtual: boolean,
  caps: FinderMenuCapabilities,
  on: FinderMenuHandlers,
): ContextMenuItem[] => {
  // A row reached through somebody else's share: `access` is what the server
  // will actually allow, and it outranks the column's `canWrite`.
  const grantee = page.access !== undefined
  const mayEdit = grantee ? page.access === 'edit' : caps.canWrite
  // The tree and the audience stay the owner's, whatever the level.
  const mayOwn = !grantee && caps.canWrite
  const folder = page.kind === 'folder'
  const file = page.kind === 'file'
  const sheet = page.kind === 'spreadsheet'
  // A file node whose bytes could become a workbook — and the one extension
  // that looks like it could and cannot.
  const source = file ? spreadsheetSourceFor(page.title) : 'no'

  return tidy([
    item('open', 'Open', on.open, {
      icon: folder ? faFolderOpen : sheet ? faTable : faFileLines,
    }),
    ...(file ? [item('download', 'Download', on.download, {
      icon: faDownload,
      shortcut: 'Mod+Shift+S',
    })] : []),
    // Building a workbook from an upload is additive — the file node stays,
    // so a person who wanted the bytes can still download exactly what they
    // uploaded — which is why it sits beside Download rather than replacing
    // it.
    ...(source !== 'no' && mayEdit && on.openAsSpreadsheet
      ? [item('open-as-spreadsheet', 'Open as spreadsheet', on.openAsSpreadsheet, {
        disabled: source === 'legacy-xls',
        // `disabledReason` is what the panel puts on `title`, so a keyboard
        // user hears why the row is grey instead of finding it merely dead.
        disabledReason: source === 'legacy-xls' ? LEGACY_XLS_REASON : undefined,
        icon: faTable,
      })]
      : []),
    // On a virtual row the second item is the way back to where the row
    // actually lives; in a folder column it is the way into the editor.
    ...(virtual
      ? [item('show-in-folder', 'Show in folder', on.showInFolder, {
        icon: faLocationCrosshairs,
      })]
      : page.kind === 'document' && mayEdit
        ? [item('edit', 'Edit', on.openEditor, { icon: faPenToSquare })]
        // A spreadsheet has no second "Edit": opening it *is* opening the
        // editor, and a row offering both would promise two different screens.
        : []),
    SEPARATOR,
    item('get-info', 'Get Info', on.getInfo, { icon: faCircleInfo, shortcut: 'Mod+I' }),
    ...(folder && page.taskId
      ? [item('open-ticket', 'Open ticket', on.openTicket, { icon: faUpRightFromSquare })]
      : []),
    item('sharing', 'Sharing…', on.sharing, { icon: faUserGroup }),
    ...(folder ? [] : [item('history', 'Version history', on.versionHistory, {
      icon: faClockRotateLeft,
    })]),
    ...(file && mayEdit
      ? [item('upload-version', 'Upload new version…', on.uploadVersion, {
        icon: faFileArrowUp,
      })]
      : []),
    ...(RETRYABLE(page.indexing) && mayEdit
      ? [item('retry-indexing', 'Retry indexing', on.retryIndexing, { icon: faRotate })]
      : []),
    SEPARATOR,
    // Publishing is the owner's act. An agent actor never sees it: its draft
    // goes to the approval queue, which is a different mechanism entirely.
    ...(page.kind === 'document' && mayOwn && page.status === 'draft' && caps.actorIsPerson
      ? [item('publish', 'Publish', on.publish, { icon: faUpRightFromSquare })]
      : []),
    // New folder inside needs a position in a folder, which a virtual row
    // (standing somewhere else) does not have.
    ...(folder && !virtual && mayEdit
      ? [item('new-folder-inside', 'New folder inside', on.newFolderInside, {
        icon: faFolderPlus,
      })]
      : []),
    ...(mayEdit ? [item('rename', 'Rename', on.rename, {
      icon: faPenToSquare,
      shortcut: 'F2',
    })] : []),
    // Every item below is gated on its own handler as well as on permission:
    // where the host has not mounted the surface an item opens, the item is
    // absent rather than inert. A menu row that does nothing is worse than one
    // that is not there.
    ...(mayOwn && on.moveTo
      ? [item('move-to', 'Move to…', on.moveTo, { icon: faArrowRightArrowLeft })]
      : []),
    SEPARATOR,
    item('copy-link', 'Copy link', on.copyLink, { icon: faLink }),
    SEPARATOR,
    ...(grantee
      ? [item('remove-share', 'Remove from Shared with me', on.removeShare, {
        destructive: true,
        icon: faUserMinus,
      })]
      : mayOwn
        ? [item('delete', 'Delete…', on.remove, { destructive: true, icon: faTrash })]
        : []),
  ])
}

// ── Two or more rows ────────────────────────────────────────────────────────

const selectionItems = (
  pages: FinderMenuPage[],
  caps: FinderMenuCapabilities,
  on: FinderMenuHandlers,
): ContextMenuItem[] => {
  const files = pages.filter((page) => page.kind === 'file')
  const owned = pages.every((page) => page.access === undefined)
  return tidy([
    item('get-info', 'Get Info', on.getInfo, { icon: faCircleInfo, shortcut: 'Mod+I' }),
    // The design's words, not a count: the confirm and the toast carry the
    // number, and a menu item that changes width with the selection is noise.
    ...(files.length > 0
      ? [item('download', 'Download', on.download, { icon: faDownload })]
      : []),
    ...(caps.canWrite && on.moveTo && owned
      ? [item('move-to', 'Move to…', on.moveTo, { icon: faArrowRightArrowLeft })]
      : []),
    SEPARATOR,
    ...(caps.canWrite && owned
      ? [item('delete', 'Delete…', on.remove, { destructive: true, icon: faTrash })]
      : []),
  ])
}

// ── A root row ──────────────────────────────────────────────────────────────

const rootRowItems = (
  row: FinderMenuRootRow,
  on: FinderMenuHandlers,
): ContextMenuItem[] => {
  if (row.role === 'link') return [item('open', 'Open', on.open, { icon: faFolderOpen })]
  const info = item('get-info', 'Get Info', on.getInfo, {
    icon: faCircleInfo,
    shortcut: 'Mod+I',
  })
  if (row.role === 'personal' || row.role === 'project') {
    return tidy([
      item('open', 'Open', on.open, { icon: faFolderOpen }),
      ...(row.role === 'project'
        ? [item('open-project', 'Open project', on.openProject, { icon: faUpRightFromSquare })]
        : []),
      SEPARATOR,
      info,
      item('sharing', 'Sharing…', on.sharing, { icon: faUserGroup }),
    ])
  }
  if (row.role === 'agent') {
    return tidy([
      item('open', 'Open', on.open, { icon: faFolderOpen }),
      item('open-agent', 'Open agent', on.openAgent, { icon: faUpRightFromSquare }),
      SEPARATOR,
      info,
      item('sharing', 'Sharing…', on.sharing, { icon: faUserGroup }),
    ])
  }
  return tidy([
    item('open', 'Open', on.open, { icon: faFolderOpen }),
    SEPARATOR,
    info,
    ...(row.canManageAccess || row.canWrite
      ? [item('space-settings', 'Sharing & settings…', on.spaceSettings, { icon: faUserGroup })]
      : [item('sharing', 'Sharing…', on.sharing, { icon: faUserGroup })]),
    ...(row.canWrite ? [item('rename', 'Rename', on.rename, {
      icon: faPenToSquare,
      shortcut: 'F2',
    })] : []),
    SEPARATOR,
    ...(row.canWrite
      ? [item('delete', 'Delete…', on.remove, { destructive: true, icon: faTrash })]
      : []),
  ])
}

// ── The empty background ────────────────────────────────────────────────────

const backgroundItems = (
  column: 'root' | 'virtual' | 'folder',
  caps: FinderMenuCapabilities,
  on: FinderMenuHandlers,
): ContextMenuItem[] => {
  if (column === 'root') {
    return tidy([
      ...(on.newSharedFolder
        ? [item('new-shared-folder', 'New shared folder…', on.newSharedFolder, {
          icon: faFolderPlus,
        })]
        : []),
      SEPARATOR,
      item('refresh', 'Refresh', on.refresh, { icon: faArrowsRotate }),
    ])
  }
  // A virtual folder has no other way to ask again: its rows are a listing the
  // server computed, not a folder anybody writes into.
  if (column === 'virtual') {
    return [item('refresh', 'Refresh', on.refresh, { icon: faArrowsRotate })]
  }
  // "New document", "Upload files…" and every kind a later integrator adds
  // come from `new-file-types.ts` — the same array the toolbar's New menu
  // reads. Until the context is mounted the column keeps its own two rows, so
  // a host that has not wired the registry still gets a working menu.
  const newRows: ContextMenuItem[] = on.newFileTypeContext
    ? newFileTypeItems(on.newFileTypeContext, 'in-folder').map((row) =>
      item(row.id, row.label, row.onSelect, { icon: row.icon }))
    : [
      item('new-document', 'New document', on.newDocument, { icon: faFileLines }),
      ...(on.uploadFiles
        ? [item('upload-files', 'Upload files…', on.uploadFiles, { icon: faCloudArrowUp })]
        : []),
    ]
  return tidy([
    ...(caps.canWrite
      ? [
        ...(on.newFolder
          ? [item('new-folder', 'New folder', on.newFolder, {
            icon: faFolderPlus,
            shortcut: 'Mod+Shift+N',
          })]
          : []),
        ...newRows,
        SEPARATOR,
      ]
      : []),
    item('get-info', 'Get Info', on.getInfo, { icon: faCircleInfo, shortcut: 'Mod+I' }),
    item('sharing', 'Sharing…', on.sharing, { icon: faUserGroup }),
  ])
}

export const buildFinderMenu = ({
  capabilities,
  handlers,
  target,
}: FinderMenuInput): ContextMenuItem[] => {
  switch (target.kind) {
    case 'page':
      return pageItems(target.page, target.virtual, capabilities, handlers)
    case 'selection':
      return selectionItems(target.pages, capabilities, handlers)
    case 'root-row':
      return rootRowItems(target.row, handlers)
    case 'background':
      return backgroundItems(target.column, capabilities, handlers)
  }
}
