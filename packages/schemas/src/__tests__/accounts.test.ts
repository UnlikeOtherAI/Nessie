import assert from 'node:assert/strict'
import test from 'node:test'

import {
  accessCheckVerdict,
  formatAccessCheckContext,
  parseAccessCheckContext,
  type AccessCheckStep,
} from '../access-check.js'
import {
  AccountRecordSchema,
  formatAccountId,
  formatAccountListScope,
  parseAccountId,
  parseAccountListScope,
  parseListedAccountId,
} from '../accounts.js'

const id = '8f3a5a00-0e64-4d10-a517-0d0b69c1d101'

test('an account id names its store and a uuid, and nothing else parses', () => {
  assert.equal(formatAccountId('mailbox', id), `mailbox:${id}`)
  assert.deepEqual(parseAccountId(`mailbox:${id}`), { id, kind: 'mailbox' })
  assert.deepEqual(parseAccountId(`ai-plan:${id}`), { id, kind: 'ai-plan' })
  assert.deepEqual(parseAccountId(`computer:${id}`), { id, kind: 'computer' })
  // A bare id is the retired address form: it names no store, so it is refused
  // rather than looked up in every table in turn.
  assert.equal(parseAccountId(id), null)
  assert.equal(parseAccountId(`mailbox:not-a-uuid`), null)
  assert.equal(parseAccountId(`vault:${id}`), null)
  assert.equal(parseAccountId(`:${id}`), null)
  assert.equal(parseAccountId(`toString:${id}`), null)
})

test('a computer is a grant subject but never a listed account', () => {
  assert.equal(parseListedAccountId(`computer:${id}`), null)
  assert.deepEqual(parseListedAccountId(`browser:${id}`), { id, kind: 'browser' })
})

test('the list scope is the viewer, the organisation or one named team', () => {
  assert.deepEqual(parseAccountListScope(undefined), { kind: 'me' })
  assert.deepEqual(parseAccountListScope('me'), { kind: 'me' })
  assert.deepEqual(parseAccountListScope('organisation'), { kind: 'organisation' })
  assert.deepEqual(parseAccountListScope(`team:${id}`), { kind: 'team', teamId: id })
  // A team the address cannot name is an error, never a fall-back.
  assert.equal(parseAccountListScope('team:'), null)
  assert.equal(parseAccountListScope('team:design'), null)
  assert.equal(parseAccountListScope('organization'), null)
  assert.equal(formatAccountListScope({ kind: 'team', teamId: id }), `team:${id}`)
  assert.equal(formatAccountListScope({ kind: 'me' }), 'me')
})

test('an access check context is a direct conversation, a channel or no person at all', () => {
  assert.deepEqual(parseAccessCheckContext(undefined), { kind: 'direct' })
  assert.deepEqual(parseAccessCheckContext('unattended'), { kind: 'unattended' })
  assert.deepEqual(parseAccessCheckContext(`channel:${id}`), { channelId: id, kind: 'channel' })
  assert.equal(parseAccessCheckContext('channel:general'), null)
  assert.equal(parseAccessCheckContext('project'), null)
  assert.equal(formatAccessCheckContext({ channelId: id, kind: 'channel' }), `channel:${id}`)
})

const step = (
  stepId: AccessCheckStep['id'],
  outcome: AccessCheckStep['outcome'],
): AccessCheckStep => ({
  id: stepId,
  label: stepId,
  outcome,
  reason: { code: 'x', sentence: 'x.' },
  remedy: null,
})

test('the verdict is refused at any failure, and approval only when the policy step warns', () => {
  assert.equal(accessCheckVerdict([step('account', 'pass'), step('policy', 'pass')]), 'allowed')
  assert.equal(
    accessCheckVerdict([step('account', 'pass'), step('policy', 'warn')]),
    'allowed_with_approval',
  )
  // A warning elsewhere (an ambiguous mailbox the agent will ask about) does
  // not turn a use into one that stops for a person.
  assert.equal(accessCheckVerdict([step('context', 'warn'), step('policy', 'pass')]), 'allowed')
  assert.equal(accessCheckVerdict([step('agent', 'fail'), step('policy', 'warn')]), 'refused')
})

test('an account row carries no field for a credential', () => {
  const row = {
    actions: ['disconnect'],
    agents: { canManage: true, count: 1, rule: 'listed' },
    capabilities: ['Read and send mail'],
    connectedAt: '2026-09-26T10:00:00.000Z',
    detail: null,
    id: `mailbox:${id}`,
    integration: null,
    kind: 'mailbox',
    label: 'support@example.com',
    lastActiveAt: null,
    owner: { kind: 'team', name: 'Support', teamId: id },
    purpose: 'mail',
    scope: 'team',
    service: 'imap',
    serviceName: 'Other email provider',
    status: { remedy: 'none', sentence: 'Connected.', word: 'connected' },
  }
  const parsed = AccountRecordSchema.parse({ ...row, password: 'hunter2', credentialRef: 'secret_x' })
  assert.equal('password' in parsed, false)
  assert.equal('credentialRef' in parsed, false)
})
