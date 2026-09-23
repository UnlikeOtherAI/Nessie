import assert from 'node:assert/strict'
import test from 'node:test'

import type { DeepWaterBriefView } from '@nessie/schemas'

import { NO_EDITS, subtractEdits } from '../src/components/features/deep-water/brief-edits.js'
import {
  EMPTY_BRIEF_DRAFT,
  answerShowsInFlight,
  draftAfterSend,
  isBriefDraftEmpty,
  reviveBriefDraft,
  sendAgainMessage,
  settleSentAction,
  type BriefDraft,
  type SentBriefAction,
} from '../src/components/features/deep-water/brief-sent-action.js'
import { resolveBriefOrigin, startAgainPlace } from '../src/components/features/deep-water/research-brief-origin.js'
import { briefWithRunView } from '../src/facades/deep-water/mutations.js'
import { CHANNEL, REQUESTER, THREAD, researchBrief, researchRun } from './deep-water-research-fixtures.js'

/**
 * What a person's brief draft does with the action they sent (amendments-fable
 * F8, amendments N2): the words and edits leave the draft only while they still
 * equal what was sent, and come back when DeepWater refuses the action or its
 * planner cannot answer the reply — even though a failed turn clears the
 * pending action without an error and writes no transcript row. Send again then
 * sends those words, never the question or an earlier reply.
 */

const ACTION = '80000000-0000-4000-8000-000000000001'
const OTHER_ACTION = '80000000-0000-4000-8000-000000000002'
const SINCE = '2026-09-23T09:05:00.000Z'
const WORDS = 'Only houses built before 1919, please.'

const reply = (overrides: Partial<SentBriefAction> = {}): SentBriefAction => ({
  actionId: ACTION,
  edits: NO_EDITS,
  kind: 'reply',
  message: WORDS,
  revision: 2,
  seen: false,
  typed: true,
  ...overrides,
})

const draft = (overrides: Partial<BriefDraft> = {}): BriefDraft => ({ ...EMPTY_BRIEF_DRAFT, ...overrides })

type Progress = Pick<DeepWaterBriefView, 'pendingAction' | 'plannerTurn' | 'revision' | 'status'>

const progress = (overrides: Partial<Progress> = {}): Progress => ({
  pendingAction: null,
  plannerTurn: { status: 'idle' },
  revision: 2,
  status: 'drafting',
  ...overrides,
})

const replying = (actionId = ACTION): Partial<Progress> => ({
  pendingAction: { actionId, error: null, kind: 'reply', since: SINCE },
  plannerTurn: { actionId, since: SINCE, status: 'replying' },
})

const plannerFailed: Partial<Progress> = {
  plannerTurn: { actionId: null, message: 'DeepWater’s research planner couldn’t answer.', retryable: true, status: 'failed' },
}

/** Walk a draft through the briefs the dialog sees, as the hook's effect does. */
const walk = (start: BriefDraft, briefs: Progress[]): BriefDraft =>
  briefs.reduce((current, brief) => settleSentAction(current, brief) ?? current, start)

test('a sent reply leaves the draft, and a failed planner turn gives its words back for Send again', () => {
  const sent = draftAfterSend(draft({ message: `${WORDS}  ` }), reply())
  assert.equal(sent.message, '', 'the words left the box')
  assert.deepEqual(sent.sent, reply())

  const after = walk(sent, [
    progress(replying()),
    // Nessie clears the pending action when the turn settles, whatever its
    // status, and DeepWater writes no transcript row for a failed turn.
    progress(plannerFailed),
  ])
  assert.equal(after.message, WORDS, 'the words are back in the box')
  assert.equal(after.unanswered, WORDS, 'Send again sends them')
  assert.equal(after.sent, null)
})

test('a reply whose edits were applied before the planner failed gives back only its words', () => {
  const edits = { pillars: ['Costs', 'Planning rules'] }
  const sent = draftAfterSend(draft({ edits, message: WORDS }), reply({ edits }))
  assert.equal(sent.edits.pillars, undefined, 'the sent pillars left the draft')
  // DeepWater applied the edits (revision 3) and then the turn failed.
  const after = walk(sent, [progress({ ...replying(), revision: 3 }), progress({ ...plannerFailed, revision: 3 })])
  assert.equal(after.message, WORDS)
  assert.equal(after.edits.pillars, undefined, 'the brief holds the applied pillars; they are not unsent again')
  assert.equal(after.unanswered, WORDS)
})

