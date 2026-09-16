import { useCallback } from 'react'
import type { KnowledgePageRecord } from '../../../../facades/knowledge/hooks'
import { useMovePages } from '../../../../facades/knowledge/finder-hooks'
import { useToasts } from '../../../../providers/ToastProvider'
import { useFinderDrag, type UseFinderDragInput } from './useFinderDrag'

/**
 * Dragging rows onto a folder inside the same root folder.
 *
 * A move across root folders is a transfer and asks move-or-copy first; that
 * branch never reaches the mutation below — everything here assumes one space,
 * which is why the payload carries a single `spaceId`. It is handed straight
 * through to `useFinderDrag` as `onForeignDrop`, which is where
 * `useFinderTransfers` receives it. This hook is the only caller of
 * `useFinderDrag`, so without the pass-through the cross-root branch would have
 * no way in at all.
 */
export const useFinderMove = ({
  onForeignDrop,
  pageById,
  selectedIds,
  selectedSpaceId,
}: {
  onForeignDrop?: UseFinderDragInput['onForeignDrop']
  pageById: (pageId: string) => KnowledgePageRecord | undefined
  selectedIds: readonly string[]
  selectedSpaceId: string | undefined
}) => {
  const movePages = useMovePages()
  const { pushToast } = useToasts()

  const canDrop = useCallback(
    (payload: { pageIds: string[] }, target: { parentPageId: string | null }): boolean => {
      if (target.parentPageId && payload.pageIds.includes(target.parentPageId)) return false
      // A folder dropped into its own descendant is refused here rather than
      // waiting for the server's cycle check to answer 409.
      let walk = target.parentPageId ? pageById(target.parentPageId) : undefined
      const seen = new Set<string>()
      while (walk && !seen.has(walk.id)) {
        seen.add(walk.id)
        if (payload.pageIds.includes(walk.id)) return false
        walk = walk.parentPageId ? pageById(walk.parentPageId) : undefined
      }
      return true
    },
    [pageById],
  )

  const onMove = useCallback(
    (payload: { pageIds: string[]; spaceId: string }, target: { parentPageId: string | null }) => {
      movePages.mutate(
        {
          pageIds: payload.pageIds,
          parentPageId: target.parentPageId,
          revisions: Object.fromEntries(payload.pageIds.map((id) => [id, pageById(id)?.revision])),
          spaceId: payload.spaceId,
        },
        {
          // The rows go back where they were (the facade reverts the
          // optimistic write); a move that silently undid itself would read
          // as a drag that missed.
          onError: (error) => pushToast({
            body: error instanceof Error
              ? error.message
              : 'This item changed since you opened it. Refresh and try again.',
            title: 'Couldn’t move that',
          }),
        },
      )
    },
    [movePages, pageById, pushToast],
  )

  const rowsForDrag = useCallback(
    (id: string) => ({
      pageIds: selectedIds.includes(id) ? [...selectedIds] : [id],
      spaceId: selectedSpaceId ?? '',
    }),
    [selectedIds, selectedSpaceId],
  )

  return useFinderDrag({ canDrop, onForeignDrop, onMove, rowsForDrag })
}
