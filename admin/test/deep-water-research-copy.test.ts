import assert from 'node:assert/strict'
import test from 'node:test'

import { ApiClientError } from '@nessie/client-core'

import { briefActionFailure, newBriefFailure } from '../src/components/features/deep-water/brief-action-errors.js'
import {
  cancelOfferedAgain,
  deepWaterTeamControls,
  deepWaterTeamStatus,
  openResearchSentence,
  openResearchStanding,
  teamChangeFailure,
  type OpenResearchFacts,
} from '../src/components/features/deep-water/deep-water-team-copy.js'
import {
  blockedReasonCopy,
  briefDoorwayLabel,
  downloadReportLabel,
  formatElapsed,
  openQuestionReply,
  progressHeadline,
  READINESS_UNREAD_COPY,
  readinessCopy,
  reportNoun,
  researchButtonTitle,
  researchListPage,
  researchName,
  researchStatusLine,
  retryDeliveryLabel,
  SETTING_LABEL,
  sourcesFoundLabel,
  sourcesLabel,
} from '../src/components/features/deep-water/research-presentation.js'
import {
  createIntentActionIds,
  reviveHeldActionId,
  type HeldActionId,
} from '../src/components/features/deep-water/intent-action-ids.js'

/**
 * What a person reads about a DeepWater research, and what the dialog does
 * with a refusal. UK English, plain, second person, and never a vendor, model,
 * price or infrastructure name (nessie.md §7.2).
 */

const FORBIDDEN = /ledger|mcp|openrouter|anthropic|openai|water api|scope|\$|token/i

const PERSON = '20000000-0000-4000-8000-000000000001'
const OTHER = '20000000-0000-4000-8000-000000000002'

test('the seven settings carry the contract\'s UK English labels', () => {
  assert.deepEqual(SETTING_LABEL, {
    chapterDepth: 'Chapter detail',
    depth: 'How thorough',
    languages: 'Source languages',
    outputLanguage: 'Report language',
    recency: 'Sources from',
    searchQuality: 'Source search',
    writingStyle: 'Writing style',
  })
})

test('a summary is never called the full report (amendments N10)', () => {
  assert.equal(reportNoun('full'), 'full report')
  assert.equal(reportNoun('summary'), 'research summary')
  assert.equal(reportNoun(null), 'report')
  assert.equal(downloadReportLabel('summary'), 'Download summary (.md)')
  assert.equal(downloadReportLabel('full'), 'Download report (.md)')
  assert.equal(downloadReportLabel(null), 'Download report (.md)')
})

test('a research is named by its title once it has one, by its question until then', () => {
  assert.equal(researchName({ title: 'Heat pumps in terraces', topic: 'heat pumps?' }), 'Heat pumps in terraces')
  assert.equal(researchName({ title: '  ', topic: ' heat pumps? ' }), 'heat pumps?')
  assert.equal(sourcesLabel(1), '1 source')
  assert.equal(sourcesLabel(12), '12 sources')
  assert.equal(sourcesLabel(null), null)
})

test('the line under a drafting research says who is agreeing its brief', () => {
  const run = (overrides: object) => ({
    origin: { kind: 'person' as const },
    requestedByUserId: PERSON,
    status: 'drafting' as const,
    ...overrides,
  }) as Parameters<typeof researchStatusLine>[0]
  assert.equal(researchStatusLine(run({}), PERSON), 'You’re agreeing the brief with DeepWater.')
  assert.equal(researchStatusLine(run({}), OTHER), 'The brief is being agreed with DeepWater.')
  assert.equal(researchStatusLine(run({ origin: { kind: 'agent' } }), PERSON), 'An agent is agreeing the brief with DeepWater.')
  assert.equal(researchStatusLine(run({ status: 'running' }), PERSON), null)
})

test('the requester still agreeing a brief continues it; everyone else views it', () => {
  const viewer = (canEdit: boolean) => ({ canCancel: false, canEdit, canRetryDelivery: false, canStart: false })
  assert.equal(briefDoorwayLabel({ status: 'drafting', viewer: viewer(true) }), 'Continue the brief')
  assert.equal(briefDoorwayLabel({ status: 'drafting', viewer: viewer(false) }), 'View brief')
  assert.equal(briefDoorwayLabel({ status: 'running', viewer: viewer(true) }), 'View brief')
})

