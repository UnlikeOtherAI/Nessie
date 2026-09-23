import assert from 'node:assert/strict'
import test from 'node:test'

import {
  emptyDeepWaterScopeState,
  type DeepWaterPendingAction,
  type DeepWaterScopeState,
  type DeepWaterTurnRegister,
} from '@nessie/schemas'

import type { DeepWaterBriefRun } from '../src/deepwater-brief-run-record.js'
import {
  deepWaterPlannerTurnView,
  deepWaterViewerActions,
  toDeepWaterBriefView,
  toDeepWaterResearchRunView,
} from '../src/deepwater-brief-view.js'

/**
 * The research views are built in one place (Water plan nessie.md §7.2,
 * amendments N2): the planner's side comes from register (b) and the person's
 * matching action, the status from contract §2.4, and what a viewer may do is
 * decided on the server. The words carry no plumbing.
 */

const RUN = '10000000-0000-4000-8000-000000000001'
const REQUESTER = '10000000-0000-4000-8000-000000000002'
const OTHER = '10000000-0000-4000-8000-000000000003'
const T1 = '10000000-0000-4000-8000-000000000004'
const T2 = '10000000-0000-4000-8000-000000000005'
const ACTION = '10000000-0000-4000-8000-000000000006'
const CHANNEL = '10000000-0000-4000-8000-000000000007'
const THREAD = '10000000-0000-4000-8000-000000000008'
const ORG = '10000000-0000-4000-8000-000000000009'
const SINCE = '2026-09-23T09:00:00.000Z'
/** A minute after SINCE: an opening sent then may still be at DeepWater. */
const NOW = new Date('2026-09-23T09:01:00.000Z')

const turn = (overrides: Partial<DeepWaterTurnRegister> = {}): DeepWaterTurnRegister => ({
  id: T1, seq: 1, status: 'pending', errorCode: null, retryable: false, authorKind: 'person', ...overrides,
})

const action = (overrides: Partial<DeepWaterPendingAction> = {}): DeepWaterPendingAction => ({
  kind: 'reply', actionId: ACTION, since: SINCE, turnId: null, error: null, ...overrides,
})

const state = (overrides: Partial<DeepWaterScopeState> = {}): DeepWaterScopeState => ({
  ...emptyDeepWaterScopeState(), ...overrides,
})

const run = (overrides: Partial<DeepWaterBriefRun> = {}): DeepWaterBriefRun => ({
  id: RUN, organizationId: ORG, teamId: ORG, requestedByUserId: REQUESTER, connectorId: ORG,
  channelId: CHANNEL, threadId: THREAD, cardMessageId: null, externalRunId: 'rs_1', status: 'drafting',
  title: null, queryPreview: 'Heat pumps', originKind: 'person', originAgentId: null, originRunId: null,
  originToolCallId: ACTION, principalUserId: null,
  uoaIdentity: { subject: 's', organizationId: 'o', teamId: 't', tokenVersion: 1 },
  scopeState: state(),
  input: { schemaVersion: 1, topic: 'Heat pumps', context: null, pillars: null, settings: null, originRootMessageId: null },
  launcher: null,
  sourceScopes: [], disclosureSources: [], failureCode: null, reportKind: null, reportTruncated: false,
  reportFileId: null, sourcesFileId: null, knowledgePageId: null, sourceCount: null, publicUrl: null,
  resultMessageId: null, wakeMessageId: null, deliveredAt: null, deliveryBlockedReason: null,
  agentWakeCount: 0, lastHandledTurnSeq: null, wakeCapNoticeAt: null,
  ledgerObservedAt: new Date(SINCE), reconcileAfter: new Date(SINCE), reconcileSeq: 0,
  requestedAt: new Date(SINCE), launchedAt: null, completedAt: null, createdAt: new Date(SINCE), updatedAt: new Date(SINCE),
  ...overrides,
})

const context = { viewer: { userId: REQUESTER, canChangeTeam: false }, reportSpaceId: null, now: NOW }

