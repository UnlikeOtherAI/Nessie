import { faCloudArrowUp, faFileLines, type IconDefinition } from '@fortawesome/free-solid-svg-icons'

/**
 * "What are you making?" — the one question the Finder's New control asks, and
 * the registry that answers it (menus-and-dialogs.md §6).
 *
 * It is a registry rather than a hard-coded pair because the answer set is
 * open: the owner asked for "is it a document, is it a spreadsheet, or is it
 * an upload", and the spreadsheet work is a separate session's. Both call
 * sites — the toolbar's `New` menu and a folder column's background menu —
 * read this array, so a kind added here appears in both without either
 * learning about it.
 *
 * **The seam, stated once.** A future integrator adds exactly one entry
 * between the two below — `{ id: 'spreadsheet', label: 'Spreadsheet',
 * description: 'Rows and columns', icon: faTable, invoke: ({ parentPageId,
 * openCreate }) => … }` — plus whatever doorway that work ships, on
 * {@link NewFileTypeContext}; both call sites then offer three answers with no
 * further change.
 *
 * Until then the item is **absent**, never a greyed "coming soon": a disabled
 * item is a promise this build cannot keep, and the pinned toolbar shape
 * (`admin/test/finder-root-column.test.ts`) counts what is actually offered.
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
}

export type NewFileType = {
  // Open on purpose: a kind this build does not know about is still a valid id.
  id: 'document' | 'upload' | (string & {})
  label: string
  /** The second line, where the surface is wide enough to show one. */
  description: string
  icon: IconDefinition
  invoke: (context: NewFileTypeContext) => void
}

export const NEW_FILE_TYPES: NewFileType[] = [
  {
    description: 'A page you write here',
    icon: faFileLines,
    id: 'document',
    invoke: ({ openCreate, parentPageId }) => openCreate(parentPageId),
    label: 'Document',
  },
  {
    description: 'Files from your computer',
    icon: faCloudArrowUp,
    id: 'upload',
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

/** The registry as menu rows: the label a person reads, and what it does. */
export const newFileTypeItems = (context: NewFileTypeContext): NewFileTypeItem[] =>
  NEW_FILE_TYPES.map((type) => ({
    icon: type.icon,
    id: `new-${type.id}`,
    label: type.label,
    onSelect: () => type.invoke(context),
  }))
