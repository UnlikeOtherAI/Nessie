import { useCallback, useEffect, useMemo, useReducer, useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
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
import { useOpenDocument } from '../useOpenDocument'
import { isAgentDraft } from '../page-status'
import { FinderListHost } from './FinderListView'
import { FinderRootBrowserColumn } from './FinderRootBrowserColumn'
import { FinderAgentsBrowserColumn } from './FinderAgentsBrowserColumn'
import { FinderStatusStrip } from './FinderStatusBar'
import type { FinderVirtualRow } from './FinderVirtualColumn'
import { FinderVirtualPane } from './FinderVirtualPane'
import { FinderTreePane } from './FinderTreePane'
import { FinderTreeDetail } from './FinderTreeDetail'
import { FinderScopeReadState } from './FinderScopeReadState'
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
  type FinderColumnSlot,
  useFinderFolderParam,
  useFinderColumnWidths,
} from './finder-view'
import { buildAgentOpenAction } from './finder-toolbar-actions'
import { agentDocumentsSpaceDisplayName } from './agent-space-name'
import { FinderUploadInput, UploadLeaveGuard, useFinderUploads } from './UploadQueue'
import { useFinderMenus } from './FinderContextMenus'
import { MoveToDialog } from './MoveToDialog'
import { useFinderMove } from './useFinderMove'
import { useFinderToolbar } from './useFinderToolbar'
import { useFinderTransfers } from './useFinderTransfers'
import { useFinderSpreadsheets } from './useFinderSpreadsheets'
import { useFinderRootNavigation } from './useFinderRootNavigation'
import { finderRouteColumns, isKnowledgeAgentsRoute } from './finder-route-columns'
import type { DocumentsFinderProps } from './documents-finder-types'

/** Shared document viewport; only its root scope changes between doorways. */

