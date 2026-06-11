import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import {
  useCreateKnowledgePage,
  useCreateKnowledgeSpace,
  useKnowledgePages,
  useKnowledgeSpaces,
  usePublishKnowledgePage,
  useRestoreKnowledgeVersion,
  useUpdateKnowledgePage,
  type KnowledgePageRecord,
  type KnowledgeSpaceRecord,
  type SavePageInput,
} from '../../../facades/knowledge/hooks'

export type KnowledgeEditorState =
  | { mode: 'create'; parentPageId: string | null }
  | { mode: 'edit'; page: KnowledgePageRecord }
  | null

type KnowledgeContextValue = {
  spaces: KnowledgeSpaceRecord[]
  selectedSpaceId?: string
  selectedSpace: KnowledgeSpaceRecord | null
  selectSpace: (spaceId: string) => void
  createSpace: (name: string) => Promise<KnowledgeSpaceRecord>
  createSpacePending: boolean
  pages: KnowledgePageRecord[]
  rootPages: KnowledgePageRecord[]
  childrenOf: (parentPageId: string) => KnowledgePageRecord[]
  pageById: (pageId: string) => KnowledgePageRecord | undefined
  pagePath: string[]
  openRootPage: (pageId: string) => void
  drillTo: (depth: number, childPageId: string) => void
  popTo: (depth: number) => void
  editor: KnowledgeEditorState
  openCreate: (parentPageId: string | null) => void
  openEdit: (page: KnowledgePageRecord) => void
  closeEditor: () => void
  savePage: (input: SavePageInput) => Promise<void>
  savePending: boolean
  historyPageId?: string
  openHistory: (pageId: string) => void
  closeHistory: () => void
  publishPage: (pageId: string) => void
  publishPending: boolean
  restoreVersion: (input: { pageId: string; versionId: string }) => void
  restorePending: boolean
}

const KnowledgeContext = createContext<KnowledgeContextValue | null>(null)

export const useKnowledge = (): KnowledgeContextValue => {
  const value = useContext(KnowledgeContext)
  if (!value) {
    throw new Error('useKnowledge must be used within a KnowledgeProvider')
  }
  return value
}

