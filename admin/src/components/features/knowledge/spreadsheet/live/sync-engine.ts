import {
  SPREADSHEET_LIMITS,
  columnIndexToLabel,
  selectionCellCount,
  type SpreadsheetAppliedBatch,
  type SpreadsheetBatchSummary,
  type SpreadsheetIntent,
  type SpreadsheetStructuralKind,
} from '@nessie/schemas'
import { shiftIntents } from '@nessie/spreadsheet/rebase'

/**
 * The client's ordering rules, with no React, no IronCalc and no `fetch` in
 * sight (`realtime-and-presence.md` §"Ordering rules the client implements").
 *
 * Everything the engine needs from the outside world arrives as a dependency,
 * which is what makes "does a gap buffer?", "is my own echo skipped?" and
 * "does a refused batch replay its intents shifted?" answerable in a unit test
 * rather than only in a browser. `spreadsheet-live.ts` supplies the real
 * dependencies; `admin/test/spreadsheet-live.test.ts` supplies fakes.
 *
 * The rules, in the order they are implemented below:
 *
 *  1. apply `sheet.ops` only at `appliedSeq + 1`, buffer anything higher,
 *     discard anything lower, and after `GAP_REPAIR_MS` with a gap fetch the
 *     missing range from the catch-up route;
 *  2. skip a batch this client wrote — it is already in the model;
 *  3. a `restore` re-bootstraps, because it is not a diff on top of anything;
 *  4. a structural `409` replays **intent**, not bytes;
 *  5. a dropped stream keeps editing locally and reconciles on reconnect.
 */

/** Rule 1's repair timer: long enough for an out-of-order NOTIFY, short enough
 *  that a person watching a peer type does not notice the stall. */
export const GAP_REPAIR_MS = 250

const STRUCTURAL_INTENT_KINDS: ReadonlySet<SpreadsheetIntent['kind']> = new Set([
  'insertRows',
  'deleteRows',
  'insertColumns',
  'deleteColumns',
  'moveRows',
  'moveColumns',
])

/**
 * Intents with no replayable form. `paste` records *that* a paste happened at
 * a cell and never what it carried; `undo`/`redo` address the engine's own
 * stack, which the rollback below has already rewound. Re-issuing either
 * would invent content, so a refused batch containing one is reported as
 * dropped rather than replayed.
 */
const UNREPLAYABLE_INTENT_KINDS: ReadonlySet<SpreadsheetIntent['kind']> = new Set([
  'paste',
  'undo',
  'redo',
])

export type OutgoingBatch = {
  clientOpId: string
  baseSeq: number
  /** Base64, as the write door takes it. */
  diffs: string
  summary: SpreadsheetBatchSummary
  /**
   * Calls this batch made that the contract has no intent shape for
   * (`intentFromCall` returned null). Such a batch ships its diffs perfectly
   * well but cannot be replayed, so a structural refusal drops it and says so
   * rather than re-issuing a partial edit.
   */
  unrebasableCalls: number
}

export type SubmitOutcome =
  | { kind: 'applied'; batch: SpreadsheetAppliedBatch }
  /** The write door refused: somebody moved the rows under this batch. */
  | { kind: 'conflict'; headSeq: number; since: SpreadsheetAppliedBatch[] }
  /** The request never reached a verdict — retry when the lane is back. */
  | { kind: 'offline' }
  /** A verdict this batch cannot recover from (too large, engine refusal). */
  | { kind: 'refused'; message: string }
  /** The page's head is on another engine build: read-only until it rebuilds. */
  | { kind: 'engine-mismatch' }

export type LiveStatus = 'connecting' | 'live' | 'offline'

export type SyncState = {
  appliedSeq: number
  /** Batches written but not yet acknowledged by the server. */
  unsent: number
  status: LiveStatus
  /** One line, shown only when a replay could not carry something over. */
  notice: string | null
  /** A refusal the person has to be told about — conflicts repair silently. */
  error: string | null
  /** True while the page's head is on an engine build this client cannot read. */
  engineMigrating: boolean
}