test('every not-ready state names its remedy, and the composer button says why', () => {
  const states = ['team_off', 'contract_outdated', 'account_not_linked', 'unavailable'] as const
  for (const state of states) {
    for (const owner of [true, false]) {
      const copy = readinessCopy(state, owner)
      assert.ok(copy.message.length > 0 && copy.title.length > 0)
      assert.doesNotMatch(`${copy.message} ${copy.title}`, FORBIDDEN)
    }
  }
  assert.match(readinessCopy('team_off', true).message, /Turn it on/)
  // Only an owner may turn it on (team enablement is owner-only), so an admin is told who can.
  assert.match(readinessCopy('team_off', false).message, /Ask a team owner to turn it on\./)
  assert.match(readinessCopy('contract_outdated', false).message, /Ask a team owner to update it\./)
  assert.equal(researchButtonTitle('ready', false), 'Research with DeepWater')
  assert.equal(researchButtonTitle(null, false), 'Research with DeepWater', 'no reason is claimed while loading')
  assert.equal(researchButtonTitle('team_off', false), 'Research with DeepWater — it’s off for this team')
  // A verdict that could not be read claims no reason, and is never worded as DeepWater being off.
  assert.doesNotMatch(`${READINESS_UNREAD_COPY.title} ${READINESS_UNREAD_COPY.message}`, /\boff\b|reached|unavailable/i)
  assert.doesNotMatch(`${READINESS_UNREAD_COPY.title} ${READINESS_UNREAD_COPY.message}`, FORBIDDEN)
  // A state this admin has no words for is a broken contract, said loudly — never an undefined title.
  assert.throws(() => readinessCopy('on' as never, true), /research readiness "on" has no words/)
})

test('Knowledge › Research is empty only when its first page has nothing further back', () => {
  assert.deepEqual(researchListPage({ count: 0, hasMore: false, index: 0 }), { kind: 'no_research' })
  assert.deepEqual(researchListPage({ count: 3, hasMore: true, index: 0 }), { kind: 'rows' })
  // The server's bounded read can answer an empty first page with more to come: the pager stays, and says so.
  const further = researchListPage({ count: 0, hasMore: true, index: 0 })
  assert.equal(further.kind, 'nothing_here')
  assert.match(further.kind === 'nothing_here' ? further.note : '', /choose Next to keep looking\.$/)
  const end = researchListPage({ count: 0, hasMore: false, index: 2 })
  assert.match(end.kind === 'nothing_here' ? end.note : '', /Choose Previous to go back\.$/)
})

test('a blocked delivery names its remedy to the requester, and only what happened to anyone else', () => {
  const reasons = [
    'knowledge_destination_unavailable', 'ledger_unavailable', 'report_expired', 'report_malformed',
    'requester_identity_changed',
  ] as const
  const viewer = (canRetryDelivery: boolean) =>
    ({ canCancel: false, canEdit: false, canRetryDelivery, canStart: false })
  const requesters = { requestedByUserId: PERSON, viewer: viewer(true) }
  const others = { requestedByUserId: PERSON, viewer: viewer(false) }
  for (const reason of reasons) {
    const mine = blockedReasonCopy(reason, requesters, PERSON)
    const theirs = blockedReasonCopy(reason, others, OTHER)
    assert.doesNotMatch(`${mine} ${theirs}`, FORBIDDEN, reason)
    // Nobody but the requester is told to press Retry or to sign in again.
    assert.doesNotMatch(theirs, /\bRetry\b|Sign in again/, reason)
    assert.doesNotMatch(theirs, /\byou\b|\byour\b/i, reason)
    // A requester is told their remedy even where the server offers no button for it.
    assert.equal(blockedReasonCopy(reason, { requestedByUserId: PERSON, viewer: viewer(false) }, PERSON), mine)
  }
  assert.match(blockedReasonCopy('requester_identity_changed', requesters, PERSON), /Sign in again, then choose Retry/)
  assert.equal(blockedReasonCopy('requester_identity_changed', others, OTHER),
    'This research is waiting for the person who asked for it to sign in again.')
  assert.equal(blockedReasonCopy('knowledge_destination_unavailable', others, null),
    'The result couldn’t be saved to Documents yet. The person who asked for it can retry.')
  assert.equal(retryDeliveryLabel('requester_identity_changed'), 'Retry')
  assert.equal(retryDeliveryLabel('knowledge_destination_unavailable'), 'Retry import')
})

