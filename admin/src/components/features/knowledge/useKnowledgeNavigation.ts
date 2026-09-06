import { useCallback, useMemo, useRef, useState } from 'react'
import type { NavigateFunction } from 'react-router-dom'
import type { KnowledgePageRecord } from '../../../facades/knowledge/hooks'

export type KnowledgeEditorState =
  | { mode: 'create'; parentPageId: string | null; initialTitle?: string }
  | { mode: 'edit'; page: KnowledgePageRecord }
  | null

type UseKnowledgeNavigationInput = {
  navigate: NavigateFunction
  // The scoped mount's fixed space (an agent's Documents tab). While set the
  // drill path may never leave it, and a deep link to another space navigates
  // to the Knowledge section instead of silently switching underneath.
  scopeSpaceId?: string
}

export type KnowledgeNavigation = ReturnType<typeof useKnowledgeNavigation>

const samePath = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((id, index) => id === right[index])

/**
 * The Knowledge drill-path state machine: which space is on screen, how deep
 * into it the reader has walked, and which overlay (editor, version history,
 * space settings) is open. Every setter resets the slices that a move
 * invalidates, which is why they live together rather than beside the data.
 *
 * Every returned function has a stable identity for the life of the mount:
 * the live path and editor are read through refs rather than captured from
 * render. That is a correctness requirement, not a micro-optimisation — the
 * `?pageId=` deep-link effect keys on the callback it is handed, so a fresh
 * identity per render re-opens the link forever.
 */
