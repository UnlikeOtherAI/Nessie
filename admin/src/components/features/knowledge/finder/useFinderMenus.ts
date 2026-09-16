import type { MouseEvent, ReactNode } from 'react'
import type { KnowledgePageRecord } from '../../../../facades/knowledge/hooks'

/**
 * **Seam, not the implementation.** Wave 2A owns the Finder's context menus
 * and dialogs and exports `useFinderMenus` with exactly this shape
 * (verification-and-waves.md §3, Wave 2). Wave 2B mounts it by name so the
 * upload wiring lands connected rather than waiting on an integration pass —
 * this file is the declaration it compiles against until 2A's file replaces
 * the body. **Replacing it means keeping the name and the shape**; the call
 * site is `DocumentsFinder`, and it passes no arguments.
 *
 * Until then every row's `onContextMenu` is `undefined`, which is exactly what
 * Wave 1D shipped: the native menu opens and nothing is broken.
 */

export type FinderMenuRowProps = {
  onContextMenu?: (event: MouseEvent<HTMLElement>) => void
}

export type FinderMenus = {
  /** The background menu of one column, keyed by the folder it is showing. */
  backgroundProps: (column: { parentPageId: string | null; spaceId: string }) => FinderMenuRowProps
  /** Every open menu, dialog and sheet this hook owns, rendered once. */
  dialogs: ReactNode
  rowProps: (row: KnowledgePageRecord) => FinderMenuRowProps
}

const NO_PROPS: FinderMenuRowProps = {}

export const useFinderMenus = (): FinderMenus => ({
  backgroundProps: () => NO_PROPS,
  dialogs: null,
  rowProps: () => NO_PROPS,
})
