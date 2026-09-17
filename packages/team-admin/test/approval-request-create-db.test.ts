import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import { AuthorizedActionContextSchema } from '@nessie/schemas'

import {
  APPROVAL_EXPIRY_SUSPENDED_RUN_MS,
  APPROVAL_EXPIRY_UNATTENDED_MS,
  createApprovalRequestOnce,
  PENDING_APPROVALS_PER_REQUESTER,
  TooManyPendingApprovalsError,
} from '../src/approval-request-create.js'

/**
 * The shared approval creator against a real database.
 *
 * These properties only exist in Postgres: the advisory lock that makes the
 * dedupe check-and-create atomic, and the per-requester ceiling counted
 * inside that lock. A hand-rolled Prisma fake cannot exercise either — it
 * would answer the lock call with a stubbed `$executeRaw` and prove nothing.
 */
const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

type Seed = {
  agentId: string
  credentialId: string
  organizationId: string
  projectId: string
  userId: string
}

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const suffix = randomUUID()
  const organization = await prisma.organization.create({
    data: { name: `approval-create-${suffix}` },
  })
  const project = await prisma.project.create({
    data: { name: 'p', organizationId: organization.id },
  })
  const user = await prisma.user.create({
    data: { displayName: 'Approver', email: `approval-create-${suffix}@example.test` },
  })
  await prisma.organizationMember.create({
    data: { organizationId: organization.id, role: 'owner', userId: user.id },
  })
  const agent = await prisma.agent.create({
    data: { agentKind: 'shared', name: `Asker ${suffix}`, organizationId: organization.id },
  })
  const credential = await prisma.agentAccessCredential.create({
    data: {
      expiresAt: new Date(Date.now() + 86_400_000),
      label: 'Paired agent',
      organizationId: organization.id,
      projectId: project.id,
      scopes: ['documents_read'],
      tokenHash: randomUUID(),
      tokenPrefix: 'nag1_create',
      tokenVersion: 0,
      userId: user.id,
    },
  })
  return {
    agentId: agent.id,
    credentialId: credential.id,
    organizationId: organization.id,
    projectId: project.id,
    userId: user.id,
  }
}

const cleanup = async (prisma: PrismaClient, s: Seed) => {
  await prisma.organization.delete({ where: { id: s.organizationId } })
  await prisma.user.delete({ where: { id: s.userId } }).catch(() => undefined)
  await prisma.$disconnect()
}

const contextFor = (s: Seed) =>
  AuthorizedActionContextSchema.parse({
    actionContext: { requestId: randomUUID() },
    actor: { actorId: s.userId, actorType: 'user', roles: ['owner'] },
    tenant: { organizationId: s.organizationId, projectId: s.projectId },
  })

const publishInput = (s: Seed, pageId: string, versionId: string) => ({
  action: 'knowledge.page.publish' as const,
  actorContext: contextFor(s),
  context: { pageId, versionId },
  lockKey: `kb-publish:${s.organizationId}:${s.agentId}`,
  matches: (pending: { context: Record<string, unknown> | null }) =>
    pending.context?.['pageId'] === pageId && pending.context?.['versionId'] === versionId,
  reason: 'Please publish',
  requester: { agentId: s.agentId },
})

runDatabaseTest('a second ask for the same thing hands back the open request', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    const pageId = randomUUID()
    const versionId = randomUUID()
    const first = await createApprovalRequestOnce(prisma, publishInput(s, pageId, versionId))
    const second = await createApprovalRequestOnce(prisma, publishInput(s, pageId, versionId))

    assert.equal(first.created, true)
    assert.equal(second.created, false)
    assert.equal(second.approval.id, first.approval.id)
    const count = await prisma.approvalRequest.count({
      where: { agentId: s.agentId, organizationId: s.organizationId },
    })
    assert.equal(count, 1, 'a polling agent must not stack requests')
  } finally {
    await cleanup(prisma, s)
  }
})

runDatabaseTest('concurrent asks for one thing converge on a single approval', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    const pageId = randomUUID()
    const versionId = randomUUID()
    // Two clients rather than one: separate connections are the closer model
    // of two replicas, and cost nothing. Honest scope, same as the MCP
    // publish race test: this pins the observable outcome — eight overlapping
    // asks yield one decision — and without artificial synchronisation it
    // cannot prove the advisory lock is what produces it. The lock's absence
    // is covered by the door-level race test in the worker, which fails
    // against the pre-shared implementation.
    const other = new PrismaClient()
    const asks = Array.from({ length: 8 }, (_, index) =>
      createApprovalRequestOnce(index % 2 === 0 ? prisma : other, publishInput(s, pageId, versionId)))
    const results = await Promise.all(asks).finally(() => other.$disconnect())

    const distinct = new Set(results.map((result) => result.approval.id))
    assert.equal(distinct.size, 1, 'a race must not open two decisions')
    assert.equal(results.filter((result) => result.created).length, 1)
    const count = await prisma.approvalRequest.count({
      where: { agentId: s.agentId, organizationId: s.organizationId },
    })
    assert.equal(count, 1, 'exactly one approval survived the race')
  } finally {
    await cleanup(prisma, s)
  }
})

