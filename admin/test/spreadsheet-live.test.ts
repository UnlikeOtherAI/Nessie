import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  SpreadsheetActor,
  SpreadsheetAppliedBatch,
  SpreadsheetIntent,
  SpreadsheetPresenceEvent,
} from '@nessie/schemas'

import {
  applyIntent,
  applyIntents,
  type IntentTarget,
} from '../src/components/features/knowledge/spreadsheet/live/apply-intent'
import {
  PEER_EXPIRY_MS,
  clipDraft,
  createFrameThrottle,
  createPresenceStore,
} from '../src/components/features/knowledge/spreadsheet/live/presence-store'
import {
  conflictNotice,
  createSpreadsheetSync,
  foreignSummary,
  fromBase64,
  summaryFromIntents,
  toBase64,
  type OutgoingBatch,
  type SubmitOutcome,
  type SyncDeps,
  type SyncState,
} from '../src/components/features/knowledge/spreadsheet/live/sync-engine'

// The client's ordering rules, presence expiry and draft throttling, with no
// DOM, no engine and no server — which is the whole reason they were built as
// pure modules. Everything a browser would supply is a fake here, so a rule
// that is wrong fails with an assertion rather than with a screenshot nobody
// looked at.
//
// docs/plans/2026-09-15-spreadsheets-ironcalc/realtime-and-presence.md

const actor = (displayName: string): SpreadsheetActor => ({
  type: 'user',
  id: `user-${displayName}`,
  displayName,
  color: '#2563eb',
})

// The engine's diff bytes are opaque to every rule under test, so a batch's
// payload is one distinguishable byte.
const bytes = (marker: number): Uint8Array => new Uint8Array([marker])

const batch = (input: {
  seq: number
  clientOpId?: string
  marker?: number
  diffs?: string | null
  structuralKind?: SpreadsheetAppliedBatch['structuralKind']
  structuralIntents?: SpreadsheetIntent[]
  who?: string
}): SpreadsheetAppliedBatch => ({
  batchId: `00000000-0000-4000-8000-${String(input.seq).padStart(12, '0')}`,
  pageId: '11111111-1111-4111-8111-111111111111',
  seq: input.seq,
  baseSeq: input.seq - 1,
  clientOpId: input.clientOpId ?? `22222222-2222-4222-8222-${String(input.seq).padStart(12, '0')}`,
  actor: actor(input.who ?? 'Dana'),
  engineVersion: '0.8.3',
  diffs: input.diffs === undefined ? toBase64(bytes(input.marker ?? input.seq)) : input.diffs,
  structuralKind: input.structuralKind ?? null,
  ...(input.structuralIntents ? { structuralIntents: input.structuralIntents } : {}),
  sheetIndexes: [0],
  cellCount: 1,
  createdAt: '2026-09-16T10:00:00.000Z',
})

type Harness = {
  applied: number[]
  fetched: number[]
  redraws: number
  rebootstraps: number
  replayed: SpreadsheetIntent[][]
  rollbacks: number[]
  states: SyncState[]
  submitted: OutgoingBatch[]
  /** Timers the engine scheduled, so a test fires them instead of waiting. */
  timers: (() => void)[]
}

const harness = (overrides: Partial<SyncDeps> = {}) => {
  const log: Harness = {
    applied: [],
    fetched: [],
    redraws: 0,
    rebootstraps: 0,
    replayed: [],
    rollbacks: [],
    states: [],
    submitted: [],
    timers: [],
  }
  let opId = 0
  const deps: SyncDeps = {
    applyExternal: (diffs) => { log.applied.push(diffs[0] ?? -1) },
    redraw: () => { log.redraws += 1 },
    fetchOps: async (afterSeq) => { log.fetched.push(afterSeq); return [] },
    submit: async (outgoing) => { log.submitted.push(outgoing); return { kind: 'offline' } },
    rollback: (count) => { log.rollbacks.push(count) },
    replay: (intents) => { log.replayed.push([...intents]); return bytes(0x99) },
    rebootstrap: () => { log.rebootstraps += 1 },
    onState: (state) => { log.states.push(state) },
    newOpId: () => `33333333-3333-4333-8333-${String((opId += 1)).padStart(12, '0')}`,
    schedule: (fn) => {
      log.timers.push(fn)
      return () => { log.timers = log.timers.filter((entry) => entry !== fn) }
    },
    ...overrides,
  }
  return { deps, log }
}