export const KnowledgeProvider = ({ children }: { children: ReactNode }) => {
  const { me } = useAuthSession()
  const spacesQuery = useKnowledgeSpaces()
  const spaces = useMemo(
    () => [...(spacesQuery.data ?? [])].sort((left, right) => left.name.localeCompare(right.name)),
    [spacesQuery.data],
  )

  const [selectedSpaceId, setSelectedSpaceId] = useState<string | undefined>()
  const [pagePath, setPagePath] = useState<string[]>([])
  const [editor, setEditor] = useState<KnowledgeEditorState>(null)
  const [historyPageId, setHistoryPageId] = useState<string | undefined>()

  const pagesQuery = useKnowledgePages(selectedSpaceId)
  const pages = useMemo(() => pagesQuery.data ?? [], [pagesQuery.data])

  const createSpaceMutation = useCreateKnowledgeSpace()
  const createPageMutation = useCreateKnowledgePage(selectedSpaceId)
  const updatePageMutation = useUpdateKnowledgePage()
  const publishPageMutation = usePublishKnowledgePage()
  const restoreVersionMutation = useRestoreKnowledgeVersion()

  useEffect(() => {
    if (!selectedSpaceId && spaces[0]) {
      setSelectedSpaceId(spaces[0].id)
    }
  }, [selectedSpaceId, spaces])

  const pagesById = useMemo(() => {
    const map = new Map<string, KnowledgePageRecord>()
    for (const page of pages) {
      map.set(page.id, page)
    }
    return map
  }, [pages])

  const pagesByParent = useMemo(() => {
    const map = new Map<string | null, KnowledgePageRecord[]>()
    for (const page of pages) {
      const key = page.parentPageId ?? null
      map.set(key, [...(map.get(key) ?? []), page])
    }
    for (const list of map.values()) {
      list.sort((left, right) => left.position - right.position || left.title.localeCompare(right.title))
    }
    return map
  }, [pages])

  // Trim the drill path to the leading run of pages that still exist so a
  // deleted/renamed page never leaves a dangling column.
  const validPath = useMemo(() => {
    const result: string[] = []
    for (const id of pagePath) {
      if (!pagesById.has(id)) break
      result.push(id)
    }
    return result
  }, [pagePath, pagesById])

  const selectedSpace = spaces.find((space) => space.id === selectedSpaceId) ?? null
  const rootPages = pagesByParent.get(null) ?? []

  const selectSpace = (spaceId: string) => {
    setSelectedSpaceId(spaceId)
    setPagePath([])
    setEditor(null)
    setHistoryPageId(undefined)
  }

  const createSpace = async (name: string) => {
    const created = await createSpaceMutation.mutateAsync({
      name,
      projectId: me?.context.projectId,
    })
    setSelectedSpaceId(created.id)
    setPagePath([])
    setEditor(null)
    setHistoryPageId(undefined)
    return created
  }

  const openRootPage = (pageId: string) => {
    setPagePath([pageId])
    setEditor(null)
    setHistoryPageId(undefined)
  }

  const drillTo = (depth: number, childPageId: string) => {
    setPagePath((current) => [...current.slice(0, depth + 1), childPageId])
    setEditor(null)
    setHistoryPageId(undefined)
  }

  const popTo = (depth: number) => {
    setPagePath((current) => current.slice(0, depth))
    setEditor(null)
    setHistoryPageId(undefined)
  }

  const openCreate = (parentPageId: string | null) => setEditor({ mode: 'create', parentPageId })
  const openEdit = (page: KnowledgePageRecord) => setEditor({ mode: 'edit', page })
  const closeEditor = () => setEditor(null)

  const savePage = async (input: SavePageInput) => {
    if (editor?.mode === 'edit') {
      await updatePageMutation.mutateAsync({ ...input, pageId: editor.page.id })
      setEditor(null)
      return
    }

    const parentPageId = editor?.mode === 'create' ? editor.parentPageId : null
    const created = await createPageMutation.mutateAsync(input)
    if (parentPageId) {
      const depth = pagePath.indexOf(parentPageId)
      setPagePath(depth >= 0 ? [...pagePath.slice(0, depth + 1), created.id] : [created.id])
    } else {
      setPagePath([created.id])
    }
    setEditor(null)
  }

  const openHistory = (pageId: string) => setHistoryPageId(pageId)
  const closeHistory = () => setHistoryPageId(undefined)

  const publishPage = (pageId: string) => {
    void publishPageMutation.mutateAsync({ pageId })
  }

  const restoreVersion = (input: { pageId: string; versionId: string }) => {
    void restoreVersionMutation.mutateAsync({
      ...input,
      changeComment: 'Restored from admin version history',
    })
  }

  const value: KnowledgeContextValue = {
    spaces,
    selectedSpaceId,
    selectedSpace,
    selectSpace,
    createSpace,
    createSpacePending: createSpaceMutation.isPending,
    pages,
    rootPages,
    childrenOf: (parentPageId) => pagesByParent.get(parentPageId) ?? [],
    pageById: (pageId) => pagesById.get(pageId),
    pagePath: validPath,
    openRootPage,
    drillTo,
    popTo,
    editor,
    openCreate,
    openEdit,
    closeEditor,
    savePage,
    savePending: createPageMutation.isPending || updatePageMutation.isPending,
    historyPageId,
    openHistory,
    closeHistory,
    publishPage,
    publishPending: publishPageMutation.isPending,
    restoreVersion,
    restorePending: restoreVersionMutation.isPending,
  }

  return <KnowledgeContext.Provider value={value}>{children}</KnowledgeContext.Provider>
}
