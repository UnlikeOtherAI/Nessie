import { IronCalc, type IronCalcHandle, type Model } from '@ironcalc/workbook'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { SpreadsheetBootstrap } from '@nessie/schemas'
import '@ironcalc/workbook/style.css'
import './spreadsheet.css'
import {
  attachModelBridge,
  type BridgeFlush,
  type PresenceFrame,
} from './spreadsheet-model-bridge'
import { spreadsheetThemeVariables, type SpreadsheetThemeVariables } from './spreadsheet-theme'
import { buildWorkbook, initSpreadsheetEngine } from './workbook-engine'

/** What the live layer (Phase 3b) is handed once the model is on screen. */
export type WorkbookSession = {
  /** The seq the bootstrap left the model at. */
  appliedSeq: number
  /** Apply a peer's batch without echoing it back into the send queue. */
  applyExternal: (diffs: Uint8Array) => void
  /** Drain the send queue now rather than on the next microtask. */
  flushNow: () => void
  handle: IronCalcHandle | null
  /** Batches the bootstrap could not inline; 3b fetches them by seq. */
  missingSeqs: number[]
  model: Model
  /** Repaint after the model changed from outside the widget. */
  redraw: () => void
}

type WorkbookHostProps = {
  bootstrap: SpreadsheetBootstrap
  canEdit: boolean
  /** Fired for every local batch: `{ calls, diffs, intents }`. */
  onFlush: (flush: BridgeFlush) => void
  /** Selection frames, for 3b's presence sender. Ignored in 3a. */
  onPresence?: (frame: PresenceFrame) => void
  /** The model and handle, once mounted; null again when the host unmounts. */
  onSession?: (session: WorkbookSession | null) => void
}

/**
 * Repaint the grid after the model changed from outside the widget.
 *
 * `@ironcalc/workbook` 0.8.3 renders the grid to a canvas and publishes no
 * repaint: `IronCalcHandle` has `setLanguage` and nothing else. The one thing
 * that paints the canvas from the current model is a re-render of the widget's
 * **`Workbook` subtree** — `Worksheet` rebuilds `WorksheetCanvas` and calls
 * `renderSheet()` in a dependency-free effect — and `Workbook` drives that from
 * a private `useState` counter it bumps after each of its own actions.
 *
 * Every keyboard action the widget handles bumps that counter, and exactly one
 * of them changes nothing else that has to be kept: **Escape**. Its handler
 * clears the cut outline and disarms the format painter
 * (`WorkbookState.clearCutRange()` / `setCopyStyles(null)`, both drawing state
 * — a paste still reads `type: "cut"` off the clipboard payload) and then
 * bumps the counter. So a synthetic `keydown` is the repaint.
 *
 * **Why it is dispatched on `.ic-workbook-container` and not on the document.**
 * The widget's key handler starts with `event.target !== root` → return, so
 * targeting that element is what makes it run — and it is also what keeps the
 * event away from the cell editor's own handlers, which sit on the `<textarea>`
 * below it. React's synthetic `stopPropagation()` (the widget calls it for
 * every unmodified key) calls `stopPropagation()` on the native event too, so
 * the event dies at React's root container: nothing on `document`, `body` or
 * `window` in the bubble phase ever sees it. Capture-phase listeners do, which
 * is why `SpreadsheetPane`'s fullscreen Escape checks `event.isTrusted`.
 *
 * Measured against the `redraw()` patch this replaces (`spike-cd-render-touch.md`
 * §"The repaint, from outside the package"): identical on the canvas bytes, the
 * address box, the formula bar, the sheet tab bar, frozen panes (both the frozen
 * band and the scrolled body), a batch landing mid-scroll, the scroll position
 * afterwards, and an editor left open with its text while a peer's batch lands.
 *
 * `WorkbookState` is built in the widget's **root** render body, so a root
 * re-render throws away in-cell editing state (decisions.md §"Spike C/D" item
 * 7). This re-renders the subtree, not the root — which is also why everything
 * here keeps the root's props referentially stable.
 */
const repaintGrid = (host: HTMLElement | null): void => {
  const container = host?.querySelector('.ic-workbook-container')
  if (!container) return
  container.dispatchEvent(
    new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }),
  )
}

