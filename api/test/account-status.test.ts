import assert from 'node:assert/strict'
import test from 'node:test'

import { AccountStatusSchema, type AccountStatus } from '@nessie/schemas'

import {
  aiPlanAccountStatus,
  appAccountStatus,
  browserAccountStatus,
  commsAccountStatus,
  mailboxAccountStatus,
  ticketsAccountStatus,
} from '../src/services/accounts/account-status.js'

// Every store's own status maps onto one of five words, each with a sentence
// that names the remedy and the remedy's code. The table below is the whole
// contract, one row per value of every source: a new raw value that is not
// mapped fails to compile in the mapper, and a changed word fails here.

const PROTOCOL_WORDS = /\b(?:IMAP|SMTP|OAuth|MCP|Browserbase|Ledger|token|scope|instance|credential)\b/i

const check = (status: AccountStatus, word: AccountStatus['word'], remedy: AccountStatus['remedy']) => {
  AccountStatusSchema.parse(status)
  assert.equal(status.word, word)
  assert.equal(status.remedy, remedy)
  assert.match(status.sentence, /^[A-Z].*\.$/, 'a sentence, capitalised and ended')
  assert.doesNotMatch(status.sentence, PROTOCOL_WORDS, `no protocol word in "${status.sentence}"`)
  assert.doesNotMatch(status.sentence, /_/, `no raw enum in "${status.sentence}"`)
}

test('a Google, Microsoft or Slack account', () => {
  check(commsAccountStatus('active', 'Google Workspace'), 'connected', 'none')
  const stopped = commsAccountStatus('needs_reauthorization', 'Slack')
  check(stopped, 'needs_attention', 'reconnect')
  assert.equal(stopped.sentence, 'Stopped: sign in to Slack again.')
  check(commsAccountStatus('disconnected', 'Google Workspace'), 'turned_off', 'reconnect')
  check(commsAccountStatus('error', 'Microsoft 365'), 'error', 'resync')
})

test('a mailbox at another email provider', () => {
  check(mailboxAccountStatus('active'), 'connected', 'none')
  check(mailboxAccountStatus('needs_reauthorization'), 'needs_attention', 'reconnect')
  check(mailboxAccountStatus('disabled'), 'turned_off', 'none')
})

test('a ticket or code account', () => {
  check(ticketsAccountStatus('active', 'Jira'), 'connected', 'none')
  const stopped = ticketsAccountStatus('needs_reauthorization', 'Linear')
  check(stopped, 'needs_attention', 'reconnect')
  assert.match(stopped.sentence, /Linear/)
  check(ticketsAccountStatus('revoked', 'GitHub'), 'turned_off', 'reconnect')
})

test('an AI plan: the health reason is more specific than the status', () => {
  const plan = (
    status: Parameters<typeof aiPlanAccountStatus>[0]['status'],
    healthReason: Parameters<typeof aiPlanAccountStatus>[0]['healthReason'],
  ) => aiPlanAccountStatus({ healthReason, status }, 'Kimi')
  check(plan('active', 'ok'), 'connected', 'none')
  check(plan('needs_reauthorization', 'ok'), 'needs_attention', 'reconnect')
  check(plan('active', 'needs_reauthorization'), 'needs_attention', 'reconnect')
  // An active plan out of quota is not connected-and-fine: nothing runs on it.
  check(plan('active', 'quota_exhausted'), 'needs_attention', 'wait')
  check(plan('error', 'provider_rejected'), 'error', 'reconnect')
  check(plan('active', 'owner_inactive'), 'turned_off', 'ask')
  check(plan('error', 'vault_unavailable'), 'error', 'ask')
  check(plan('error', 'ok'), 'error', 'reconnect')
  // Disconnecting keeps the row; whatever its last health said, it is off.
  check(plan('disconnected', 'quota_exhausted'), 'turned_off', 'reconnect')
})

test('a cloud browser account', () => {
  check(browserAccountStatus({ healthReason: null, status: 'active' }), 'connected', 'none')
  check(
    browserAccountStatus({ healthReason: 'auth_failed', status: 'needs_attention' }),
    'needs_attention',
    'replace_key',
  )
  // A service that could not be reached is retried; nobody should replace a
  // key that is fine.
  check(
    browserAccountStatus({ healthReason: 'unreachable', status: 'needs_attention' }),
    'needs_attention',
    'wait',
  )
  check(
    browserAccountStatus({ healthReason: 'disabled_by_owner', status: 'disabled' }),
    'turned_off',
    'ask',
  )
})

test('a person’s own app connection reads the App Store’s own lifecycle words', () => {
  check(appAccountStatus('active', 'Notion'), 'connected', 'none')
  const unfinished = appAccountStatus('pending_setup', 'Notion')
  check(unfinished, 'not_finished', 'finish_setup')
  assert.equal(unfinished.sentence, 'Not finished: finish signing in to Notion.')
  check(appAccountStatus('paused', 'Notion'), 'turned_off', 'none')
  check(appAccountStatus('error', 'Notion'), 'error', 'reconnect')
})
