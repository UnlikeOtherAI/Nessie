import { useCallback, useEffect, useMemo, useReducer, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { KnowledgePageRecord } from '../../../../facades/knowledge/hooks'
import {
  useKnowledgeRoot,
  useLatestPages,
  useSharedWithMe,
  virtualRows,
} from '../../../../facades/knowledge/finder-hooks'
import { getCookie, setCookie } from '../../../../lib/storage'
import { useNavigationLayout } from '../../../../navigation/mobile-shell'
import { useTabParam } from '../../../../navigation/useTabParam'
import { ColumnBrowserColumn } from '../../../shared/column-browser/ColumnBrowserColumn'
import { ColumnBrowserViewport } from '../../../shared/column-browser/ColumnBrowserViewport'
import { useKnowledge } from '../KnowledgeProvider'
import { isAgentDraft } from '../page-status'
import { FinderListHost } from './FinderListView'
import { FinderRootColumn, type FinderRootRow } from './FinderRootColumn'
import { FinderStatusBar } from './FinderStatusBar'
import { FinderVirtualHost, type FinderVirtualRow } from './FinderVirtualColumn'
import { FinderFolderHost, type FinderFolderLevel } from './FinderFolderColumn'
import { buildFinderToolbarActions } from './finder-toolbar-actions'
import { emptyFinderSelection, finderSelectionReducer } from './finder-selection'
import {
  agentDraftVisibleIds,
  DEFAULT_FINDER_SORT,
  FINDER_SORTS,
  FINDER_SORT_COOKIE,
  isFinderSort,
  sortFinderRows,
} from './finder-sort'
import {
  FINDER_VIEWS,
  FINDER_VIEW_COOKIE,
  migrateStoredFinderView,
  useFinderFolderParam,
} from './finder-view'
import { useFinderMove } from './useFinderMove'

/**
 * The Documents Finder: the viewport, its columns, the status bar, and the
 * toolbar that acts on whichever column is active.
 *
 * It composes and holds no row markup — that is each column's — and it is the
 * same component in all three places documents are browsed. What differs is
 * the scope: the Knowledge section starts at the root column, a project's Docs
 * tab starts *inside* the project's folder, and an agent's tab inside the
 * agent's.
 */

export type FinderScope =
  | { kind: 'org' }
  | { kind: 'project'; projectId: string }
  | { kind: 'agent'; spaceId: string; agentId: string }

const COLUMN_WIDTH_COOKIE = 'knowledgeColumnWidth'
const MIN_COLUMN_WIDTH = 300
const MAX_COLUMN_WIDTH = 720
const DEFAULT_COLUMN_WIDTH = 320

const clampWidth = (value: number): number =>
  Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, value))

const readStoredWidth = (): number => {
  const stored = Number(getCookie(COLUMN_WIDTH_COOKIE))
  return Number.isFinite(stored) && stored > 0 ? clampWidth(stored) : DEFAULT_COLUMN_WIDTH
}

type DocumentsFinderProps = {
  /** The ⚙ action; the dialog it opens belongs to the workspace. */
  canManageSpace: boolean
  /** The root's "New shared folder…" — a root folder needs a visibility choice. */
  onCreateRootFolder?: () => void
  onOpenSettings: () => void
  /** Upload into the active column. The file input lives with the workspace. */
  onUploadFile: (parentPageId: string | null) => void
  scope: FinderScope
}