test('the planner turn view follows register (b) and the person\'s matching action', () => {
  assert.deepEqual(deepWaterPlannerTurnView(null), { status: 'idle' })
  // The opening is in flight before Ledger acknowledged a turn.
  const opening = action({ kind: 'scope_start' })
  assert.deepEqual(deepWaterPlannerTurnView(state({ pendingAction: opening })), { status: 'replying', actionId: ACTION, since: SINCE })
  // A watch read saw the opening turn before its ack: turn 1 answers the opening.
  assert.deepEqual(
    deepWaterPlannerTurnView(state({ turn: turn(), pendingAction: opening })),
    { status: 'replying', actionId: ACTION, since: SINCE },
  )
  assert.deepEqual(
    deepWaterPlannerTurnView(state({ turn: turn({ status: 'failed', errorCode: 'turn_lost', retryable: true }) })),
    { status: 'failed', actionId: null, retryable: true, message: 'The answer from DeepWater\'s research planner did not come back.' },
  )
  assert.deepEqual(deepWaterPlannerTurnView(state({ turn: turn({ status: 'complete' }) })), { status: 'idle' })
  // Sending the text again after a failure is newer than the failed turn.
  assert.deepEqual(
    deepWaterPlannerTurnView(state({ turn: turn({ status: 'failed', retryable: true }), pendingAction: action() })),
    { status: 'replying', actionId: ACTION, since: SINCE },
  )
  // Another person's (or the agent's) open turn is replying, but not theirs to point at.
  assert.deepEqual(
    deepWaterPlannerTurnView(state({ turn: turn({ id: T2, seq: 2 }), pendingAction: action({ kind: 'launch' }) })),
    { status: 'replying', actionId: null, since: null },
  )
  // An action that ended in an error is not in flight.
  const failedAction = action({ error: { code: 'busy', at: SINCE } })
  assert.deepEqual(deepWaterPlannerTurnView(state({ turn: turn({ status: 'complete' }), pendingAction: failedAction })), { status: 'idle' })
})

test('the view status follows contract §2.4 and a failure reads plainly', () => {
  assert.equal(toDeepWaterResearchRunView(run({ status: 'queued' }), context).status, 'drafting')
  assert.equal(
    toDeepWaterResearchRunView(run({ scopeState: state({ pendingAction: action({ kind: 'launch' }) }) }), context).status,
    'starting',
  )
  const operator = toDeepWaterResearchRunView(run({ status: 'needs_setup' }), context)
  assert.equal(operator.status, 'failed')
  assert.equal(operator.failure?.code, 'needs_operator')
  const failed = toDeepWaterResearchRunView(run({ status: 'failed', failureCode: 'scope_limit' }), context)
  assert.deepEqual(failed.failure, { code: 'scope_limit', message: 'Too many research briefs are open at once.' })
  const delivered = toDeepWaterResearchRunView(run({
    status: 'completed', deliveredAt: new Date(SINCE), knowledgePageId: RUN, reportFileId: RUN, reportKind: 'summary',
  }), { ...context, reportSpaceId: CHANNEL })
  assert.deepEqual(delivered.artifacts, { report: true, sources: false })
  assert.deepEqual(delivered.report, { spaceId: CHANNEL, pageId: RUN })
  assert.equal(delivered.delivery.state, 'delivered')
  assert.equal(delivered.reportKind, 'summary')
  for (const text of [failed.failure?.message ?? '', operator.failure?.message ?? '']) {
    assert.doesNotMatch(text, /ledger|mcp|scope|_/i)
  }
})

test('only the requester edits a person\'s brief, and an owner may cancel any open run', () => {
  const draft = run()
  assert.deepEqual(deepWaterViewerActions(draft, { userId: REQUESTER, canChangeTeam: false }, NOW), {
    canEdit: true, canStart: true, canCancel: true, canRetryDelivery: false,
  })
  assert.deepEqual(deepWaterViewerActions(draft, { userId: OTHER, canChangeTeam: true }, NOW), {
    canEdit: false, canStart: false, canCancel: true, canRetryDelivery: false,
  })
  assert.equal(deepWaterViewerActions(draft, { userId: OTHER, canChangeTeam: false }, NOW).canCancel, false)
  const busy = run({ scopeState: state({ pendingAction: action() }) })
  assert.equal(deepWaterViewerActions(busy, { userId: REQUESTER, canChangeTeam: false }, NOW).canEdit, false)
  const agentBrief = run({ originKind: 'agent', originAgentId: T2 })
  assert.equal(deepWaterViewerActions(agentBrief, { userId: REQUESTER, canChangeTeam: false }, NOW).canEdit, false)
  assert.equal(deepWaterViewerActions(agentBrief, { userId: REQUESTER, canChangeTeam: false }, NOW).canCancel, true)
  const blocked = run({ status: 'running', deliveryBlockedReason: 'requester_identity_changed' })
  assert.equal(deepWaterViewerActions(blocked, { userId: REQUESTER, canChangeTeam: false }, NOW).canRetryDelivery, true)
  const final = run({ status: 'completed', deliveryBlockedReason: 'report_expired' })
  assert.equal(deepWaterViewerActions(final, { userId: REQUESTER, canChangeTeam: false }, NOW).canRetryDelivery, false)
  assert.equal(deepWaterViewerActions(final, { userId: REQUESTER, canChangeTeam: true }, NOW).canCancel, false)
})

