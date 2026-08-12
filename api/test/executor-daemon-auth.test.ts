import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ExecutorDaemonChallengeResponseSchema,
  ExecutorDaemonClaimRequestSchema,
} from '@nessie/schemas'

import {
  issueExecutorDaemonChallenge,
  verifyExecutorDaemonChallenge,
} from '../src/services/executor-daemon-auth.js'

const SECRET = 'test-secret'
const EXECUTOR_ID = '11111111-1111-4111-8111-111111111111'
const NOW = new Date('2026-08-12T12:00:00.000Z')

test('daemon challenge is bound to one executor and expires', () => {
  const issued = issueExecutorDaemonChallenge(EXECUTOR_ID, SECRET, NOW)
  assert.equal(ExecutorDaemonChallengeResponseSchema.safeParse(issued).success, true)
  assert.equal(
    ExecutorDaemonClaimRequestSchema.safeParse({
      challenge: issued.challenge,
      executorId: EXECUTOR_ID,
      signature: 'a'.repeat(64),
    }).success,
    true,
  )
  assert.equal(verifyExecutorDaemonChallenge(issued.challenge, EXECUTOR_ID, SECRET, NOW), true)
  assert.equal(verifyExecutorDaemonChallenge(
    issued.challenge,
    '22222222-2222-4222-8222-222222222222',
    SECRET,
    NOW,
  ), false)
  assert.equal(verifyExecutorDaemonChallenge(
    issued.challenge,
    EXECUTOR_ID,
    SECRET,
    new Date(NOW.getTime() + 60_001),
  ), false)
})

test('daemon challenge rejects altered payloads and signatures', () => {
  const issued = issueExecutorDaemonChallenge(EXECUTOR_ID, SECRET, NOW)
  const [payload, signature] = issued.challenge.split('.')
  assert.ok(payload)
  assert.ok(signature)
  assert.equal(verifyExecutorDaemonChallenge(
    `${payload}x.${signature}`,
    EXECUTOR_ID,
    SECRET,
    NOW,
  ), false)
  assert.equal(verifyExecutorDaemonChallenge(
    `${payload}.${signature}x`,
    EXECUTOR_ID,
    SECRET,
    NOW,
  ), false)
})
