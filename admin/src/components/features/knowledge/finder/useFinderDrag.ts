import { useCallback, useEffect, useRef, useState } from 'react'
import type { DragEvent } from 'react'

/**
 * Moving rows by drag (browser-ui.md §8, transfer.md §1).
 *
 * **Inside one root folder a move is a move**: nothing asks, the rows leave
 * the source column and appear in the target, and a failure puts them back.
 * ⌥ is ignored there — an in-space duplicate is a separate feature this plan
 * does not add — so an in-space drag never paints the copy cursor either.
 * **Across root folders** the drop asks move-or-copy through `onForeignDrop`,
 * and ⌥ held at release copies without asking.
 *
 * **The `+` while ⌥ is held.** The HTML drag image is fixed at `dragstart` and
 * cannot be swapped mid-drag, so the badge is not part of the ghost: it is
 * `copyIntent`, which the host paints beside the pointer, next to the platform's
 * own copy cursor that `dropEffect = 'copy'` asks for. The alternative — a
 * transparent `setDragImage` and a hand-drawn ghost that follows the pointer —
 * would replace a native affordance on every drag in the browser to decorate
 * one of them.
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

/** The `+` badge's position and how many rows it is about, or null. */
export type CopyIntent = { count: number; x: number; y: number }

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
   * A drop whose source root differs from the target's: the move-or-copy prompt
   * opens at the pointer, and `alt` says the person already chose copy and the
   * prompt is skipped. `useFinderTransfers` supplies it.
   */
  onForeignDrop?: (
    payload: FinderDragPayload,
    target: FinderDropTarget,
    point: { x: number; y: number },
    altKey: boolean,
  ) => void
}

// The `+` beside the pointer while ⌥ is held over another root folder. It is
// written to the document rather than rendered, because the element must not be
// inside the subtree being dragged (a drag source that re-renders under the
// pointer cancels the drag on WebKit) and because no React tree here outlives
// the columns it would have to escape.
const COPY_BADGE_ID = 'finder-copy-badge'

const paintCopyBadge = (intent: CopyIntent | null): void => {
  if (typeof document === 'undefined') return
  const existing = document.getElementById(COPY_BADGE_ID)
  if (!intent) {
    existing?.remove()
    return
  }
  const badge = existing ?? document.createElement('div')
  if (!existing) {
    badge.id = COPY_BADGE_ID
    badge.setAttribute('aria-hidden', 'true')
    badge.dataset['copyBadge'] = 'true'
    badge.style.cssText = [
      'position:fixed',
      // A decoration that follows the pointer, like a hover hint, and never an
      // overlay: it owns no Back, traps no focus and nothing dismisses it.
      'z-index:var(--layer-tooltip)',
      'pointer-events:none',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'min-width:18px',
      'height:18px',
      'padding:0 4px',
      'border-radius:9px',
      'font-size:12px',
      'line-height:1',
      'font-weight:600',
      'background:var(--accent)',
      'color:var(--on-accent)',
      'box-shadow:0 2px 6px var(--scrim-strong)',
    ].join(';')
    document.body.appendChild(badge)
  }
  badge.textContent = intent.count > 1 ? `+${intent.count}` : '+'
  badge.style.left = `${intent.x + 14}px`
  badge.style.top = `${intent.y + 14}px`
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
  // Where the pointer is and whether ⌥ is down, but only over a target that
  // would accept a copy. Over an in-space target it is null, because ⌥ means
  // nothing there and a `+` that lies is worse than no `+`.
  const [copyIntent, setCopyIntent] = useState<CopyIntent | null>(null)

  useEffect(() => {
    paintCopyBadge(copyIntent)
    return () => paintCopyBadge(null)
  }, [copyIntent])

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
    setCopyIntent(null)
  }, [])

  const dropHandlersFor = useCallback(
    (key: string, target: FinderDropTarget) => ({
      onDragLeave: (event: DragEvent<HTMLElement>) => {
        // `dragleave` fires for every child the pointer crosses; only the one
        // that leaves the target itself counts.
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        setDropTargetKey((current) => (current === key ? null : current))
        setCopyIntent(null)
      },
      onDragOver: (event: DragEvent<HTMLElement>) => {
        const payload = carried.current
        if (!payload || dragCarriesFiles(event)) return
        if (!canDrop(payload, target)) return
        event.preventDefault()
        const copying = payload.spaceId !== target.spaceId && event.altKey
        event.dataTransfer.dropEffect = copying ? 'copy' : 'move'
        setDropTargetKey(key)
        setCopyIntent(copying
          ? { count: payload.pageIds.length, x: event.clientX, y: event.clientY }
          : null)
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
    copyIntent,
    dragEnd,
    dragStart,
    draggingIds,
    dropHandlersFor,
    dropTargetKey,
    isDragging: draggingIds.length > 0,
  }
}
