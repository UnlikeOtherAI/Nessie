import {
  faCloudArrowUp,
  faFileImport,
  faFileLines,
  faTable,
  type IconDefinition,
} from '@fortawesome/free-solid-svg-icons'

/**
 * "What are you making?" — the one question the Finder's New control asks, and
 * the registry that answers it (menus-and-dialogs.md §6).
 *
 * It is a registry rather than a hard-coded pair because the answer set is
 * open: the owner asked for "is it a document, is it a spreadsheet, or is it
 * an upload". Both call sites — the toolbar's `New` menu and a folder column's
 * background menu — read this array, so a kind added here appears in both
 * without either learning about it.
 *
 * **The seam, honoured.** The spreadsheet entry the Finder's authors left room
 * for now sits between the two originals. Its `invoke` opens the title dialog
 * that work ships (`SpreadsheetCreateDialog`), and the page it creates lands
 * in `parentPageId` — the folder the person is standing in — exactly as a new
 * document does.
 *
 * A kind whose doorway the host has not mounted is **absent**, never a greyed
 * "coming soon": a disabled item is a promise the build cannot keep, and the
 * pinned toolbar shape (`admin/test/finder-root-column.test.ts`) counts what
 * is actually offered.
 */

/** The seams a kind may reach for. Each already exists on `useKnowledge()`. */
export type NewFileTypeContext = {
  /** The folder the new thing lands in; `null` is the root of the folder. */
  parentPageId: string | null
  spaceId: string
  /** Opens the editor in create mode — the title is typed there. */
  openCreate: (parentPageId: string | null) => void
  /** Opens the hidden multi-file `<input type="file">` for this folder. */
  openUploadPicker: (parentPageId: string | null) => void
  /**
   * Opens "New spreadsheet" for this folder. Optional, and the one seam that
   * is: the spreadsheet pane is a lazily loaded chunk with its own dialogs, so
   * a host that does not mount them offers no spreadsheet row rather than a
   * row that opens nothing.
   */
  openSpreadsheetCreate?: (parentPageId: string | null) => void
  /**
   * Opens "Import spreadsheet…" for this folder — an `.xlsx`/`.csv`/`.tsv`
   * becomes a workbook rather than a file node. Optional for the same reason
   * as `openSpreadsheetCreate`.
   */
  openSpreadsheetImport?: (parentPageId: string | null) => void
}

export type NewFileType = {
  // Open on purpose: a kind this build does not know about is still a valid id.
  id: 'document' | 'spreadsheet' | 'spreadsheet-import' | 'upload' | (string & {})
  /** Under the toolbar's own "New": the noun alone. */
  label: string
  /**
   * In a folder column's background menu, where there is no "New" above it to
   * borrow the verb from. It is written out rather than derived, because
   * "Upload…" becomes "Upload files…" there and no rule produces that.
   */
  inFolderLabel: string
  /** The second line, where the surface is wide enough to show one. */
  description: string
  icon: IconDefinition
  /** `false` when this build cannot make the kind; the row is then absent. */
  available?: (context: NewFileTypeContext) => boolean
  invoke: (context: NewFileTypeContext) => void
}

export const NEW_FILE_TYPES: NewFileType[] = [
  {
    description: 'A page you write here',
    icon: faFileLines,
    id: 'document',
    inFolderLabel: 'New document',
    invoke: ({ openCreate, parentPageId }) => openCreate(parentPageId),
    label: 'Document',
  },
  {
    available: ({ openSpreadsheetCreate }) => Boolean(openSpreadsheetCreate),
    description: 'Rows and columns, edited here',
    icon: faTable,
    id: 'spreadsheet',
    inFolderLabel: 'New spreadsheet',
    invoke: ({ openSpreadsheetCreate, parentPageId }) => openSpreadsheetCreate?.(parentPageId),
    label: 'Spreadsheet',
  },
  {
    available: ({ openSpreadsheetImport }) => Boolean(openSpreadsheetImport),
    // Beside "Spreadsheet" rather than under "Upload…", because the answer to
    // "what are you making?" is the same — a workbook — and only the starting
    // point differs. An `.xlsx` dropped on the folder is still a file node;
    // this is the doorway that says otherwise.
    description: 'From an .xlsx, .csv or .tsv',
    icon: faFileImport,
    id: 'spreadsheet-import',
    inFolderLabel: 'Import spreadsheet…',
    invoke: ({ openSpreadsheetImport, parentPageId }) => openSpreadsheetImport?.(parentPageId),
    label: 'Spreadsheet from a file…',
  },
  {
    description: 'Files from your computer',
    icon: faCloudArrowUp,
    id: 'upload',
    inFolderLabel: 'Upload files…',
    invoke: ({ openUploadPicker, parentPageId }) => openUploadPicker(parentPageId),
    label: 'Upload…',
  },
]

export type NewFileTypeItem = {
  icon: IconDefinition
  id: string
  label: string
  onSelect: () => void
}

/**
 * The registry as menu rows: the label a person reads, and what it does.
 *
 * `where` picks which of the two labels the row carries — under the toolbar's
 * "New", or on a folder's own background where the verb has to be in the row.
 */
export const newFileTypeItems = (
  context: NewFileTypeContext,
  where: 'under-new' | 'in-folder' = 'under-new',
): NewFileTypeItem[] =>
  NEW_FILE_TYPES.filter((type) => type.available?.(context) ?? true).map((type) => ({
    icon: type.icon,
    id: `new-${type.id}`,
    label: where === 'in-folder' ? type.inFolderLabel : type.label,
    onSelect: () => type.invoke(context),
  }))