runDatabaseTest('an asker at the pending ceiling is refused, inside the lock', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    // Ten genuinely distinct requests — dedupe keys on the version, so each
    // of these is a new decision, which is exactly the pile the ceiling
    // exists to stop.
    for (let index = 0; index < PENDING_APPROVALS_PER_REQUESTER; index += 1) {
      await createApprovalRequestOnce(prisma, publishInput(s, randomUUID(), randomUUID()))
    }

    await assert.rejects(
      () => createApprovalRequestOnce(prisma, publishInput(s, randomUUID(), randomUUID())),
      (error: unknown) => {
        assert.ok(error instanceof TooManyPendingApprovalsError)
        return true
      },
    )
    const count = await prisma.approvalRequest.count({
      where: { agentId: s.agentId, organizationId: s.organizationId },
    })
    assert.equal(count, PENDING_APPROVALS_PER_REQUESTER, 'a refused ask opens nothing')
  } finally {
    await cleanup(prisma, s)
  }
})

runDatabaseTest('prepare folds its writes and context into the same locked transaction', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    const { approval, created } = await createApprovalRequestOnce(prisma, {
      ...publishInput(s, randomUUID(), randomUUID()),
      context: { outer: true },
      prepare: async () => ({ context: { templateId: randomUUID() } }),
    })

    assert.equal(created, true)
    const stored = await prisma.approvalRequest.findUniqueOrThrow({
      where: { id: approval.id },
    })
    const storedContext = stored.context as Record<string, unknown>
    assert.equal(storedContext['outer'], true)
    assert.ok(storedContext['templateId'], 'the prepared context must merge into the row')
  } finally {
    await cleanup(prisma, s)
  }
})

runDatabaseTest('a throwing prepare rolls the whole unit back, side effects included', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    await assert.rejects(
      () => createApprovalRequestOnce(prisma, {
        ...publishInput(s, randomUUID(), randomUUID()),
        prepare: async (tx) => {
          // The shape a proposal door leaves behind when its approval is
          // refused: a row created beside the approval must not survive it.
          await tx.approvalRequest.create({
            data: {
              action: 'knowledge.page.publish',
              agentId: s.agentId,
              continuationToken: randomUUID(),
              expiresAt: new Date(Date.now() + 60_000),
              organizationId: s.organizationId,
              reason: 'side effect',
              requesterId: s.agentId,
            },
          })
          throw new Error('preparation declined')
        },
      }),
      /preparation declined/,
    )
    const count = await prisma.approvalRequest.count({
      where: { agentId: s.agentId, organizationId: s.organizationId },
    })
    assert.equal(count, 0, 'neither the approval nor its companion row may survive')
  } finally {
    await cleanup(prisma, s)
  }
})

runDatabaseTest('expiry defaults by asker kind and respects an explicit override', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    const before = Date.now()
    const agentAsk = await createApprovalRequestOnce(prisma, publishInput(s, randomUUID(), randomUUID()))
    const agentExpiry = new Date(agentAsk.approval.expiresAt).getTime() - before
    assert.ok(
      Math.abs(agentExpiry - APPROVAL_EXPIRY_SUSPENDED_RUN_MS) < 5_000,
      'a run-suspended ask stands for thirty minutes',
    )

    const credentialAsk = await createApprovalRequestOnce(prisma, {
      ...publishInput(s, randomUUID(), randomUUID()),
      requester: { agentAccessCredentialId: s.credentialId, requiredApproverUserId: s.userId },
    })
    const credentialExpiry = new Date(credentialAsk.approval.expiresAt).getTime() - before
    assert.ok(
      Math.abs(credentialExpiry - APPROVAL_EXPIRY_UNATTENDED_MS) < 5_000,
      'a request nobody is waiting on stands for a week',
    )

    const overridden = await createApprovalRequestOnce(prisma, {
      ...publishInput(s, randomUUID(), randomUUID()),
      expiresInMs: 60_000,
    })
    const overrideExpiry = new Date(overridden.approval.expiresAt).getTime() - before
    assert.ok(Math.abs(overrideExpiry - 60_000) < 5_000, 'an explicit window wins')
  } finally {
    await cleanup(prisma, s)
  }
})

runDatabaseTest('the pinned approver is told once, and a re-ask does not re-ring', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    const pageId = randomUUID()
    const versionId = randomUUID()
    const input = {
      ...publishInput(s, pageId, versionId),
      requester: { agentAccessCredentialId: s.credentialId, requiredApproverUserId: s.userId },
    }
    const first = await createApprovalRequestOnce(prisma, input)
    assert.deepEqual(first.approvers, [s.userId])

    const second = await createApprovalRequestOnce(prisma, input)
    assert.equal(second.created, false)
    assert.deepEqual(second.approvers, [], 'a deduplicated ask rings nobody new')

    const alerts = await prisma.userAlert.findMany({
      where: { approvalRequestId: first.approval.id },
    })
    assert.equal(alerts.length, 1, 'exactly one bell for one decision')
    assert.equal(alerts[0]?.userId, s.userId)
  } finally {
    await cleanup(prisma, s)
  }
})
