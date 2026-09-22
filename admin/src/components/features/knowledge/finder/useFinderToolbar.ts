import { useState } from 'react'
import type { FinderSort } from './finder-sort'
import type { FinderView } from './finder-view'
import { buildFinderToolbarActions } from './finder-toolbar-actions'

/**
 * The toolbar's actions, bound to the column the Finder is standing in.
 *
 * `buildFinderToolbarActions` is the pure table of what a toolbar offers in
 * each capability combination, and it is tested as one. This is the other
 * half: which folder each action acts on, and the one piece of state the
 * toolbar owns — whether a column is currently showing its inline "new
 * folder" row, which is a toolbar decision that a column renders.
 */
export type FinderToolbarInput = {
  activeKey: string
  activeParentPageId: string | null
  agentDraftCount: number
  canManageSpace: boolean
  isRootColumn: boolean
  isVirtualColumn: boolean
  needsReviewOnly: boolean
  onCreateDocument: (parentPageId: string | null) => void
  onCreateRootFolder?: () => void
  onCreateSpreadsheet?: (parentPageId: string | null) => void
  onImportSpreadsheet?: (parentPageId: string | null) => void
  onOpenSettings: () => void
  onSelectSort: (sort: FinderSort) => void
  onSelectView: (view: FinderView) => void
  onToggleNeedsReview: (only: boolean) => void
  onUploadFile: () => void
  showViewAction: boolean
  sort: FinderSort
  spaceCanWrite: boolean
  view: FinderView
}

export const useFinderToolbar = (input: FinderToolbarInput) => {
  const [creatingFolderIn, setCreatingFolderIn] = useState<string | null>(null)

  const actions = buildFinderToolbarActions({
    agentDraftCount: input.agentDraftCount,
    canManageSpace: input.canManageSpace,
    canWrite: input.spaceCanWrite && !input.isRootColumn,
    isRootColumn: input.isRootColumn,
    isVirtualColumn: input.isVirtualColumn,
    needsReviewOnly: input.needsReviewOnly,
    onCreateDocument: () => input.onCreateDocument(input.activeParentPageId),
    onCreateSpreadsheet: input.onCreateSpreadsheet
      ? () => input.onCreateSpreadsheet?.(input.activeParentPageId)
      : undefined,
    onImportSpreadsheet: input.onImportSpreadsheet
      ? () => input.onImportSpreadsheet?.(input.activeParentPageId)
      : undefined,
    onCreateFolder: () => {
      // The Knowledge root creates a space, which needs a visibility choice
      // an inline folder-name field cannot carry, so it uses the space dialog.
      if (input.isRootColumn) return input.onCreateRootFolder?.()
      setCreatingFolderIn(input.activeKey)
    },
    onOpenSettings: input.onOpenSettings,
    onSelectSort: input.onSelectSort,
    onSelectView: input.onSelectView,
    onToggleNeedsReview: input.onToggleNeedsReview,
    onUploadFile: input.onUploadFile,
    showViewAction: input.showViewAction,
    sort: input.sort,
    view: input.view,
  })

  return {
    actions,
    /** Which column is showing its inline "new folder" row, if any. */
    creatingFolderIn,
    closeNewFolder: () => setCreatingFolderIn(null),
    openNewFolderIn: setCreatingFolderIn,
  }
}
