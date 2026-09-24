import assert from 'node:assert/strict'
import test from 'node:test'
import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import { executorAccessVerificationBinding } from '../src/executor-access-verification.js'
import { hashExecutorContinuationValue } from '../src/executor-continuation-security.js'

const actor = {
  actor: { actorId: 'person' }, tenant: { organizationId: 'org' },
} as AuthorizedActionContext
const input = { accessChangeId: 'change', confirmationToken: 'secret' }
const row = {
  id: 'change', executorId: 'machine', actorUserId: 'person', status: 'pending',
  expiresAt: new Date(Date.now() + 60_000), verificationChallengeId: 'nonce',
  subjectDigest: 'terms', confirmationTokenHash: hashExecutorContinuationValue('secret'),
}
const db = (record: unknown) => ({ executorContinuation: { findFirst: async (args: unknown) => {
  assert.deepEqual(args, { where: {
    id: 'change', actorUserId: 'person', executor: { organizationId: 'org' },
  } })
  return record
} } }) as unknown as PrismaClient

test('proof binds each change, actor, machine, nonce and immutable terms', async () => {
  const original = await executorAccessVerificationBinding(db(row), actor, input)
  assert.match(original.actionDigest, /^[a-f0-9]{64}$/)
  for (const field of ['id', 'executorId', 'actorUserId', 'verificationChallengeId', 'subjectDigest']) {
    const next = await executorAccessVerificationBinding(db({ ...row, [field]: 'different' }), actor, input)
    assert.notEqual(next.actionDigest, original.actionDigest)
  }
})

test('unknown, wrong-token, used, expired and unverified continuations cannot request a factor', async () => {
  for (const record of [null, { ...row, confirmationTokenHash: 'wrong' }, { ...row, status: 'consumed' },
    { ...row, expiresAt: new Date(0) }, { ...row, verificationChallengeId: null }]) {
    await assert.rejects(executorAccessVerificationBinding(db(record), actor, input))
  }
})
