import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import {
  useCreateKnowledgePage,
  useCreateKnowledgeSpace,
  useEnsureMyDocsSpace,
  useKnowledgePages,
  useKnowledgeSpaces,
  usePublishKnowledgePage,
  useRestoreKnowledgeVersion,
  useSeedKnowledgeBase,
  useUpdateKnowledgePage,
  useUpdateKnowledgeSpace,
  type KnowledgePageRecord,
  type KnowledgeSpaceRecord,
  type SavePageInput,
  type UpdateSpaceInput,
} from '../../../facades/knowledge/hooks'
import {
  EXAMPLE_PAGE_HTML,
  EXAMPLE_PAGE_SUMMARY,
  EXAMPLE_PAGE_TITLE,
} from './example-page'

export type KnowledgeEditorState =
  | { mode: 'create'; parentPageId: string | null; initialTitle?: string }
  | { mode: 'edit'; page: KnowledgePageRecord }
  | null

type KnowledgeContextValue = {
  spaces: KnowledgeSpaceRecord[]
  // The caller's personal "My Docs" space, provisioned once per session via
  // the idempotent ensure endpoint. Undefined until that call resolves.
  myDocsSpaceId?: string
  selectedSpaceId?: string
  selectedSpace: KnowledgeSpaceRecord | null
  selectSpace: (spaceId: string) => void
  // A product-contributed Documents view (e.g. DeepWater's "Research") pinned in
  // the Knowledge sidebar. When set the workspace renders that product view
  // instead of a space's pages; selecting any space clears it.
  activeProductView?: string
  selectProductView: (view: string) => void
  createSpace: (
    name: string,
    memberAgentIds?: string[],
    visibility?: KnowledgeSpaceRecord['visibility'],
  ) => Promise<KnowledgeSpaceRecord>
  createSpacePending: boolean
  spaceSettingsOpen: boolean
  openSpaceSettings: () => void
  closeSpaceSettings: () => void
  updateSpace: (input: Omit<UpdateSpaceInput, 'spaceId'>) => Promise<void>
  updateSpacePending: boolean
  pages: KnowledgePageRecord[]
  rootPages: KnowledgePageRecord[]
  childrenOf: (parentPageId: string) => KnowledgePageRecord[]
  pageById: (pageId: string) => KnowledgePageRecord | undefined
  pagePath: string[]
  openPageId?: string
  browseTo: (path: string[]) => void
  openPagePath: (path: string[]) => void
  openRootPage: (pageId: string) => void
  openPageDeepLink: (input: { spaceId: string; pageId: string }) => void
  drillTo: (depth: number, childPageId: string) => void
  popTo: (depth: number) => void
  editor: KnowledgeEditorState
  // initialTitle prefills the create form's title — used by the unresolved
  // wikilink "create this page?" confirmation, which already knows the title
  // the reader typed/linked and shouldn't make them retype it.
  openCreate: (parentPageId: string | null, initialTitle?: string) => void
  openEdit: (page: KnowledgePageRecord) => void
  closeEditor: () => void
  createFolder: (parentPageId: string | null, title: string) => Promise<void>
  createFolderPending: boolean
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
  const myDocsQuery = useEnsureMyDocsSpace()
  const spaces = useMemo(
    () => [...(spacesQuery.data ?? [])].sort((left, right) => left.name.localeCompare(right.name)),
    [spacesQuery.data],
  )

  const [selectedSpaceId, setSelectedSpaceId] = useState<string | undefined>()
  const [pagePath, setPagePath] = useState<string[]>([])
  const [openPageId, setOpenPageId] = useState<string | undefined>()
  const [editor, setEditor] = useState<KnowledgeEditorState>(null)
  const [historyPageId, setHistoryPageId] = useState<string | undefined>()
  const [spaceSettingsOpen, setSpaceSettingsOpen] = useState(false)
  const [activeProductView, setActiveProductView] = useState<string | undefined>()

  const pagesQuery = useKnowledgePages(selectedSpaceId)
  const pages = useMemo(() => pagesQuery.data ?? [], [pagesQuery.data])

  const createSpaceMutation = useCreateKnowledgeSpace()
  const updateSpaceMutation = useUpdateKnowledgeSpace()
  const createPageMutation = useCreateKnowledgePage(selectedSpaceId)
  const updatePageMutation = useUpdateKnowledgePage()
  const publishPageMutation = usePublishKnowledgePage()
  const restoreVersionMutation = useRestoreKnowledgeVersion()
  const seedMutation = useSeedKnowledgeBase()

  useEffect(() => {
    if (!selectedSpaceId && spaces[0]) {
      setSelectedSpaceId(spaces[0].id)
    }
  }, [selectedSpaceId, spaces])

  // First visit with no spaces: seed a "General" space + one example page.
  const seededRef = useRef(false)
  useEffect(() => {
    if (seededRef.current || !spacesQuery.isSuccess || spaces.length > 0) return
    // Seed at most once per mount — never reset the guard on error, so a
    // persistent failure can't spin into a retry loop of failed POSTs.
    seededRef.current = true
    seedMutation.mutate(
      {
        body: EXAMPLE_PAGE_HTML,
        projectId: me?.context.projectId,
        spaceName: 'General',
        summary: EXAMPLE_PAGE_SUMMARY,
        title: EXAMPLE_PAGE_TITLE,
      },
      {
        onSuccess: (space) => setSelectedSpaceId(space.id),
      },
    )
  }, [spacesQuery.isSuccess, spaces.length, me, seedMutation])

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
  const validOpenPageId = openPageId && validPath.at(-1) === openPageId ? openPageId : undefined

  const selectSpace = (spaceId: string) => {
    setSelectedSpaceId(spaceId)
    setPagePath([])
    setOpenPageId(undefined)
    setEditor(null)
    setHistoryPageId(undefined)
    setSpaceSettingsOpen(false)
    setActiveProductView(undefined)
  }

  const selectProductView = (view: string) => {
    setActiveProductView(view)
    setPagePath([])
    setOpenPageId(undefined)
    setEditor(null)
    setHistoryPageId(undefined)
    setSpaceSettingsOpen(false)
  }

  const createSpace = async (
    name: string,
    memberAgentIds?: string[],
    visibility?: KnowledgeSpaceRecord['visibility'],
  ) => {
    const created = await createSpaceMutation.mutateAsync({
      name,
      memberAgentIds,
      projectId: me?.context.projectId,
      visibility,
    })
    setSelectedSpaceId(created.id)
    setPagePath([])
    setOpenPageId(undefined)
    setEditor(null)
    setHistoryPageId(undefined)
    return created
  }

  const openSpaceSettings = () => setSpaceSettingsOpen(true)
  const closeSpaceSettings = () => setSpaceSettingsOpen(false)

  const updateSpace = async (input: Omit<UpdateSpaceInput, 'spaceId'>) => {
    if (!selectedSpaceId) return
    await updateSpaceMutation.mutateAsync({ spaceId: selectedSpaceId, ...input })
    setSpaceSettingsOpen(false)
  }

  const browseTo = (path: string[]) => {
    setPagePath(path)
    setOpenPageId(undefined)
    setEditor(null)
    setHistoryPageId(undefined)
  }

  const openPagePath = (path: string[]) => {
    const pageId = path.at(-1)
    if (!pageId) return
    setPagePath(path)
    setOpenPageId(pageId)
    setEditor(null)
    setHistoryPageId(undefined)
  }

  const openRootPage = (pageId: string) => openPagePath([pageId])

  // Jumps straight to a page from outside the browsing flow (an approval's
  // "Open page" link, a search result, a DeepWater research run's native
  // Knowledge document). We don't know the page's ancestor chain up front, so
  // the path is just the page itself — enough for the preview to open;
  // breadcrumbs/back just fall back to the space root. Also clears any active
  // product view (e.g. the DeepWater "Research" Documents view) so a deep
  // link always lands on the real document instead of staying stuck behind
  // whichever product surface the caller happened to be viewing.
  const openPageDeepLink = (input: { spaceId: string; pageId: string }) => {
    setActiveProductView(undefined)
    setSelectedSpaceId(input.spaceId)
    setPagePath([input.pageId])
    setOpenPageId(input.pageId)
    setEditor(null)
    setHistoryPageId(undefined)
  }

  const drillTo = (depth: number, childPageId: string) => {
    setPagePath((current) => [...current.slice(0, depth + 1), childPageId])
    setOpenPageId(childPageId)
    setEditor(null)
    setHistoryPageId(undefined)
  }

  const popTo = (depth: number) => {
    const nextPath = pagePath.slice(0, depth)
    setPagePath(nextPath)
    setOpenPageId(nextPath.at(-1))
    setEditor(null)
    setHistoryPageId(undefined)
  }

  const openCreate = (parentPageId: string | null, initialTitle?: string) =>
    setEditor({ mode: 'create', parentPageId, initialTitle })
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
      const nextPath = depth >= 0 ? [...pagePath.slice(0, depth + 1), created.id] : [created.id]
      setPagePath(nextPath)
    } else {
      setPagePath([created.id])
    }
    setOpenPageId(created.id)
    setEditor(null)
  }

  // A folder is a title-only page flagged `metadata.folder` so it renders as a
  // container even while empty. Unlike savePage we never open it as a document —
  // it just appears in the active column, ready to be drilled into.
  const createFolder = async (parentPageId: string | null, title: string) => {
    await createPageMutation.mutateAsync({ title, parentPageId, metadata: { folder: true } })
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
    myDocsSpaceId: myDocsQuery.data?.spaceId,
    selectedSpaceId,
    selectedSpace,
    selectSpace,
    activeProductView,
    selectProductView,
    createSpace,
    createSpacePending: createSpaceMutation.isPending,
    spaceSettingsOpen,
    openSpaceSettings,
    closeSpaceSettings,
    updateSpace,
    updateSpacePending: updateSpaceMutation.isPending,
    pages,
    rootPages,
    childrenOf: (parentPageId) => pagesByParent.get(parentPageId) ?? [],
    pageById: (pageId) => pagesById.get(pageId),
    pagePath: validPath,
    openPageId: validOpenPageId,
    browseTo,
    openPagePath,
    openRootPage,
    openPageDeepLink,
    drillTo,
    popTo,
    editor,
    openCreate,
    openEdit,
    closeEditor,
    createFolder,
    createFolderPending: createPageMutation.isPending,
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