export const DocumentsFinder = ({
  canManageSpace,
  onCreateRootFolder,
  onOpenSettings,
  documentPane,
  scope,
}: DocumentsFinderProps) => {
  const knowledge = useKnowledge()
  const { pathname, search } = useLocation()
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
  // Read once so the fallback cannot move under the hook that deletes it.
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
  // A failed read must reach the column, or an empty folder and a dead server
  // look identical on screen. In project and agent scope the spaces read is
  // what resolves the folder at all, so its failure counts here too — and
  // Retry has to re-run whichever one actually failed.
  const pagesQuery = {
    isError: knowledge.pagesLoadFailed || knowledge.spacesLoadFailed,
    isLoading: knowledge.pagesLoading,
    refetch: () => {
      if (knowledge.spacesLoadFailed) knowledge.refetchSpaces()
      if (knowledge.pagesLoadFailed) knowledge.refetchPages()
    },
  }

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
  // The browse path, as pages — minus the open page on the end of it. A
  // document is *in* a folder, never a folder itself, so a path ending in one
  // must not grow a column: the Finder drew an empty column named after the
  // open document, said "Nothing here yet" inside it, and on `single` that
  // column was the whole screen.
  const pathPages = useMemo(
    () => {
      const pages = pagePath
        .map((id) => pageById(id))
        .filter((page): page is KnowledgePageRecord => Boolean(page))
      return pages.at(-1) && pages.at(-1)?.kind !== 'folder' ? pages.slice(0, -1) : pages
    },
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
    // An agent's Documents home is named `${agent} — Documents`; in the
    // column's own header the suffix is furniture (agent-space-name.ts).
    const spaceName = knowledge.selectedSpace?.name ?? 'Documents'
    return [
      {
        depth: 0,
        key: `space:${selectedSpaceId}`,
        parentPageId: null,
        title: knowledge.selectedSpace?.ownerAgentId
          ? agentDocumentsSpaceDisplayName(spaceName)
          : spaceName,
      },
      ...pathPages.map((folder, index) => ({
        depth: index + 1,
        key: `folder:${folder.id}`,
        parentPageId: folder.id,
        title: folder.title,
      })),
    ]
  }, [knowledge.selectedSpace?.name, knowledge.selectedSpace?.ownerAgentId, pathPages, selectedSpaceId, virtualKind])

  const virtualColumnKey = virtualKind ? `virtual:${virtualKind}` : null
  const agentsDirectorySelected = knowledge.selectedRoot?.kind === 'agents'
    || knowledge.selectedRoot?.kind === 'agent-space'
  // On a phone every addressable Knowledge root destination is already a
  // route layer. Keep its column mounted from the route even during the short
  // fetch/state sync on a cold deep link; otherwise the route and a nested
  // column stage both push and the old Documents screen remains on top.
  const agentsDirectoryRendered = agentsDirectorySelected
    || (single && orgScope && isKnowledgeAgentsRoute(pathname))
  const agentsColumnKey = agentsDirectoryRendered ? 'virtual:agents' : null
  const deepestKey = virtualColumnKey ?? levels.at(-1)?.key ?? agentsColumnKey ?? 'root'
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
  const { agentsDirectoryOpen, backToAgents, backToRoot, openAgentHome, openRootRow,
    selectedRootRowId } = useFinderRootNavigation({ dispatch, knowledge, navigate, orgScope, search })

  // Where an opened document goes: the pane beside the browser, or — on the
  // desktop shell — a window of its own. A folder never reaches it.
  const openDocument = useOpenDocument()

  const openPageIn = useCallback(
    (level: FinderFolderLevel, page: KnowledgePageRecord) => {
      const prefix = pagePath.slice(0, level.depth)
      if (page.kind === 'folder') {
        browseTo([...prefix, page.id])
        dispatch({ columnKey: `folder:${page.id}`, type: 'enterColumn' })
        return
      }
      openDocument(page, () => knowledge.openPagePath([...prefix, page.id]))
    },
    [browseTo, knowledge, openDocument, pagePath],
  )

  // ── Spreadsheets ──────────────────────────────────────────────────────────
  // "New spreadsheet", "Import spreadsheet…" and "Open as spreadsheet" — the
  // three doorways onto the spreadsheet page kind, and the two dialogs they
  // open. Every one of them lands the new page *in the folder the person is
  // standing in* and then opens it, because a workbook nobody was taken to is
  // a row in a list somewhere.
  const spreadsheets = useFinderSpreadsheets({
    openPagePath: knowledge.openPagePath,
    pageById,
    pagePath,
    spaceId: selectedSpaceId,
  })

  const transfers = useFinderTransfers({ pageById, root: rootQuery.data })
  const uploads = useFinderUploads({ pages: knowledge.pages, spaceId: selectedSpaceId })
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
    onCreateSpreadsheet: spaceCanWrite ? spreadsheets.openCreate : undefined,
    onImportSpreadsheet: spaceCanWrite ? spreadsheets.openImport : undefined,
    onOpenSettings: () => onOpenSettings(
      activeParentPageId ? pageById(activeParentPageId) : undefined,
    ),
    onSelectSort: chooseSort,
    onSelectView: (next) => {
      selectView(next)
      setCookie(FINDER_VIEW_COOKIE, next)
    },
    onToggleNeedsReview: setNeedsReviewOnly,
    onUploadFile: uploads.openPicker,
    showViewAction: !single,
    sort,
    spaceCanWrite,
    view,
  })
  const submitFolder = (parentPageId: string | null, name: string) =>
    void knowledge.createFolder(parentPageId, name).finally(closeNewFolder)

  // The agent doorway is the documents column's own header button now, not a
  // toolbar action: "Open" belongs on the column that *is* the agent's
  // documents folder (finder-toolbar-actions.ts).
  const agentOpenAction = buildAgentOpenAction({
    onOpenAgent: (agentId) => void navigate(`/agents/${agentId}`),
    ownerAgentId: knowledge.selectedSpace?.ownerAgentId,
    scopeAgentId: scope.kind === 'agent' ? scope.agentId : undefined,
  })

  // A root row is the only place a different root folder can receive a drop.
  const rootDrop = {
    dropHandlersForSpace: (spaceId: string) => drag.dropHandlersFor(spaceId, {
      kind: 'folder',
      parentPageId: null,
      spaceId,
    }),
    dropTargetId: drag.dropTargetKey,
  }

  const menus = useFinderMenus({
    onConvertToSpreadsheet: spaceCanWrite ? spreadsheets.convert : undefined,
    onCreateRootFolder,
    onCreateSpreadsheet: spaceCanWrite ? spreadsheets.openCreate : undefined,
    onImportSpreadsheet: spaceCanWrite ? spreadsheets.openImport : undefined,
    onNewFolderIn: openNewFolderIn,
    onRefresh: () => void virtualQuery.refetch(),
    onUploadFiles: uploads.openPicker,
    // Injected rather than imported: the menu owns *when* a move opens, the
    // transfer wave owns what it does. Without this the item is absent, which
    // is the honest state — never an item that does nothing.
    renderMoveTo: (request) => (
      <MoveToDialog
        currentParentPageId={request.currentParentPageId}
        onClose={request.onClose}
        open={request.open}
        pageById={pageById}
        pages={request.pages}
        root={rootQuery.data}
        sourceSpaceId={request.sourceSpaceId}
      />
    ),
    selectedIds: selection.ids,
  })

  // Every column is independently resizable, keyed by its *slot* (root, the
  // virtual listing, depth:0, depth:1, …) rather than by the folder in it —
  // "the second column is too narrow" is about the position, not the page.
  const { resizeFor, widthFor } = useFinderColumnWidths()

  const virtualList: FinderVirtualRow[] = virtualKind === 'latest'
    ? virtualRows(latestQuery.data)
    : virtualKind === 'shared-with-me' ? virtualRows(sharedQuery.data) : []
  const virtualQuery = virtualKind === 'latest' ? latestQuery : sharedQuery

  // No shared group in project scope: an ad-hoc space rides above column 0.
  const siblingSpaces = scope.kind === 'project'
    ? knowledge.spaces.filter((space) => space.id !== selectedSpaceId)
    : []

  const rootColumn = (
    <FinderRootBrowserColumn
      {...rootDrop}
      actions={single ? actions : undefined}
      activeRowId={selectedRootRowId}
      columnActive={rootColumnActive}
      onOpen={openRootRow}
      query={rootQuery}
      refuseProps={uploads.refuseProps}
      resize={resizeFor('root')}
      root={rootQuery.data}
    />
  )

  const agentsColumn = agentsDirectoryRendered ? (
    <FinderAgentsBrowserColumn
      activeAgentId={knowledge.selectedRoot?.kind === 'agent-space'
        ? knowledge.selectedRoot.agentId : undefined}
      backToRoot={backToRoot}
      columnActive={activeKey === 'virtual:agents'}
      onOpen={openAgentHome}
      query={rootQuery}
      resize={resizeFor('virtual')}
      root={rootQuery.data}
    />
  ) : null

  const columns = [
    ...(orgScope ? [rootColumn] : []),
    ...(agentsColumn ? [agentsColumn] : []),
    ...(virtualColumnKey
      ? [(
        <FinderVirtualPane
          columnKey={virtualColumnKey}
          dispatch={dispatch}
          key={virtualColumnKey}
          kind={virtualKind ?? 'latest'}
          onBack={backToRoot}
          onOpen={(row) => {
            const inPlace = () =>
              knowledge.openPageDeepLink({ pageId: row.id, spaceId: row.home.spaceId })
            // Latest and Shared with me list folders too, and a folder is a
            // place to browse to, never a window.
            if (row.kind === 'folder') return inPlace()
            openDocument({ id: row.id, spaceId: row.home.spaceId, title: row.title }, inPlace)
          }}
          query={virtualQuery}
          refuseProps={uploads.refuseProps}
          resize={resizeFor('virtual')}
          rows={virtualList}
          screen={single && orgScope}
          selection={selection}
        />
      )]
      : levels.map((level, index) => (
        <ColumnBrowserColumn
          actions={(() => {
            // Column 0 outside org scope carries the whole toolbar on
            // `single`; the agent documents column additionally carries its
            // `Open` doorway on every layout. One list, never two doorways.
            const columnActions = [
              ...(single && !orgScope && index === 0 ? actions : []),
              ...(index === 0 && agentOpenAction ? [agentOpenAction] : []),
            ]
            return columnActions.length > 0 ? columnActions : undefined
          })()}
          key={level.key}
          // A pushed layer with no way out is a trap: a folder returns to
          // its parent, a root folder's listing to the root column.
          onBack={level.depth > 0
            ? () => browseTo(pagePath.slice(0, level.depth - 1))
            : backToAgents ?? backToRoot}
          resize={resizeFor(`depth:${index}`)}
          screen={single && orgScope && index === 0}
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
            query={pagesQuery}
            onSubmitFolder={(name) => submitFolder(level.parentPageId, name)}
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

  const columnSlots: FinderColumnSlot[] = [
    ...(orgScope ? ['root' as const] : []),
    ...(agentsColumn ? ['virtual' as const] : []),
    ...(virtualColumnKey
      ? ['virtual' as const]
      : levels.map((_, index) => `depth:${index}` as const)),
  ]

  const { columns: displayedColumns, slots: displayedColumnSlots } = finderRouteColumns({
    agentsColumn, columns, folderCount: levels.length, orgScope, pathname,
    rootColumn, single, slots: columnSlots, virtualColumnKey,
  })
  const agentsDirectoryActive = knowledge.selectedRoot?.kind === 'agents'

  const statusBar = <FinderStatusStrip
      itemCount={agentsDirectoryActive
        ? rootQuery.data?.agentHomes.length ?? 0
        : virtualColumnKey ? virtualList.length : activeRows.length}
      message={uploads.statusMessage}
      more={Boolean(virtualColumnKey && virtualQuery.hasNextPage)}
      selectedCount={selection.ids.length}
      showStorage={orgScope}
      single={single}
      transferRows={transfers.progressRows}
      truncated={agentsDirectoryActive
        ? rootQuery.data?.agentHomesTruncated ?? false
        : rootQuery.data?.sharedTruncated ?? false}
      uploads={uploads}
    />

  // List view is a split affordance: on `single` a column *is* one folder.
  const listView = view === 'list' && !single && !virtualColumnKey && !agentsDirectoryOpen && levels.length > 0

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

  // Outside the Knowledge section there is no root column, so a failed spaces
  // read leaves no column to report it — the screen would simply be blank.
  // Say so where the columns would have been, with the Retry beside it.
  const scopeReadFailed = !orgScope && knowledge.spacesLoadFailed

  const treeDetail = (
    <FinderTreeDetail
      activePageId={knowledge.openPageId} agentDocumentsActive={knowledge.selectedRoot?.kind === 'agent-space'}
      agentsDirectoryActive={agentsDirectoryActive} browseTo={browseTo} documentPane={documentPane}
      onOpenAgent={openAgentHome}
      onOpenDocument={(page, path) => openDocument(page, () => knowledge.openPagePath(path))}
      pagePath={pagePath} pagesQuery={pagesQuery}
      root={rootQuery.data} rootQuery={rootQuery} rowsIn={rowsIn}
    />
  )

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-[color:var(--main)] text-[color:var(--tx)]">
      {toolbar}
      <div className="flex min-h-0 flex-1">
        {scopeReadFailed ? (
          <FinderScopeReadState query={pagesQuery} />
        ) : view === 'tree' && !single && !virtualColumnKey ? (
          <FinderTreePane activePageId={knowledge.openPageId} activeRootRowId={selectedRootRowId} browseTo={browseTo}
            createFolderColumnKey={creatingFolderIn} createFolderPending={knowledge.createFolderPending}
            onCancelFolder={closeNewFolder} onSubmitFolder={(name) => submitFolder(activeParentPageId, name)}
            onOpenDocument={(page, path) => openDocument(page, () => knowledge.openPagePath(path))}
            onOpenRoot={openRootRow} pagePath={pagePath} pagesQuery={pagesQuery}
            root={rootQuery.data} rootQuery={rootQuery} rowsIn={rowsIn}
            selectedSpaceId={selectedSpaceId} detail={treeDetail} />
        ) : listView ? (
          <>
            {orgScope ? (
              <div className="h-full flex-shrink-0" style={{ width: widthFor('root') }}>
                {rootColumn}
              </div>
            ) : null}
            <FinderListHost
              creatingFolder={creatingFolderIn === levels.at(-1)?.key}
              createFolderPending={knowledge.createFolderPending}
              dispatch={dispatch} level={levels.at(-1) as FinderFolderLevel}
              onBrowseTo={(pageId) => {
                if (pageId === null) return browseTo([])
                const at = pagePath.indexOf(pageId)
                browseTo(at >= 0 ? pagePath.slice(0, at + 1) : [pageId])
              }}
              onCreateFolder={() => openNewFolderIn(levels.at(-1)?.key ?? null)} onCancelFolder={closeNewFolder}
              onOpen={(page) => openPageIn(levels.at(-1) as FinderFolderLevel, page)} onSelectSort={chooseSort}
              onSubmitFolder={(name) => submitFolder(levels.at(-1)?.parentPageId ?? null, name)} pageById={pageById}
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
              activeColumn={displayedColumns.length - 1}
              columns={displayedColumns}
              columnWidths={displayedColumnSlots.map(widthFor)}
              stageScope="knowledge"
            />
          </div>
        )}
      </div>
      {statusBar}
      {documentPane && view !== 'tree' ? (
        <div className="absolute inset-0 z-[var(--layer-stack)] bg-[color:var(--main)]">{documentPane}</div>
      ) : null}
      <FinderUploadInput
        parentPageId={activeParentPageId}
        spaceId={selectedSpaceId}
        uploads={uploads}
      />
      <UploadLeaveGuard queue={uploads.queue} />
      {spreadsheets.dialogs}
      {menus.dialogs}
      {transfers.prompt}
    </div>
  )
}
