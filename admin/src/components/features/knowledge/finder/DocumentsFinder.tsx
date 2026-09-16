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
import { ScreenHeader } from '../../../shared/ScreenHeader'
import { ColumnBrowserViewport } from '../../../shared/column-browser/ColumnBrowserViewport'
import { useKnowledge } from '../KnowledgeProvider'
import { isAgentDraft } from '../page-status'
import { FinderListHost } from './FinderListView'
import { FinderRootColumn, type FinderRootRow } from './FinderRootColumn'
import { FinderStatusStrip } from './FinderStatusBar'
import type { FinderVirtualRow } from './FinderVirtualColumn'
import { FinderVirtualPane } from './FinderVirtualPane'
import { FinderFolderHost, type FinderFolderLevel } from './FinderFolderColumn'
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
  finderBarTitle,
  FINDER_VIEWS,
  FINDER_VIEW_COOKIE,
  migrateStoredFinderView,
  useFinderColumnWidth,
  useFinderFolderParam,
} from './finder-view'
import { FinderUploadInput, UploadLeaveGuard, useFinderUploads } from './UploadQueue'
import { useFinderMenus } from './useFinderMenus'
import { useFinderMove } from './useFinderMove'
import { useFinderToolbar } from './useFinderToolbar'
import { useFinderTransfers } from './useFinderTransfers'

/**
 * The Documents Finder: the viewport, its columns, the status bar and the
 * toolbar that acts on whichever column is active. It holds no row markup, and
 * it is the same component wherever documents are browsed; only the scope
 * differs (the root column, a project's folder, an agent's).
 */

export type FinderScope =
  | { kind: 'org' }
  | { kind: 'project'; projectId: string }
  | { kind: 'agent'; spaceId: string; agentId: string }

type DocumentsFinderProps = {
  /** The ⚙ action; the dialog it opens belongs to the workspace. */
  canManageSpace: boolean
  /** The root's "New shared folder…" — a root folder needs a visibility choice. */
  onCreateRootFolder?: () => void
  onOpenSettings: () => void
  // Uploading is the Finder's own (uploads-and-indexing.md §2).
  scope: FinderScope
}