/** Let every queued microtask and resolved promise settle. */
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
}

// ── base64, the one thing every rule rides on ────────────────────────────────

test('diff bytes survive the base64 round trip', () => {
  const original = new Uint8Array([0, 1, 127, 128, 255, 42])
  assert.deepEqual([...fromBase64(toBase64(original))], [...original])
})

// ── Rule 1: apply in seq order, buffer a gap, repair from the route ─────────

test('a contiguous batch applies immediately and repaints once', async () => {
  const { deps, log } = harness()
  const sync = createSpreadsheetSync(deps, 4)
  sync.receive(batch({ seq: 5, marker: 0x05 }))
  assert.deepEqual(log.applied, [0x05])
  assert.equal(sync.appliedSeq(), 5)
  assert.equal(log.redraws, 1)
  assert.deepEqual(log.timers, [], 'a contiguous batch schedules no repair')
  await settle()
})

test('a batch below appliedSeq is discarded, not re-applied', () => {
  const { deps, log } = harness()
  const sync = createSpreadsheetSync(deps, 9)
  sync.receive(batch({ seq: 7 }))
  sync.receive(batch({ seq: 9 }))
  assert.deepEqual(log.applied, [])
  assert.equal(sync.appliedSeq(), 9)
})

test('a gap buffers, and the buffer drains in order once it is filled', () => {
  const { deps, log } = harness()
  const sync = createSpreadsheetSync(deps, 1)
  sync.receive(batch({ seq: 4, marker: 0x04 }))
  sync.receive(batch({ seq: 3, marker: 0x03 }))
  assert.deepEqual(log.applied, [], 'nothing applies over a hole at seq 2')
  assert.equal(sync.appliedSeq(), 1)
  sync.receive(batch({ seq: 2, marker: 0x02 }))
  assert.deepEqual(log.applied, [0x02, 0x03, 0x04], 'in seq order, not arrival order')
  assert.equal(sync.appliedSeq(), 4)
})

test('a gap that stays open fetches the missing range after the repair timer', async () => {
  const { deps, log } = harness({
    fetchOps: async (afterSeq) => {
      log.fetched.push(afterSeq)
      return [batch({ seq: 2, marker: 0x02 }), batch({ seq: 3, marker: 0x03 })]
    },
  })
  const sync = createSpreadsheetSync(deps, 1)
  sync.receive(batch({ seq: 3, marker: 0x03 }))
  assert.equal(log.timers.length, 1, 'the repair is scheduled, not immediate')
  assert.deepEqual(log.fetched, [])

  log.timers.shift()?.()
  await settle()
  assert.deepEqual(log.fetched, [1], 'the catch-up route is asked from the last applied seq')
  assert.deepEqual(log.applied, [0x02, 0x03])
  assert.equal(sync.appliedSeq(), 3)
})

test('a batch the fan-out could not inline is fetched by seq rather than skipped', async () => {
  const { deps, log } = harness({
    fetchOps: async (afterSeq) => {
      log.fetched.push(afterSeq)
      return [batch({ seq: 2, marker: 0x02 })]
    },
  })
  const sync = createSpreadsheetSync(deps, 1)
  // `diffs: null` is what a batch over the NOTIFY cap looks like on the lane.
  sync.receive(batch({ seq: 2, diffs: null }))
  assert.deepEqual(log.applied, [], 'there is nothing to apply')
  assert.equal(log.timers.length, 1)
  log.timers.shift()?.()
  await settle()
  assert.deepEqual(log.applied, [0x02])
  assert.equal(sync.appliedSeq(), 2)
})

// ── Rule 2: skip this client's own echo ─────────────────────────────────────