const launcherRun = (overrides: Partial<DeepWaterBriefRun> = {}): DeepWaterBriefRun => run({
  scopeState: null, uoaIdentity: null, input: null, launcher: { startRecorded: true, ledgerCancel: null }, status: 'running',
  ...overrides,
})

test('a launcher run is cancellable only by a team owner or admin while it is open', () => {
  const launcher = launcherRun()
  assert.deepEqual(deepWaterViewerActions(launcher, { userId: REQUESTER, canChangeTeam: false }, NOW), {
    canEdit: false, canStart: false, canCancel: false, canRetryDelivery: false,
  })
  assert.equal(deepWaterViewerActions(launcher, { userId: OTHER, canChangeTeam: true }, NOW).canCancel, true)
  const ended = launcherRun({ status: 'completed' })
  assert.equal(deepWaterViewerActions(ended, { userId: OTHER, canChangeTeam: true }, NOW).canCancel, false)
})

test('a launcher run offers Cancel only where the cancel route can act on it', () => {
  const owner = { userId: OTHER, canChangeTeam: true }
  const canCancel = (overrides: Partial<DeepWaterBriefRun>) =>
    deepWaterViewerActions(launcherRun(overrides), owner, NOW).canCancel
  // DeepWater has it: cancelled through DeepWater.
  assert.equal(canCancel({ status: 'running', externalRunId: 'rs_1' }), true)
  // A start may be on its way to DeepWater right now: nothing may cancel it yet (N9.6).
  assert.equal(canCancel({ status: 'running', externalRunId: null }), false)
  assert.equal(canCancel({ status: 'queued', externalRunId: null, launcher: { startRecorded: true, ledgerCancel: null } }), false)
  // DeepWater never received it: cancelled here.
  assert.equal(canCancel({ status: 'queued', externalRunId: null, launcher: { startRecorded: false, ledgerCancel: null } }), true)
  assert.equal(canCancel({ status: 'needs_setup', externalRunId: null }), true)
})