test('the replying clock reads as seconds, then minutes, then hours', () => {
  assert.equal(formatElapsed(-5), '0s')
  assert.equal(formatElapsed(12_400), '12s')
  assert.equal(formatElapsed(65_000), '1:05')
  assert.equal(formatElapsed(3_723_000), '1:02:03')
})

test('a research\'s phase reads as a numbered step in plain words, never DeepWater\'s own names', () => {
  assert.equal(progressHeadline('scoping'), 'Step 1 of 5: Planning')
  assert.equal(progressHeadline('gathering'), 'Step 2 of 5: Reading sources')
  assert.equal(progressHeadline('synthesising'), 'Step 3 of 5: Summarising')
  assert.equal(progressHeadline('verifying'), 'Step 4 of 5: Checking')
  assert.equal(progressHeadline('writing_report'), 'Step 5 of 5: Writing the report')
  for (const phase of ['scoping', 'gathering', 'synthesising', 'verifying', 'writing_report'] as const) {
    assert.doesNotMatch(progressHeadline(phase), /_|synthesis|ledger|water/i)
  }
  assert.equal(sourcesFoundLabel(null), null)
  assert.equal(sourcesFoundLabel(1), '1 source found')
  assert.equal(sourcesFoundLabel(23), '23 sources found')
})

test('a one-tap answer names the question it answers', () => {
  assert.equal(openQuestionReply(' Which country? ', ' The UK '), 'Which country?\nThe UK')
})

test('a retry of the same intent reuses its key; a new intent or a decided outcome mints a new one', () => {
  let minted = 0
  const ids = createIntentActionIds(() => `key-${++minted}`)
  const first = ids.take({ message: 'hello' })
  ids.settle(true)
  assert.equal(ids.take({ message: 'hello' }), first, 'a lost answer is retried under the same key')
  assert.notEqual(ids.take({ message: 'hello again' }), first, 'a different body is a different intent')
  const second = ids.take({ message: 'hello again' })
  ids.settle(false)
  assert.notEqual(ids.take({ message: 'hello again' }), second, 'after a decided outcome the same words are new')
})

test('a key kept in a stored draft comes back with the body, so a resend after a reload is a replay', () => {
  let stored: HeldActionId | null = null
  const writes: (HeldActionId | null)[] = []
  const draftStore = {
    get: () => stored,
    set: (held: HeldActionId | null) => {
      stored = held
      writes.push(held)
    },
  }
  let minted = 0
  const before = createIntentActionIds(() => `key-${++minted}`, draftStore)
  const first = before.take({ topic: 'Heat pumps' })
  assert.equal(writes.length, 1, 'the key is stored as it is taken, before the request leaves')
  before.settle(true)
  // The dialog closed or the page reloaded: a new mount reads the stored key.
  const after = createIntentActionIds(() => `key-${++minted}`, draftStore)
  assert.equal(after.take({ topic: 'Heat pumps' }), first, 'the same body resent after a reload reuses its key')
  assert.equal(writes.length, 1, 'reusing a key writes nothing')
  after.settle(false)
  assert.equal(stored, null, 'a decided outcome forgets the key in the draft too')
  assert.notEqual(after.take({ topic: 'Heat pumps' }), first)
  // Storage is untrusted input.
  assert.deepEqual(reviveHeldActionId({ actionId: 'k', signature: '{}', extra: 1 }), { actionId: 'k', signature: '{}' })
  assert.equal(reviveHeldActionId({ actionId: '', signature: '{}' }), null)
  assert.equal(reviveHeldActionId({ actionId: 'k' }), null)
  assert.equal(reviveHeldActionId(['k', '{}']), null)
})

