import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import type { Prisma, PrismaClient } from '@prisma/client'
import {
  executorCodingSessionOwnerKey,
  prepareExecutorAccessChange,
  removePrivateAssignment,
  setExecutorAgentWholeSuiteGrant,
  transitionExecutorLifecycle,
} from '@nessie/executor-manage'
import { ExecutorCapabilityDescriptorSchema, ticketWorkCodingSessionContext } from '@nessie/schemas'

import { unbindAgentFromChannel } from '../src/agent-bindings.js'
import { deleteBoard, deleteBoardColumn } from '../src/board-structure.js'
import { deleteChannel, setChannelArchived, updateChannel } from '../src/channel-manage.js'
import { deleteProject } from '../src/project-delete.js'
import { endStandingPoliciesForAuthorInTransaction } from '../src/standing-policy-fences.js'
import { confirmPolicy, seatAuthor } from './standing-policy-binding-fixture.js'
import { seedStandingPolicyWorld, testPrisma, type StandingPolicyWorld } from './standing-policy-fixture.js'

/**
 * Every fence ends standing machine access in the transaction of its change
 * (docs/plans/2026-09-23-ticket-driven-agents/machine-access.md → "Fences"):
 * the machine paused, drained or revoked, a person's or the agent's access
 * withdrawn, a review that narrows what it offers, the author losing the
 * board or deactivated, the agent unbound from the target channel, that
 * channel archived, deleted or made non-public, and the project, a board or a
 * start-work column gone. Each writes `executor.policy.ended` with its reason,
 * cancels the tickets' live work, and closes their sessions by id under the
 * ticket's own owner context.
 */

const dbTest = process.env.DATABASE_URL ? test : test.skip

type Fence = {
  minis: string
  policyId: string
  sessionId: string
  taskId: string
  workId: string
  world: StandingPolicyWorld
}

const withFence = async (run: (fence: Fence, prisma: PrismaClient) => Promise<void>): Promise<void> => {
  const prisma = testPrisma()
  const world = await seedStandingPolicyWorld(prisma)
  try {
    await seatAuthor(prisma, world)
    const minis = await world.machine({ label: 'Minis' })
    const policyId = await confirmPolicy(world, [minis])
    const taskId = await world.task('Fix login redirect')
    const sessionId = randomUUID()
    const work = await world.work({ executorId: minis, policyId, sessionIds: [sessionId], status: 'active', taskId })
    await run({ minis, policyId, sessionId, taskId, workId: work.id, world }, prisma)
  } finally {
    try { await world.cleanup() } finally { await prisma.$disconnect() }
  }
}

/**
 * The policy ended for this reason, by this actor; its work cancelled; the
 * session closed by id in the ticket's own context.
 */
const assertEnded = async (
  prisma: PrismaClient, fence: Fence, reason: string, actorId?: string | null, closeReason = 'policy_ended',
) => {
  const policy = await prisma.executorStandingPolicy.findUniqueOrThrow({ where: { id: fence.policyId } })
  assert.deepEqual([policy.status, policy.endedReason], ['ended', reason])
  if (actorId !== undefined) assert.equal(policy.endedByUserId, actorId)
  const work = await prisma.agentTicketWork.findUniqueOrThrow({ where: { id: fence.workId } })
  assert.deepEqual([work.status, work.stateReason], ['cancelled', 'machine_access_ended'], reason)
  const close = await prisma.executorCodingSessionCloseRequest.findFirst({
    where: { executorId: fence.minis, reason: closeReason, sessionId: fence.sessionId },
  })
  assert.equal(close?.ownerKey, executorCodingSessionOwnerKey(fence.minis, {
    actorUserId: fence.world.authorId,
    agentId: fence.world.agentId,
    contextId: ticketWorkCodingSessionContext(fence.policyId, fence.taskId),
  }), `${reason}: the ticket's own session, by id`)
  const audit = await prisma.auditLog.findFirstOrThrow({
    where: { action: 'executor.policy.ended', resourceId: fence.policyId },
  })
  assert.equal((audit.metadata as { reason: string }).reason, reason)
}