test('a failure seen only after the brief moved on still gives the words back', () => {
  // The dialog never saw the action in flight, but the brief moved past the
  // revision it was sent against, so it is over.
  const after = walk(draftAfterSend(draft({ message: WORDS }), reply()), [progress({ ...plannerFailed, revision: 3 })])
  assert.equal(after.unanswered, WORDS)
})

test('an older brief that has not moved never ends the action', () => {
  // The previous turn had failed; this read predates the new action.
  const sent = draftAfterSend(draft({ message: WORDS }), reply())
  assert.equal(settleSentAction(sent, progress(plannerFailed)), null)
})

test('an answered reply is forgotten, and nothing comes back', () => {
  const after = walk(draftAfterSend(draft({ message: WORDS }), reply()), [
    progress(replying()),
    progress({ revision: 3 }),
  ])
  assert.deepEqual(after, EMPTY_BRIEF_DRAFT)
  assert.equal(isBriefDraftEmpty(after), true)
})

test('a refused action gives back its words and edits', () => {
  const edits = { settings: { recency: 'year' as const } }
  const sent = draftAfterSend(draft({ edits, message: WORDS }), reply({ edits }))
  const refused = progress({
    pendingAction: { actionId: ACTION, error: { code: 'busy', message: 'Still answering.' }, kind: 'reply', since: SINCE },
  })
  const after = walk(sent, [refused])
  assert.equal(after.message, WORDS)
  assert.deepEqual(after.edits, edits)
  assert.equal(after.unanswered, null, 'a refusal is not a planner failure')
})

test('a one-tap answer that fails comes back to Send again, not into the box', () => {
  const tapped = 'Which country?\nThe UK'
  const sent = draftAfterSend(draft({ message: 'half-written' }), reply({ message: tapped, typed: false }))
  assert.equal(sent.message, 'half-written', 'what the person was typing is left alone')
  const after = walk(sent, [progress(replying()), progress(plannerFailed)])
  assert.equal(after.message, 'half-written')
  assert.equal(after.unanswered, tapped)
})

test('what changed while the action was on its way stays in the draft', () => {
  const sentEdits = { pillars: ['A', 'B'], settings: { depth: 'deep' as const, recency: 'year' as const } }
  // Before the 202 arrived: more words typed, a pillar list and one setting changed again.
  const current = draft({
    edits: { pillars: ['A', 'B', 'C'], settings: { depth: 'deep', recency: 'month' } },
    message: `${WORDS} And flats.`,
  })
  const after = draftAfterSend(current, reply({ edits: sentEdits }))
  assert.equal(after.message, `${WORDS} And flats.`)
  assert.deepEqual(after.edits, { pillars: ['A', 'B', 'C'], settings: { recency: 'month' } })
  assert.deepEqual(subtractEdits(sentEdits, sentEdits), NO_EDITS)
})

test('a Start that launches is forgotten; one refused gives its edits back', () => {
  const edits = { settings: { depth: 'light' as const } }
  const start = reply({ edits, kind: 'start', message: '', typed: false })
  const sent = draftAfterSend(draft({ edits, unanswered: 'kept' }), start)
  assert.equal(sent.unanswered, 'kept', 'Start does not answer the planner')
  const launched = walk(sent, [progress({ status: 'starting' }), progress({ status: 'running' })])
  assert.equal(launched.sent, null)
  assert.deepEqual(launched.edits, NO_EDITS)

  const refused = walk(sent, [
    progress({ status: 'starting' }),
    progress({ pendingAction: { actionId: ACTION, error: { code: 'rejected', message: 'No.' }, kind: 'launch', since: SINCE } }),
  ])
  assert.deepEqual(refused.edits, edits)
})

