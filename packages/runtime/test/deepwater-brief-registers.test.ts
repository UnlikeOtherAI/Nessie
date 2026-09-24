import assert from 'node:assert/strict'
import test from 'node:test'

import {
  emptyDeepWaterScopeState,
  type DeepWaterScopeState,
  type LedgerScopeBrief,
  type LedgerScopeResult,
  type LedgerScopeTurn,
} from '@nessie/schemas'

import {
  DeepWaterTurnSequenceConflictError,
  advanceBriefRegister,
  advanceTurnRegister,
  applyScopeResultToState,
  deepWaterWatchDelayMs,
  productRunStatusForLedger,
  settledTurnFinishesAction,
} from '../src/deepwater-brief-registers.js'

const T1 = '11111111-1111-4111-8111-111111111111'
const T2 = '22222222-2222-4222-8222-222222222222'
const ACTION = '33333333-3333-4333-8333-333333333333'
const AGENT = '44444444-4444-4444-8444-444444444444'
const MESSAGE = '55555555-5555-4555-8555-555555555555'

const turn = (overrides: Partial<LedgerScopeTurn> = {}): LedgerScopeTurn => ({
  id: T1,
  seq: 1,
  status: 'pending',
  authorKind: 'person',
  errorCode: null,
  retryable: false,
  ...overrides,
})

const brief = (overrides: Partial<LedgerScopeBrief> = {}): LedgerScopeBrief => ({
  state: 'drafting',
  revision: 1,
  topic: 'Heat pumps',
  reply: null,
  pillars: ['Costs'],
  settings: {
    depth: 'standard',
    chapterDepth: 'standard',
    searchQuality: 'standard',
    languages: [],
    outputLanguage: 'en',
    recency: 'any',
    writingStyle: 'standard',
  },
  lockedSettings: [],
  openQuestions: [],
  analysis: null,
  ready: false,
  messages: null,
  ...overrides,
})

const result = (overrides: Partial<LedgerScopeResult> = {}): LedgerScopeResult => ({
  id: 'rs_1',
  status: 'drafting',
  errorCode: null,
  title: null,
  turn: turn(),
  brief: brief(),
  ...overrides,
})

const message = (seq: string, revision: number) => ({
  id: MESSAGE,
  seq,
  turnId: T1,
  role: 'planner' as const,
  authorKind: null,
  event: null,
  content: 'reply',
  briefRevision: revision,
  createdAt: '2026-09-23T10:00:00.000Z',
})

test('a stale pending read never regresses a turn that already failed', () => {
  const failed = advanceTurnRegister(null, turn({ status: 'failed', errorCode: 'planner_failed', retryable: true }))
  const stale = advanceTurnRegister(failed.turn, turn({ status: 'pending' }))
  assert.equal(stale.advanced, false)
  assert.equal(stale.turn.status, 'failed')
  assert.equal(stale.turn.retryable, true)
})

test('a newer turn advances past a settled older one, and an older one never comes back', () => {
  const first = advanceTurnRegister(null, turn({ status: 'failed' })).turn
  const second = advanceTurnRegister(first, turn({ id: T2, seq: 2, status: 'pending' }))
  assert.equal(second.advanced, true)
  assert.equal(second.turn.id, T2)
  assert.equal(advanceTurnRegister(second.turn, turn({ status: 'complete' })).advanced, false)
})

test('two turns under one sequence number is a contract violation, not a race', () => {
  const current = advanceTurnRegister(null, turn()).turn
  assert.throws(
    () => advanceTurnRegister(current, turn({ id: T2 })),
    DeepWaterTurnSequenceConflictError,
  )
})

test('brief content moves only on a strictly greater revision', () => {
  const current = advanceBriefRegister(null, brief({ revision: 3, pillars: ['A'] })).brief
  const same = advanceBriefRegister(current, brief({ revision: 3, pillars: ['B'] }))
  assert.equal(same.contentAdvanced, false)
  assert.deepEqual(same.brief.pillars, ['A'])
  const older = advanceBriefRegister(current, brief({ revision: 2, pillars: ['C'] }))
  assert.deepEqual(older.brief.pillars, ['A'])
  const newer = advanceBriefRegister(current, brief({ revision: 4, pillars: ['D'] }))
  assert.equal(newer.contentAdvanced, true)
  assert.deepEqual(newer.brief.pillars, ['D'])
})

test('a transcript-free read keeps the transcript; a later transcript at the same revision fills it in', () => {
  const withTranscript = advanceBriefRegister(null, brief({ revision: 2, messages: [message('7', 2)] })).brief
  const bare = advanceBriefRegister(withTranscript, brief({ revision: 3, messages: null }))
  assert.equal(bare.contentAdvanced, true)
  assert.equal(bare.transcriptAdvanced, false)
  assert.equal(bare.brief.messages.length, 1)
  assert.equal(bare.brief.messagesRevision, 2)

  const filled = advanceBriefRegister(bare.brief, brief({ revision: 3, messages: [message('7', 2), message('9', 3)] }))
  assert.equal(filled.contentAdvanced, false)
  assert.equal(filled.transcriptAdvanced, true)
  assert.equal(filled.brief.messages.length, 2)
  // An older transcript never rolls it back.
  const rolledBack = advanceBriefRegister(filled.brief, brief({ revision: 2, messages: [message('7', 2)] }))
  assert.equal(rolledBack.brief.messages.length, 2)
})

