import { useCallback, useRef, useState } from 'react'
import type { DragEvent } from 'react'

/**
 * Moving rows by drag (browser-ui.md §8).
 *
 * **Inside one root folder a move is a move**: nothing asks, the rows leave
 * the source column and appear in the target, and a failure puts them back.
 * **Across root folders** the drop asks move-or-copy — that whole path,
 * including ⌥ to copy without asking, is Wave 2's, and this hook reports it
 * through `onForeignDrop` rather than deciding it.
 *
 * The file-drop overlay and this share `dragover`. They are told apart by
 * `dataTransfer.types` carrying `'Files'`, so an in-app row drag can never
 * open the upload overlay and a dragged file can never look like a row.
 */

/** Our own payload type, so a drag from another app is never mistaken for one. */
export const FINDER_DRAG_MIME = 'application/x-nessie-finder-rows'

export type FinderDragPayload = {
  /** The root folder (space) the rows are leaving. */
  spaceId: string
  pageIds: string[]
}

export type FinderDropTarget =
  /** A folder row, or a root row meaning "the root of that folder". */
  | { kind: 'folder'; spaceId: string; parentPageId: string | null }
  /** A column's empty body: the folder that column is showing. */
  | { kind: 'body'; spaceId: string; parentPageId: string | null }

export const dragCarriesFiles = (event: DragEvent): boolean =>
  Array.from(event.dataTransfer?.types ?? []).includes('Files')

export type UseFinderDragInput = {
  /** Which rows a drag that starts on `id` carries: the selection, or just it. */
  rowsForDrag: (id: string) => FinderDragPayload
  /** Refuses a drop the server would refuse anyway (a folder into itself). */
  canDrop: (payload: FinderDragPayload, target: FinderDropTarget) => boolean
  /** An in-space move. The optimistic write and the revert are the caller's. */
  onMove: (payload: FinderDragPayload, target: FinderDropTarget) => void
  /**
   * Declared and left unconnected in Wave 1: a drop whose source root differs
   * from the target's opens the move-or-copy prompt at the pointer, and `alt`
   * says the person already chose copy.
   */
  onForeignDrop?: (
    payload: FinderDragPayload,
    target: FinderDropTarget,
    point: { x: number; y: number },
    altKey: boolean,
  ) => void
}

export const useFinderDrag = ({
  canDrop,
  onForeignDrop,
  onMove,
  rowsForDrag,
}: UseFinderDragInput) => {
  // The payload in a ref as well as in `dataTransfer`: Chrome and Safari both
  // refuse to read `getData` during `dragover`, so the only way a target can
  // decide whether it may accept the drag *while it is happening* is to
  // remember what left. It is cleared on dragend, including a cancelled one.
  const carried = useRef<FinderDragPayload | null>(null)
  const [draggingIds, setDraggingIds] = useState<readonly string[]>([])
  const [dropTargetKey, setDropTargetKey] = useState<string | null>(null)

  const dragStart = useCallback(
    (id: string) => (event: DragEvent<HTMLElement>) => {
      const payload = rowsForDrag(id)
      carried.current = payload
      setDraggingIds(payload.pageIds)
      event.dataTransfer.effectAllowed = 'copyMove'
      event.dataTransfer.setData(FINDER_DRAG_MIME, JSON.stringify(payload))
      // A plain-text arm so a drag that leaves the app is at least legible,
      // and so Firefox has something to build its default ghost from.
      event.dataTransfer.setData('text/plain', payload.pageIds.join('\n'))
    },
    [rowsForDrag],
  )

  const dragEnd = useCallback(() => {
    carried.current = null
    setDraggingIds([])
    setDropTargetKey(null)
  }, [])

  const dropHandlersFor = useCallback(
    (key: string, target: FinderDropTarget) => ({
      onDragLeave: (event: DragEvent<HTMLElement>) => {
        // `dragleave` fires for every child the pointer crosses; only the one
        // that leaves the target itself counts.
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        setDropTargetKey((current) => (current === key ? null : current))
      },
      onDragOver: (event: DragEvent<HTMLElement>) => {
        const payload = carried.current
        if (!payload || dragCarriesFiles(event)) return
        if (!canDrop(payload, target)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = event.altKey ? 'copy' : 'move'
        setDropTargetKey(key)
      },
      onDrop: (event: DragEvent<HTMLElement>) => {
        const payload = carried.current
        setDropTargetKey(null)
        if (!payload || dragCarriesFiles(event)) return
        if (!canDrop(payload, target)) return
        event.preventDefault()
        event.stopPropagation()
        if (payload.spaceId === target.spaceId) onMove(payload, target)
        else {
          onForeignDrop?.(
            payload,
            target,
            { x: event.clientX, y: event.clientY },
            event.altKey,
          )
        }
        dragEnd()
      },
    }),
    [canDrop, dragEnd, onForeignDrop, onMove],
  )

  return {
    dragEnd,
    dragStart,
    draggingIds,
    dropHandlersFor,
    dropTargetKey,
    isDragging: draggingIds.length > 0,
  }
}
