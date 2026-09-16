// Method shadowing, not a fork (admin-ui.md §"Method shadowing, not a fork").
//
// Own-property wrappers are installed on the live wasm `Model` instance. Every
// mutating call runs the prototype method first, then records the call and
// schedules one microtask that drains the engine's send queue into the sink.
// Selection-only calls emit a presence frame instead of an intent. Because the
// wrappers are own properties on the real instance, `__wbg_ptr` and every
// pointer-taking method are untouched and the IronCalc widget keeps calling the
// same object it was handed.
//
// Measured on the Spike C/D branch (decisions.md §"Spike C/D"): 52 own-property
// wrappers, `__wbg_ptr` untouched for the whole run.
import type { Model } from '@ironcalc/wasm'
import {
  SPREADSHEET_LIMITS,
  type SpreadsheetIntent,
  type SpreadsheetSelection,
} from '@nessie/schemas'

/** One recorded call, before it is translated into a wire intent. */
export type RecordedCall = {
  args: unknown[]
  at: number
  method: string
}

export type PresenceFrame = {
  column: number
  range: [number, number, number, number]
  row: number
  sheet: number
}

export type BridgeFlush = {
  /** Every mutating call since the last flush, in order. */
  calls: RecordedCall[]
  /** The engine's own diff payload. Never the 1-byte empty flush. */
  diffs: Uint8Array
  /** The subset the wire contract can carry, for a refused batch's replay. */
  intents: SpreadsheetIntent[]
}

export type BridgeOptions = {
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
const SELECTION = [
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
] as const

const SELECTION_SET: ReadonlySet<string> = new Set<string>(SELECTION)

const isRecordable = (name: string): boolean =>
  !NON_RECORDING.has(name)
  && !SELECTION_SET.has(name)
  // wasm-bindgen's own plumbing (`__destroy_into_raw`, `__wbg_*`) is on the
  // same prototype and must never be shadowed: doing so corrupts disposal.
  && !name.startsWith('_')
  && !name.startsWith('get')
  && !name.startsWith('can')
  && !name.startsWith('is')

/**
 * The engine answers an empty send queue with a single `0x00` byte rather than
 * zero bytes (decisions.md §"Spike C/D" item 2). Submitting that as a batch
 * would burn a `seq` on every microtask, so it reads as "nothing to send"
 * everywhere — here, and again at the write door.
 */
export const isEmptyFlush = (diffs: Uint8Array): boolean =>
  diffs.length === 0 || (diffs.length === 1 && diffs[0] === 0x00)

const int = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) ? value : null

const areaOf = (value: unknown): { range: SpreadsheetSelection; sheet: number } | null => {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  const sheet = int(raw.sheet)
  const row = int(raw.row)
  const column = int(raw.column)
  const width = int(raw.width)
  const height = int(raw.height)
  if (sheet === null || row === null || column === null || width === null || height === null) return null
  return {
    range: { c0: column, c1: column + width - 1, r0: row, r1: row + height - 1 },
    sheet,
  }
}

const rectOf = (args: unknown[]): { range: SpreadsheetSelection; sheet: number } | null => {
  const sheet = int(args[0])
  const r0 = int(args[1])
  const c0 = int(args[2])
  const r1 = int(args[3])
  const c1 = int(args[4])
  if (sheet === null || r0 === null || c0 === null || r1 === null || c1 === null) return null
  return { range: { c0, c1, r0, r1 }, sheet }
}

/**
 * Translates one recorded engine call into the wire contract's intent, or null
 * when the contract has no shape for it.
 *
 * An intent is *advisory*: it is what the browser recorded itself doing, so a
 * batch refused for a structural conflict can be replayed against the moved
 * grid (storage-and-concurrency.md). A call with no intent still ships its
 * diffs — it simply cannot be rebased, and Phase 3b treats it as such.
 */