test('a cancel that did not go through says why the research is still open, until a newer one or its end', () => {
  // A brief: its cancel action ended in an error.
  const refused = run({ status: 'running', scopeState: state({
    pendingAction: action({ kind: 'cancel', error: { code: 'unavailable', at: SINCE } }),
  }) })
  const failure = toDeepWaterResearchRunView(refused, context).cancelFailure
  assert.equal(failure?.code, 'unavailable')
  assert.match(failure?.message ?? '', /wasn't cancelled/)
  assert.doesNotMatch(failure?.message ?? '', /ledger|mcp|scope|_/i)
  // A cancel still in flight, or another action's error, says nothing about cancelling.
  const inFlight = run({ status: 'running', scopeState: state({ pendingAction: action({ kind: 'cancel' }) }) })
  assert.equal(toDeepWaterResearchRunView(inFlight, context).cancelFailure, null)
  const replyError = run({ scopeState: state({ pendingAction: action({ error: { code: 'busy', at: SINCE } }) }) })
  assert.equal(toDeepWaterResearchRunView(replyError, context).cancelFailure, null)

  // A launcher run: its latest cancel through DeepWater failed.
  const failed = { actionId: ACTION, state: 'failed', code: 'forbidden', at: SINCE } as const
  const launcher = launcherRun({ externalRunId: 'rs_1', launcher: { startRecorded: true, ledgerCancel: failed } })
  assert.deepEqual(toDeepWaterResearchRunView(launcher, context).cancelFailure, {
    code: 'forbidden', message: 'DeepWater didn\'t accept this cancel, so the research is still open.',
  })
  const requested = { actionId: ACTION, state: 'requested', code: null, at: SINCE } as const
  const retrying = launcherRun({ externalRunId: 'rs_1', launcher: { startRecorded: true, ledgerCancel: requested } })
  assert.equal(toDeepWaterResearchRunView(retrying, context).cancelFailure, null)
  // Once the run has ended, an old failure is not a reason for anything.
  const ended = launcherRun({ status: 'completed', launcher: { startRecorded: true, ledgerCancel: failed } })
  assert.equal(toDeepWaterResearchRunView(ended, context).cancelFailure, null)
})

test('a brief DeepWater may be opening offers no Cancel until it opened or its opening ended', () => {
  const opening = run({
    status: 'queued',
    externalRunId: null,
    scopeState: state({ pendingAction: action({ kind: 'scope_start' }) }),
  })
  assert.equal(deepWaterViewerActions(opening, { userId: REQUESTER, canChangeTeam: true }, NOW).canCancel, false)
  // Past the window its job retries in, the job has given up or died: Cancel is offered, and
  // the cancel route decides from the job itself.
  const lateEnough = new Date(Date.parse(SINCE) + 30 * 60_000)
  assert.equal(deepWaterViewerActions(opening, { userId: REQUESTER, canChangeTeam: false }, lateEnough).canCancel, true)
  // Ledger never answered, or refused: nothing can open it any more, so it can be cancelled here.
  const stalled = run({
    status: 'queued',
    externalRunId: null,
    scopeState: state({ pendingAction: action({ kind: 'scope_start', error: { code: 'unavailable', at: SINCE } }) }),
  })
  assert.equal(deepWaterViewerActions(stalled, { userId: REQUESTER, canChangeTeam: false }, NOW).canCancel, true)
  assert.equal(deepWaterViewerActions(stalled, { userId: OTHER, canChangeTeam: true }, NOW).canCancel, true)
  // An agent's unnamed brief carries no action of the person's; the route decides whether its run is still sending.
  const agentBrief = run({ status: 'queued', externalRunId: null, originKind: 'agent', originAgentId: OTHER })
  assert.equal(deepWaterViewerActions(agentBrief, { userId: REQUESTER, canChangeTeam: false }, NOW).canCancel, true)
})

test('transcript authors come from Nessie\'s own turn record, never from the wire', () => {
  const view = toDeepWaterBriefView(run({
    scopeState: state({
      turnAuthors: { [T1]: { kind: 'agent', agentId: T2 } },
      pendingAction: action({ error: { code: 'revision_conflict', at: SINCE } }),
      brief: {
        revision: 2, state: 'drafting', topic: 'Heat pumps', reply: 'Two pillars.', pillars: ['Costs', 'Noise'],
        settings: {
          depth: 'light', chapterDepth: 'standard', searchQuality: 'standard', languages: [],
          outputLanguage: 'en', recency: 'any', writingStyle: 'standard',
        },
        lockedSettings: ['depth'], openQuestions: [], analysis: null, ready: true, messagesRevision: 2,
        messages: [
          { id: T1, seq: '1', turnId: T1, role: 'requester', authorKind: 'person', event: null, content: 'Hi', briefRevision: 1, createdAt: SINCE },
          { id: T2, seq: '2', turnId: T1, role: 'planner', authorKind: null, event: null, content: 'Two pillars.', briefRevision: 2, createdAt: SINCE },
        ],
      },
    }),
  }), { ...context, planner: { displayName: 'DeepWater', iconUrl: null } })
  assert.deepEqual(view.messages.map((message) => message.author), [{ kind: 'agent', agentId: T2 }, { kind: 'planner' }])
  assert.equal(view.revision, 2)
  assert.equal(view.pillarCount, 2)
  assert.deepEqual(view.lockedSettings, ['depth'])
  assert.deepEqual(view.pendingAction?.error, {
    code: 'revision_conflict',
    message: 'The brief changed while you were editing it. Check the latest version, then try again.',
  })
})
