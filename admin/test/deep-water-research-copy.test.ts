import assert from 'node:assert/strict'
import test from 'node:test'

import { ApiClientError } from '@nessie/client-core'

import { briefActionFailure, newBriefFailure } from '../src/components/features/deep-water/brief-action-errors.js'
import {
  deepWaterTeamControl,
  deepWaterTeamStatus,
  openResearchSentence,
  teamChangeFailure,
} from '../src/components/features/deep-water/deep-water-team-copy.js'
import {
  BLOCKED_REASON_COPY,
  briefDoorwayLabel,
  downloadReportLabel,
  formatElapsed,
  openQuestionReply,
  readinessCopy,
  reportNoun,
  researchButtonTitle,
  researchName,
  researchStatusLine,
  retryDeliveryLabel,
  SETTING_LABEL,
  sourcesLabel,
} from '../src/components/features/deep-water/research-presentation.js'
import { createIntentActionIds } from '../src/components/features/deep-water/useIntentActionId.js'

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
})

test('every blocked delivery names one remedy, in plain words', () => {
  for (const [reason, copy] of Object.entries(BLOCKED_REASON_COPY)) {
    assert.doesNotMatch(copy, FORBIDDEN, reason)
  }
  assert.equal(retryDeliveryLabel('requester_identity_changed'), 'Retry')
  assert.equal(retryDeliveryLabel('knowledge_destination_unavailable'), 'Retry import')
})

test('the replying clock reads as seconds, then minutes, then hours', () => {
  assert.equal(formatElapsed(-5), '0s')
  assert.equal(formatElapsed(12_400), '12s')
  assert.equal(formatElapsed(65_000), '1:05')
  assert.equal(formatElapsed(3_723_000), '1:02:03')
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

const apiError = (code: string, status: number, details?: unknown) =>
  new ApiClientError('refused', code, status, details)

test('a synchronous refusal of a brief action reads as its remedy', () => {
  const conflict = briefActionFailure(apiError('DEEP_WATER_BRIEF_REVISION_CONFLICT', 409, { currentRevision: 4 }))
  assert.equal(conflict.refetch, true, 'a revision conflict rebases the unsent edits onto the new brief')
  assert.equal(conflict.retrySameAction, false)
  assert.equal(briefActionFailure(apiError('DEEP_WATER_BRIEF_INCOMPLETE', 422)).message,
    'Add at least one pillar before you start the research.')
  assert.equal(
    briefActionFailure(apiError('DEEP_WATER_NOT_READY', 409, { reason: 'team_off' })).message,
    readinessCopy('team_off', false).message,
  )
  const lost = briefActionFailure(new TypeError('fetch failed'))
  assert.equal(lost.retrySameAction, true, 'a lost request is retried under the same key')
  assert.equal(briefActionFailure(apiError('INTERNAL', 503)).retrySameAction, true)
  assert.equal(briefActionFailure(apiError('SOMETHING_ELSE', 400)).retrySameAction, false)
  // Accepted, but the answer broke the contract: never "check your connection"; a
  // retry is a replay under the same key, and the brief is read again.
  const unreadable = briefActionFailure(apiError('INVALID_RESPONSE', 202))
  assert.equal(unreadable.refetch, true)
  assert.equal(unreadable.retrySameAction, true)
  assert.doesNotMatch(unreadable.message, /connection/i)
  assert.doesNotMatch(unreadable.message, FORBIDDEN)
  // A new brief whose answer could not be read has nothing on screen to point at:
  // pressing Plan again replays the same key and opens it.
  const unreadableNew = newBriefFailure(apiError('INVALID_RESPONSE', 202))
  assert.equal(unreadableNew.retrySameAction, true)
  assert.doesNotMatch(unreadableNew.message, /where it stands/i)
  assert.match(unreadableNew.message, /Plan with DeepWater again/)
  assert.deepEqual(newBriefFailure(apiError('INTERNAL', 503)), briefActionFailure(apiError('INTERNAL', 503)))
})

test('an owner gets the one change there is to make for the team', () => {
  assert.equal(deepWaterTeamControl('team_off', false, true), 'turn_on')
  assert.equal(deepWaterTeamControl('ready', true, true), 'turn_off')
  assert.equal(deepWaterTeamControl('contract_outdated', true, true), 'update')
  assert.equal(deepWaterTeamControl('ready', true, false), null, 'only a team owner changes it')
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
    openResearchSentence(run, 'Jana', true),
    'A research started by Jana is having its brief agreed. It keeps DeepWater as it is until it ends — cancel it '
      + 'here, or let it finish, then try again.',
  )
  assert.match(
    openResearchSentence({ ...run, originKind: 'agent', status: 'running' }, null, true),
    /^A research started by an agent is being researched\./,
  )
  // Without the cancel standing there is no Cancel beside it, so none is pointed at.
  const noCancel = openResearchSentence(run, 'Jana', false)
  assert.doesNotMatch(noCancel, /cancel/i)
  assert.match(noCancel, /try again once it has finished\.$/)
  const unnamed = teamChangeFailure(apiError('LEDGER_DEEPWATER_ACTIVE_RUNS', 409))
  assert.equal(unnamed.kind, 'message')
  assert.equal(teamChangeFailure(apiError('LEDGER_DEEPWATER_MCP_URL_UNSET', 503)).kind, 'message')
  for (const copy of [unnamed, teamChangeFailure(apiError('X', 503))]) {
    assert.doesNotMatch(copy.kind === 'message' ? copy.message : '', FORBIDDEN)
  }
})
