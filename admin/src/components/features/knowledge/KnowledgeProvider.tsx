import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useOptionalAuthSession } from '../../../providers/AuthSessionProvider'
import { reportPushSurface } from '../../../lib/push-surface'
import {
  useEnsureMyDocsSpace,
  useKnowledgePages,
  useKnowledgeSpace,
  useKnowledgeSpaces,
  useSeedKnowledgeBase,
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
import { useKnowledgeMutations } from './useKnowledgeMutations'
import { useKnowledgeNavigation, type KnowledgeEditorState } from './useKnowledgeNavigation'

export type { KnowledgeEditorState } from './useKnowledgeNavigation'

type KnowledgeContextValue = {
  // Set when this provider is scoped to one project (a project's Documents
  // tab). Consumers use it to drop org-level chrome that makes no sense inside
  // a single project.
  scopeProjectId?: string
  // Set by the owning agent-detail surface, so the shared team can avoid
  // rendering a redundant "Open agent" doorway while it is already there.
  scopeAgentId?: string
  spaces: KnowledgeSpaceRecord[]
  spacePagination?: {
    canNext: boolean
    canPrevious: boolean
    label: string
    onPageChange: (page: number) => void
    onPageSizeChange: (pageSize: number) => void
    page: number
    pageCount: number
    pageSize: number
  }
  // A document-attention read is only safe after the scoped space list has
  // resolved; loading an empty placeholder must not clear unseen documents.
  spacesLoaded: boolean
  spacesLoadFailed: boolean
  // The caller's personal "My Docs" space, read separately from the paged
  // shared-space list so its pinned doorway never vanishes on another page.
  myDocsSpace?: KnowledgeSpaceRecord | null
  selectedSpaceId?: string
  selectedSpace: KnowledgeSpaceRecord | null
  selectSpace: (spaceId: string) => void
  // A product-contributed Documents view (e.g. DeepWater's "Research") pinned in
  // the Knowledge sidebar. When set the team renders that product view
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
  // The selected space's page list fetch — surfaced so the filesystem browser
  // can show a real loading/error+Retry state instead of treating a failed
  // fetch as an empty space.
  pagesLoading: boolean
  pagesLoadFailed: boolean
  refetchPages: () => unknown
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
  archivePage: (pageId: string) => Promise<void>
  archivePending: boolean
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

/**
 * Resolve the space currently on screen, even when an explicit deep link
 * points outside the scoped/capped list. The detail response is authoritative
 * for permissions; list membership is only navigation state.
 */
export const useDisplayedKnowledgeSpace = (
  spaces: KnowledgeSpaceRecord[],
  selectedSpaceId?: string,
): KnowledgeSpaceRecord | null => {
  const listedSpace = spaces.find((space) => space.id === selectedSpaceId)
  const detailQuery = useKnowledgeSpace(listedSpace ? undefined : selectedSpaceId)
  return listedSpace ?? detailQuery.data ?? null
}

// The provider is the team parameterisation seam: it wires the knowledge
// facade's queries to `useKnowledgeNavigation` (where the reader is) and
// `useKnowledgeMutations` (what a write does to that). `projectId` scopes the
// project Documents tab to that project's spaces; `spaceId` scopes an owning
// surface such as an agent Documents tab to one canonical knowledge space.
// Scoped mounts never ensure My Docs or seed first-visit example content.
export const KnowledgeProvider = ({
  agentId,
  children,
  projectId,
  spaceId,
}: {
  agentId?: string
  children: ReactNode
  projectId?: string
  spaceId?: string
}) => {
  const location = useLocation()
  const navigate = useNavigate()
  const me = useOptionalAuthSession()?.me ?? null
  const spacesQuery = useKnowledgeSpaces(projectId, !spaceId)
  const spaceQuery = useKnowledgeSpace(spaceId)
  const myDocsQuery = useEnsureMyDocsSpace(!projectId && !spaceId)
  const myDocsSpaceQuery = useKnowledgeSpace(myDocsQuery.data?.spaceId)
  const spaces = useMemo(() => {
    const all = spaceId
      ? spaceQuery.data ? [spaceQuery.data] : []
      : spacesQuery.items
    return [...all].sort((left, right) => left.name.localeCompare(right.name))
  }, [spaceId, spaceQuery.data, spacesQuery.items])

  const navigation = useKnowledgeNavigation({ navigate, scopeSpaceId: spaceId })
  const {
    activeProductView,
    editor,
    historyPageId,
    openPageId,
    pagePath,
    selectedSpaceId,
    setSelectedSpaceId,
    spaceSettingsOpen,
  } = navigation
  const selectedSpace = useDisplayedKnowledgeSpace(spaces, selectedSpaceId)

  const pagesQuery = useKnowledgePages(selectedSpaceId)
  const pages = useMemo(() => pagesQuery.data ?? [], [pagesQuery.data])
  const seedMutation = useSeedKnowledgeBase()

  useEffect(() => {
    if (spaceId && selectedSpaceId !== spaceId) {
      setSelectedSpaceId(spaceId)
      return
    }
    if (!selectedSpaceId && spaces[0]) {
      setSelectedSpaceId(spaces[0].id)
    }
  }, [selectedSpaceId, setSelectedSpaceId, spaceId, spaces])

  // First visit with no spaces: seed a "General" space + one example page.
  const seededRef = useRef(false)
  useEffect(() => {
    if (projectId || spaceId || seededRef.current || !spacesQuery.query.isSuccess || spacesQuery.total !== 0) return
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
  }, [
    me,
    projectId,
    seedMutation,
    setSelectedSpaceId,
    spaceId,
    spacesQuery.query.isSuccess,
    spacesQuery.total,
  ])

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

  const rootPages = useMemo(() => pagesByParent.get(null) ?? [], [pagesByParent])
  const validOpenPageId = openPageId && validPath.at(-1) === openPageId ? openPageId : undefined

  const mutations = useKnowledgeMutations({
    navigation,
    pagesById,
    projectId,
    sessionProjectId: me?.context.projectId,
  })

  useEffect(() => {
    reportPushSurface(
      activeProductView || !selectedSpaceId
        ? null
        : { kind: 'knowledge_space', spaceId: selectedSpaceId },
      location,
    )
    return () => reportPushSurface(null, location)
  }, [activeProductView, location, selectedSpaceId])

  const { refetch: refetchPagesQuery } = pagesQuery
  const refetchPages = useCallback(() => refetchPagesQuery(), [refetchPagesQuery])
  const childrenOf = useCallback(
    (parentPageId: string) => pagesByParent.get(parentPageId) ?? [],
    [pagesByParent],
  )
  const pageById = useCallback((pageId: string) => pagesById.get(pageId), [pagesById])

  const spacePagination = useMemo(
    () => spaceId
      ? undefined
      : {
          canNext: spacesQuery.canNext,
          canPrevious: spacesQuery.canPrevious,
          label: spacesQuery.label,
          onPageChange: spacesQuery.onPageChange,
          onPageSizeChange: spacesQuery.onPageSizeChange,
          page: spacesQuery.page,
          pageCount: spacesQuery.pageCount,
          pageSize: spacesQuery.pageSize,
        },
    [
      spaceId,
      spacesQuery.canNext,
      spacesQuery.canPrevious,
      spacesQuery.label,
      spacesQuery.onPageChange,
      spacesQuery.onPageSizeChange,
      spacesQuery.page,
      spacesQuery.pageCount,
      spacesQuery.pageSize,
    ],
  )

  // Memoized deliberately: `useKnowledgePageDeepLink` keys its effect on the
  // callbacks published here, so a fresh object per render would re-open the
  // same `?pageId=` link forever.
  const value = useMemo<KnowledgeContextValue>(() => ({
    scopeAgentId: agentId,
    scopeProjectId: projectId,
    spaces,
    spacePagination,
    spacesLoaded: spaceId ? spaceQuery.isSuccess : spacesQuery.query.isSuccess,
    spacesLoadFailed: spaceId ? spaceQuery.isError : spacesQuery.query.isError,
    myDocsSpace: myDocsSpaceQuery.data ?? null,
    selectedSpaceId,
    selectedSpace,
    selectSpace: navigation.selectSpace,
    activeProductView,
    selectProductView: navigation.selectProductView,
    createSpace: mutations.createSpace,
    createSpacePending: mutations.createSpacePending,
    spaceSettingsOpen,
    openSpaceSettings: navigation.openSpaceSettings,
    closeSpaceSettings: navigation.closeSpaceSettings,
    updateSpace: mutations.updateSpace,
    updateSpacePending: mutations.updateSpacePending,
    pages,
    pagesLoading: pagesQuery.isLoading,
    pagesLoadFailed: pagesQuery.isError,
    refetchPages,
    rootPages,
    childrenOf,
    pageById,
    pagePath: validPath,
    openPageId: validOpenPageId,
    browseTo: navigation.browseTo,
    openPagePath: navigation.openPagePath,
    openRootPage: navigation.openRootPage,
    openPageDeepLink: navigation.openPageDeepLink,
    drillTo: navigation.drillTo,
    popTo: navigation.popTo,
    editor,
    openCreate: navigation.openCreate,
    openEdit: navigation.openEdit,
    closeEditor: navigation.closeEditor,
    createFolder: mutations.createFolder,
    createFolderPending: mutations.createFolderPending,
    savePage: mutations.savePage,
    savePending: mutations.savePending,
    historyPageId,
    openHistory: navigation.openHistory,
    closeHistory: navigation.closeHistory,
    publishPage: mutations.publishPage,
    publishPending: mutations.publishPending,
    archivePage: mutations.archivePage,
    archivePending: mutations.archivePending,
    restoreVersion: mutations.restoreVersion,
    restorePending: mutations.restorePending,
  }), [
    activeProductView,
    agentId,
    childrenOf,
    editor,
    historyPageId,
    mutations,
    myDocsSpaceQuery.data,
    navigation,
    pageById,
    pages,
    pagesQuery.isError,
    pagesQuery.isLoading,
    projectId,
    refetchPages,
    rootPages,
    selectedSpace,
    selectedSpaceId,
    spaceId,
    spacePagination,
    spaceQuery.isError,
    spaceQuery.isSuccess,
    spaceSettingsOpen,
    spaces,
    spacesQuery.query.isError,
    spacesQuery.query.isSuccess,
    validOpenPageId,
    validPath,
  ])

  return <KnowledgeContext.Provider value={value}>{children}</KnowledgeContext.Provider>
}
