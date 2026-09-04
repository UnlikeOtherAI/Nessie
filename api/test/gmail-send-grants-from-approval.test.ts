import assert from 'node:assert/strict'
import test from 'node:test'

import { approvedGoogleConnectionForStandingConsent } from '../src/routes/gmail-drafts.js'

const CONNECTION = '00000000-0000-4000-8000-000000000001'

test('a standing send grant accepts only a supported Google approval with its frozen connection', () => {
  assert.equal(
    approvedGoogleConnectionForStandingConsent({
      action: 'tool.invoke',
      context: { approvedGoogleConnectionId: CONNECTION },
      toolName: 'gmail_draft_send',
    }),
    CONNECTION,
  )
  assert.equal(
    approvedGoogleConnectionForStandingConsent({
      action: 'tool.invoke',
      context: { approvedGoogleConnectionId: CONNECTION },
      toolName: 'calendar_event_update',
    }),
    CONNECTION,
  )
})

test('a mailbox or lifecycle approval cannot create a Gmail send grant', () => {
  for (const toolName of ['mailbox_send', 'email_account_disconnect']) {
    assert.equal(
      approvedGoogleConnectionForStandingConsent({
        action: 'tool.invoke',
        context: { approvedGoogleConnectionId: CONNECTION },
        toolName,
      }),
      null,
    )
  }
})

test('a supported approval without a frozen connection cannot create a grant', () => {
  assert.equal(
    approvedGoogleConnectionForStandingConsent({
      action: 'tool.invoke', context: {}, toolName: 'gmail_draft_send',
    }),
    null,
  )
})

test('a non-tool approval cannot create standing consent', () => {
  assert.equal(
    approvedGoogleConnectionForStandingConsent({
      action: 'agent.todo.publish',
      context: { approvedGoogleConnectionId: CONNECTION },
      toolName: 'gmail_draft_send',
    }),
    null,
  )
})