export const WorkbookHost = ({
  bootstrap,
  canEdit,
  onFlush,
  onPresence,
  onSession,
}: WorkbookHostProps) => {
  const hostRef = useRef<HTMLDivElement>(null)
  const handleRef = useRef<IronCalcHandle>(null)
  const [built, setBuilt] = useState<{ appliedSeq: number; missingSeqs: number[]; model: Model }>()
  const [error, setError] = useState<string>()
  const [theme, setTheme] = useState<SpreadsheetThemeVariables>()

  // Callbacks are read through refs so a parent that re-renders with fresh
  // closures never re-runs the bridge effect and never re-mounts the widget.
  const flushRef = useRef(onFlush)
  const presenceRef = useRef(onPresence)
  const sessionRef = useRef(onSession)
  useEffect(() => {
    flushRef.current = onFlush
    presenceRef.current = onPresence
    sessionRef.current = onSession
  })

  const snapshotKey = `${bootstrap.pageId}:${bootstrap.snapshot.seq}`
  useEffect(() => {
    let cancelled = false
    void initSpreadsheetEngine()
      .then(() => {
        if (cancelled) return
        setBuilt(buildWorkbook(bootstrap))
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => { cancelled = true }
    // Rebuilding on every `bootstrap` identity would throw away local edits on
    // any parent re-render; the snapshot a page was bootstrapped from is what
    // actually decides whether this is a different workbook.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshotKey])

  useEffect(() => {
    if (!built) return
    const { appliedSeq, missingSeqs, model } = built
    const bridge = attachModelBridge(model, {
      onFlush: (flush) => flushRef.current(flush),
      onPresence: (frame) => presenceRef.current?.(frame),
    })
    sessionRef.current?.({
      appliedSeq,
      applyExternal: bridge.applyExternal,
      flushNow: bridge.flushNow,
      handle: handleRef.current,
      missingSeqs,
      model,
      redraw: () => repaintGrid(hostRef.current),
    })
    return () => {
      bridge.detach()
      sessionRef.current?.(null)
    }
  }, [built])

  // One mapping covers all eleven admin themes, so the only trigger is "the
  // document's theme attribute changed". The canvas re-reads the variables in
  // `WorksheetCanvas`'s dependency-free effect, so a repaint is what paints it.
  useEffect(() => {
    const root = document.documentElement
    const apply = () => setTheme(spreadsheetThemeVariables(root))
    apply()
    const observer = new MutationObserver(() => {
      apply()
      repaintGrid(hostRef.current)
    })
    observer.observe(root, { attributeFilter: ['data-theme', 'class', 'style'] })
    return () => observer.disconnect()
  }, [])

  // The widget mutates this object into CSS custom properties on its root, so a
  // new identity every render would restyle (and re-render) on every keystroke.
  const themeVariables = useMemo(() => theme, [theme])

  /**
   * The widget element itself is memoised, and that is load-bearing.
   *
   * `IronCalc` builds `new WorkbookState()` in its **root render body**, so
   * every re-render of the root throws away whatever cell was being edited
   * (decisions.md §"Spike C/D" item 7). Referentially stable *props* do not
   * prevent that: React re-renders a child whenever its parent renders,
   * whatever the props are. The one thing that does is handing React the same
   * element object, which makes it bail out of the subtree entirely.
   *
   * Without this, typing into a cell does nothing at all in the real app. The
   * widget's key handler sets the editing cell on the `WorkbookState` it was
   * holding, a parent render — a presence frame, a peer's batch, a filter
   * query settling — replaces that object before the paint, and the editor
   * reads `getEditingCell() === null` and stays hidden. Measured by driving
   * the running page: the editing cell was set with the typed character, and
   * the `workbookState` the next commit rendered against was a different
   * object.
   */
  const workbook = useMemo(
    () =>
      built && themeVariables
        ? (
            <IronCalc
              canEdit={canEdit}
              model={built.model}
              ref={handleRef}
              rootContainer={hostRef.current}
              themeVariables={themeVariables}
            />
          )
        : null,
    [built, canEdit, themeVariables],
  )

  if (error) {
    return (
      <div
        className="flex h-full items-center justify-center p-6 text-sm text-[color:var(--danger-text)]"
        data-testid="spreadsheet-engine-error"
      >
        The spreadsheet engine could not start: {error}
      </div>
    )
  }

  return (
    <div className="spreadsheet-widget-host flex" data-testid="spreadsheet-widget-host" ref={hostRef}>
      {workbook ?? (
        <div
          className="flex h-full w-full items-center justify-center text-sm text-[color:var(--tx3)]"
          data-testid="spreadsheet-engine-loading"
        >
          Loading the grid…
        </div>
      )}
    </div>
  )
}
