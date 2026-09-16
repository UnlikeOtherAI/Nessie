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

// IronCalc builds `workbookState` in its *root* render body, so a re-render of
// the root throws away in-cell editing state (decisions.md §"Spike C/D" item 7).
// `redraw()` only re-renders the Workbook subtree and is safe; everything here
// therefore keeps the root's props referentially stable and repaints through
// the handle instead of through React.
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
      redraw: () => handleRef.current?.redraw(),
    })
    return () => {
      bridge.detach()
      sessionRef.current?.(null)
    }
  }, [built])

  // One mapping covers all eleven admin themes, so the only trigger is "the
  // document's theme attribute changed". The canvas re-reads the variables in
  // `WorksheetCanvas`'s dependency-free effect, so a redraw is what paints it.
  useEffect(() => {
    const root = document.documentElement
    const apply = () => setTheme(spreadsheetThemeVariables(root))
    apply()
    const observer = new MutationObserver(() => {
      apply()
      handleRef.current?.redraw()
    })
    observer.observe(root, { attributeFilter: ['data-theme', 'class', 'style'] })
    return () => observer.disconnect()
  }, [])

  // The widget mutates this object into CSS custom properties on its root, so a
  // new identity every render would restyle (and re-render) on every keystroke.
  const themeVariables = useMemo(() => theme, [theme])

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
      {built && themeVariables ? (
        <IronCalc
          canEdit={canEdit}
          model={built.model}
          ref={handleRef}
          rootContainer={hostRef.current}
          themeVariables={themeVariables}
        />
      ) : (
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