test('a batch this client wrote advances the seq without being applied again', async () => {
  const { deps, log } = harness({
    submit: async (outgoing) => {
      log.submitted.push(outgoing)
      return { kind: 'applied', batch: batch({ seq: 6, clientOpId: outgoing.clientOpId }) }
    },
  })
  const sync = createSpreadsheetSync(deps, 5)
  sync.enqueue({
    diffs: bytes(0x11),
    intents: [{ kind: 'setUserInput', sheet: 0, row: 2, column: 2, value: '7' }],
    unrebasableCalls: 0,
    sheet: 0,
  })
  await settle()
  assert.equal(log.submitted.length, 1)
  assert.equal(sync.appliedSeq(), 6, 'the ack advanced the seq')
  assert.deepEqual(log.applied, [], 'the local model already has it')

  // The echo of the same batch arrives off the lane afterwards.
  sync.receive(batch({ seq: 6, clientOpId: log.submitted[0]?.clientOpId, marker: 0x11 }))
  assert.deepEqual(log.applied, [], 'the echo is skipped, not applied twice')
  assert.equal(sync.appliedSeq(), 6)
})

test('an echo that beats the ack home is still skipped, and the gap behind it closes', async () => {
  let ack: ((outcome: SubmitOutcome) => void) | null = null
  const { deps, log } = harness({
    submit: (outgoing) => {
      log.submitted.push(outgoing)
      return new Promise<SubmitOutcome>((resolve) => { ack = resolve })
    },
  })
  const sync = createSpreadsheetSync(deps, 5)
  sync.enqueue({ diffs: bytes(0x11), intents: [], unrebasableCalls: 0, sheet: 0 })
  await settle()
  const own = log.submitted[0]
  assert.ok(own)

  // Somebody else's seq 6 and this client's seq 7 arrive before the POST
  // answers. Only the foreign one may be applied, and only after 6 lands.
  sync.receive(batch({ seq: 7, clientOpId: own.clientOpId, marker: 0x11 }))
  assert.deepEqual(log.applied, [])
  sync.receive(batch({ seq: 6, marker: 0x06 }))
  assert.deepEqual(log.applied, [0x06])
  assert.equal(sync.appliedSeq(), 7, 'the seq walked past this client\'s own batch')
  ack?.({ kind: 'applied', batch: batch({ seq: 7, clientOpId: own.clientOpId }) })
  await settle()
  assert.deepEqual(log.applied, [0x06], 'the ack did not re-apply anything')
})

// ── Rule 3: a restore is not a diff ─────────────────────────────────────────

test('a restore batch re-bootstraps instead of being applied', () => {
  const { deps, log } = harness()
  const sync = createSpreadsheetSync(deps, 3)
  sync.receive(batch({ seq: 4, diffs: null, structuralKind: 'restore' }))
  assert.equal(log.rebootstraps, 1)
  assert.deepEqual(log.applied, [])
  assert.equal(sync.appliedSeq(), 3, 'the seq is meaningless until the bootstrap answers')
})

// ── Rule 4: replay intent, not bytes ────────────────────────────────────────

const insertRowAt = (row: number): SpreadsheetIntent =>
  ({ kind: 'insertRows', sheet: 0, row, count: 1 })

test('a structural conflict undoes, applies the foreign batch and re-issues shifted intents', async () => {
  const outcomes: SubmitOutcome[] = [
    {
      kind: 'conflict',
      headSeq: 6,
      since: [
        batch({
          seq: 6,
          marker: 0x06,
          structuralKind: 'insertRows',
          structuralIntents: [insertRowAt(2)],
          who: 'Dana',
        }),
      ],
    },
    { kind: 'applied', batch: batch({ seq: 7 }) },
  ]
  const { deps, log } = harness({
    submit: async (outgoing) => {
      log.submitted.push(outgoing)
      return outcomes.shift() ?? { kind: 'offline' }
    },
  })
  const sync = createSpreadsheetSync(deps, 5)
  // A person typed 42 into B4 while Dana inserted a row above it.
  sync.enqueue({
    diffs: bytes(0x11),
    intents: [{ kind: 'setUserInput', sheet: 0, row: 4, column: 2, value: '42' }],
    unrebasableCalls: 0,
    sheet: 0,
  })
  await settle()

  assert.deepEqual(log.rollbacks, [1], 'the one pending batch was undone')
  assert.deepEqual(log.applied, [0x06], 'the foreign batch was applied underneath')
  assert.deepEqual(
    log.replayed,
    [[{ kind: 'setUserInput', sheet: 0, row: 5, column: 2, value: '42' }]],
    'the edit was re-issued one row down, not re-sent as bytes',
  )
  assert.equal(log.submitted.length, 2, 'the replacement batch was submitted')
  assert.equal(log.submitted[1]?.baseSeq, 6, 'based at the head the server named')
  assert.equal(
    log.states.at(-1)?.notice,
    null,
    'nothing was lost, so nothing is said — announcing every repair trains people to ignore the line',
  )
})

