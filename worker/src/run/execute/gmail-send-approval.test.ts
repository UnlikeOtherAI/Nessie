import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

import { GmailApprovalResumeError, resolveFrozenGmailSendApproval } from './gmail-send-approval.js'
import type { RunContext } from './types.js'

const APPROVAL = '11111111-1111-4111-8111-111111111111'
const CONNECTION = '22222222-2222-4222-8222-222222222222'
const DRAFT = '33333333-3333-4333-8333-333333333333'
const ORGANIZATION = '44444444-4444-4444-8444-444444444444'
const RUN = '55555555-5555-4555-8555-555555555555'

const context = (): RunContext => ({
  channel: { id: 'channel-1', organizationId: ORGANIZATION, projectId: null, teamId: null },
  run: { id: RUN },
}) as unknown as RunContext

const actorContext = (): AuthorizedActionContext => ({
  actor: { actorId: '66666666-6666-4666-8666-666666666666', actorType: 'user', roles: [] },
  actionContext: { requestId: 'gmail-approval-resume-test' },
  approval: { approvalId: APPROVAL, approvalProof: 'proof' },
  tenant: { organizationId: ORGANIZATION },
}) as unknown as AuthorizedActionContext

const prisma = (): PrismaClient => ({
  approvalRequest: {
    findFirst: async () => ({
      continuationToken: 'proof',
      resumeState: { args: {
        connectionId: CONNECTION, draftId: DRAFT, expectedFingerprint: 'f'.repeat(64),
        reviewed: { bcc: [], body: 'Reviewed body', cc: [], subject: 'Reviewed', to: ['to@example.test'] },
      } },
    }),
  },
} as unknown as PrismaClient)

test('approved Gmail resume replaces model input with the exact frozen invocation', async () => {
  const resolved = await resolveFrozenGmailSendApproval(
    prisma(), context(), actorContext(), { draftId: DRAFT },
  )
  assert.deepEqual(resolved?.executionArgs, {
    connectionId: CONNECTION, draftId: DRAFT, expectedFingerprint: 'f'.repeat(64),
  })
  assert.equal((resolved?.authorizationArgs.reviewed.body), 'Reviewed body')
})

test('approved Gmail resume rejects model arguments that differ from the frozen approval', async () => {
  await assert.rejects(
    resolveFrozenGmailSendApproval(
      prisma(), context(), actorContext(), { draftId: DRAFT, expectedFingerprint: 'e'.repeat(64) },
    ),
    GmailApprovalResumeError,
  )
})