export type SyncDeps = {
  /** Apply a peer's diff bytes to the model, recording nothing. */
  applyExternal: (diffs: Uint8Array) => void
  /** Repaint after the model changed from outside the widget. */
  redraw: () => void
  /** `GET …/spreadsheet/ops?afterSeq=` — used for a gap and for a `diffs: null`. */
  fetchOps: (afterSeq: number) => Promise<SpreadsheetAppliedBatch[]>
  /** `POST …/spreadsheet/ops`. Every verdict is an outcome, including a throw. */
  submit: (batch: OutgoingBatch) => Promise<SubmitOutcome>
  /**
   * Undo `count` local batches and throw the undo's own diffs away.
   *
   * Rolling back is the only way to get the model back to `baseSeq` before the
   * foreign batches are applied: the engine has no "apply underneath" door.
   */
  rollback: (count: number) => void
  /**
   * Re-issue the shifted intents against the model and return the diffs they
   * produced, or null when they produced nothing.
   */
  replay: (intents: SpreadsheetIntent[]) => Uint8Array | null
  /** Throw the model away and bootstrap again (rule 3). */
  rebootstrap: () => void
  onState: (state: SyncState) => void
  /** Mint a `clientOpId`. Injected so a test can make them predictable. */
  newOpId: () => string
  /** Injected so the 250 ms repair timer does not make a unit test wait. */
  schedule?: (fn: () => void, ms: number) => () => void
}

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const handle = setTimeout(fn, ms)
  return () => clearTimeout(handle)
}

export const toBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  // Chunked: `String.fromCharCode(...bytes)` blows the argument limit on a
  // paste-sized batch, which is exactly the batch that matters.
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  }
  return btoa(binary)
}