export const useKnowledgeNavigation = ({
  navigate,
  scopeSpaceId,
}: UseKnowledgeNavigationInput) => {
  const [selectedSpaceId, setSelectedSpaceId] = useState<string | undefined>(scopeSpaceId)
  const [pagePath, setPagePathState] = useState<string[]>([])
  const [openPageId, setOpenPageId] = useState<string | undefined>()
  const [editor, setEditor] = useState<KnowledgeEditorState>(null)
  const [historyPageId, setHistoryPageId] = useState<string | undefined>()
  const [spaceSettingsOpen, setSpaceSettingsOpen] = useState(false)
  const [activeProductView, setActiveProductView] = useState<string | undefined>()

  const pagePathRef = useRef(pagePath)
  pagePathRef.current = pagePath
  const editorRef = useRef(editor)
  editorRef.current = editor

  // An unchanged path must not allocate a new array. A deep link that re-opens
  // the document already on screen would otherwise commit a new state object,
  // re-render the provider, and re-arm whatever effect asked for the jump.
  const setPagePath = useCallback(
    (next: string[] | ((current: string[]) => string[])): void => {
      setPagePathState((current) => {
        const resolved = typeof next === 'function' ? next(current) : next
        return samePath(current, resolved) ? current : resolved
      })
    },
    [],
  )

  const readPagePath = useCallback((): string[] => pagePathRef.current, [])
  const readEditor = useCallback((): KnowledgeEditorState => editorRef.current, [])

  // Leaving the current document: the editor and the history overlay describe
  // a page that is no longer the one in view.
  const closeOverlays = useCallback((): void => {
    setEditor(null)
    setHistoryPageId(undefined)
  }, [])

  const selectSpace = useCallback((nextSpaceId: string): void => {
    if (scopeSpaceId && nextSpaceId !== scopeSpaceId) return
    setSelectedSpaceId(nextSpaceId)
    setPagePath([])
    setOpenPageId(undefined)
    setSpaceSettingsOpen(false)
    setActiveProductView(undefined)
    closeOverlays()
  }, [closeOverlays, scopeSpaceId, setPagePath])

  const selectProductView = useCallback((view: string): void => {
    setActiveProductView(view)
    setPagePath([])
    setOpenPageId(undefined)
    setSpaceSettingsOpen(false)
    closeOverlays()
  }, [closeOverlays, setPagePath])

  const openSpaceSettings = useCallback(() => setSpaceSettingsOpen(true), [])
  const closeSpaceSettings = useCallback(() => setSpaceSettingsOpen(false), [])

  const browseTo = useCallback((path: string[]): void => {
    setPagePath(path)
    setOpenPageId(undefined)
    closeOverlays()
  }, [closeOverlays, setPagePath])

  const openPagePath = useCallback((path: string[]): void => {
    const pageId = path.at(-1)
    if (!pageId) return
    setPagePath(path)
    setOpenPageId(pageId)
    closeOverlays()
  }, [closeOverlays, setPagePath])

  const openRootPage = useCallback(
    (pageId: string): void => openPagePath([pageId]),
    [openPagePath],
  )

  // Jumps straight to a page from outside the browsing flow (an approval's
  // "Open page" link, a search result, a DeepWater research run's native
  // Knowledge document). We don't know the page's ancestor chain up front, so
  // the path is just the page itself — enough for the preview to open;
  // breadcrumbs/back just fall back to the space root. Also clears any active
  // product view (e.g. the DeepWater "Research" Documents view) so a deep
  // link always lands on the real document instead of staying stuck behind
  // whichever product surface the caller happened to be viewing.
  const openPageDeepLink = useCallback(
    (input: { spaceId: string; pageId: string }): void => {
      if (scopeSpaceId && input.spaceId !== scopeSpaceId) {
        void navigate(
          `/knowledge-base/spaces/${encodeURIComponent(input.spaceId)}`
          + `?pageId=${encodeURIComponent(input.pageId)}`,
        )
        return
      }
      setActiveProductView(undefined)
      setSelectedSpaceId(input.spaceId)
      setPagePath([input.pageId])
      setOpenPageId(input.pageId)
      closeOverlays()
    },
    [closeOverlays, navigate, scopeSpaceId, setPagePath],
  )

  const drillTo = useCallback((depth: number, childPageId: string): void => {
    setPagePath((current) => [...current.slice(0, depth + 1), childPageId])
    setOpenPageId(childPageId)
    closeOverlays()
  }, [closeOverlays, setPagePath])

  const popTo = useCallback((depth: number): void => {
    const nextPath = pagePathRef.current.slice(0, depth)
    setPagePath(nextPath)
    setOpenPageId(nextPath.at(-1))
    closeOverlays()
  }, [closeOverlays, setPagePath])

  const openCreate = useCallback(
    (parentPageId: string | null, initialTitle?: string): void =>
      setEditor({ mode: 'create', parentPageId, initialTitle }),
    [],
  )
  const openEdit = useCallback(
    (page: KnowledgePageRecord): void => setEditor({ mode: 'edit', page }),
    [],
  )
  const closeEditor = useCallback((): void => setEditor(null), [])

  const openHistory = useCallback((pageId: string): void => setHistoryPageId(pageId), [])
  const closeHistory = useCallback((): void => setHistoryPageId(undefined), [])

  // Memoized so the provider's context value can be memoized in turn: this
  // object changes identity only when a navigation state value actually moved.
  return useMemo(() => ({
    activeProductView,
    browseTo,
    closeEditor,
    closeHistory,
    closeOverlays,
    closeSpaceSettings,
    drillTo,
    editor,
    historyPageId,
    openCreate,
    openEdit,
    openHistory,
    openPageDeepLink,
    openPageId,
    openPagePath,
    openRootPage,
    openSpaceSettings,
    pagePath,
    popTo,
    readEditor,
    readPagePath,
    selectProductView,
    selectSpace,
    selectedSpaceId,
    setEditor,
    setOpenPageId,
    setPagePath,
    setSelectedSpaceId,
    setSpaceSettingsOpen,
    spaceSettingsOpen,
  }), [
    activeProductView,
    browseTo,
    closeEditor,
    closeHistory,
    closeOverlays,
    closeSpaceSettings,
    drillTo,
    editor,
    historyPageId,
    openCreate,
    openEdit,
    openHistory,
    openPageDeepLink,
    openPageId,
    openPagePath,
    openRootPage,
    openSpaceSettings,
    pagePath,
    popTo,
    readEditor,
    readPagePath,
    selectProductView,
    selectSpace,
    selectedSpaceId,
    setPagePath,
    spaceSettingsOpen,
  ])
}
