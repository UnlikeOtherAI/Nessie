import { useCallback, useRef, useState } from 'react'
import type { DragEvent } from 'react'

// Native HTML5 file drag-and-drop state for a host element.
//
// Two shapes, one implementation. A single-file host (a file node, a page
// attachment, a new file version) keeps taking `(files: File[]) => void` and
// wraps it in `firstFileOnly`. A host that files what it receives into folders
// — the Finder's column — passes `onDrop` instead and receives the walked
// drop: every file with the folder path it came from, the caps already
// applied, and the one notice a browser without the directory API earns.

const hasFiles = (event: DragEvent): boolean =>
  Array.from(event.dataTransfer?.types ?? []).includes('Files')

// Adapter for hosts that upload one file at a time (KB file nodes, page
// attachments, file versions): a multi-file drop keeps only the first entry.
export const firstFileOnly =
  (handle: (file: File) => void) =>
  (files: File[]): void => {
    const [file] = files
    if (file) handle(file)
  }

/** One dropped file, with the folder path it sat in inside a dropped folder. */
export type DroppedEntry = {
  file: File
  // Empty for a file dropped on its own; `['Contracts', '2026']` for
  // `Contracts/2026/lease.pdf` inside a dropped `Contracts` folder.
  relativePath: string[]
}

// A mistaken drop of a home directory is refused before the first byte. The
// per-file limit is the server's (`NESSIE_MAX_UPLOAD_BYTES`); these two are a
// client courtesy, so they are deliberately generous and deliberately absolute
// — over either one, nothing starts.
export const MAX_DROP_ENTRIES = 500
export const MAX_DROP_BYTES = 5 * 1024 ** 3

export const DROP_REFUSAL_COPY = {
  too_large: "That's more than 5 GB at once — drop fewer files.",
  too_many: "That's more than 500 files — drop a folder or a smaller set.",
} as const

export type DropRefusalCode = keyof typeof DROP_REFUSAL_COPY

// Safari before 11.1 and every engine without `webkitGetAsEntry` reports a
// dropped folder as a zero-byte, type-less File. There is nothing to upload
// and no way to read what is inside, so those are dropped — with a sentence,
// never in silence.
export const DIRECTORIES_UNSUPPORTED_COPY =
  "Folders can't be dropped in this browser — drop the files inside them."

export type FileDrop = {
  // Empty when `refusal` is set: a refused drop starts nothing at all.
  entries: DroppedEntry[]
  refusal: { code: DropRefusalCode; message: string } | null
  // True when the drop carried a folder this browser cannot read into files.
  directoriesUnsupported: boolean
}

type FileDropOptions = {
  // Receives the walked drop instead of the flat file list. When present,
  // `onDropFiles` is not called.
  onDrop?: (drop: FileDrop) => void
}