test('the server\'s answer says whether the action is still in flight', () => {
  const brief = researchBrief()
  assert.equal(answerShowsInFlight(reply(), { ...brief, ...replying() }), true)
  // A replay of a reply that has since ended: the brief's next state decides.
  assert.equal(answerShowsInFlight(reply(), { ...brief, pendingAction: null, plannerTurn: { status: 'idle' } }), false)
  assert.equal(answerShowsInFlight(reply({ kind: 'start' }), researchRun({ status: 'starting' })), true)
  assert.equal(answerShowsInFlight(reply({ kind: 'start' }), researchRun({ status: 'running' })), false)
  // Another action's answer is not this one's.
  assert.equal(answerShowsInFlight(reply(), { ...brief, ...replying(OTHER_ACTION) }), false)
})

test('Send again sends the unanswered words, the question only when no turn was ever answered, else nothing', () => {
  const opened = researchBrief({ messages: [] })
  assert.equal(sendAgainMessage(WORDS, opened), WORDS)
  assert.equal(sendAgainMessage(null, opened), opened.topic)
  const answered = researchBrief()
  assert.ok(answered.messages.some((message) => message.author.kind === 'person'))
  assert.equal(sendAgainMessage(null, answered), null, 'an earlier reply or the question is never guessed')
})

test('Send again\'s words last only while the failure stands', () => {
  const held = draft({ unanswered: WORDS })
  assert.equal(settleSentAction(held, progress(plannerFailed)), null)
  assert.equal(settleSentAction(held, progress())?.unanswered, null)
})

test('the stored draft is revived field by field and never trusted', () => {
  const stored = draftAfterSend(draft({ message: WORDS }), reply({ edits: { pillars: ['A'] } }))
  assert.deepEqual(reviveBriefDraft(JSON.parse(JSON.stringify(stored))), stored)
  const tampered = reviveBriefDraft({ message: 7, sent: { actionId: ACTION, kind: 'delete' }, unanswered: ['x'] })
  assert.deepEqual(tampered, EMPTY_BRIEF_DRAFT)
  assert.equal(reviveBriefDraft('nope'), null)
})

test('a brief comes back to the screen\'s conversation, its reply thread, or the place a doorway names', () => {
  const screen = { channelId: CHANNEL, kind: 'thread' as const, threadId: THREAD }
  const root = '60000000-0000-4000-8000-000000000099'
  assert.deepEqual(resolveBriefOrigin(screen, undefined), screen)
  assert.deepEqual(resolveBriefOrigin(screen, { rootMessageId: root }), { ...screen, rootMessageId: root })
  assert.deepEqual(resolveBriefOrigin({ kind: 'personal' }, { rootMessageId: root }), { kind: 'personal' })
  const drawer = { channelId: CHANNEL, kind: 'thread' as const, threadId: '40000000-0000-4000-8000-000000000009' }
  assert.deepEqual(resolveBriefOrigin(screen, { origin: drawer }), drawer)
  assert.equal(resolveBriefOrigin(screen, { origin: null }), null, 'a conversation still opening is nowhere yet')
})

test('Start again restarts where the research was asked, under its reply thread', () => {
  const root = '60000000-0000-4000-8000-000000000099'
  const run = researchRun({
    origin: { agentId: null, cardMessageId: null, channelId: CHANNEL, kind: 'person', rootMessageId: root, threadId: THREAD },
    requestedByUserId: REQUESTER,
    status: 'failed',
  })
  assert.deepEqual(startAgainPlace(run), {
    origin: { channelId: CHANNEL, kind: 'thread', rootMessageId: root, threadId: THREAD },
  })
  assert.deepEqual(startAgainPlace(researchRun({})), { origin: { channelId: CHANNEL, kind: 'thread', threadId: THREAD } })
  const nowhere = researchRun({
    origin: { agentId: null, cardMessageId: null, channelId: null, kind: 'person', rootMessageId: null, threadId: null },
  })
  assert.deepEqual(startAgainPlace(nowhere), {})
})

test('Start\'s answer shows the research starting in the brief at once, and Start no longer offered', () => {
  const brief = researchBrief()
  const run = researchRun({ status: 'starting', viewer: { canCancel: true, canEdit: false, canRetryDelivery: false, canStart: false } })
  const merged = briefWithRunView(brief, run)
  assert.equal(merged.status, 'starting')
  assert.equal(merged.viewer.canStart, false)
  assert.deepEqual(merged.messages, brief.messages, 'the conversation is kept')
  assert.equal(briefWithRunView(brief, researchRun({ id: '10000000-0000-4000-8000-000000000009' })), brief)
})