test('an edit whose row the foreign batch deleted is dropped, and only then is a notice shown', async () => {
  const { deps, log } = harness({
    submit: async (outgoing) => {
      log.submitted.push(outgoing)
      if (log.submitted.length > 1) return { kind: 'applied', batch: batch({ seq: 8 }) }
      return {
        kind: 'conflict',
        headSeq: 6,
        since: [
          batch({
            seq: 6,
            structuralKind: 'deleteRows',
            structuralIntents: [{ kind: 'deleteRows', sheet: 0, row: 4, count: 1 }],
            who: 'Dana',
          }),
        ],
      }
    },
  })
  const sync = createSpreadsheetSync(deps, 5)
  sync.enqueue({
    diffs: bytes(0x11),
    intents: [{ kind: 'setUserInput', sheet: 0, row: 4, column: 2, value: '42' }],
    unrebasableCalls: 0,
    sheet: 0,
  })
  await settle()
  assert.deepEqual(log.replayed, [], 'there was nothing left to re-issue')
  assert.equal(log.submitted.length, 1, 'and therefore nothing to resubmit')
  assert.equal(
    log.states.at(-1)?.notice,
    'Row structure changed by Dana; 1 edit could not be re-applied: B4',
  )
})

test('a foreign structural batch with no intents refuses to rebase rather than replaying blind', async () => {
  const { deps, log } = harness({
    submit: async (outgoing) => {
      log.submitted.push(outgoing)
      return {
        kind: 'conflict',
        headSeq: 6,
        // A server-built structural batch: `structuralKind` says rows moved
        // and nothing says which.
        since: [batch({ seq: 6, structuralKind: 'sort', who: 'the sort tool' })],
      }
    },
  })
  const sync = createSpreadsheetSync(deps, 5)
  sync.enqueue({
    diffs: bytes(0x11),
    intents: [{ kind: 'setUserInput', sheet: 0, row: 4, column: 2, value: '42' }],
    unrebasableCalls: 0,
    sheet: 0,
  })
  await settle()
  assert.deepEqual(log.replayed, [], 're-issuing an unshifted index would land on the wrong row')
  assert.match(log.states.at(-1)?.notice ?? '', /could not be re-applied: B4/)
})

test('a batch whose calls had no intent shape is reported rather than partly replayed', async () => {
  const { deps, log } = harness({
    submit: async (outgoing) => {
      log.submitted.push(outgoing)
      if (log.submitted.length > 1) return { kind: 'applied', batch: batch({ seq: 8 }) }
      return {
        kind: 'conflict',
        headSeq: 6,
        since: [
          batch({
            seq: 6,
            structuralKind: 'insertRows',
            structuralIntents: [insertRowAt(2)],
            who: 'Dana',
          }),
        ],
      }
    },
  })
  const sync = createSpreadsheetSync(deps, 5)
  sync.enqueue({
    diffs: bytes(0x11),
    intents: [{ kind: 'setUserInput', sheet: 0, row: 9, column: 1, value: 'x' }],
    // One call the contract has no intent for: it shipped its diffs and cannot
    // be replayed.
    unrebasableCalls: 1,
    sheet: 0,
  })
  await settle()
  assert.deepEqual(log.replayed, [[{ kind: 'setUserInput', sheet: 0, row: 10, column: 1, value: 'x' }]])
  assert.equal(
    log.states.at(-1)?.notice,
    'Row structure changed by Dana; 1 edit could not be re-applied',
  )
})