dbTest('pausing, draining or revoking the machine ends the machine access naming it', async () => {
  for (const [action, reason] of [['pause', 'executor_paused'], ['drain', 'executor_drained'], ['revoke', 'executor_revoked']] as const) {
    await withFence(async (fence, prisma) => {
      await transitionExecutorLifecycle(prisma, fence.world.authorContext, { action, executorId: fence.minis })
      await assertEnded(prisma, fence, reason, fence.world.authorId)
    })
  }
})

dbTest('the author\'s place on the roster or the agent\'s access withdrawn ends it', async () => {
  await withFence(async (fence, prisma) => {
    // Another administrator removes the author from the machine's roster.
    await prisma.executorPrivateAssignment.create({
      data: { executorId: fence.minis, principalKind: 'user', role: 'admin', userId: fence.world.ownerId },
    })
    await removePrivateAssignment(prisma, fence.world.contextFor(fence.world.ownerId), {
      executorId: fence.minis, principal: { principalKind: 'user', userId: fence.world.authorId },
    })
    await assertEnded(prisma, fence, 'access_revoked', fence.world.ownerId)
  })
  await withFence(async (fence, prisma) => {
    // The owner-wide close this writes carries no ticket context; the policy's own names the session.
    await setExecutorAgentWholeSuiteGrant(prisma, fence.world.authorContext, {
      agentId: fence.world.agentId, executorId: fence.minis, state: 'denied',
    })
    await assertEnded(prisma, fence, 'access_revoked', fence.world.authorId)
  })
})

dbTest('a review that leaves the machine without the pair or the coding bridge ends it', async () => {
  await withFence(async (fence, prisma) => {
    const descriptor = ExecutorCapabilityDescriptorSchema.parse({
      limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 1024, maxSessions: 2 },
      localPolicyDigest: `sha256:${'3'.repeat(64)}`,
      operationKeys: ['mcp.tools', 'mcp.call'],
      platform: { architecture: 'x64', os: 'windows', osMajorVersion: 26100 },
      profiles: ['workspace_sandbox'], protocolVersion: 1, revision: 2, sandboxBackend: 'none', supervisor: 'service',
    })
    await prisma.executorCapabilityRevision.create({
      data: {
        descriptor: descriptor as unknown as Prisma.InputJsonValue, executorId: fence.minis,
        localPolicyDigest: descriptor.localPolicyDigest, revision: 2, signature: 'proposed',
      },
    })
    const review = await prepareExecutorAccessChange(prisma, fence.world.authorContext, {
      change: { kind: 'descriptor_review', revision: 2, status: 'active' }, executorId: fence.minis,
    })
    await fence.world.confirm(review)
    // The review's effects suspend it first, which already closed the session; the review itself ends it.
    await assertEnded(prisma, fence, 'descriptor_narrowed', fence.world.authorId, 'policy_suspended')
  })
})

dbTest('the author losing the board, or deactivated, ends it', async () => {
  await withFence(async (fence, prisma) => {
    await prisma.$transaction(async (tx) => {
      await tx.projectMember.deleteMany({ where: { projectId: fence.world.projectId, userId: fence.world.authorId } })
      await endStandingPoliciesForAuthorInTransaction(tx, {
        actor: { userId: fence.world.ownerId },
        organizationId: fence.world.organizationId,
        userId: fence.world.authorId,
      })
    })
    await assertEnded(prisma, fence, 'author_lost_access', fence.world.ownerId)
  })
  await withFence(async (fence, prisma) => {
    // Still on the project: nothing to end.
    const kept = await prisma.$transaction((tx) => endStandingPoliciesForAuthorInTransaction(tx, {
      organizationId: fence.world.organizationId, userId: fence.world.authorId,
    }))
    assert.deepEqual(kept, [])
    await prisma.$transaction((tx) => endStandingPoliciesForAuthorInTransaction(tx, {
      deactivated: true, organizationId: fence.world.organizationId, userId: fence.world.authorId,
    }))
    await assertEnded(prisma, fence, 'author_deactivated', null)
  })
})