export const DocumentsFinder = ({
  canManageSpace,
  onCreateRootFolder,
  onOpenSettings,
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
  // deletes the param when the fallback is selected.
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

  // `?folder=` — the deepest open folder, read cold and mirrored on browse.
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

  // The column holding the selection, else the deepest open one — where a new
  // folder or file lands.
  const activeKey = selection.ids.length > 0 ? selection.columnKey : deepestKey
  const activeLevel = levels.find((level) => level.key === activeKey)
  const activeParentPageId = activeLevel?.parentPageId ?? null
  const rootColumnActive = activeKey === 'root'
  const activeRows = useMemo(
    () => (virtualColumnKey || !activeLevel ? [] : rowsIn(activeLevel.parentPageId)),
    [activeLevel, rowsIn, virtualColumnKey],
  )

  // A selection that outlives its row is a toolbar acting on nothing.
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
        // Provisioned on the way in: `GET /root` writes no space for a
        // project nobody has opened yet.
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

  // ── Uploads, menus, the transfer prompt ───────────────────────────────────
  const uploads = useFinderUploads({ pages: knowledge.pages, spaceId: selectedSpaceId })
  const menus = useFinderMenus()
  const transfers = useFinderTransfers({ pageById, root: rootQuery.data })

  // ── Drag: in-space moves ──────────────────────────────────────────────────
  const drag = useFinderMove({
    onForeignDrop: transfers.onForeignDrop,
    pageById,
    selectedIds: selection.ids,
    selectedSpaceId,
  })

  // ── The toolbar ───────────────────────────────────────────────────────────
  const spaceCanWrite = knowledge.selectedSpace?.canWrite ?? false
  const { actions, closeNewFolder, creatingFolderIn, openNewFolderIn } = useFinderToolbar({
    activeKey,
    activeParentPageId,
    agentDraftCount,
    canManageSpace,
    isRootColumn: rootColumnActive,
    isVirtualColumn: Boolean(virtualColumnKey),
    needsReviewOnly,
    onCreateDocument: (parentPageId) => knowledge.openCreate(parentPageId),
    onCreateRootFolder,
    onOpenAgent: (agentId) => void navigate(`/agents/${agentId}`),
    onOpenSettings,
    onSelectSort: chooseSort,
    onSelectView: (next) => {
      selectView(next)
      setCookie(FINDER_VIEW_COOKIE, next)
    },
    onToggleNeedsReview: setNeedsReviewOnly,
    onUploadFile: uploads.openPicker,
    ownerAgentId: knowledge.selectedSpace?.ownerAgentId,
    scopeAgentId: scope.kind === 'agent' ? scope.agentId : undefined,
    showViewAction: !single,
    sort,
    spaceCanWrite,
    view,
  })

  // A root row is the only place a *different* root folder can be dropped, so
  // a cross-root transfer starts there (transfer.md §1). These two prop names
  // are the contract with Wave 2A, which adds them to `FinderRootColumn`.
  const rootDrop = {
    dropHandlersForSpace: (spaceId: string) => drag.dropHandlersFor(spaceId, {
      kind: 'folder',
      parentPageId: null,
      spaceId,
    }),
    dropTargetId: drag.dropTargetKey,
  }

  // ── Geometry ──────────────────────────────────────────────────────────────
  const { columnWidth, resize } = useFinderColumnWidth()

  const virtualList: FinderVirtualRow[] = virtualKind === 'latest'
    ? virtualRows(latestQuery.data)
    : virtualKind === 'shared-with-me' ? virtualRows(sharedQuery.data) : []
  const virtualQuery = virtualKind === 'latest' ? latestQuery : sharedQuery

  // No shared group in project scope: an ad-hoc space rides above column 0.
  const siblingSpaces = scope.kind === 'project'
    ? knowledge.spaces.filter((space) => space.id !== selectedSpaceId)
    : []

  // The root column is a screen of its own, so leaving a root folder is a
  // route change. Project and agent scope have none to return to.
  const backToRoot = orgScope
    ? () => {
        knowledge.selectVirtual(null)
        void navigate('/knowledge-base')
      }
    : undefined

  const rootColumn = (
    <ColumnBrowserColumn
      actions={single ? actions : undefined}
      key="root"
      resize={resize}
      screen
      scrollKey="finder:root"
      title="Documents"
    >
      <div className="h-full" {...uploads.refuseProps}>
        <FinderRootColumn
          {...rootDrop}
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
      </div>
    </ColumnBrowserColumn>
  )

  const columns = [
    ...(orgScope ? [rootColumn] : []),
    ...(virtualColumnKey
      ? [(
        <FinderVirtualPane
          columnKey={virtualColumnKey}
          dispatch={dispatch}
          key={virtualColumnKey}
          kind={virtualKind ?? 'latest'}
          onBack={backToRoot}
          onOpen={(row) => knowledge.openPageDeepLink({
            pageId: row.id,
            spaceId: row.home.spaceId,
          })}
          query={virtualQuery}
          refuseProps={uploads.refuseProps}
          resize={resize}
          rows={virtualList}
          selection={selection}
        />
      )]
      : levels.map((level, index) => (
        <ColumnBrowserColumn
          actions={single && !orgScope && index === 0 ? actions : undefined}
          key={level.key}
          // A pushed layer with no way out is a trap: a folder returns to
          // its parent, a root folder's listing to the root column.
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
            onCancelFolder={() => closeNewFolder()}
            onCreateFolder={() => openNewFolderIn(level.key)}
            onOpen={(page) => openPageIn(level, page)}
            onSubmitFolder={(name) => {
              void knowledge.createFolder(level.parentPageId, name)
                .finally(() => closeNewFolder())
            }}
            menus={menus}
            onUploadRefused={uploads.notice}
            pageById={pageById}
            pathSelectionId={pagePath[level.depth]}
            rows={rowsIn(level.parentPageId)}
            uploads={uploads.queue}
            selection={selection}
            siblingSpaces={index === 0 ? siblingSpaces : []}
            onOpenSiblingSpace={(spaceId) => knowledge.selectSpace(spaceId)}
            spaceId={selectedSpaceId ?? ''}
          />
        </ColumnBrowserColumn>
      ))),
  ]

  const statusBar = (<FinderStatusStrip
      itemCount={virtualColumnKey ? virtualList.length : activeRows.length}
      message={uploads.statusMessage}
      more={Boolean(virtualColumnKey && virtualQuery.hasNextPage)}
      selectedCount={selection.ids.length}
      showStorage={orgScope}
      single={single}
      transferRows={transfers.progressRows}
      truncated={rootQuery.data?.sharedTruncated ?? false}
      uploads={uploads}
    />
  )

  // List view is a split affordance: on `single` a column *is* one folder.
  const listView = view === 'list' && !single && !virtualColumnKey && levels.length > 0

  // The toolbar spans the window; below `split` the column carries it.
  const toolbar = single ? null : (
    <ScreenHeader
      actions={actions}
      title={finderBarTitle({
        deepestFolderTitle: pathPages.at(-1)?.title,
        spaceName: knowledge.selectedSpace?.name,
        virtualKind,
      })}
    />
  )

  return (
    <div className="flex h-full min-h-0 flex-col bg-[color:var(--main)] text-[color:var(--tx)]">
      {toolbar}
      <div className="flex min-h-0 flex-1">
        {listView ? (
          <>
            {orgScope ? (
              <div className="h-full flex-shrink-0" style={{ width: columnWidth }}>
                {rootColumn}
              </div>
            ) : null}
            <FinderListHost
              dispatch={dispatch}
              level={levels.at(-1) as FinderFolderLevel}
              onBrowseTo={(pageId) => {
                if (pageId === null) return browseTo([])
                const at = pagePath.indexOf(pageId)
                browseTo(at >= 0 ? pagePath.slice(0, at + 1) : [pageId])
              }}
              onCreateFolder={() => openNewFolderIn(levels.at(-1)?.key ?? null)}
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
      <FinderUploadInput
        parentPageId={activeParentPageId}
        spaceId={selectedSpaceId}
        uploads={uploads}
      />
      <UploadLeaveGuard queue={uploads.queue} />
      {menus.dialogs}
      {transfers.prompt}
    </div>
  )
}
