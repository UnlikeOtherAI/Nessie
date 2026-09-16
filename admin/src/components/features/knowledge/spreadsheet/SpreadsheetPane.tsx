import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Model } from '@ironcalc/wasm'
import {
  SPREADSHEET_ENGINE_VERSION,
  formatA1Range,
  type SpreadsheetSelection,
} from '@nessie/schemas'
import { useKnowledgeVersions, useRestoreKnowledgeVersion } from '../../../../facades/knowledge/hooks'
import type { KnowledgePageRecord } from '../../../../facades/knowledge/hooks'
import {
  spreadsheetExportPath,
  useReplaceInSpreadsheet,
  useRestructureSpreadsheet,
  useSaveSpreadsheetVersion,
  useSetSpreadsheetFilter,
  useSpreadsheetBootstrap,
  useSpreadsheetFilter,
  type SpreadsheetFilterCriterion,
  type SpreadsheetReplaceResult,
} from '../../../../facades/knowledge/spreadsheet-hooks'
import { useViewport } from '../../../../hooks/useViewport'
import { downloadAuthedPath } from '../../../../lib/uploads'
import { useAuthSession } from '../../../../providers/AuthSessionProvider'
import { useLocalBack } from '../../../../navigation/LocalBackContext'
import { OVERLAY_LAYER } from '../../../../navigation/overlay'
import { KnowledgePane } from '../KnowledgePane'
import { Notice } from '../../../primitives/Notice'
import type { PageHeaderAction } from '../../../shared/ResponsivePageHeader'
import { FilterChipsBar } from './FilterChipsBar'
import { FilterHeaderButtons } from './FilterHeaderButtons'
import { FilterPopover } from './FilterPopover'
import { FindReplacePopover } from './FindReplacePopover'
import { PresenceStrip, type SpreadsheetPeer } from './PresenceStrip'
import { SpreadsheetActionBar, type SpreadsheetActionId } from './SpreadsheetActionBar'
import { SpreadsheetExportDialog } from './SpreadsheetExportDialog'
import { SpreadsheetHistoryPanel } from './SpreadsheetHistoryPanel'
import { SpreadsheetSaveVersionDialog } from './SpreadsheetSaveVersionDialog'
import { SpreadsheetSortDialog } from './SpreadsheetSortDialog'
import {
  SpreadsheetVersionSavedNoticeBar,
  type SpreadsheetVersionSavedNotice,
} from './SpreadsheetVersionSavedNotice'
import { WorkbookHost, type WorkbookSession } from './WorkbookHost'
import type { BridgeFlush, PresenceFrame } from './spreadsheet-model-bridge'
import type { FindMatch, FindOptions } from './spreadsheet-find'

/**
 * A spreadsheet page's pane.
 *
 * Rule zero is satisfied without a new route or a new surface row: this is what
 * `KnowledgeDocumentPane` renders when `page.kind === 'spreadsheet'`, so every
 * existing knowledge doorway — My Docs, a space, a project's Docs tab, an
 * agent's Documents tab, a ticket's documents, a `kb_search` hit — already
 * reaches it.
 *
 * Phase 3a owns everything here except the live lane. The seams left for
 * Phase 3b are named `onSession`, `onPresence` and `peers`: 3b supplies the
 * hook that turns a flush into a submitted batch and a frame into a presence
 * event, and hangs its overlay off the same `hostRef` the filter buttons use.
 */

