// Spike C/D host. Throwaway: this file is the seed for Phase 3a's
// WorkbookHost.tsx and is deleted from the branch once the spike is recorded.
import { init, IronCalc, Model, type IronCalcHandle } from '@ironcalc/workbook'
import wasmUrl from '@ironcalc/wasm/wasm_bg.wasm?url'
import { useEffect, useRef, useState } from 'react'
import '@ironcalc/workbook/style.css'
import { attachModelBridge, type BridgeFlush, type ModelBridge, type PresenceFrame } from './spreadsheet-model-bridge'
import { spreadsheetThemeVariables } from './spreadsheet-theme'
import { attachTouchSelection } from './useTouchSelection'

declare global {
  interface Window { __spike?: SpikeApi }
}

interface SpikeApi {
  applyPeerBatch: (cell?: string, value?: string, redraw?: boolean) => Record<string, unknown>
  cell: (row: number, column: number) => string
  cellPoint: (row: number, column: number) => { x: number, y: number }
  pairProbe: () => Record<string, unknown>
  flushes: BridgeFlush[]
  intentLog: string[]
  presence: PresenceFrame[]
  insertRow: (row?: number) => void
  ready: true
  recorded: string[]
  redraw: () => void
  selection: () => number[]
  setTheme: (theme: string) => void
  touchMode: () => boolean
  undo: () => void
  redo: () => void
}

const seed = (model: Model): void => {
  model.setUserInput(0, 1, 1, 'Region')
  model.setUserInput(0, 1, 2, 'Q3')
  model.setUserInput(0, 2, 1, 'North')
  model.setUserInput(0, 2, 2, '120')
  model.setUserInput(0, 3, 1, 'South')
  model.setUserInput(0, 3, 2, '80')
  model.setUserInput(0, 4, 1, 'Total')
  model.setUserInput(0, 4, 2, '=SUM(B2:B3)')
  model.evaluate()
  model.flushSendQueue()
}

