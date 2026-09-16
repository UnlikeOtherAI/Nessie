import type { ReactNode } from 'react'
import type { KnowledgeRoot } from '@nessie/schemas'
import type { KnowledgePageRecord } from '../../../../facades/knowledge/hooks'
import type { FinderDragPayload, FinderDropTarget } from './useFinderDrag'

/**
 * **Seam, not the implementation.** Wave 2D owns the cross-root move-or-copy
 * prompt and exports `useFinderTransfers` with exactly this shape and this
 * input (verification-and-waves.md §3, Wave 2; the signature confirmed by 2D
 * after it shipped). Wave 2B mounts it by name, so integration deletes this
 * file and nothing at the call site moves.
 *
 * Until then a drop across two root folders does nothing at all, which is what
 * Wave 1D shipped: `useFinderDrag` reports it and no one is listening.
 */

export type FinderTransfersInput = {
  pageById: (pageId: string) => KnowledgePageRecord | undefined
  /** The root listing, for the destination's name and its audience sentence. */
  root: KnowledgeRoot | undefined
}

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
  /**
   * A live transfer's progress row, docked in the Finder's tray. It says what
   * a move and a copy each do on failure — a failed move keeps its committed
   * batches and retries the remainder, a failed copy rolls back — so the tray
   * mounts it as its own row and never wraps it in a summary of its own.
   */
  progressRows: ReactNode
}

export const useFinderTransfers = (_input: FinderTransfersInput): FinderTransfers => ({
  onForeignDrop: () => undefined,
  progressRows: null,
  prompt: null,
})