dbTest('the agent unbound from the target channel ends it; the other channel does not', async () => {
  await withFence(async (fence, prisma) => {
    const { world } = fence
    await unbindAgentFromChannel(prisma, {
      agentId: world.agentId, channelId: world.opsId, organizationId: world.organizationId, userId: world.ownerId,
    })
    assert.equal((await prisma.executorStandingPolicy.findUniqueOrThrow({ where: { id: fence.policyId } })).status, 'live')
    await unbindAgentFromChannel(prisma, {
      agentId: world.agentId, channelId: world.engId, organizationId: world.organizationId, userId: world.ownerId,
    })
    await assertEnded(prisma, fence, 'agent_unbound', world.ownerId)
  })
})

dbTest('the target channel archived, deleted or made protected ends it', async () => {
  const cases: Array<[string, (fence: Fence, prisma: PrismaClient) => Promise<unknown>]> = [
    ['archived', (fence, prisma) => setChannelArchived(prisma, {
      archived: true, channelId: fence.world.engId, isOrganizationAdmin: true,
      organizationId: fence.world.organizationId,
      userId: fence.world.ownerId,
    })],
    ['deleted', (fence, prisma) => deleteChannel(prisma, {
      channelId: fence.world.engId, isOrganizationAdmin: true, organizationId: fence.world.organizationId,
      userId: fence.world.ownerId,
    })],
    ['protected', (fence, prisma) => updateChannel(prisma, {
      channelId: fence.world.engId, isOrganizationAdmin: true, organizationId: fence.world.organizationId,
      userId: fence.world.ownerId, visibility: 'protected',
    })],
  ]
  for (const [label, change] of cases) {
    await withFence(async (fence, prisma) => {
      assert.ok(await change(fence, prisma), label)
      await assertEnded(prisma, fence, 'target_channel_unavailable', fence.world.ownerId)
    })
  }
})

dbTest('the project, the board or a start-work column gone ends it', async () => {
  await withFence(async (fence, prisma) => {
    const other = await prisma.boardColumn.create({
      data: { boardId: fence.world.board, category: 'todo', name: 'Icebox', organizationId: fence.world.organizationId, position: 9 },
    })
    // A column it does not start work from changes nothing.
    await deleteBoardColumn(prisma, fence.world.board, other.id, fence.world.authorId)
    assert.equal((await prisma.executorStandingPolicy.findUniqueOrThrow({ where: { id: fence.policyId } })).status, 'live')
    const { board, columns } = fence.world
    assert.deepEqual(await deleteBoardColumn(prisma, board, columns.inProgress, fence.world.authorId), { ok: true })
    await assertEnded(prisma, fence, 'scope_archived', fence.world.authorId)
  })
  await withFence(async (fence, prisma) => {
    const spare = await prisma.board.create({
      data: { name: 'Spare', organizationId: fence.world.organizationId, position: 1, projectId: fence.world.projectId },
    })
    const { board, projectId } = fence.world
    assert.deepEqual(await deleteBoard(prisma, projectId, board, spare.id, fence.world.authorId), { ok: true })
    await assertEnded(prisma, fence, 'scope_archived', fence.world.authorId)
  })
  await withFence(async (fence, prisma) => {
    const deleted = await deleteProject(prisma, {
      actorUserId: fence.world.ownerId, organizationId: fence.world.organizationId, projectId: fence.world.projectId,
    })
    assert.equal(deleted.kind, 'deleted', JSON.stringify(deleted))
    await assertEnded(prisma, fence, 'scope_archived', fence.world.ownerId)
  })
})