const SpikeWorkbook = (): React.ReactElement => {
  const host = useRef<HTMLDivElement>(null)
  const handle = useRef<IronCalcHandle>(null)
  const [model, setModel] = useState<Model | undefined>()
  const [theme, setTheme] = useState<Record<string, string>>({})
  const [status, setStatus] = useState('loading engine…')
  const [touchDebug, setTouchDebug] = useState('')
  const bridge = useRef<ModelBridge>(undefined)
  const peer = useRef<Model>(undefined)

  useEffect(() => {
    let cancelled = false
    void init({ module_or_path: wasmUrl }).then(() => {
      if (cancelled) return
      const created = new Model('Spike', 'en-GB', 'UTC', 'en')
      seed(created)
      peer.current = Model.from_bytes(created.toBytes(), 'en')
      peer.current.flushSendQueue()
      setModel(created)
      setStatus('ready')
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!model) return
    const flushes: BridgeFlush[] = []
    const presence: PresenceFrame[] = []
    const attached = attachModelBridge(model, {
      onFlush: (flush) => { flushes.push(flush) },
      onPresence: (frame) => { presence.push(frame) },
    })
    bridge.current = attached
    window.__spike = {
      // A second, independent model forked from the mounted one's current
      // bytes plays the remote peer: it makes one edit, `flushSendQueue()`
      // gives the diffs, and the mounted model applies them the way the live
      // lane will. Forking at call time is what makes `bytesEqual` mean
      // something -- both models start from the same state.
      applyPeerBatch: (cell = 'B3', value = '999', repaint = true) => {
        attached.flushNow()
        const source = Model.from_bytes(model.toBytes(), 'en')
        peer.current = source
        const emptyFlush = source.flushSendQueue().length
        const row = Number(cell.slice(1))
        const column = cell.charCodeAt(0) - 64
        source.setUserInput(0, row, column, value)
        source.evaluate()
        const diffs = source.flushSendQueue()
        const before = model.getFormattedCellValue(0, row, column)
        attached.applyExternal(diffs)
        if (repaint) handle.current?.redraw()
        const echoed = model.flushSendQueue()
        const mine = model.toBytes()
        const theirs = source.toBytes()
        let firstDiff = -1
        for (let i = 0; i < Math.max(mine.length, theirs.length); i += 1) {
          if (mine[i] !== theirs[i]) { firstDiff = i; break }
        }
        return {
          after: model.getFormattedCellValue(0, row, column),
          before,
          byteLengths: [mine.length, theirs.length],
          bytesEqual: firstDiff === -1,
          diffBytes: diffs.length,
          echoedBytes: Array.from(echoed),
          emptyFlushBytes: emptyFlush,
          firstDiff,
          firstDiffWindow: firstDiff < 0 ? [] : [
            Array.from(mine.slice(Math.max(firstDiff - 6, 0), firstDiff + 10)),
            Array.from(theirs.slice(Math.max(firstDiff - 6, 0), firstDiff + 10)),
          ],
        }
      },
      cell: (row, column) => model.getFormattedCellValue(0, row, column),
      // Two pristine models built the same way: one edited directly, one fed
      // the other's diffs. Cell values must agree; whether `toBytes()` agrees
      // is the question Phase 0's engine-pair test owns, and this is the
      // browser half of the answer.
      pairProbe: () => {
        const left = new Model('Pair', 'en-GB', 'UTC', 'en')
        seed(left)
        const right = Model.from_bytes(left.toBytes(), 'en')
        right.flushSendQueue()
        const forkEqual = String(left.toBytes()) === String(right.toBytes())
        left.setUserInput(0, 2, 2, '77')
        left.evaluate()
        const diffs = left.flushSendQueue()
        right.pauseEvaluation()
        right.applyExternalDiffs(diffs)
        right.resumeEvaluation()
        right.evaluate()
        const leftBytes = left.toBytes()
        const rightBytes = right.toBytes()
        let firstDiff = -1
        for (let i = 0; i < Math.max(leftBytes.length, rightBytes.length); i += 1) {
          if (leftBytes[i] !== rightBytes[i]) { firstDiff = i; break }
        }
        const again = Model.from_bytes(rightBytes, 'en')
        const settles = String(again.toBytes()) === String(rightBytes)
        const base = new Model('Pair', 'en-GB', 'UTC', 'en')
        seed(base)
        const baseBytes = base.toBytes()
        const window0 = Array.from(baseBytes.slice(36, 56))
        const forkA = Model.from_bytes(baseBytes, 'en').toBytes()
        const forkB = Model.from_bytes(baseBytes, 'en').toBytes()
        const window1 = Array.from(forkA.slice(36, 56))
        const twoForksEqual = String(forkA) === String(forkB)
        const selfEqual = String(base.toBytes()) === String(baseBytes)
        return {
          bytesEqualAfterDiff: firstDiff === -1,
          bytesEqualAfterFork: forkEqual,
          firstDiff,
          lengths: [leftBytes.length, rightBytes.length],
          roundTripSettles: settles,
          selfEqual,
          twoForksEqual,
          window: [window0.join(','), window1.join(',')],
          valuesEqual: ['77', '157'].every((value, index) => (
            [left, right].every((m) => m.getFormattedCellValue(0, index === 0 ? 2 : 4, 2) === value)
          )),
        }
      },
      // Canvas-relative centre of a cell, by the same sums
      // WorksheetCanvas.getCoordinatesByCell uses (28px row header, 30px
      // column header). The e2e driver taps through this, never through
      // hard-coded pixels.
      cellPoint: (row, column) => {
        const view = model.getSelectedView()
        let x = 30
        for (let c = view.left_column; c < column; c += 1) x += model.getColumnWidth(0, c)
        let y = 28
        for (let r = view.top_row; r < row; r += 1) y += model.getRowHeight(0, r)
        return { x: x + model.getColumnWidth(0, column) / 2, y: y + model.getRowHeight(0, row) / 2 }
      },
      flushes,
      insertRow: (row = 2) => { model.insertRows(0, row, 1); model.evaluate(); handle.current?.redraw() },
      intentLog: [],
      presence,
      recorded: attached.recorded,
      redo: () => { model.redo(); model.evaluate(); handle.current?.redraw() },
      redraw: () => handle.current?.redraw(),
      ready: true,
      selection: () => Array.from(model.getSelectedView().range),
      setTheme: (next) => {
        document.documentElement.dataset.theme = next
        setTheme(spreadsheetThemeVariables(document.documentElement))
      },
      touchMode: () => host.current?.querySelector<HTMLElement>('.ic-worksheet-sheet-container')?.dataset.spikeSelecting === 'true',
      undo: () => { model.undo(); model.evaluate(); handle.current?.redraw() },
    }
    setTheme(spreadsheetThemeVariables(document.documentElement))
    return () => { attached.detach(); delete window.__spike }
  }, [model])

  useEffect(() => {
    if (!model || !host.current) return
    const container = host.current.querySelector<HTMLElement>('.ic-worksheet-sheet-container')
    if (!container) return
    return attachTouchSelection(container, {
      model,
      onDebug: setTouchDebug,
      redraw: () => handle.current?.redraw(),
    })
  }, [model, status])

  return (
    <div className="spike-shell" ref={host}>
      <div className="spike-bar">
        <span data-testid="spike-status">{status}</span>
        <span data-testid="spike-touch-debug">{touchDebug}</span>
        <button onClick={() => window.__spike?.setTheme('daylight')} type="button">Light</button>
        <button onClick={() => window.__spike?.setTheme('midnight')} type="button">Dark</button>
        <button onClick={() => window.__spike?.applyPeerBatch()} type="button">Peer edit</button>
        <button onClick={() => window.__spike?.insertRow()} type="button">Insert row</button>
        <button onClick={() => window.__spike?.undo()} type="button">Undo</button>
        <button onClick={() => window.__spike?.redo()} type="button">Redo</button>
      </div>
      <div className="spike-widget">
        {model ? (
          <IronCalc
            canEdit
            model={model}
            ref={handle}
            rootContainer={host.current}
            themeVariables={theme}
          />
        ) : null}
      </div>
    </div>
  )
}

export default SpikeWorkbook
