import { useCallback, useMemo } from 'react'
import {
  useArchiveKnowledgePage,
  useCreateKnowledgePage,
  useCreateKnowledgeSpace,
  usePublishKnowledgePage,
  useRestoreKnowledgeVersion,
  useUpdateKnowledgePage,
  useUpdateKnowledgeSpace,
  type KnowledgePageRecord,
  type KnowledgeSpaceRecord,
  type SavePageInput,
  type UpdateSpaceInput,
} from '../../../facades/knowledge/hooks'
import type { KnowledgeNavigation } from './useKnowledgeNavigation'

type UseKnowledgeMutationsInput = {
  navigation: KnowledgeNavigation
  // The page lookup for the space on screen, used to rebuild the ancestor
  // chain of a page created under a parent the reader drilled into.
  pagesById: Map<string, KnowledgePageRecord>
  // In project scope a new space belongs to the project being viewed, not to
  // whichever project the session's claim happens to name.
  projectId?: string
  sessionProjectId?: string
}

/**
 * The Knowledge write path: each wrapper runs one facade mutation and then
 * moves the drill path to wherever the write left the reader — a new space
 * becomes the selected one, a saved page opens, an archived page pops its
 * column. The navigation slice is passed in rather than owned here, because
 * "what changed on the server" and "where the reader now is" are two
 * questions and only the first belongs to a mutation.
 */
export const useKnowledgeMutations = ({
  navigation,
  pagesById,
  projectId,
  sessionProjectId,
}: UseKnowledgeMutationsInput) => {
  const {
    closeOverlays,
    readEditor,
    readPagePath,
    selectedSpaceId,
    setEditor,
    setOpenPageId,
    setPagePath,
    setSelectedSpaceId,
    setSpaceSettingsOpen,
  } = navigation

  const createSpaceMutation = useCreateKnowledgeSpace()
  const updateSpaceMutation = useUpdateKnowledgeSpace()
  const createPageMutation = useCreateKnowledgePage(selectedSpaceId)
  const updatePageMutation = useUpdateKnowledgePage()
  const publishPageMutation = usePublishKnowledgePage()
  const archivePageMutation = useArchiveKnowledgePage()
  const restoreVersionMutation = useRestoreKnowledgeVersion()

  const createSpace = useCallback(async (
    name: string,
    memberAgentIds?: string[],
    visibility?: KnowledgeSpaceRecord['visibility'],
  ): Promise<KnowledgeSpaceRecord> => {
    const created = await createSpaceMutation.mutateAsync({
      name,
      memberAgentIds,
      projectId: projectId ?? sessionProjectId,
      visibility,
    })
    setSelectedSpaceId(created.id)
    setPagePath([])
    setOpenPageId(undefined)
    closeOverlays()
    return created
  }, [
    closeOverlays,
    createSpaceMutation,
    projectId,
    sessionProjectId,
    setOpenPageId,
    setPagePath,
    setSelectedSpaceId,
  ])

  const updateSpace = useCallback(async (
    input: Omit<UpdateSpaceInput, 'spaceId'>,
  ): Promise<void> => {
    if (!selectedSpaceId) return
    await updateSpaceMutation.mutateAsync({ spaceId: selectedSpaceId, ...input })
    setSpaceSettingsOpen(false)
  }, [selectedSpaceId, setSpaceSettingsOpen, updateSpaceMutation])

  const savePage = useCallback(async (input: SavePageInput): Promise<void> => {
    const editor = readEditor()
    if (editor?.mode === 'edit') {
      await updatePageMutation.mutateAsync({ ...input, pageId: editor.page.id })
      setEditor(null)
      return
    }

    const created = await createPageMutation.mutateAsync(input)
    const parentPageId = input.parentPageId ?? null
    if (parentPageId) {
      const parentPath: string[] = []
      const visited = new Set<string>()
      let current = pagesById.get(parentPageId)
      while (current && !visited.has(current.id)) {
        visited.add(current.id)
        parentPath.unshift(current.id)
        current = current.parentPageId ? pagesById.get(current.parentPageId) : undefined
      }
      setPagePath([...parentPath, created.id])
    } else {
      setPagePath([created.id])
    }
    setOpenPageId(created.id)
    setEditor(null)
  }, [
    createPageMutation,
    pagesById,
    readEditor,
    setEditor,
    setOpenPageId,
    setPagePath,
    updatePageMutation,
  ])

  // A folder is a title-only page flagged `metadata.folder` so it renders as a
  // container even while empty. Unlike savePage we never open it as a document —
  // it just appears in the active column, ready to be drilled into.
  const createFolder = useCallback(async (
    parentPageId: string | null,
    title: string,
  ): Promise<void> => {
    await createPageMutation.mutateAsync({ title, parentPageId, metadata: { folder: true } })
  }, [createPageMutation])

  // Publish and restore are fire-and-forget from their menu items, so they run
  // through `mutate`: the failure lands on the mutation's own error state
  // instead of becoming an unhandled rejection nothing in the tree can see.
  const publishPage = useCallback((pageId: string): void => {
    publishPageMutation.mutate({ pageId })
  }, [publishPageMutation])

  const restoreVersion = useCallback((input: { pageId: string; versionId: string }): void => {
    restoreVersionMutation.mutate({
      ...input,
      changeComment: 'Restored from admin version history',
    })
  }, [restoreVersionMutation])

  const archivePage = useCallback(async (pageId: string): Promise<void> => {
    await archivePageMutation.mutateAsync({ pageId })
    const currentPath = readPagePath()
    const pageIndex = currentPath.indexOf(pageId)
    const nextPath = pageIndex >= 0 ? currentPath.slice(0, pageIndex) : []
    setPagePath(nextPath)
    setOpenPageId(nextPath.at(-1))
    closeOverlays()
  }, [archivePageMutation, closeOverlays, readPagePath, setOpenPageId, setPagePath])

  // Memoized so the provider's context value can be memoized in turn: this
  // object changes identity only when a wrapper or a pending flag moved.
  return useMemo(() => ({
    archivePage,
    archivePending: archivePageMutation.isPending,
    createFolder,
    createFolderPending: createPageMutation.isPending,
    createSpace,
    createSpacePending: createSpaceMutation.isPending,
    publishPage,
    publishPending: publishPageMutation.isPending,
    restorePending: restoreVersionMutation.isPending,
    restoreVersion,
    savePage,
    savePending: createPageMutation.isPending || updatePageMutation.isPending,
    updateSpace,
    updateSpacePending: updateSpaceMutation.isPending,
  }), [
    archivePage,
    archivePageMutation.isPending,
    createFolder,
    createPageMutation.isPending,
    createSpace,
    createSpaceMutation.isPending,
    publishPage,
    publishPageMutation.isPending,
    restoreVersion,
    restoreVersionMutation.isPending,
    savePage,
    updatePageMutation.isPending,
    updateSpace,
    updateSpaceMutation.isPending,
  ])
}
