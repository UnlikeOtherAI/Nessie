import assert from 'node:assert/strict'
import test from 'node:test'

import {
  APPROVAL_GATE_ACTIONS,
  approvalGateActionLabels,
  canCreateStandingConsentFromApproval,
} from '../src/components/features/channels/approval-gate-eligibility.js'

const CONNECTION = '00000000-0000-4000-8000-000000000001'

test('only supported Google approvals offer standing consent', () => {
  const context = { approvedGoogleConnectionId: CONNECTION }
  assert.equal(canCreateStandingConsentFromApproval('gmail_draft_send', context), true)
  assert.equal(canCreateStandingConsentFromApproval('calendar_event_create', context), true)
  assert.equal(canCreateStandingConsentFromApproval('mailbox_send', context), false)
  assert.equal(canCreateStandingConsentFromApproval('email_account_disconnect', context), false)
})

test('a supported tool without a frozen connection cannot offer standing consent', () => {
  assert.equal(canCreateStandingConsentFromApproval('calendar_event_cancel', {}), false)
})

test('mailbox send and account disconnect retain one-time approval controls only', () => {
  for (const toolName of ['mailbox_send', 'email_account_disconnect']) {
    const actions = approvalGateActionLabels(toolName, {})
    assert.ok(actions.includes(APPROVAL_GATE_ACTIONS.approve))
    assert.ok(actions.includes(APPROVAL_GATE_ACTIONS.reject))
    assert.ok(!actions.includes(APPROVAL_GATE_ACTIONS.standingConsent))
  }
})
