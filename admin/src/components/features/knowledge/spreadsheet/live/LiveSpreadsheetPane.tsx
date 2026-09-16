import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { KnowledgePageRecord } from '../../../../../facades/knowledge/hooks'
import { useSpreadsheetBootstrap } from '../../../../../facades/knowledge/spreadsheet-hooks'
import { SpreadsheetPane } from '../SpreadsheetPane'
import type { WorkbookSession } from '../WorkbookHost'
import type { PresenceFrame } from '../spreadsheet-model-bridge'
import { PresenceOverlay } from './PresenceOverlay'
import { SpreadsheetConflictNotice } from './SpreadsheetConflictNotice'
import { useDraftObserver } from './useDraftObserver'
import { useSpreadsheetLive } from './useSpreadsheetLive'
import { useTouchSelection } from './useTouchSelection'
import './spreadsheet-live.css'

/**
 * The spreadsheet pane, alive.
 *
 * Phase 3a built the pane and left five named seams on it — `onSession`,
 * `onFlush`, `onPresence`, `peers`, `liveStatus`, `versionNotice`. This
 * component is what fills them, and it is the lazy chunk's entry point so the
 * live lane costs `/knowledge-base` nothing: `SpreadsheetPane` itself is
 * untouched and still renders on its own in the shell suite's fixture.
 *
 * The overlay is portalled into a layer this file appends to the widget host
 * rather than rendered as a sibling of the pane. Two reasons, both measured
 * elsewhere in this program:
 *
 *  - the host is `position: relative` and **moves with the pane into
 *    fullscreen**, so the peers' rectangles keep landing on the cells they
 *    name instead of being left behind at the inline pane's old coordinates;
 *  - it is a plain DOM node this file creates, so React never reconciles it
 *    against IronCalc's own children. Portalling into a node two renderers
 *    both write to is how a widget's subtree gets torn out from under it.
 */

type LiveSpreadsheetPaneProps = {
  /**
   * What the *browser* believes, from the space the row was found in. It is
   * the optimistic answer that holds until the bootstrap arrives, never the
   * authority: see `mayWrite` below.
   */
  canWrite: boolean
  onBack?: () => void
  page: KnowledgePageRecord
}

/** The absolutely-positioned layer the overlay is portalled into. */
const useOverlayLayer = (host: HTMLElement | null): HTMLDivElement | null => {
  const [layer, setLayer] = useState<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!host) { setLayer(null); return undefined }
    const element = host.ownerDocument.createElement('div')
    element.className = 'spreadsheet-live-layer'
    host.appendChild(element)
    setLayer(element)
    return () => {
      element.remove()
      setLayer(null)
    }
  }, [host])
  return layer
}

export const LiveSpreadsheetPane = ({ canWrite, onBack, page }: LiveSpreadsheetPaneProps) => {
  // Whether this viewer may write *this page* — the server's own verdict, from
  // the bootstrap it already fetched (same query key, so no second request).
  // A space-membership check is the wrong question once a page can be shared
  // person to person: an `edit` grantee writes a page inside somebody else's
  // personal space, and a `view` grantee must not write one inside a space
  // they can otherwise edit. The prop stands in only until the answer lands.
  const bootstrap = useSpreadsheetBootstrap(page.id).data
  const mayWrite = bootstrap ? bootstrap.viewer.canWrite : canWrite
  const live = useSpreadsheetLive({ canWrite: mayWrite, pageId: page.id })
  const rootRef = useRef<HTMLDivElement>(null)
  const [session, setSession] = useState<WorkbookSession | null>(null)
  const [host, setHost] = useState<HTMLElement | null>(null)
  const [container, setContainer] = useState<HTMLElement | null>(null)
  const [sheet, setSheet] = useState(0)
  const layer = useOverlayLayer(host)

  const onSession = useCallback((next: WorkbookSession | null) => {
    setSession(next)
    if (next) setSheet(next.model.getSelectedView().sheet)
    live.onSession(next)
    // `live.onSession` is rebuilt on every render of this component; reading it
    // through the closure here would re-run the host's bridge effect and
    // re-mount the widget, which throws away in-cell editing state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // IronCalc's own elements exist only once the widget has mounted, so they
  // are looked up after the session arrives — and as state, because a ref
  // assignment schedules no render and the overlay would measure `null` once
  // and never look again (the mistake Phase 3a's funnel buttons made first).
  useEffect(() => {
    const root = rootRef.current
    if (!session || !root) { setContainer(null); setHost(null); return }
    setHost(root.querySelector<HTMLElement>('[data-testid="spreadsheet-widget-host"]'))
    setContainer(root.querySelector<HTMLElement>('.ic-worksheet-sheet-container'))
  }, [session, live.revision])

  const onPresence = useCallback((frame: PresenceFrame) => {
    setSheet(frame.sheet)
    live.onPresence(frame)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onTouchChanged = useCallback(() => {
    session?.redraw()
    // A finger dragging out a range is a selection change like any other, so
    // peers watch it move rather than seeing it jump when the finger lifts.
    live.onPresence({ column: 0, range: [0, 0, 0, 0], row: 0, sheet })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, sheet])

  const touch = useTouchSelection({
    bounds: host,
    canEdit: mayWrite && !live.engineMigrating,
    container,
    model: session?.model ?? null,
    onChanged: onTouchChanged,
    revision: live.revision,
    sheet,
  })

  useDraftObserver({ enabled: mayWrite, host, onDraft: live.onDraft })

  // `touch-action: none` on the scroll element while a range is being dragged.
  // It is set on the element rather than in a class so it can be lifted the
  // instant the finger goes up: leaving it on would stop the sheet scrolling.
  useEffect(() => {
    if (!container) return undefined
    container.style.touchAction = touch.selecting ? 'none' : ''
    return () => { container.style.touchAction = '' }
  }, [container, touch.selecting])

  return (
    <div className="relative flex h-full w-full flex-col" ref={rootRef}>
      {/* In flow, not floated over the pane: a line that covers the action bar
          is a line that takes a control away to say something about it. */}
      {live.liveError ? (
        <SpreadsheetConflictNotice
          message={live.liveError}
          onDismiss={live.dismissLiveError}
          testId="spreadsheet-live-error"
          tone="danger"
        />
      ) : null}
      {live.conflictNotice ? (
        <SpreadsheetConflictNotice
          message={live.conflictNotice}
          onDismiss={live.dismissConflictNotice}
        />
      ) : null}
      <div className="relative min-h-0 flex-1">
      <SpreadsheetPane
        canWrite={mayWrite}
        engineMigrating={live.engineMigrating}
        liveStatus={live.liveStatus}
        onBack={onBack}
        onFlush={live.onFlush}
        onPresence={onPresence}
        onSession={onSession}
        page={page}
        peers={live.peers}
        versionNotice={live.versionNotice}
      />
      </div>
      {layer
        ? createPortal(
            <PresenceOverlay
              bounds={host}
              container={container}
              model={session?.model ?? null}
              peers={live.peerFrames}
              revision={live.revision}
              sheet={sheet}
              touchHandles={touch.handles}
            />,
            layer,
          )
        : null}
    </div>
  )
}

export default LiveSpreadsheetPane