// A dropped folder arrives as an entry tree that must be read asynchronously,
// so the items are taken off the DataTransfer synchronously (the object is
// neutered the moment the handler returns) and walked afterwards.
const readDirectory = (reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> =>
  new Promise((resolve) => {
    reader.readEntries(resolve, () => resolve([]))
  })

const readEntryFile = (entry: FileSystemFileEntry): Promise<File | null> =>
  new Promise((resolve) => {
    entry.file(resolve, () => resolve(null))
  })

// A tree deeper or wider than anything a person meant to drop still has to
// terminate: the entry cap bounds the files, and this bounds the folders.
const WALK_BUDGET = 5_000

type Walk = { entries: DroppedEntry[]; visited: number }

const walkEntry = async (
  entry: FileSystemEntry,
  prefix: string[],
  walk: Walk,
): Promise<void> => {
  walk.visited += 1
  if (walk.visited > WALK_BUDGET || walk.entries.length > MAX_DROP_ENTRIES) return
  if (entry.isFile) {
    const file = await readEntryFile(entry as FileSystemFileEntry)
    if (file) walk.entries.push({ file, relativePath: prefix })
    return
  }
  if (!entry.isDirectory) return
  const reader = (entry as FileSystemDirectoryEntry).createReader()
  const next = [...prefix, entry.name]
  // `readEntries` answers in batches and must be called until it answers an
  // empty one — a directory of 300 files arrives as three calls, not one.
  for (;;) {
    const batch = await readDirectory(reader)
    if (batch.length === 0) return
    for (const child of batch) {
      await walkEntry(child, next, walk)
      if (walk.visited > WALK_BUDGET || walk.entries.length > MAX_DROP_ENTRIES) return
    }
  }
}

const capped = (entries: DroppedEntry[], directoriesUnsupported: boolean): FileDrop => {
  if (entries.length > MAX_DROP_ENTRIES) {
    return {
      directoriesUnsupported,
      entries: [],
      refusal: { code: 'too_many', message: DROP_REFUSAL_COPY.too_many },
    }
  }
  const bytes = entries.reduce((total, entry) => total + entry.file.size, 0)
  if (bytes > MAX_DROP_BYTES) {
    return {
      directoriesUnsupported,
      entries: [],
      refusal: { code: 'too_large', message: DROP_REFUSAL_COPY.too_large },
    }
  }
  return { directoriesUnsupported, entries, refusal: null }
}

/**
 * Turns one drop into the entries it carries.
 *
 * Exported for the suite, and because the hidden `<input type="file">` a
 * toolbar opens has to produce the same shape as the drop that lands on the
 * column — one queue, one cap, one refusal sentence.
 */
export const readDroppedItems = async (
  items: DataTransferItem[],
  files: File[],
): Promise<FileDrop> => {
  const entries = items
    .filter((item) => item.kind === 'file')
    .map((item) => (typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null))
    .filter((entry): entry is FileSystemEntry => entry !== null)

  if (entries.length === 0) {
    // No directory API (or no items at all): a folder is indistinguishable
    // from a zero-byte, type-less file, so it is dropped and said so.
    const usable = files.filter((file) => file.size > 0 || file.type !== '')
    return capped(
      usable.map((file) => ({ file, relativePath: [] })),
      usable.length !== files.length,
    )
  }

  const walk: Walk = { entries: [], visited: 0 }
  for (const entry of entries) {
    await walkEntry(entry, [], walk)
  }
  return capped(walk.entries, false)
}

export const useFileDrop = (
  onDropFiles: (files: File[]) => void,
  disabled = false,
  options: FileDropOptions = {},
) => {
  const [isDragging, setIsDragging] = useState(false)
  // How many files the pointer is carrying, for the overlay's label. The
  // items list is readable during the drag; `dataTransfer.files` is not.
  const [draggingCount, setDraggingCount] = useState(0)
  const depth = useRef(0)
  // The live handlers ride in refs so the returned `dropHandlers` object is
  // stable: it is spread onto a host element, and a new identity on every
  // keystroke in the surrounding form would re-register all four listeners.
  const onDropFilesRef = useRef(onDropFiles)
  const onDropRef = useRef(options.onDrop)
  const disabledRef = useRef(disabled)
  onDropFilesRef.current = onDropFiles
  onDropRef.current = options.onDrop
  disabledRef.current = disabled

  const onDragEnter = useCallback((event: DragEvent) => {
    if (disabledRef.current || !hasFiles(event)) return
    event.preventDefault()
    depth.current += 1
    setDraggingCount(
      Array.from(event.dataTransfer?.items ?? []).filter((item) => item.kind === 'file').length,
    )
    setIsDragging(true)
  }, [])

  const onDragOver = useCallback((event: DragEvent) => {
    if (disabledRef.current || !hasFiles(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }, [])

  const onDragLeave = useCallback(() => {
    if (disabledRef.current) return
    depth.current -= 1
    if (depth.current <= 0) {
      depth.current = 0
      setIsDragging(false)
      setDraggingCount(0)
    }
  }, [])

  const onDrop = useCallback((event: DragEvent) => {
    if (disabledRef.current) return
    // An in-app row drag (a Finder row onto a folder) carries no `Files`, and
    // must fall through to the host's own drop handling rather than being
    // swallowed here as an upload of nothing.
    if (!hasFiles(event)) return
    event.preventDefault()
    depth.current = 0
    setIsDragging(false)
    setDraggingCount(0)
    const handleDrop = onDropRef.current
    if (!handleDrop) {
      const files = Array.from(event.dataTransfer?.files ?? [])
      if (files.length > 0) onDropFilesRef.current(files)
      return
    }
    // Both lists are read now: the DataTransfer is neutered as soon as this
    // handler returns, and the entry walk below is asynchronous.
    const items = Array.from(event.dataTransfer?.items ?? [])
    const files = Array.from(event.dataTransfer?.files ?? [])
    void readDroppedItems(items, files).then(handleDrop)
  }, [])

  return {
    draggingCount,
    dropHandlers: { onDragEnter, onDragLeave, onDragOver, onDrop },
    isDragging,
  }
}