export const intentFromCall = (call: RecordedCall): SpreadsheetIntent | null => {
  const a = call.args
  switch (call.method) {
    case 'setUserInput': {
      const sheet = int(a[0])
      const row = int(a[1])
      const column = int(a[2])
      const value = a[3]
      if (sheet === null || row === null || column === null || typeof value !== 'string') return null
      if (value.length > SPREADSHEET_LIMITS.maxCellTextChars) return null
      return { column, kind: 'setUserInput', row, sheet, value }
    }
    case 'updateRangeStyle': {
      const target = areaOf(a[0])
      const stylePath = a[1]
      const value = a[2]
      if (!target || typeof stylePath !== 'string' || typeof value !== 'string') return null
      return { kind: 'updateRangeStyle', range: target.range, sheet: target.sheet, stylePath, value }
    }
    case 'rangeClearAll':
    case 'rangeClearContents':
    case 'rangeClearFormatting': {
      const target = rectOf(a)
      if (!target) return null
      return { kind: call.method, range: target.range, sheet: target.sheet }
    }
    case 'insertRows':
    case 'deleteRows': {
      const sheet = int(a[0])
      const row = int(a[1])
      const count = int(a[2])
      if (sheet === null || row === null || count === null) return null
      return { count, kind: call.method, row, sheet }
    }
    case 'insertColumns':
    case 'deleteColumns': {
      const sheet = int(a[0])
      const column = int(a[1])
      const count = int(a[2])
      if (sheet === null || column === null || count === null) return null
      return { column, count, kind: call.method, sheet }
    }
    case 'moveRows':
    case 'moveColumns': {
      const sheet = int(a[0])
      const start = int(a[1])
      const count = int(a[2])
      const delta = int(a[3])
      if (sheet === null || start === null || count === null || delta === null) return null
      return { count, delta, kind: call.method, sheet, start }
    }
    case 'setRowsHidden':
    case 'setColumnsHidden': {
      const sheet = int(a[0])
      const start = int(a[1])
      const end = int(a[2])
      const hidden = a[3]
      if (sheet === null || start === null || end === null || typeof hidden !== 'boolean') return null
      return { end, hidden, kind: call.method, sheet, start }
    }
    case 'setRowsHeight':
    case 'setColumnsWidth': {
      const sheet = int(a[0])
      const start = int(a[1])
      const end = int(a[2])
      const size = a[3]
      if (sheet === null || start === null || end === null || typeof size !== 'number') return null
      return { end, kind: call.method, sheet, size, start }
    }
    case 'setFrozenRowsCount':
    case 'setFrozenColumnsCount': {
      const sheet = int(a[0])
      const count = int(a[1])
      if (sheet === null || count === null) return null
      return { count, kind: call.method, sheet }
    }
    case 'pasteFromClipboard': {
      const sheet = int(a[0])
      const source = a[1]
      const isCut = a[4]
      if (sheet === null || !Array.isArray(source)) return null
      const row = int(source[0])
      const column = int(source[1])
      if (row === null || column === null) return null
      return { column, isCut: isCut === true, kind: 'paste', row, sheet }
    }
    case 'undo':
    case 'redo':
      return { kind: call.method }
    default:
      return null
  }
}

export type ModelBridge = {
  /** Applies foreign diffs without recording them as local intent. */
  applyExternal: (diffs: Uint8Array) => void
  detach: () => void
  /** Drains the send queue now instead of waiting for the microtask. */
  flushNow: () => void
  /** The names the bridge decided to record, for the version-drift test. */
  recorded: string[]
}

export const mutatingMethodNames = (model: Model): string[] =>
  Object.getOwnPropertyNames(Object.getPrototypeOf(model) as object)
    .filter((name) => typeof (model as unknown as Record<string, unknown>)[name] === 'function')
    .filter(isRecordable)
    .sort()

export const attachModelBridge = (model: Model, options: BridgeOptions): ModelBridge => {
  const target = model as unknown as Record<string, (...args: unknown[]) => unknown>
  const prototype = Object.getPrototypeOf(model) as Record<string, (...args: unknown[]) => unknown>
  const pending: RecordedCall[] = []
  const recorded = mutatingMethodNames(model)
  const installed: string[] = []
  let scheduled = false
  let suspended = false

  const flushNow = (): void => {
    scheduled = false
    const calls = pending.splice(0, pending.length)
    const diffs = model.flushSendQueue()
    if (isEmptyFlush(diffs)) return
    const intents: SpreadsheetIntent[] = []
    for (const call of calls) {
      const intent = intentFromCall(call)
      if (intent && intents.length < SPREADSHEET_LIMITS.maxIntentsPerBatch) intents.push(intent)
    }
    options.onFlush({ calls, diffs, intents })
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
      pending.push({ args, at: Date.now(), method: name })
      schedule()
    })
  }
  const onPresence = options.onPresence
  if (onPresence) {
    for (const name of SELECTION) {
      wrap(name, () => {
        const view = model.getSelectedView()
        onPresence({ column: view.column, range: view.range, row: view.row, sheet: view.sheet })
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
    recorded,
  }
}