const apiError = (code: string, status: number, details?: unknown) =>
  new ApiClientError('refused', code, status, details)

test('a synchronous refusal of a brief action reads as its remedy', () => {
  const conflict = briefActionFailure(apiError('DEEP_WATER_BRIEF_REVISION_CONFLICT', 409, { currentRevision: 4 }), 'reply', false)
  assert.equal(conflict.refetch, true, 'a revision conflict rebases the unsent edits onto the new brief')
  assert.equal(conflict.retrySameAction, false)
  assert.equal(briefActionFailure(apiError('DEEP_WATER_BRIEF_INCOMPLETE', 422), 'start', false).message,
    'Add at least one pillar before you start the research.')
  const lost = briefActionFailure(new TypeError('fetch failed'), 'reply', false)
  assert.equal(lost.retrySameAction, true, 'a lost request is retried under the same key')
  // It may still have arrived and been recorded: nothing says it did not.
  assert.doesNotMatch(lost.message, /didn’t reach|never|wasn’t sent/i)
  assert.match(lost.message, /^Nessie didn’t answer\./)
  assert.equal(briefActionFailure(apiError('INTERNAL', 503), 'start', false).retrySameAction, true)
  assert.equal(briefActionFailure(apiError('SOMETHING_ELSE', 400), 'start', false).retrySameAction, false)
  // Accepted, but the answer broke the contract: never "check your connection"; a
  // retry is a replay under the same key, and the brief is read again.
  const unreadable = briefActionFailure(apiError('INVALID_RESPONSE', 202), 'reply', false)
  assert.equal(unreadable.refetch, true)
  assert.equal(unreadable.retrySameAction, true)
  assert.doesNotMatch(unreadable.message, /connection/i)
  assert.doesNotMatch(unreadable.message, FORBIDDEN)
  // A new brief whose answer could not be read, or never came, has nothing on
  // screen to point at: pressing Plan again replays the same key and opens it.
  const unreadableNew = newBriefFailure(apiError('INVALID_RESPONSE', 202), false)
  assert.equal(unreadableNew.retrySameAction, true)
  assert.doesNotMatch(unreadableNew.message, /where it stands/i)
  assert.match(unreadableNew.message, /Plan with DeepWater again/)
  const lostNew = newBriefFailure(new TypeError('fetch failed'), false)
  assert.equal(lostNew.retrySameAction, true)
  assert.match(lostNew.message, /press Plan with DeepWater again — if your brief was already opened, that same/)
  assert.doesNotMatch(lostNew.message, /didn’t reach/)
  assert.deepEqual(newBriefFailure(apiError('INTERNAL', 503), false),
    briefActionFailure(apiError('INTERNAL', 503), 'create', false))
})

test('a not-ready refusal names the remedy for this viewer\'s role', () => {
  const notReady = (reason: string, owner: boolean) =>
    briefActionFailure(apiError('DEEP_WATER_NOT_READY', 409, { reason }), 'create', owner)
  // Only an owner may turn DeepWater on or update it, so only an owner is told to.
  assert.equal(notReady('team_off', true).message, readinessCopy('team_off', true).message)
  assert.equal(notReady('team_off', false).message, readinessCopy('team_off', false).message)
  assert.doesNotMatch(notReady('team_off', true).message, /Ask a team owner/)
  assert.match(notReady('contract_outdated', false).message, /Ask a team owner to update it\./)
  assert.equal(notReady('account_not_linked', true).message, readinessCopy('account_not_linked', true).message)
  assert.equal(notReady('team_off', true).retrySameAction, false)
  assert.equal(notReady('ready', true).message, 'DeepWater isn’t ready for your team right now.')
  assert.equal(newBriefFailure(apiError('DEEP_WATER_NOT_READY', 409, { reason: 'team_off' }), true).message,
    readinessCopy('team_off', true).message)
})