export const DocumentsFinder = ({
  canManageSpace,
  onCreateRootFolder,
  onOpenSettings,
  onUploadFile,
  scope,
}: DocumentsFinderProps) => {
  const knowledge = useKnowledge()
  const navigate = useNavigate()
  const single = useNavigationLayout() === 'single'
  const [searchParams, setSearchParams] = useSearchParams()

  const orgScope = scope.kind === 'org'
  const rootQuery = useKnowledgeRoot(orgScope)
  const virtualKind = knowledge.selectedRoot?.kind === 'latest'
    ? 'latest'
    : knowledge.selectedRoot?.kind === 'shared-with-me'
      ? 'shared-with-me'
      : null
  const latestQuery = useLatestPages(
    scope.kind === 'project' ? scope.projectId : undefined,
    virtualKind === 'latest',
  )
  const sharedQuery = useSharedWithMe(virtualKind === 'shared-with-me')

  // ── View, sort and the open folder, all in the URL ────────────────────────
  // Read once per mount: the fallback must not move under the hook that
  // deletes the param when the fallback itself is selected.
  const [storedView] = useState(() => migrateStoredFinderView(getCookie(FINDER_VIEW_COOKIE)))
  const [view, selectView] = useTabParam('view', FINDER_VIEWS, storedView)
  const [storedSort] = useState(() => {
    const stored = getCookie(FINDER_SORT_COOKIE)
    return isFinderSort(stored) ? stored : DEFAULT_FINDER_SORT
  })
  const [sort, selectSort] = useTabParam('sort', FINDER_SORTS, storedSort)
  const chooseSort = useCallback((next: typeof sort) => {
    selectSort(next)
    setCookie(FINDER_SORT_COOKIE, next)
  }, [selectSort])

  const { browseTo, childrenOf, pagePath, pageById, rootPages, selectedSpaceId } = knowledge

  // `?folder=` — the deepest open folder, read on a cold start and mirrored
  // back on every browse.
  useFinderFolderParam({
    browseTo,
    pageById,
    pagePath,
    pagesLoading: knowledge.pagesLoading,
    searchParams,
    selectedSpaceId,
    setSearchParams,
  })

  // ── Needs review ──────────────────────────────────────────────────────────
  const [needsReviewOnly, setNeedsReviewOnly] = useState(false)
  useEffect(() => setNeedsReviewOnly(false), [selectedSpaceId])
  const agentDraftCount = useMemo(
    () => knowledge.pages.filter(isAgentDraft).length,
    [knowledge.pages],
  )
  const reviewVisibleIds = useMemo(
    () => (needsReviewOnly
      ? agentDraftVisibleIds(knowledge.pages, isAgentDraft, pageById)
      : null),
    [knowledge.pages, needsReviewOnly, pageById],
  )

  // ── The columns, as data ──────────────────────────────────────────────────
  const pathPages = useMemo(
    () => pagePath
      .map((id) => pageById(id))
      .filter((page): page is KnowledgePageRecord => Boolean(page)),
    [pageById, pagePath],
  )
  const rowsIn = useCallback(
    (parentPageId: string | null): KnowledgePageRecord[] => {
      const all = parentPageId === null ? rootPages : childrenOf(parentPageId)
      const filtered = reviewVisibleIds ? all.filter((page) => reviewVisibleIds.has(page.id)) : all
      return sortFinderRows(filtered, sort)
    },
    [childrenOf, reviewVisibleIds, rootPages, sort],
  )

  const levels: FinderFolderLevel[] = useMemo(() => {
    if (!selectedSpaceId || virtualKind) return []
    return [
      {
        depth: 0,
        key: `space:${selectedSpaceId}`,
        parentPageId: null,
        title: knowledge.selectedSpace?.name ?? 'Documents',
      },
      ...pathPages.map((folder, index) => ({
        depth: index + 1,
        key: `folder:${folder.id}`,
        parentPageId: folder.id,
        title: folder.title,
      })),
    ]
  }, [knowledge.selectedSpace?.name, pathPages, selectedSpaceId, virtualKind])

  const virtualColumnKey = virtualKind ? `virtual:${virtualKind}` : null
  const deepestKey = virtualColumnKey ?? levels.at(-1)?.key ?? 'root'
  const [selection, dispatch] = useReducer(finderSelectionReducer, emptyFinderSelection(deepestKey))

  // The active column is the one holding the selection; with nothing selected
  // it is the deepest open one, which is where a new folder or file lands.
  const activeKey = selection.ids.length > 0 ? selection.columnKey : deepestKey
  const activeLevel = levels.find((level) => level.key === activeKey)
  const activeParentPageId = activeLevel?.parentPageId ?? null
  const rootColumnActive = activeKey === 'root'
  const activeRows = useMemo(
    () => (virtualColumnKey || !activeLevel ? [] : rowsIn(activeLevel.parentPageId)),
    [activeLevel, rowsIn, virtualColumnKey],
  )

  // A page the selection names may be gone — archived, moved, filtered out by
  // Needs review — and a selection that outlives its row is a toolbar acting
  // on nothing.
  useEffect(() => {
    if (virtualColumnKey || !activeLevel) return
    dispatch({
      columnKey: activeLevel.key,
      order: activeRows.map((page) => page.id),
      type: 'reconcile',
    })
  }, [activeLevel, activeRows, virtualColumnKey])

  // ── Opening ───────────────────────────────────────────────────────────────
  const selectedRootRowId = knowledge.activeProductView
    ? `view:${knowledge.activeProductView}`
    : knowledge.selectedRoot?.kind === 'latest'
      ? 'virtual:latest'
      : knowledge.selectedRoot?.kind === 'shared-with-me'
        ? 'virtual:shared'
        : knowledge.selectedRoot?.spaceId

  const openRootRow = useCallback((row: FinderRootRow) => {
    dispatch({ columnKey: 'root', id: row.id, modifier: 'none', order: [], type: 'click' })
    switch (row.kind) {
      case 'latest':
        knowledge.selectVirtual('latest')
        return void navigate('/knowledge-base/latest')
      case 'shared-with-me':
        knowledge.selectVirtual('shared-with-me')
        return void navigate('/knowledge-base/shared-with-me')
      case 'space':
        knowledge.selectSpace(row.space.spaceId)
        return void navigate(`/knowledge-base/spaces/${encodeURIComponent(row.space.spaceId)}`)
      case 'project-unopened':
        // The folder is provisioned on the way in: `GET /root` deliberately
        // writes no space for a project nobody has opened yet.
        return void knowledge.openProjectDocuments(row.projectId).then((spaceId) => {
          if (spaceId) void navigate(`/knowledge-base/spaces/${encodeURIComponent(spaceId)}`)
        })
      case 'dashboards':
        return void navigate('/dashboards')
      case 'product-view':
        knowledge.selectProductView(row.view)
        return void navigate(`/knowledge-base/views/${encodeURIComponent(row.view)}`)
    }
  }, [knowledge, navigate])

  const openPageIn = useCallback(
    (level: FinderFolderLevel, page: KnowledgePageRecord) => {
      const prefix = pagePath.slice(0, level.depth)
      if (page.kind === 'folder') {
        browseTo([...prefix, page.id])
        dispatch({ columnKey: `folder:${page.id}`, type: 'enterColumn' })
        return
      }
      knowledge.openPagePath([...prefix, page.id])
    },
    [browseTo, knowledge, pagePath],
  )

  // ── Drag: in-space moves ──────────────────────────────────────────────────
  const drag = useFinderMove({
    pageById,
    selectedIds: selection.ids,
    selectedSpaceId,
  })

  // ── The toolbar ───────────────────────────────────────────────────────────
  const [creatingFolderIn, setCreatingFolderIn] = useState<string | null>(null)
  const spaceCanWrite = knowledge.selectedSpace?.canWrite ?? false
  const actions = buildFinderToolbarActions({
    agentDraftCount,
    canManageSpace,
    canWrite: spaceCanWrite && !rootColumnActive,
    isRootColumn: rootColumnActive,
    isVirtualColumn: Boolean(virtualColumnKey),
    needsReviewOnly,
    onCreateDocument: () => knowledge.openCreate(activeParentPageId),
    onCreateFolder: () => {
      if (rootColumnActive) return onCreateRootFolder?.()
      selectView('columns')
      setCreatingFolderIn(activeKey)
    },
    onOpenAgent: (agentId) => void navigate(`/agents/${agentId}`),
    onOpenSettings,
    onSelectSort: chooseSort,
    onSelectView: (next) => {
      selectView(next)
      setCookie(FINDER_VIEW_COOKIE, next)
    },
    onToggleNeedsReview: setNeedsReviewOnly,
    onUploadFile: () => onUploadFile(activeParentPageId),
    ownerAgentId: knowledge.selectedSpace?.ownerAgentId,
    scopeAgentId: scope.kind === 'agent' ? scope.agentId : undefined,
    showViewAction: !single,
    sort,
    view,
  })

  // ── Geometry ──────────────────────────────────────────────────────────────
  const [columnWidth, setColumnWidth] = useState(readStoredWidth)
  const resize = {
    max: MAX_COLUMN_WIDTH,
    min: MIN_COLUMN_WIDTH,
    onResize: (width: number, commit: boolean) => {
      setColumnWidth(width)
      if (commit) setCookie(COLUMN_WIDTH_COOKIE, String(width))
    },
    width: columnWidth,
  }

  const virtualList: FinderVirtualRow[] = virtualKind === 'latest'
    ? virtualRows(latestQuery.data)
    : virtualKind === 'shared-with-me'
      ? virtualRows(sharedQuery.data)
      : []
  const virtualQuery = virtualKind === 'latest' ? latestQuery : sharedQuery

  // In project scope the shared group does not exist, so an ad-hoc space filed
  // under this project would be unreachable here. It rides above the page rows
  // of column 0 instead — one click away, exactly as at the org root.
  const siblingSpaces = scope.kind === 'project'
    ? knowledge.spaces.filter((space) => space.id !== selectedSpaceId)
    : []

  // In the section the root column is a screen of its own, so leaving a root
  // folder is a route change rather than a selection change. In project and
  // agent scope there is no root column to return to.
  const backToRoot = orgScope
    ? () => {
        knowledge.selectVirtual(null)
        void navigate('/knowledge-base')
      }
    : undefined

  const rootColumn = (
    <ColumnBrowserColumn
      actions={actions}
      key="root"
      resize={resize}
      screen
      scrollKey="finder:root"
      title="Documents"
    >
      <FinderRootColumn
        activeRowId={selectedRootRowId}
        columnActive={rootColumnActive}
        onOpen={openRootRow}
        query={{
          isError: rootQuery.isError,
          isLoading: rootQuery.isLoading,
          refetch: rootQuery.refetch,
        }}
        root={rootQuery.data}
      />
    </ColumnBrowserColumn>
  )

  const columns = [
    ...(orgScope ? [rootColumn] : []),
    ...(virtualColumnKey
      ? [(
        <ColumnBrowserColumn
          key={virtualColumnKey}
          onBack={backToRoot}
          resize={resize}
          showBack
          title={virtualKind === 'latest' ? 'Latest' : 'Shared with me'}
        >
          <FinderVirtualHost
            columnKey={virtualColumnKey}
            dispatch={dispatch}
            kind={virtualKind ?? 'latest'}
            onOpen={(row) => knowledge.openPageDeepLink({
              pageId: row.id,
              spaceId: row.home.spaceId,
            })}
            query={virtualQuery}
            rows={virtualList}
            selection={selection}
          />
        </ColumnBrowserColumn>
      )]
      : levels.map((level, index) => (
        <ColumnBrowserColumn
          actions={!orgScope && index === 0 ? actions : undefined}
          key={level.key}
          // Every column beyond the root is a real layer on `single`, and a
          // pushed layer with no way out is a trap. A folder returns to its
          // parent folder; a root folder's own listing returns to the root
          // column, which in the section is the screen it was pushed over.
          onBack={level.depth > 0
            ? () => browseTo(pagePath.slice(0, level.depth - 1))
            : backToRoot}
          resize={resize}
          scrollKey={`finder:${level.key}`}
          showBack={level.depth > 0 || Boolean(backToRoot)}
          title={level.title}
        >
          <FinderFolderHost
            canWrite={spaceCanWrite}
            columnActive={activeKey === level.key}
            createFolderPending={knowledge.createFolderPending}
            creatingFolder={creatingFolderIn === level.key}
            dispatch={dispatch}
            drag={drag}
            level={level}
            onBack={level.depth > 0
              ? () => browseTo(pagePath.slice(0, level.depth - 1))
              : undefined}
            onCancelFolder={() => setCreatingFolderIn(null)}
            onCreateFolder={() => setCreatingFolderIn(level.key)}
            onOpen={(page) => openPageIn(level, page)}
            onSubmitFolder={(name) => {
              void knowledge.createFolder(level.parentPageId, name)
                .finally(() => setCreatingFolderIn(null))
            }}
            pageById={pageById}
            pathSelectionId={pagePath[level.depth]}
            rows={rowsIn(level.parentPageId)}
            selection={selection}
            siblingSpaces={index === 0 ? siblingSpaces : []}
            onOpenSiblingSpace={(spaceId) => knowledge.selectSpace(spaceId)}
            spaceId={selectedSpaceId ?? ''}
          />
        </ColumnBrowserColumn>
      ))),
  ]

  const statusBar = single ? null : (
    <FinderStatusBar
      itemCount={virtualColumnKey ? virtualList.length : activeRows.length}
      more={Boolean(virtualColumnKey && virtualQuery.hasNextPage)}
      selectedCount={selection.ids.length}
      showStorage={orgScope}
      truncated={rootQuery.data?.sharedTruncated ?? false}
    />
  )

  // List view is a split-layout affordance: on `single` a column *is* one
  // folder full width, so a second way to say that would be a fork.
  const listView = view === 'list' && !single && !virtualColumnKey && levels.length > 0

  return (
    <div className="flex h-full min-h-0 flex-col bg-[color:var(--main)] text-[color:var(--tx)]">
      <div className="flex min-h-0 flex-1">
        {listView ? (
          <>
            {orgScope ? (
              <div className="h-full flex-shrink-0" style={{ width: columnWidth }}>
                {rootColumn}
              </div>
            ) : null}
            <FinderListHost
              actions={orgScope ? undefined : actions}
              dispatch={dispatch}
              level={levels.at(-1) as FinderFolderLevel}
              onBrowseTo={(pageId) => {
                if (pageId === null) return browseTo([])
                const at = pagePath.indexOf(pageId)
                browseTo(at >= 0 ? pagePath.slice(0, at + 1) : [pageId])
              }}
              onCreateFolder={() => setCreatingFolderIn(levels.at(-1)?.key ?? null)}
              onOpen={(page) => openPageIn(levels.at(-1) as FinderFolderLevel, page)}
              onSelectSort={chooseSort}
              pageById={pageById}
              pathPages={pathPages}
              rootLabel={knowledge.selectedSpace?.name ?? 'Documents'}
              rows={rowsIn(levels.at(-1)?.parentPageId ?? null)}
              selection={selection}
              sort={sort}
            />
          </>
        ) : (
          <div className="min-w-0 flex-1">
            <ColumnBrowserViewport
              activeColumn={columns.length - 1}
              columnWidth={columnWidth}
              columns={columns}
              stageScope="knowledge"
            />
          </div>
        )}
      </div>
      {statusBar}
    </div>
  )
}