test('an ack records its turn; the settled turn clears the action whatever order they arrive in', () => {
  const opened: DeepWaterScopeState = {
    ...emptyDeepWaterScopeState(),
    pendingAction: { kind: 'scope_start', actionId: ACTION, since: 'now', turnId: null, error: null },
  }
  // The watch read sees the settled opening turn before the ack arrives.
  const settledFirst = applyScopeResultToState(opened, result({ turn: turn({ status: 'failed', retryable: true }) }))
  assert.equal(settledFirst.pendingActionCleared, true)
  assert.equal(settledFirst.newlySettledTurn?.id, T1)
  assert.equal(settledFirst.state.pendingAction, null)
  // The late ack finds nothing to re-arm.
  const lateAck = applyScopeResultToState(settledFirst.state, result({ turn: turn({ status: 'pending' }) }), {
    ackActionId: ACTION,
  })
  assert.equal(lateAck.state.pendingAction, null)
  assert.equal(lateAck.state.turn?.status, 'failed')
  assert.equal(lateAck.newlySettledTurn, null)

  // The ordinary order: ack first, then the settled read.
  const acked = applyScopeResultToState(opened, result(), { ackActionId: ACTION })
  assert.equal(acked.state.pendingAction?.turnId, T1)
  const settled = applyScopeResultToState(acked.state, result({ turn: turn({ status: 'complete' }) }))
  assert.equal(settled.pendingActionCleared, true)
  assert.equal(settled.newlySettledTurn?.status, 'complete')
  // Re-reading the same settled turn does not settle it twice.
  assert.equal(applyScopeResultToState(settled.state, result({ turn: turn({ status: 'complete' }) })).newlySettledTurn, null)
})

test('a reply action waits for its own turn, not an older one', () => {
  const action = { kind: 'reply' as const, actionId: ACTION, since: 'now', turnId: T2, error: null }
  const settledOlder = { id: T1, seq: 1, status: 'complete' as const, errorCode: null, retryable: false, authorKind: 'person' as const }
  assert.equal(settledTurnFinishesAction(action, settledOlder), false)
  assert.equal(settledTurnFinishesAction(action, { ...settledOlder, id: T2, seq: 2 }), true)
  // An action that ended in an error is not in flight.
  assert.equal(
    settledTurnFinishesAction({ ...action, error: { code: 'busy', at: 'now' } }, { ...settledOlder, id: T2, seq: 2 }),
    false,
  )
})

test('turn authors are recorded once, from the author\'s own call', () => {
  const author = { kind: 'agent' as const, agentId: AGENT }
  const first = applyScopeResultToState(emptyDeepWaterScopeState(), result(), { turnAuthor: author })
  assert.deepEqual(first.state.turnAuthors[T1], author)
  const other = applyScopeResultToState(first.state, result(), {
    turnAuthor: { kind: 'person', userId: ACTION },
  })
  assert.deepEqual(other.state.turnAuthors[T1], author)
})

test('Ledger statuses map onto product-run statuses', () => {
  assert.equal(productRunStatusForLedger('drafting'), 'drafting')
  assert.equal(productRunStatusForLedger('starting'), 'running')
  assert.equal(productRunStatusForLedger('timed_out'), 'failed')
  assert.equal(productRunStatusForLedger('complete'), 'completed')
  assert.equal(productRunStatusForLedger('needs_setup'), 'needs_setup')
})

test('the watch reads every 5 s while anything is in flight, 30 s while running, then backs off', () => {
  const open = { ...emptyDeepWaterScopeState(), turn: { ...turn(), errorCode: null } }
  const delay = (input: Omit<Parameters<typeof deepWaterWatchDelayMs>[0], 'msSinceLastEvent'>) =>
    deepWaterWatchDelayMs({ ...input, msSinceLastEvent: null })
  assert.equal(delay({ status: 'drafting', state: open, msSinceLastChange: 0 }), 5_000)
  assert.equal(delay({ status: 'running', state: emptyDeepWaterScopeState(), msSinceLastChange: 0 }), 30_000)
  const idle = emptyDeepWaterScopeState()
  assert.equal(delay({ status: 'drafting', state: idle, msSinceLastChange: 60_000 }), 10 * 60_000)
  assert.equal(delay({ status: 'drafting', state: idle, msSinceLastChange: 4 * 3_600_000 }), 2 * 3_600_000)
  assert.equal(delay({ status: 'drafting', state: idle, msSinceLastChange: 48 * 3_600_000 }), 6 * 3_600_000)
})

test('while DeepWater\'s events reach a run the watch is the backstop: 60 s, never faster', () => {
  const open = { ...emptyDeepWaterScopeState(), turn: { ...turn(), errorCode: null } }
  const idle = emptyDeepWaterScopeState()
  const delay = (status: 'drafting' | 'running', state: typeof idle, msSinceLastEvent: number | null) =>
    deepWaterWatchDelayMs({ status, state, msSinceLastChange: 0, msSinceLastEvent })
  // An event in the last two minutes: the 5 s and 30 s cadences become 60 s.
  assert.equal(delay('drafting', open, 0), 60_000)
  assert.equal(delay('running', idle, 119_000), 60_000)
  assert.equal(delay('running', idle, 120_000), 60_000)
  // Older than two minutes, or none yet: the watch's own cadence again.
  assert.equal(delay('running', idle, 120_001), 30_000)
  assert.equal(delay('drafting', open, 10 * 60_000), 5_000)
  assert.equal(delay('running', idle, null), 30_000)
  // A quiet run keeps its longer backoff: an event never makes the watch read more often.
  assert.equal(delay('drafting', idle, 0), 10 * 60_000)
})