type SpreadsheetPaneProps = {
  canWrite: boolean
  onBack?: () => void
  page: KnowledgePageRecord
  /** Fed by Phase 3b's live lane; empty until then. */
  peers?: SpreadsheetPeer[]
  /** Phase 3b's submit door. Absent in 3a: local edits stay in the browser. */
  onFlush?: (flush: BridgeFlush) => void
  onPresence?: (frame: PresenceFrame) => void
  onSession?: (session: WorkbookSession | null) => void
  /** Phase 3b reports the lane's state; 3a renders the offline notice for it. */
  liveStatus?: 'connecting' | 'live' | 'offline'
  /** Set while the server is rebuilding on a newer engine: the grid is read-only. */
  engineMigrating?: boolean
  /**
   * The pre-destructive snapshot to offer a Restore for. 3a owns the notice;
   * the *trigger* is a batch's summary arriving on the live lane (Phase 3b) or
   * an agent's tool result (Phase 4), so it is a prop rather than something
   * this pane could know on its own. The pane still owns dismissal, and the
   * Restore inside it goes through the same mutation as History's.
   */
  versionNotice?: SpreadsheetVersionSavedNotice | null
}

export const SpreadsheetPane = ({
  canWrite,
  engineMigrating = false,
  liveStatus,
  onBack,
  onFlush,
  onPresence,
  onSession,
  page,
  peers = [],
  versionNotice = null,
}: SpreadsheetPaneProps) => {
  const { token } = useAuthSession()
  const viewport = useViewport()
  const phone = !viewport.atLeast.sm

  const bootstrapQuery = useSpreadsheetBootstrap(page.id)
  const bootstrap = bootstrapQuery.data
  const versionsQuery = useKnowledgeVersions(page.id)
  const restoreVersion = useRestoreKnowledgeVersion()
  const saveVersion = useSaveSpreadsheetVersion(page.id)
  const restructure = useRestructureSpreadsheet(page.id)
  const replace = useReplaceInSpreadsheet(page.id)

  const [session, setSession] = useState<WorkbookSession | null>(null)
  const [sheet, setSheet] = useState(0)
  const [selection, setSelection] = useState<SpreadsheetSelection>()
  // Bumped whenever the model changed, so everything drawn over the canvas
  // (filter buttons, the find match list) re-measures instead of going stale.
  const [revision, setRevision] = useState(0)
  const [fullscreen, setFullscreen] = useState(false)
  const [formatBarVisible, setFormatBarVisible] = useState(false)
  const [open, setOpen] = useState<null | 'export' | 'find' | 'history' | 'save-version' | 'sort'>(null)
  const [filterColumn, setFilterColumn] = useState<number | null>(null)
  // Dismissed locally, supplied from outside: a new snapshot arriving replaces
  // a dismissed one rather than staying hidden behind it.
  const [dismissedNotice, setDismissedNotice] = useState<string | null>(null)
  const notice = versionNotice && versionNotice.versionId !== dismissedNotice
    ? versionNotice
    : null
  const [replaceResult, setReplaceResult] = useState<SpreadsheetReplaceResult>()
  // Every write in this pane is fire-and-forget from the grid's point of view:
  // nothing here is a form with a field to hang an error on, so a refusal that
  // is not said out loud is a refusal nobody sees. One line, last error wins.
  const [actionError, setActionError] = useState<string | null>(null)
  const onActionError = (what: string) => (error: unknown) =>
    setActionError(`${what} failed: ${error instanceof Error ? error.message : String(error)}`)

  // Read by the fullscreen Escape handler, which must not re-subscribe on every
  // surface toggle.
  const openRef = useRef<boolean>(false)
  const filterAnchor = useRef<HTMLButtonElement>(null)
  const findAnchor = useRef<HTMLButtonElement>(null)
  const columnAnchor = useRef<HTMLButtonElement | null>(null)
  const gridBounds = useRef<HTMLDivElement>(null)
  // State, not a ref: IronCalc's scroll element only exists after the widget
  // mounts, and a ref assignment schedules no render, so the overlay would
  // measure once against `null` and never look again.
  const [scrollContainer, setScrollContainer] = useState<HTMLElement | null>(null)

  const filterQuery = useSpreadsheetFilter(page.id, sheet)
  const filterModel = filterQuery.data ?? null
  const filterMutations = useSetSpreadsheetFilter(page.id)

  const sheets = useMemo(
    () => (bootstrap?.sheets ?? []).map((info) => ({ index: info.index, name: info.name })),
    [bootstrap?.sheets],
  )
  const sheetName = sheets.find((entry) => entry.index === sheet)?.name ?? 'Sheet1'
  const model: Model | null = session?.model ?? null

  // Fullscreen is an overlay, not a route: Back closes it before it can pop the
  // page. It deliberately does *not* go through `useOverlay` — that primitive
  // re-parents nothing and would run its open/close motion on the very element
  // that stays on screen afterwards, so a person leaving fullscreen would watch
  // the inline pane fade. One model, one widget: the host never moves in the
  // tree, only the pane's own box does, which is what keeps in-cell editing
  // state (IronCalc builds `workbookState` in its root render body).
  useLocalBack({
    active: fullscreen,
    id: 'overlay:spreadsheet-fullscreen',
    label: 'Close fullscreen',
    onBack: () => setFullscreen(false),
    priority: 40,
  })
  useEffect(() => {
    if (!fullscreen) return undefined
    const onKeyDown = (event: KeyboardEvent) => {
      // A dialog or popover over the grid owns Escape first; this only leaves
      // fullscreen when nothing else is open.
      if (event.key !== 'Escape' || openRef.current) return
      event.preventDefault()
      setFullscreen(false)
    }
    // Capture, not bubble: IronCalc uses Escape to cancel cell editing and
    // stops the event inside React's root, which a document-level bubbling
    // listener never sees while the grid has focus. Measured — Escape simply
    // did nothing in fullscreen until this moved to the capture phase.
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [fullscreen])

  const handleSession = useCallback((next: WorkbookSession | null) => {
    setSession(next)
    if (next) {
      const view = next.model.getSelectedView()
      setSheet(view.sheet)
      setSelection(normalise(view.range))
    }
    onSession?.(next)
    // `onSession` is 3b's seam and is re-created on every parent render; reading
    // it through the closure here would re-run the host's bridge effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleFlush = useCallback((flush: BridgeFlush) => {
    setRevision((value) => value + 1)
    onFlush?.(flush)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handlePresence = useCallback((frame: PresenceFrame) => {
    setSheet(frame.sheet)
    setSelection(normalise(frame.range))
    onPresence?.(frame)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The scroll element the overlays measure against appears only once IronCalc
  // has mounted its worksheet, so it is looked up after the session arrives.
  useEffect(() => {
    setScrollContainer(
      session
        ? gridBounds.current?.querySelector<HTMLElement>('.ic-worksheet-sheet-container') ?? null
        : null,
    )
  }, [session, revision])

  const headerLabels = useMemo(() => {
    if (!model || !filterModel) return undefined
    const labels: Record<number, string> = {}
    for (let column = filterModel.range.c0; column <= filterModel.range.c1; column += 1) {
      labels[column] = model.getFormattedCellValue(sheet, filterModel.range.r0, column)
    }
    return labels
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterModel, model, revision, sheet])

  const columnValues = useMemo(() => {
    if (!model || !filterModel || filterColumn === null) return []
    const seen = new Set<string>()
    for (let row = filterModel.range.r0 + 1; row <= filterModel.range.r1; row += 1) {
      const value = model.getFormattedCellValue(sheet, row, filterColumn)
      if (value) seen.add(value)
    }
    return [...seen].sort((left, right) => left.localeCompare(right))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterColumn, filterModel, model, revision, sheet])

  const download = (path: string, filename: string): void => {
    void downloadAuthedPath(path, filename, token)
  }

  const onAction = (id: SpreadsheetActionId): void => {
    switch (id) {
      case 'filter':
        setFilterColumn(selection?.c0 ?? filterModel?.range.c0 ?? 1)
        break
      case 'format-bar':
        setFormatBarVisible((value) => !value)
        break
      case 'fullscreen':
        setFullscreen((value) => !value)
        break
      default:
        setOpen(id === 'find' && open === 'find' ? null : id)
    }
  }

  // Ctrl/Cmd-F is the find box, as it is in Sheets — the browser's own find
  // cannot see a canvas, so leaving it to the browser finds nothing at all.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'f' || !(event.metaKey || event.ctrlKey)) return
      event.preventDefault()
      setOpen('find')
    }
    // Capture, for the same reason as Escape above: the widget swallows the
    // keystroke while the grid has focus, which is exactly when a person
    // reaches for Find.
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [])

  // No header action of its own. History used to be one, and it is also the
  // action bar's fifth button, so the word appeared twice on one screen with
  // one meaning. The bar keeps it, next to "Save version", where somebody
  // deciding about versions is already looking.
  const headerActions: PageHeaderAction[] = []

  const busy = restoreVersion.isPending || saveVersion.isPending

  // IronCalc's workbook container takes focus back after any of our surfaces
  // has taken it — measured: with the sort dialog open, `document.activeElement`
  // is `.ic-workbook-container`, not the dialog. Two things break silently as a
  // result. A modal's Escape and focus trap are installed by `useModalA11y` on
  // the *panel*, so a panel that has lost focus has lost both. A popover's
  // Escape rides a document listener, and the widget's own Escape handler stops
  // the event inside React's root before it gets there. Worse, a find box that
  // cannot hold focus sends the next keystroke into a cell.
  //
  // `inert` is the fix and the right semantics: while one of our surfaces is
  // up, the grid behind it is inert. The funnel buttons go inert with it, which
  // is correct — a second column's filter waits for the first to be answered.
  const overlayOpen = open !== null || filterColumn !== null
  openRef.current = overlayOpen

  /**
   * Rendered in the header block rather than as a row of its own: a grid
   * already stacks IronCalc's toolbar and formula bar above it, and a
   * separately bordered bar of ours made a fourth band of chrome. In
   * fullscreen there is no header block, so it leads the body instead.
   */
  const actionBar = (
    <SpreadsheetActionBar
      canWrite={canWrite && !engineMigrating}
      compact={phone}
      filterButtonRef={filterAnchor}
      filterOpen={filterColumn !== null}
      findButtonRef={findAnchor}
      findOpen={open === 'find'}
      formatBarVisible={formatBarVisible}
      framed={fullscreen}
      fullscreen={fullscreen}
      onSelect={onAction}
      showFormatToggle={phone}
    />
  )

  const body = (
    <div className="spreadsheet-pane relative flex h-full min-h-0 flex-col" data-testid="spreadsheet-pane">
      {fullscreen ? actionBar : null}

      {filterModel ? (
        <FilterChipsBar
          headerLabels={headerLabels}
          model={filterModel}
          onClearAll={() =>
            filterMutations.clear.mutate(sheet, { onError: onActionError('Clear filters') })}
          onClearColumn={(column) => {
            const columns = { ...filterModel.columns }
            delete columns[column]
            filterMutations.set.mutate(
              { model: { ...filterModel, columns }, sheet },
              { onError: onActionError('Clear filter') },
            )
          }}
          onReapply={() =>
            filterMutations.reapply.mutate(sheet, { onError: onActionError('Re-apply') })}
          pending={filterMutations.reapply.isPending || filterMutations.set.isPending}
        />
      ) : null}

      <PresenceStrip peers={peers} />

      {engineMigrating ? (
        <Notice className="mx-3 mt-2" size="sm" tone="warning">
          This spreadsheet is being rebuilt on engine {SPREADSHEET_ENGINE_VERSION}. You can read it;
          edits are refused until that finishes.
        </Notice>
      ) : null}
      {liveStatus === 'offline' ? (
        <Notice className="mx-3 mt-2" data-testid="spreadsheet-offline-notice" size="sm" tone="warning">
          Offline — your edits are queued and will be sent when the connection comes back.
        </Notice>
      ) : null}
      {actionError ? (
        <Notice
          className="mx-3 mt-2 flex items-center gap-3"
          data-testid="spreadsheet-action-error"
          role="alert"
          size="sm"
          tone="danger"
        >
          <span className="min-w-0 flex-1">{actionError}</span>
          <button
            className="admin-button admin-button-secondary admin-button-compact"
            onClick={() => setActionError(null)}
            type="button"
          >
            Dismiss
          </button>
        </Notice>
      ) : null}
      {notice ? (
        <SpreadsheetVersionSavedNoticeBar
          notice={notice}
          onDismiss={() => setDismissedNotice(notice.versionId)}
          onRestore={(versionId) => {
            restoreVersion.mutate(
              { pageId: page.id, versionId },
              { onError: onActionError('Restore') },
            )
            setDismissedNotice(notice.versionId)
          }}
          pending={busy}
        />
      ) : null}

      {bootstrapQuery.isError ? (
        <div className="p-6">
          <Notice tone="danger">
            This spreadsheet could not be opened.{' '}
            <button className="underline" onClick={() => void bootstrapQuery.refetch()} type="button">
              Retry
            </button>
          </Notice>
        </div>
      ) : bootstrap ? (
        <div
          className="relative flex min-h-0 flex-1 flex-col"
          data-format-bar={formatBarVisible || !phone ? 'shown' : 'hidden'}
          inert={overlayOpen}
          ref={gridBounds}
        >
          <WorkbookHost
            bootstrap={bootstrap}
            canEdit={canWrite && !engineMigrating}
            onFlush={handleFlush}
            onPresence={handlePresence}
            onSession={handleSession}
          />
          {filterModel ? (
            <FilterHeaderButtons
              activeColumns={new Set(Object.keys(filterModel.columns).map(Number))}
              bounds={gridBounds.current}
              container={scrollContainer}
              model={model}
              onOpen={(column, anchor) => {
                columnAnchor.current = anchor
                setFilterColumn(column)
              }}
              range={filterModel.range}
              revision={revision}
              sheet={sheet}
            />
          ) : null}
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-[color:var(--tx3)]">
          Opening {page.title}…
        </div>
      )}

      {open === 'sort' && selection ? (
        <SpreadsheetSortDialog
          headerLabels={headerLabels}
          onClose={() => setOpen(null)}
          onSubmit={(request) => {
            restructure.mutate(
              { ...request, action: 'sort' },
              { onError: onActionError('Sort') },
            )
            setOpen(null)
          }}
          open
          pending={restructure.isPending}
          selection={selection}
          sheet={sheet}
          sheetName={sheetName}
        />
      ) : null}

      {open === 'save-version' ? (
        <SpreadsheetSaveVersionDialog
          onClose={() => setOpen(null)}
          onSubmit={(changeComment) => {
            saveVersion.mutate({ changeComment }, { onError: onActionError('Save version') })
            setOpen(null)
          }}
          open
          pending={saveVersion.isPending}
        />
      ) : null}

      {open === 'export' ? (
        <SpreadsheetExportDialog
          filtered={Boolean(filterModel)}
          onClose={() => setOpen(null)}
          onExport={({ format, sheet: only }) => {
            download(
              spreadsheetExportPath(page.id, format, only === undefined ? {} : { sheet: only }),
              `${page.title}.${format}`,
            )
            setOpen(null)
          }}
          open
          sheets={sheets}
        />
      ) : null}

      {open === 'history' ? (
        <div
          className="absolute inset-0 bg-[color:var(--panel)]"
          data-testid="spreadsheet-history-layer"
        >
          <div className="flex items-center justify-between border-b border-[color:var(--sep)] px-4 py-2">
            <span className="text-sm font-semibold text-[color:var(--tx)]">Version history</span>
            <button
              className="admin-button admin-button-secondary admin-button-compact"
              onClick={() => setOpen(null)}
              type="button"
            >
              Close
            </button>
          </div>
          <div className="h-[calc(100%-2.75rem)]">
            <SpreadsheetHistoryPanel
              canRestore={canWrite && !engineMigrating}
              onDownload={(versionId) =>
                download(
                  spreadsheetExportPath(page.id, 'xlsx', { versionId }),
                  `${page.title}.xlsx`,
                )}
              onRestore={(versionId) =>
                restoreVersion.mutate(
                  { pageId: page.id, versionId },
                  { onError: onActionError('Restore') },
                )}
              pending={busy}
              versions={versionsQuery.data ?? []}
            />
          </div>
        </div>
      ) : null}

      {filterColumn !== null && filterModel ? (
        <FilterPopover
          anchorRef={columnAnchor.current ? columnAnchor : filterAnchor}
          column={filterColumn}
          columnValues={columnValues}
          criterion={filterModel.columns[filterColumn]}
          headerLabel={headerLabels?.[filterColumn]}
          onApply={(criterion: SpreadsheetFilterCriterion) => {
            filterMutations.set.mutate(
              {
                model: {
                  ...filterModel,
                  columns: { ...filterModel.columns, [filterColumn]: criterion },
                },
                sheet,
              },
              { onError: onActionError('Filter') },
            )
            setFilterColumn(null)
          }}
          onClear={() => {
            const columns = { ...filterModel.columns }
            delete columns[filterColumn]
            filterMutations.set.mutate(
              { model: { ...filterModel, columns }, sheet },
              { onError: onActionError('Clear filter') },
            )
            setFilterColumn(null)
          }}
          onClose={() => setFilterColumn(null)}
          onSort={(direction) => {
            restructure.mutate(
              {
                action: 'sort',
                hasHeaderRow: true,
                keys: [{ column: filterColumn, direction }],
                range: filterModel.range,
                sheet,
              },
              { onError: onActionError('Sort') },
            )
            setFilterColumn(null)
          }}
          open
        />
      ) : null}

      <FindReplacePopover
        anchorRef={findAnchor}
        canWrite={canWrite && !engineMigrating}
        model={model}
        onClose={() => setOpen(null)}
        onReplace={(input) => {
          setReplaceResult(undefined)
          replace.mutate(
            { ...toReplaceInput(input), selection, sheet },
            { onError: onActionError('Replace'), onSuccess: setReplaceResult },
          )
        }}
        onStep={(match: FindMatch) => {
          if (!model) return
          if (match.sheet !== sheet) model.setSelectedSheet(match.sheet)
          model.setSelectedCell(match.row, match.column)
          session?.redraw()
        }}
        open={open === 'find'}
        replacePending={replace.isPending}
        replaceResult={replaceResult}
        revision={revision}
        selection={selection}
        sheet={sheet}
        sheets={sheets}
      />
    </div>
  )

  if (fullscreen) {
    return (
      <div
        className="fixed inset-0 bg-[color:var(--main)]"
        data-testid="spreadsheet-fullscreen"
        style={{ zIndex: OVERLAY_LAYER.modal }}
      >
        {body}
      </div>
    )
  }

  return (
    <KnowledgePane actions={headerActions} below={actionBar} onBack={onBack} title={page.title}>
      {body}
    </KnowledgePane>
  )
}

const normalise = (range: [number, number, number, number]): SpreadsheetSelection => ({
  c0: Math.min(range[1], range[3]),
  c1: Math.max(range[1], range[3]),
  r0: Math.min(range[0], range[2]),
  r1: Math.max(range[0], range[2]),
})

const toReplaceInput = (input: FindOptions & { all: boolean; replacement: string }) => ({
  all: input.all,
  inFormulas: input.inFormulas,
  matchCase: input.matchCase,
  query: input.query,
  regex: input.regex,
  replacement: input.replacement,
  scope: input.scope,
  wholeCell: input.wholeCell,
})

/** Exported so the pane can name a selection in a log or a tool card. */
export const describeSelection = (selection?: SpreadsheetSelection): string =>
  selection ? formatA1Range(selection) : ''

export default SpreadsheetPane
