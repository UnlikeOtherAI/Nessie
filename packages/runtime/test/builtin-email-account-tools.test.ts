import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BUILTIN_TOOL_DEFINITIONS,
  EMAIL_ACCOUNT_TOOL_DEFINITIONS,
  STRUCTURALLY_APPROVAL_GATED_TOOL_IDS,
} from '../src/index.js'

test('email account lifecycle tools are PA-only and separately named from message tools', () => {
  assert.deepEqual(
    EMAIL_ACCOUNT_TOOL_DEFINITIONS.map((tool) => tool.id),
    [
      'email_account_list',
      'email_account_connect',
      'email_account_check',
      'email_account_disconnect',
      'email_account_agent_access',
    ],
  )
  assert.ok(EMAIL_ACCOUNT_TOOL_DEFINITIONS.every((tool) => tool.personalAssistantOnly))
  assert.ok(EMAIL_ACCOUNT_TOOL_DEFINITIONS.every((tool) => tool.category === 'email-calendar'))
  assert.ok(
    EMAIL_ACCOUNT_TOOL_DEFINITIONS.every((tool) =>
      BUILTIN_TOOL_DEFINITIONS.some((registered) => registered.id === tool.id)
    ),
  )
})

test('disconnect is structurally approval gated while listing is read-only', () => {
  const disconnect = EMAIL_ACCOUNT_TOOL_DEFINITIONS.find(
    (tool) => tool.id === 'email_account_disconnect',
  )
  const list = EMAIL_ACCOUNT_TOOL_DEFINITIONS.find(
    (tool) => tool.id === 'email_account_list',
  )
  assert.equal(disconnect?.requiresApproval, true)
  assert.equal(disconnect?.safe, false)
  assert.equal(list?.safe, true)
  assert.equal(STRUCTURALLY_APPROVAL_GATED_TOOL_IDS.has('email_account_disconnect'), true)
})

test('the connection tool cannot accept a secret through model arguments', () => {
  const connect = EMAIL_ACCOUNT_TOOL_DEFINITIONS.find(
    (tool) => tool.id === 'email_account_connect',
  )
  assert.deepEqual(Object.keys(connect?.parameters.properties ?? {}), ['scope'])
  for (const forbidden of ['password', 'username', 'oauthCode', 'imapHost', 'smtpHost']) {
    assert.equal(connect?.parameters.properties[forbidden], undefined)
  }
  assert.match(connect?.description ?? '', /never ask them to paste an email password/)
})
