import assert from 'node:assert/strict'
import test from 'node:test'

import {
  blockedNotice,
  completedKickoff,
  deepWaterFailureMessage,
  failedNotice,
  identityChangedOnAgentBriefNotice,
  identityChangedWhileRunningNotice,
  noticePushBody,
  resultNotice,
  startUnconfirmedNotice,
  turnKickoff,
  wakeCapNotice,
  wakeUnreachableNotice,
} from './deepwater-copy.js'

/**
 * What DeepWater's delivery says. A person's notice never names the plumbing
 * (no vendor, model, price or infrastructure word); a summary is never called
 * the full report (Water plan amendments N10); and a kickoff tells the agent
 * which tools to use without quoting the planner or the report.
 */

const JARGON = /ledger|mcp|openrouter|anthropic|openai|\$\d|research_scope|rs_/i

test('person-facing notices use plain words and never the plumbing', () => {
  const notices = [
    resultNotice({ topic: 'Heat pumps', sourceCount: 3, pageId: 'p', spaceId: 's', reportKind: 'full', truncated: false }),
    failedNotice({ topic: 'Heat pumps', failureCode: 'upstream_failed' }),
    startUnconfirmedNotice('Heat pumps'),
    wakeUnreachableNotice({ topic: 'Heat pumps', finished: false, link: null }),
    wakeCapNotice('Heat pumps'),
    identityChangedWhileRunningNotice('Heat pumps'),
    identityChangedOnAgentBriefNotice('Heat pumps'),
    ...(['requester_identity_changed', 'ledger_unavailable', 'knowledge_destination_unavailable',
      'report_expired', 'report_malformed'] as const)
      .map((reason) => blockedNotice({ topic: 'Heat pumps', reason })),
  ]
  for (const notice of notices) assert.doesNotMatch(notice, JARGON, notice)
})

test('a summary is never presented as the full report', () => {
  const summary = completedKickoff({ sourceCount: 2, pageId: 'page-1', reportKind: 'summary' })
  assert.match(summary, /full report could not be written/)
  assert.match(summary, /they have the summary, not the full report/)
  assert.match(completedKickoff({ sourceCount: 1, pageId: 'page-1', reportKind: 'full' }), /The full report is saved/)
  assert.match(completedKickoff({ sourceCount: 5, pageId: 'page-1', reportKind: null }), /The report is saved/)
  assert.match(completedKickoff({ sourceCount: 1, pageId: 'page-1', reportKind: 'full' }), /\(1 source\)/)
  const reply = resultNotice({
    topic: 'Heat pumps', sourceCount: 2, pageId: 'p', spaceId: 's', reportKind: 'summary', truncated: true,
  })
  assert.match(reply, /research summary/)
  assert.doesNotMatch(reply, /The full report/)
  assert.match(reply, /end of it is missing/)
})

test('a turn kickoff names the next tools, or what to do when the planner failed', () => {
  const turn = { id: 't', seq: 2, status: 'complete' as const, errorCode: null, retryable: false, authorKind: 'agent' as const }
  const answered = turnKickoff({ topic: 'Heat pumps', researchId: 'rs_1', turn })
  assert.match(answered, /mcp_research_scope_get/)
  assert.match(answered, /include_transcript off/)
  assert.match(answered, /mcp_research_scope_launch/)
  const retry = turnKickoff({ topic: 'Heat pumps', researchId: 'rs_1', turn: { ...turn, status: 'failed', retryable: true } })
  assert.match(retry, /Send your reply again/)
  const giveUp = turnKickoff({ topic: 'Heat pumps', researchId: 'rs_1', turn: { ...turn, status: 'failed' } })
  assert.match(giveUp, /Tell the person who asked/)
})

test('failure reasons are plain and never the raw code', () => {
  assert.equal(deepWaterFailureMessage('scope_limit'), 'too many research briefs are open at once')
  assert.equal(deepWaterFailureMessage('something_new'), 'DeepWater stopped before the research finished')
  assert.equal(deepWaterFailureMessage(null), 'DeepWater stopped before the research finished')
})

test('a changed sign-in says a running research is still running, and a blocked one that it finished', () => {
  const running = identityChangedWhileRunningNotice('Heat pumps')
  assert.match(running, /can't check on your research “Heat pumps”/)
  assert.doesNotMatch(running, /finished|saved to Documents/)
  const finished = blockedNotice({ topic: 'Heat pumps', reason: 'requester_identity_changed' })
  assert.match(finished, /has finished, but it couldn't be saved to Documents/)
})

test('a changed sign-in on an agent\'s brief names the remedy and never a result', () => {
  const notice = identityChangedOnAgentBriefNotice('Heat pumps')
  assert.match(notice, /agent working on your DeepWater research brief “Heat pumps” can't carry on/)
  assert.match(notice, /Sign in again, then choose Retry/)
  assert.doesNotMatch(notice, /finished|saved to Documents/)
})

test('a lock screen says only a finished research is waiting to be saved', () => {
  assert.match(noticePushBody('blocked'), /before it can be saved/)
  assert.doesNotMatch(noticePushBody('identity_changed'), /saved|finished/)
  assert.match(noticePushBody('identity_changed'), /Sign in again/)
})