export const fromBase64 = (value: string): Uint8Array => {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

const structuralKindOf = (
  intents: readonly SpreadsheetIntent[],
): SpreadsheetStructuralKind | null => {
  for (const intent of intents) {
    if (STRUCTURAL_INTENT_KINDS.has(intent.kind)) return intent.kind as SpreadsheetStructuralKind
  }
  return null
}

const cellsOf = (intent: SpreadsheetIntent): number => {
  switch (intent.kind) {
    case 'setUserInput':
    case 'paste':
      return 1
    case 'updateRangeStyle':
    case 'rangeClearAll':
    case 'rangeClearContents':
    case 'rangeClearFormatting':
      return selectionCellCount(intent.range)
    case 'insertRows':
    case 'deleteRows':
    case 'insertColumns':
    case 'deleteColumns':
      return intent.count
    default:
      return 0
  }
}

/**
 * The batch summary the write door takes, derived from what the bridge
 * recorded.
 *
 * It is **advisory** — it feeds the structural-conflict check, the filter
 * remap and the audit line, and nothing else — but `sheetIndexes` is what
 * decides whether a batch is even *considered* for a conflict, so an empty one
 * would make every batch unconflictable and silently land edits on moved rows.
 * Hence the `fallbackSheet`: a batch whose intents carry no sheet (or whose
 * calls had no intent shape at all) still names the sheet it was made on.
 */
export const summaryFromIntents = (
  intents: readonly SpreadsheetIntent[],
  fallbackSheet: number,
): SpreadsheetBatchSummary => {
  const sheets = new Set<number>()
  const touched: SpreadsheetBatchSummary['touched'] = []
  let cellCount = 0
  for (const intent of intents) {
    if ('sheet' in intent) sheets.add(intent.sheet)
    cellCount += cellsOf(intent)
    if (touched.length >= SPREADSHEET_LIMITS.maxTouchedRectangles) continue
    if (intent.kind === 'setUserInput' || intent.kind === 'paste') {
      touched.push({
        sheet: intent.sheet,
        r0: intent.row,
        c0: intent.column,
        r1: intent.row,
        c1: intent.column,
      })
    } else if (
      intent.kind === 'updateRangeStyle'
      || intent.kind === 'rangeClearAll'
      || intent.kind === 'rangeClearContents'
      || intent.kind === 'rangeClearFormatting'
    ) {
      touched.push({ sheet: intent.sheet, ...intent.range })
    }
  }
  if (sheets.size === 0) sheets.add(fallbackSheet)
  return {
    structuralKind: structuralKindOf(intents),
    sheetIndexes: [...sheets].sort((left, right) => left - right),
    cellCount,
    touched,
    intents: intents.slice(0, SPREADSHEET_LIMITS.maxIntentsPerBatch),
  }
}

/**
 * A foreign batch in the terms `shiftIntents` reads, or **null when it cannot
 * be read at all**.
 *
 * `structuralEditsFromSummary` needs both a `structuralKind` and the intents
 * behind it. A structural batch that arrived without intents — every
 * server-built one, because those summaries carry none by construction — says
 * *that* rows moved and never *which*. Returning null makes the caller drop
 * the replay and say so, instead of re-issuing every index unchanged and
 * landing the edit on whatever row now happens to carry it.
 */
export const foreignSummary = (
  batch: SpreadsheetAppliedBatch,
): SpreadsheetBatchSummary | null => {
  if (!batch.structuralKind) {
    return { structuralKind: null, sheetIndexes: batch.sheetIndexes, cellCount: 0, touched: [] }
  }
  if (!batch.structuralIntents || batch.structuralIntents.length === 0) return null
  return {
    structuralKind: batch.structuralKind,
    sheetIndexes: batch.sheetIndexes,
    cellCount: batch.cellCount,
    touched: [],
    intents: batch.structuralIntents,
  }
}

/** "Row structure changed by Dana; 1 edit could not be re-applied: B14". */
export const conflictNotice = (
  actorName: string,
  dropped: readonly SpreadsheetIntent[],
  unrebasable: number,
): string | null => {
  const total = dropped.length + unrebasable
  if (total === 0) return null
  const named = dropped
    .map((intent) =>
      intent.kind === 'setUserInput' || intent.kind === 'paste'
        ? `${columnIndexToLabel(intent.column)}${intent.row}`
        : null)
    .filter((label): label is string => label !== null)
    .slice(0, 3)
  const where = named.length > 0 ? `: ${named.join(', ')}` : ''
  return `Row structure changed by ${actorName}; ${total} ${total === 1 ? 'edit' : 'edits'} could not be re-applied${where}`
}

export type SpreadsheetSync = ReturnType<typeof createSpreadsheetSync>

export const createSpreadsheetSync = (deps: SyncDeps, bootstrapSeq: number) => {
  const schedule = deps.schedule ?? defaultSchedule
  const buffered = new Map<number, SpreadsheetAppliedBatch>()
  /** Seqs this client wrote: already in the model, so advance past them. */
  const ownSeqs = new Set<number>()
  /** `clientOpId`s in flight, so an echo that beats the POST's answer is skipped. */
  const ownOpIds = new Set<string>()
  /** Written but not acknowledged, oldest first. The head is the one in flight. */
  const queue: OutgoingBatch[] = []

  let seq = bootstrapSeq
  let status: LiveStatus = 'connecting'
  let notice: string | null = null
  let error: string | null = null
  let engineMigrating = false
  let inFlight = false
  let disposed = false
  let cancelGapRepair: (() => void) | null = null
  let repairing = false

  const publish = (): void => {
    if (disposed) return
    deps.onState({ appliedSeq: seq, unsent: queue.length, status, notice, error, engineMigrating })
  }

  const applyBatch = (batch: SpreadsheetAppliedBatch): void => {
    if (batch.diffs === null) return
    deps.applyExternal(fromBase64(batch.diffs))
  }

  // ── Rule 1 + rule 2: apply in order, skip own echoes, buffer a gap ────────
  const drain = (): void => {
    let painted = false
    for (;;) {
      const next = seq + 1
      if (ownSeqs.has(next)) {
        ownSeqs.delete(next)
        seq = next
        continue
      }
      const batch = buffered.get(next)
      if (!batch) break
      // A batch the fan-out could not inline has to be fetched by seq, so the
      // repair path owns it: stop here rather than skipping past it.
      if (batch.diffs === null) break
      buffered.delete(next)
      applyBatch(batch)
      seq = next
      painted = true
    }
    if (painted) deps.redraw()
  }

  const needsRepair = (): boolean => {
    if (buffered.size === 0) return false
    const next = buffered.get(seq + 1)
    return !next || next.diffs === null
  }

  const scheduleGapRepair = (): void => {
    if (cancelGapRepair || repairing) return
    cancelGapRepair = schedule(() => {
      cancelGapRepair = null
      void repairGap()
    }, GAP_REPAIR_MS)
  }

  const repairGap = async (): Promise<void> => {
    if (repairing || disposed) return
    repairing = true
    try {
      const fetched = await deps.fetchOps(seq)
      for (const batch of fetched) receive(batch, { repaired: true })
      drain()
    } catch {
      // The catch-up route is as unreachable as the lane was; the reconnect
      // loop calls `resume()` again, which comes straight back here.
      status = 'offline'
    } finally {
      repairing = false
      publish()
      if (needsRepair()) scheduleGapRepair()
    }
  }

  const receive = (
    batch: SpreadsheetAppliedBatch,
    options: { repaired?: boolean } = {},
  ): void => {
    if (disposed) return
    // Rule 3: a restore is not a diff on top of this model, it *is* the model.
    // It carries no diffs at all, so there is nothing to apply and nothing to
    // catch up to — the only honest answer is to build the workbook again.
    if (batch.structuralKind === 'restore') {
      deps.rebootstrap()
      return
    }
    if (batch.seq <= seq) return
    if (ownOpIds.has(batch.clientOpId)) {
      ownOpIds.delete(batch.clientOpId)
      ownSeqs.add(batch.seq)
    } else {
      const existing = buffered.get(batch.seq)
      // A repaired copy carries the diffs the inline one dropped; never the
      // reverse, so an inline arrival must not overwrite a repaired one.
      if (!existing || (existing.diffs === null && batch.diffs !== null)) {
        buffered.set(batch.seq, batch)
      }
    }
    drain()
    if (!options.repaired) {
      if (needsRepair()) scheduleGapRepair()
      publish()
    }
  }

  // ── The submit door ───────────────────────────────────────────────────────
  const enqueue = (input: {
    diffs: Uint8Array
    intents: readonly SpreadsheetIntent[]
    unrebasableCalls: number
    sheet: number
  }): void => {
    if (disposed || engineMigrating) return
    queue.push({
      clientOpId: deps.newOpId(),
      baseSeq: seq,
      diffs: toBase64(input.diffs),
      summary: summaryFromIntents(input.intents, input.sheet),
      unrebasableCalls: input.unrebasableCalls,
    })
    publish()
    void pump()
  }

  const pump = async (): Promise<void> => {
    if (inFlight || disposed) return
    const batch = queue[0]
    if (!batch) return
    inFlight = true
    // Rule 5: a queued batch is based on the head this client has actually
    // seen, which may have moved a long way while the lane was down.
    batch.baseSeq = seq
    ownOpIds.add(batch.clientOpId)
    let outcome: SubmitOutcome
    try {
      outcome = await deps.submit(batch)
    } catch {
      outcome = { kind: 'offline' }
    }
    inFlight = false
    if (disposed) return

    switch (outcome.kind) {
      case 'applied':
        queue.shift()
        ownOpIds.delete(batch.clientOpId)
        if (outcome.batch.seq > seq) ownSeqs.add(outcome.batch.seq)
        drain()
        if (status === 'offline') status = 'live'
        break
      case 'conflict':
        ownOpIds.delete(batch.clientOpId)
        await rebase(outcome.headSeq, outcome.since)
        break
      case 'offline':
        ownOpIds.delete(batch.clientOpId)
        status = 'offline'
        publish()
        // Rule 5: hold the queue. `resume()` pumps it when the lane is back.
        return
      case 'refused':
        queue.shift()
        ownOpIds.delete(batch.clientOpId)
        error = outcome.message
        // The local model is now ahead of the server by a batch the server
        // will never take, so the only honest recovery is to start again.
        deps.rebootstrap()
        break
      case 'engine-mismatch':
        ownOpIds.delete(batch.clientOpId)
        engineMigrating = true
        queue.length = 0
        break
    }
    publish()
    void pump()
  }

  // ── Rule 4: replay intent, not bytes ──────────────────────────────────────
  const rebase = async (
    headSeq: number,
    since: readonly SpreadsheetAppliedBatch[],
  ): Promise<void> => {
    const rolled = queue.splice(0, queue.length)
    // (a) undo the pending batches; their undo diffs are drained and dropped.
    deps.rollback(rolled.length)

    // (b) apply the foreign batches in order. One the fan-out could not inline
    //     arrives with `diffs: null` and is fetched by seq.
    let foreign = since.filter((batch) => batch.seq > seq)
    if (foreign.some((batch) => batch.diffs === null)) {
      try {
        const fetched = await deps.fetchOps(seq)
        const bySeq = new Map(fetched.map((batch) => [batch.seq, batch]))
        foreign = foreign.map((batch) => (batch.diffs === null ? bySeq.get(batch.seq) ?? batch : batch))
      } catch {
        // An un-fetchable batch leaves a gap the repair timer owns; the rebase
        // below is still the right thing to attempt.
      }
    }
    foreign = [...foreign].sort((left, right) => left.seq - right.seq)
    for (const batch of foreign) {
      applyBatch(batch)
      if (batch.seq > seq) seq = batch.seq
    }
    if (headSeq > seq) seq = headSeq
    deps.redraw()

    // (c) re-issue the recorded intents with their indexes shifted.
    const summaries: SpreadsheetBatchSummary[] = []
    let unreadable = false
    for (const batch of foreign) {
      const summary = foreignSummary(batch)
      if (!summary) { unreadable = true; continue }
      summaries.push(summary)
    }
    const recorded = rolled.flatMap((batch) => batch.summary.intents ?? [])
    const replayable = recorded.filter((intent) => !UNREPLAYABLE_INTENT_KINDS.has(intent.kind))
    // Only calls the bridge could not turn into an intent at all are counted
    // rather than named: an unreplayable *intent* still knows its cell, and
    // "a paste at B4 was lost" is worth saying where "1 edit was lost" is not.
    const unrebasable = rolled.reduce((total, batch) => total + batch.unrebasableCalls, 0)

    const shifted = unreadable ? [] : shiftIntents(replayable, summaries)
    // `shiftIntents` drops rather than marks, so what was dropped is recovered
    // by shifting each intent on its own — which is also what names the cells
    // in the notice.
    const dropped = [
      ...recorded.filter((intent) => UNREPLAYABLE_INTENT_KINDS.has(intent.kind)),
      ...(unreadable
        ? [...replayable]
        : replayable.filter((intent) => shiftIntents([intent], summaries).length === 0)),
    ]

    if (shifted.length > 0) {
      // (d)+(e) one new batch, based at the head the server just named.
      const diffs = deps.replay(shifted)
      const first = shifted[0]
      if (diffs) {
        queue.push({
          clientOpId: deps.newOpId(),
          baseSeq: seq,
          diffs: toBase64(diffs),
          summary: summaryFromIntents(shifted, first && 'sheet' in first ? first.sheet : 0),
          unrebasableCalls: 0,
        })
      }
    }
    notice = conflictNotice(
      foreign[foreign.length - 1]?.actor.displayName ?? 'somebody else',
      dropped,
      unrebasable,
    )
  }

  return {
    /** A local flush from the bridge. */
    enqueue,
    /** One `sheet.ops` frame off the lane. */
    receive: (batch: SpreadsheetAppliedBatch): void => receive(batch),
    /** The lane opened, or came back: catch up first, then flush the queue. */
    resume: async (): Promise<void> => {
      if (disposed) return
      status = 'live'
      error = null
      publish()
      await repairGap()
      void pump()
    },
    /** The lane dropped. Editing continues; the queue waits. */
    suspend: (): void => {
      status = 'offline'
      publish()
    },
    dismissNotice: (): void => { notice = null; publish() },
    dismissError: (): void => { error = null; publish() },
    appliedSeq: (): number => seq,
    /** For the pane's "n unsaved" affordance and for the e2e run. */
    unsent: (): number => queue.length,
    dispose: (): void => {
      disposed = true
      cancelGapRepair?.()
      cancelGapRepair = null
    },
  }
}