test('a paste is never replayed: the contract records that it happened, not what it carried', async () => {
  const { deps, log } = harness({
    submit: async (outgoing) => {
      log.submitted.push(outgoing)
      return {
        kind: 'conflict',
        headSeq: 6,
        since: [batch({ seq: 6, structuralKind: 'insertRows', structuralIntents: [insertRowAt(2)] })],
      }
    },
  })
  const sync = createSpreadsheetSync(deps, 5)
  sync.enqueue({
    diffs: bytes(0x11),
    intents: [{ kind: 'paste', sheet: 0, row: 4, column: 2, isCut: false }],
    unrebasableCalls: 0,
    sheet: 0,
  })
  await settle()
  assert.deepEqual(log.replayed, [])
  assert.match(log.states.at(-1)?.notice ?? '', /1 edit could not be re-applied: B4/)
})

// ── Rule 5: the offline queue ───────────────────────────────────────────────

test('a batch that never reached a verdict is held, and one reconnect sends it once', async () => {
  let online = false
  const { deps, log } = harness({
    submit: async (outgoing) => {
      log.submitted.push(outgoing)
      return online
        ? { kind: 'applied', batch: batch({ seq: 9, clientOpId: outgoing.clientOpId }) }
        : { kind: 'offline' }
    },
  })
  const sync = createSpreadsheetSync(deps, 8)
  sync.enqueue({ diffs: bytes(0x11), intents: [], unrebasableCalls: 0, sheet: 0 })
  await settle()
  assert.equal(log.submitted.length, 1)
  assert.equal(log.states.at(-1)?.status, 'offline')
  assert.equal(log.states.at(-1)?.unsent, 1, 'the edit is queued, not lost')

  // Editing continues while the lane is down.
  sync.enqueue({ diffs: bytes(0x12), intents: [], unrebasableCalls: 0, sheet: 0 })
  await settle()
  assert.equal(log.states.at(-1)?.unsent, 2)

  online = true
  await sync.resume()
  await settle()
  assert.equal(log.submitted.length, 4, 'both queued batches went out, each once more')
  assert.equal(log.states.at(-1)?.unsent, 0)
  assert.equal(log.states.at(-1)?.status, 'live')
})

test('a queued batch is re-based on the head this client has since seen', async () => {
  let online = false
  const { deps, log } = harness({
    submit: async (outgoing) => {
      log.submitted.push(outgoing)
      return online
        ? { kind: 'applied', batch: batch({ seq: 12, clientOpId: outgoing.clientOpId }) }
        : { kind: 'offline' }
    },
  })
  const sync = createSpreadsheetSync(deps, 8)
  sync.enqueue({ diffs: bytes(0x11), intents: [], unrebasableCalls: 0, sheet: 0 })
  await settle()
  assert.equal(log.submitted[0]?.baseSeq, 8)

  sync.receive(batch({ seq: 9 }))
  sync.receive(batch({ seq: 10 }))
  online = true
  await sync.resume()
  await settle()
  assert.equal(log.submitted.at(-1)?.baseSeq, 10, 'not the stale 8 it was minted at')
})

// ── The summary the write door reads ────────────────────────────────────────

test('a summary names every sheet its intents touched, and the current one when they touch none', () => {
  const summary = summaryFromIntents(
    [
      { kind: 'setUserInput', sheet: 2, row: 1, column: 1, value: 'a' },
      { kind: 'rangeClearContents', sheet: 0, range: { r0: 1, c0: 1, r1: 3, c1: 2 } },
    ],
    0,
  )
  assert.deepEqual(summary.sheetIndexes, [0, 2])
  assert.equal(summary.cellCount, 7)
  assert.equal(summary.structuralKind, null)
  assert.equal(summary.touched.length, 2)

  // An `undo` carries no address at all; without the fallback this batch would
  // name no sheet and could never be caught by the conflict check.
  assert.deepEqual(summaryFromIntents([{ kind: 'undo' }], 3).sheetIndexes, [3])
})

