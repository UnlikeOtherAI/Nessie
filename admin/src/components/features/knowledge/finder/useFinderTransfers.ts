import type { ReactNode } from 'react'
import type { FinderDragPayload, FinderDropTarget } from './useFinderDrag'

/**
 * **Seam, not the implementation.** Wave 2D owns the cross-root move-or-copy
 * prompt and exports `useFinderTransfers` with exactly this shape
 * (verification-and-waves.md §3, Wave 2). Wave 2B mounts it by name — this
 * file is the declaration it compiles against until 2D's replaces the body.
 * **Replacing it means keeping the name and the shape**; the call site is
 * `DocumentsFinder`, and it passes no arguments.
 *
 * Until then a drop across two root folders does nothing at all, which is
 * what Wave 1D shipped: `useFinderDrag` reports it and no one is listening.
 */

export type FinderTransfers = {
  /** A drop whose source root differs from the target's. */
  onForeignDrop: (
    payload: FinderDragPayload,
    target: FinderDropTarget,
    point: { x: number; y: number },
    altKey: boolean,
  ) => void
  /** The move-or-copy prompt, rendered at the pointer. */
  prompt: ReactNode
  /** A queued transfer's progress row, docked in the Finder's upload tray. */
  progressRows: ReactNode
}

export const useFinderTransfers = (): FinderTransfers => ({
  onForeignDrop: () => undefined,
  progressRows: null,
  prompt: null,
})