test('a busy refusal says what the refused action is waiting for', () => {
  const busy = (action: Parameters<typeof briefActionFailure>[1]) =>
    briefActionFailure(apiError('DEEP_WATER_BRIEF_BUSY', 409), action, false)
  // A reply or Start waits for DeepWater to finish with the last change.
  assert.match(busy('reply').message, /still working on the last change to this brief/)
  assert.equal(busy('start').message, busy('reply').message)
  // A cancel is refused only while DeepWater is still opening the brief: never
  // "the planner is still answering", which would send the person to wait for
  // a reply that has nothing to do with it.
  assert.match(busy('cancel').message, /^DeepWater is still opening this brief/)
  assert.doesNotMatch(busy('cancel').message, /answer|replied|change/i)
  for (const action of ['create', 'reply', 'start', 'cancel', 'deliver'] as const) {
    assert.equal(busy(action).refetch, true)
    assert.equal(busy(action).retrySameAction, false)
    assert.doesNotMatch(busy(action).message, FORBIDDEN)
  }
})

test('an owner gets every change there is to make for the team', () => {
  assert.deepEqual(deepWaterTeamControls('team_off', false, true), ['turn_on'])
  assert.deepEqual(deepWaterTeamControls('ready', true, true), ['turn_off'])
  // A team that needs updating is on: it can be updated, or turned off without updating first.
  assert.deepEqual(deepWaterTeamControls('contract_outdated', true, true), ['update', 'turn_off'])
  assert.deepEqual(deepWaterTeamControls('unavailable', true, true), ['turn_off'])
  assert.deepEqual(deepWaterTeamControls('account_not_linked', true, true), ['turn_off'])
  assert.deepEqual(deepWaterTeamControls('ready', true, false), [], 'only a team owner changes it')
  assert.deepEqual(deepWaterTeamControls('contract_outdated', true, false), [])
  assert.match(deepWaterTeamStatus('ready', true, false), /on for this team/)
  assert.match(deepWaterTeamStatus('account_not_linked', true, false), /^DeepWater is on for this team\. Your sign-in/)
  assert.match(deepWaterTeamStatus('team_off', false, true), /off for this team/)
})

test('an open research that blocks a change is named by who and where, never its question', () => {
  const run = {
    id: '40000000-0000-4000-8000-000000000001',
    originKind: 'person' as const,
    requestedByUserId: PERSON,
    status: 'drafting',
  }
  const failure = teamChangeFailure(apiError('LEDGER_DEEPWATER_ACTIVE_RUNS', 409, { ...run, channelId: null }))
  // Anything more the refusal names about the run (its chat) is not read.
  assert.deepEqual(failure, { kind: 'open_research', run })
  assert.equal(
    openResearchSentence(run, 'Jana', 'can_cancel'),
    'A research started by Jana is having its brief agreed. It keeps DeepWater as it is until it ends — cancel it '
      + 'here, or let it finish, then try again.',
  )
  assert.match(
    openResearchSentence({ ...run, originKind: 'agent', status: 'running' }, null, 'can_cancel'),
    /^A research started by an agent is being researched\./,
  )
  // Without the cancel standing there is no Cancel beside it, so none is pointed at.
  const noCancel = openResearchSentence(run, 'Jana', 'cannot_cancel')
  assert.doesNotMatch(noCancel, /cancel/i)
  assert.match(noCancel, /try again once it has finished\.$/)
  // An accepted cancel is not a stopped research: the change is still refused
  // until DeepWater has stopped it, and nothing asks for a second cancel.
  const requested = openResearchSentence(run, 'Jana', 'cancel_requested')
  assert.equal(requested, 'Cancel requested for the research started by Jana. Until it has stopped, DeepWater '
    + 'stays as it is — try again once it has.')
  assert.equal(openResearchSentence(run, 'Jana', 'stopped'),
    'The research started by Jana has stopped. You can try again now.')
  for (const standing of ['can_cancel', 'cannot_cancel', 'cancel_requested', 'stopped'] as const) {
    assert.doesNotMatch(openResearchSentence(run, 'Jana', standing), FORBIDDEN)
  }
  const unnamed = teamChangeFailure(apiError('LEDGER_DEEPWATER_ACTIVE_RUNS', 409))
  assert.equal(unnamed.kind, 'message')
  assert.equal(teamChangeFailure(apiError('LEDGER_DEEPWATER_MCP_URL_UNSET', 503)).kind, 'message')
  const lost = teamChangeFailure(new TypeError('fetch failed'))
  assert.deepEqual(lost, { kind: 'message', message: 'Nessie didn’t answer. Check your connection, then try again.' })
  for (const copy of [unnamed, teamChangeFailure(apiError('X', 503))]) {
    assert.doesNotMatch(copy.kind === 'message' ? copy.message : '', FORBIDDEN)
  }
})