test('a summary names the structural kind its intents imply', () => {
  assert.equal(summaryFromIntents([insertRowAt(2)], 0).structuralKind, 'insertRows')
})

test('a foreign batch with no structural kind is readable; one without its intents is not', () => {
  assert.ok(foreignSummary(batch({ seq: 2 })))
  assert.equal(foreignSummary(batch({ seq: 2, structuralKind: 'moveRows' })), null)
  assert.ok(
    foreignSummary(batch({
      seq: 2,
      structuralKind: 'insertRows',
      structuralIntents: [insertRowAt(1)],
    })),
  )
})

test('the notice names at most three cells and says nothing when nothing was lost', () => {
  assert.equal(conflictNotice('Dana', [], 0), null)
  assert.equal(
    conflictNotice('Dana', [{ kind: 'setUserInput', sheet: 0, row: 14, column: 2, value: '' }], 0),
    'Row structure changed by Dana; 1 edit could not be re-applied: B14',
  )
  const four: SpreadsheetIntent[] = [1, 2, 3, 4].map((row) => ({
    kind: 'setUserInput', sheet: 0, row, column: 1, value: '',
  }))
  assert.equal(
    conflictNotice('Dana', four, 0),
    'Row structure changed by Dana; 4 edits could not be re-applied: A1, A2, A3',
  )
})

// ── Replaying an intent against the engine ──────────────────────────────────

const recorder = () => {
  const calls: { args: unknown[]; method: string }[] = []
  const target = new Proxy({} as IntentTarget, {
    get: (_unused, method: string) => (...args: unknown[]) => { calls.push({ args, method }) },
  })
  return { calls, target }
}

test('every intent the contract can carry re-issues as the engine call it came from', () => {
  const { calls, target } = recorder()
  const applied = applyIntents(target, [
    { kind: 'setUserInput', sheet: 0, row: 5, column: 2, value: '42' },
    { kind: 'updateRangeStyle', sheet: 1, range: { r0: 2, c0: 3, r1: 4, c1: 5 }, stylePath: 'font.b', value: 'true' },
    { kind: 'rangeClearContents', sheet: 0, range: { r0: 1, c0: 1, r1: 2, c1: 2 } },
    { kind: 'deleteRows', sheet: 0, row: 3, count: 2 },
    { kind: 'moveColumns', sheet: 0, start: 2, count: 1, delta: 3 },
    { kind: 'setRowsHeight', sheet: 0, start: 1, end: 2, size: 30 },
    { kind: 'setFrozenRowsCount', sheet: 0, count: 1 },
  ])
  assert.equal(applied, 7)
  assert.deepEqual(calls[0], { args: [0, 5, 2, '42'], method: 'setUserInput' })
  // The wasm binding takes an Area, not five integers — the one place the two
  // IronCalc bindings disagree that this layer has to know about.
  assert.deepEqual(calls[1], {
    args: [{ sheet: 1, row: 2, column: 3, width: 3, height: 3 }, 'font.b', 'true'],
    method: 'updateRangeStyle',
  })
  assert.deepEqual(calls[2], { args: [0, 1, 1, 2, 2], method: 'rangeClearContents' })
  assert.deepEqual(calls[3], { args: [0, 3, 2], method: 'deleteRows' })
  assert.deepEqual(calls[4], { args: [0, 2, 1, 3], method: 'moveColumns' })
})

test('an intent with no replayable form is refused rather than invented', () => {
  const { calls, target } = recorder()
  assert.equal(applyIntent(target, { kind: 'undo' }), false)
  assert.equal(applyIntent(target, { kind: 'paste', sheet: 0, row: 1, column: 1, isCut: false }), false)
  assert.deepEqual(calls, [])
})

// ── Presence: expiry, self-exclusion, leave ─────────────────────────────────

