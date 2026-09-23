import assert from 'node:assert/strict'
import test from 'node:test'

import { LedgerIdentityError, UOA_SUBJECT_FORBIDDEN_CODE } from '@nessie/runtime'

import { classifyError, resolveRecovery, userMessageForFailureReason } from './error-classification.js'

/**
 * A run whose model call cannot be signed as the person it acts for (Water
 * plan amendments-fable F4) fails as theirs to fix: never retried, never
 * turned into an answer-shaped apology, and never mistaken for the model
 * provider refusing the deployment — UOA's refusal is a 403 too.
 */

const exchangeFailed = (status: number, code: string | null) =>
  new LedgerIdentityError('LEDGER_UOA_TOKEN_EXCHANGE_FAILED', `UOA delegation exchange failed with HTTP ${status}`, {
    kind: 'refused',
    status,
    code,
  })

test('a requester UOA refuses, or one with no linked identity, is a changed sign-in', () => {
  for (const error of [
    exchangeFailed(403, UOA_SUBJECT_FORBIDDEN_CODE),
    new LedgerIdentityError('LEDGER_UOA_TOKEN_EXCHANGE_FAILED', 'epoch moved', { kind: 'epoch_mismatch' }),
    new LedgerIdentityError('LEDGER_UOA_IDENTITY_REQUIRED', 'no linked identity'),
    // An inference stage keeps only the message of what it caught, and marks it.
    Object.assign(new Error('UOA delegation exchange failed with HTTP 403'), { requesterIdentityRefused: true }),
  ]) {
    assert.equal(classifyError(error), 'requester_identity')
  }
  assert.deepEqual(resolveRecovery('requester_identity', 0, { remaining: 6, total: 6 }), { action: 'fail_run' })
  assert.deepEqual(resolveRecovery('requester_identity', 0, { remaining: 0, total: 6 }), { action: 'fail_run' })
  assert.match(userMessageForFailureReason('requester_identity'), /your sign-in has changed\. Sign in again/)
})

test('a UOA refusal that does not name the person is not the person\'s sign-in', () => {
  assert.notEqual(classifyError(exchangeFailed(403, null)), 'requester_identity')
  assert.notEqual(classifyError(exchangeFailed(503, null)), 'requester_identity')
  assert.notEqual(classifyError(Object.assign(new Error('boom'), { requesterIdentityRefused: false })), 'requester_identity')
})