test('an owner\'s cancel on the hero follows the research to its end, and is offered again when it did not go through', () => {
  const facts = (overrides: Partial<OpenResearchFacts> = {}): OpenResearchFacts => ({
    canCancel: true, cancelRequested: false, refusedAgain: false, stoppedOnAnswer: false, unreadable: false,
    view: { cancelFailed: false, finished: false }, ...overrides,
  })
  assert.equal(openResearchStanding(facts()), 'can_cancel')
  assert.equal(openResearchStanding(facts({ canCancel: false })), 'cannot_cancel')
  // Accepted: stopping, and the change is refused meanwhile without a second cancel.
  assert.equal(openResearchStanding(facts({ cancelRequested: true })), 'cancel_requested')
  assert.equal(openResearchStanding(facts({ cancelRequested: true, refusedAgain: true })), 'cancel_requested')
  // Then refused, or given up, by DeepWater: said, and Cancel offered again, however often the change was tried.
  const failed = openResearchStanding(facts({ cancelRequested: true, refusedAgain: true,
    view: { cancelFailed: true, finished: false } }))
  assert.equal(failed, 'cancel_failed')
  assert.equal(cancelOfferedAgain(failed), true)
  assert.equal(openResearchStanding(facts({ canCancel: false, view: { cancelFailed: true, finished: false } })),
    'cannot_cancel')
  // Stopped: by the answer itself, or seen in the research's view.
  assert.equal(openResearchStanding(facts({ cancelRequested: true, stoppedOnAnswer: true })), 'stopped')
  assert.equal(openResearchStanding(facts({ view: { cancelFailed: false, finished: true } })), 'stopped')
  // An owner who may not read the research: requested, and once the change is refused by it again, unconfirmed.
  const blind = { unreadable: true, view: null }
  assert.equal(openResearchStanding(facts({ ...blind, cancelRequested: true })), 'cancel_requested')
  const unconfirmed = openResearchStanding(facts({ ...blind, cancelRequested: true, refusedAgain: true }))
  assert.equal(unconfirmed, 'cancel_unconfirmed')
  assert.equal(cancelOfferedAgain(unconfirmed), true)
  assert.equal(cancelOfferedAgain('cancel_requested'), false)
  // While the research's view is still loading, nothing is claimed about the cancel's outcome.
  assert.equal(openResearchStanding(facts({ cancelRequested: true, refusedAgain: true, view: null })), 'cancel_requested')

  const run = { id: '40000000-0000-4000-8000-000000000001', originKind: 'agent' as const, requestedByUserId: null,
    status: 'running' }
  assert.equal(openResearchSentence(run, null, 'cancel_failed'), 'The research started by an agent wasn’t '
    + 'cancelled: it is being researched, and DeepWater stays as it is until it ends — cancel it again, or let it '
    + 'finish, then try again.')
  assert.equal(openResearchSentence(run, null, 'cancel_unconfirmed'), 'Cancel requested for the research started '
    + 'by an agent, but it is still open — the cancel may not have gone through. Cancel it again, or try again once '
    + 'it has stopped.')
  for (const standing of ['cancel_failed', 'cancel_unconfirmed'] as const) {
    assert.doesNotMatch(openResearchSentence(run, null, standing), FORBIDDEN)
  }
})