const presence = (input: {
  clientId: string
  who?: string
  sheet?: number
  draft?: string
}): SpreadsheetPresenceEvent => ({
  clientId: input.clientId,
  sheet: input.sheet ?? 0,
  selection: { r0: 1, c0: 1, r1: 1, c1: 1 },
  cursor: { r: 1, c: 1 },
  draft: input.draft === undefined ? null : { r: 1, c: 1, text: input.draft },
  ts: '2026-09-16T10:00:00.000Z',
  pageId: '11111111-1111-4111-8111-111111111111',
  actor: actor(input.who ?? 'Dana'),
  sheetName: 'Sheet1',
})

test('a peer expires after the contract window and a leave removes one at once', () => {
  let clock = 1_000
  const store = createPresenceStore({ selfClientId: 'me', now: () => clock })
  store.receive(presence({ clientId: 'a', who: 'Dana' }))
  clock += 5_000
  store.receive(presence({ clientId: 'b', who: 'Sam' }))
  assert.deepEqual(store.list().map((peer) => peer.event.clientId), ['b', 'a'], 'newest first')

  clock += PEER_EXPIRY_MS - 4_000
  assert.equal(store.expire(), true, 'the older one aged out')
  assert.deepEqual(store.list().map((peer) => peer.event.clientId), ['b'])

  assert.equal(store.leave('b'), true)
  assert.deepEqual(store.list(), [], 'a leave does not wait out the window')
  assert.equal(store.leave('b'), false, 'and a second one changes nothing')
})

test('this pane never draws itself as a peer', () => {
  const store = createPresenceStore({ selfClientId: 'me' })
  assert.equal(store.receive(presence({ clientId: 'me' })), false)
  assert.deepEqual(store.list(), [])
})

test('a peer refreshing its frame keeps it alive rather than duplicating it', () => {
  let clock = 0
  const store = createPresenceStore({ selfClientId: 'me', now: () => clock })
  store.receive(presence({ clientId: 'a' }))
  clock += PEER_EXPIRY_MS - 1
  store.receive(presence({ clientId: 'a', draft: '12' }))
  clock += 2
  store.expire()
  assert.equal(store.list().length, 1)
  assert.equal(store.list()[0]?.event.draft?.text, '12')
})

// ── Presence: the sender's throttle ─────────────────────────────────────────

test('the throttle sends the first frame at once and then the latest per window', () => {
  let clock = 10_000
  let pending: (() => void) | null = null
  const sent: string[] = []
  const throttle = createFrameThrottle({
    intervalMs: 100,
    now: () => clock,
    schedule: (fn) => { pending = fn; return () => { pending = null } },
    send: (frame) => { sent.push(frame.draft?.text ?? '-') },
  })
  const frame = (text: string) => ({ ...presence({ clientId: 'me', draft: text }) })

  throttle.push(frame('1'))
  assert.deepEqual(sent, ['1'], 'the first frame does not wait')

  // A burst inside one window: three keystrokes, one frame, and it is the last
  // one — a peer's ghost has to track the typing, not lag a window behind it.
  throttle.push(frame('12'))
  throttle.push(frame('123'))
  throttle.push(frame('1234'))
  assert.deepEqual(sent, ['1'])
  clock += 100
  pending?.()
  assert.deepEqual(sent, ['1', '1234'])

  // And a frame after the window is idle goes straight out again.
  clock += 500
  throttle.push(frame('done'))
  assert.deepEqual(sent, ['1', '1234', 'done'])
})

test('a heartbeat jumps the throttle instead of queueing behind it', () => {
  let clock = 0
  const sent: string[] = []
  const throttle = createFrameThrottle({
    intervalMs: 100,
    now: () => clock,
    schedule: () => () => undefined,
    send: (frame) => { sent.push(frame.clientId) },
  })
  throttle.push(presence({ clientId: 'first' }))
  throttle.push(presence({ clientId: 'dropped' }))
  throttle.sendNow(presence({ clientId: 'beat' }))
  assert.deepEqual(sent, ['first', 'beat'])
})

test('a draft longer than the contract carries is clipped, not refused', () => {
  assert.equal(clipDraft('short'), 'short')
  assert.equal(clipDraft('x'.repeat(300)).length, 256)
})
