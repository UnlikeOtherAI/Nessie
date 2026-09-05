import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

import { GmailApprovalResumeError, resolveFrozenGmailSendApproval } from './gmail-send-approval.js'
import { hashJsonValue } from '../tool-util.js'
import type { RunContext } from './types.js'

const APPROVAL = '11111111-1111-4111-8111-111111111111'
const CONNECTION = '22222222-2222-4222-8222-222222222222'
const DRAFT = '33333333-3333-4333-8333-333333333333'
const ORGANIZATION = '44444444-4444-4444-8444-444444444444'
const RUN = '55555555-5555-4555-8555-555555555555'
const SUSPENDED_RUN = '77777777-7777-4777-8777-777777777777'

const frozenArgs = {
  connectionId: CONNECTION, draftId: DRAFT, expectedFingerprint: 'f'.repeat(64),
  reviewed: { bcc: [], body: 'Reviewed body', cc: [], subject: 'Reviewed', to: ['to@example.test'] },
}

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

const prisma = (input: { consumed?: boolean; lineage?: string | null } = {}): PrismaClient => {
  const approval = {
    action: 'tool.invoke',
    argsHash: hashJsonValue(frozenArgs),
    continuationToken: 'proof',
    id: APPROVAL,
    organizationId: ORGANIZATION,
    proofConsumedAt: input.consumed ? new Date() : null,
    resumeState: { args: frozenArgs },
    runId: SUSPENDED_RUN,
    status: 'approved',
    toolName: 'gmail_draft_send',
  }
  const matches = (where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => approval[key as keyof typeof approval] === value)
  return {
    approvalRequest: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        matches(where) ? approval : null,
    },
    run: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        assert.equal(where.id, RUN)
        return { continuationOfRunId: input.lineage ?? SUSPENDED_RUN }
      },
    },
  } as unknown as PrismaClient
}

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

test('an approved Gmail continuation accepts the suspended run, never the new run id', async () => {
  const resolved = await resolveFrozenGmailSendApproval(
    prisma(), context(), actorContext(), { draftId: DRAFT },
  )
  assert.equal(resolved?.authorizationArgs.draftId, DRAFT)
})

for (const [name, input] of [
  ['a non-lineage continuation', { lineage: 'other-run' }],
  ['an already consumed proof', { consumed: true }],
] as const) {
  test(`${name} cannot unlock a frozen Gmail send`, async () => {
    await assert.rejects(
      resolveFrozenGmailSendApproval(prisma(input), context(), actorContext(), { draftId: DRAFT }),
      GmailApprovalResumeError,
    )
  })
}
