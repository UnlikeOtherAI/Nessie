// Method shadowing, not a fork (admin-ui.md §"Method shadowing, not a fork").
//
// Own-property wrappers are installed on the live wasm `Model` instance. Every
// mutating call runs the prototype method first, then records a
// `SpreadsheetIntent` (method + args) and schedules one microtask that drains
// the engine's send queue into the sink. Selection-only calls emit a presence
// frame instead of an intent. Because the wrappers are own properties on the
// real instance, `__wbg_ptr` and every pointer-taking method are untouched and
// the IronCalc widget keeps calling the same object it was handed.
import type { Model } from '@ironcalc/wasm'

export interface SpreadsheetIntent {
  method: string
  args: unknown[]
  at: number
}

export interface PresenceFrame {
  sheet: number
  row: number
  column: number
  range: [number, number, number, number]
}

export interface BridgeFlush {
  intents: SpreadsheetIntent[]
  diffs: Uint8Array
}

export interface BridgeOptions {
  onFlush: (flush: BridgeFlush) => void
  onPresence?: (frame: PresenceFrame) => void
}

// Reads, queue drains and the external-diff door are never recorded: they
// produce no diffs of their own, and recording `applyExternalDiffs` would echo
// a peer's batch straight back at the server.
const NON_RECORDING = new Set([
  'applyExternalDiffs',
  'canRedo',
  'canUndo',
  'constructor',
  'copyToClipboard',
  'cycleReference',
  'evaluate',
  'flushSendQueue',
  'free',
  'isValidDefinedName',
  'pauseEvaluation',
  'resolveColor',
  'resumeEvaluation',
  'toBytes',
])

// Selection and viewport. These mutate the model but carry no document
// meaning, so they become presence frames rather than journal intents.
const SELECTION = new Set([
  'onAreaSelecting',
  'onArrowDown',
  'onArrowLeft',
  'onArrowRight',
  'onArrowUp',
  'onExpandSelectedRange',
  'onNavigateToEdgeInDirection',
  'onPageDown',
  'onPageUp',
  'setSelectedCell',
  'setSelectedRange',
  'setSelectedSheet',
  'setTopLeftVisibleCell',
  'setWindowHeight',
  'setWindowWidth',
])

const isRecordable = (name: string): boolean =>
  !NON_RECORDING.has(name)
  && !SELECTION.has(name)
  // wasm-bindgen's own plumbing (`__destroy_into_raw`, `__wbg_*`) is on the
  // same prototype and must never be shadowed.
  && !name.startsWith('_')
  && !name.startsWith('get')
  && !name.startsWith('can')
  && !name.startsWith('is')

export interface ModelBridge {
  /** Every mutating call seen since the bridge was installed. */
  intents: SpreadsheetIntent[]
  /** The names the bridge decided to record, for the drift test. */
  recorded: string[]
  /** Drains the send queue now instead of waiting for the microtask. */
  flushNow: () => void
  /** Applies foreign diffs without recording them as local intent. */
  applyExternal: (diffs: Uint8Array) => void
  detach: () => void
}

export const mutatingMethodNames = (model: Model): string[] =>
  Object.getOwnPropertyNames(Object.getPrototypeOf(model) as object)
    .filter((name) => typeof (model as unknown as Record<string, unknown>)[name] === 'function')
    .filter(isRecordable)
    .sort()

export const attachModelBridge = (model: Model, options: BridgeOptions): ModelBridge => {
  const target = model as unknown as Record<string, (...args: unknown[]) => unknown>
  const prototype = Object.getPrototypeOf(model) as Record<string, (...args: unknown[]) => unknown>
  const intents: SpreadsheetIntent[] = []
  const recorded = mutatingMethodNames(model)
  const installed: string[] = []
  let scheduled = false
  let suspended = false

  const flushNow = (): void => {
    scheduled = false
    const pending = intents.splice(0, intents.length)
    const diffs = model.flushSendQueue()
    if (pending.length === 0 && diffs.length === 0) return
    options.onFlush({ diffs, intents: pending })
  }

  const schedule = (): void => {
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => { if (scheduled) flushNow() })
  }

  const wrap = (name: string, after: (args: unknown[]) => void): void => {
    const original = prototype[name]
    if (typeof original !== 'function') return
    Object.defineProperty(target, name, {
      configurable: true,
      enumerable: false,
      value: function wrapped(this: unknown, ...args: unknown[]): unknown {
        const result = original.apply(this, args)
        if (!suspended) after(args)
        return result
      },
      writable: true,
    })
    installed.push(name)
  }

  for (const name of recorded) {
    wrap(name, (args) => {
      intents.push({ args, at: Date.now(), method: name })
      schedule()
    })
  }
  if (options.onPresence) {
    for (const name of SELECTION) {
      wrap(name, () => {
        const view = model.getSelectedView()
        options.onPresence?.({
          column: view.column,
          range: view.range,
          row: view.row,
          sheet: view.sheet,
        })
      })
    }
  }

  return {
    applyExternal: (diffs) => {
      suspended = true
      try {
        model.pauseEvaluation()
        model.applyExternalDiffs(diffs)
        model.resumeEvaluation()
        model.evaluate()
      } finally {
        suspended = false
      }
    },
    detach: () => { for (const name of installed) delete target[name] },
    flushNow,
    intents,
    recorded,
  }
}
