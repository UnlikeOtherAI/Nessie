import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import { sweepExpiredApprovals } from '../src/services/approvals.js'

/**
 * Approval expiry has to claim and terminalise in ONE transaction, and it has
 * to heal what an earlier crash left behind (audit 1.5).
 *
 * The old sweep claimed `pending → expired` in one statement and closed the
 * run in a second transaction, then selected `pending` only — so a kill
 * between the two parked the run in `waiting_approval` with nobody left to
 * revisit it.
 */
const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

type Seed = {
  agentId: string
  channelId: string
  organizationId: string
  projectId: string
  teamId: string
  threadId: string
  userId: string
}

const seedTeam = async (prisma: PrismaClient): Promise<Seed> => {
  const organization = await prisma.organization.create({
    data: { name: `approval-sweep-${randomUUID()}` },
  })
  const project = await prisma.project.create({
    data: { name: 'project', organizationId: organization.id },
  })
  const team = await prisma.team.create({ data: { name: 'team', projectId: project.id } })
  const channel = await prisma.channel.create({
    data: {
      label: 'approvals',
      organizationId: organization.id,
      projectId: project.id,
      slug: `approval-sweep-${randomUUID()}`,
      teamId: team.id,
      visibility: 'public',
    },
  })
  const thread = await prisma.thread.create({ data: { channelId: channel.id } })
  const agent = await prisma.agent.create({
    data: { name: 'Sweep agent', organizationId: organization.id, status: 'waiting_approval' },
  })
  const user = await prisma.user.create({
    data: { displayName: 'Approver', email: `sweep-${randomUUID()}@example.com` },
  })
  return {
    agentId: agent.id,
    channelId: channel.id,
    organizationId: organization.id,
    projectId: project.id,
    teamId: team.id,
    threadId: thread.id,
    userId: user.id,
  }
}

const cleanup = async (prisma: PrismaClient, seed: Seed): Promise<void> => {
  await prisma.$executeRaw`DELETE FROM queue_jobs WHERE payload->>'threadId' = ${seed.threadId}`
  await prisma.approvalRequest.deleteMany({ where: { organizationId: seed.organizationId } })
  await prisma.taskEvent.deleteMany({ where: { task: { organizationId: seed.organizationId } } })
  await prisma.task.deleteMany({ where: { organizationId: seed.organizationId } })
  await prisma.message.deleteMany({ where: { threadId: seed.threadId } })
  await prisma.run.deleteMany({ where: { threadId: seed.threadId } })
  await prisma.thread.deleteMany({ where: { id: seed.threadId } })
  await prisma.channel.deleteMany({ where: { id: seed.channelId } })
  await prisma.agent.deleteMany({ where: { id: seed.agentId } })
  await prisma.team.deleteMany({ where: { id: seed.teamId } })
  await prisma.project.deleteMany({ where: { id: seed.projectId } })
  await prisma.user.deleteMany({ where: { id: seed.userId } })
  await prisma.organization.deleteMany({ where: { id: seed.organizationId } })
}

/** A run parked on a tool gate, with the approval left in `status`. */
const seedParkedApproval = async (
  prisma: PrismaClient,
  seed: Seed,
  status: 'pending' | 'expired',
) => {
  const message = await prisma.message.create({
    data: { content: 'Send the update', role: 'user', threadId: seed.threadId, userId: seed.userId },
  })
  const run = await prisma.run.create({
    data: {
      agentId: seed.agentId,
      status: 'waiting_approval',
      threadId: seed.threadId,
      triggerMessageId: message.id,
    },
  })
  const task = await prisma.task.create({
    data: {
      agentId: seed.agentId,
      organizationId: seed.organizationId,
      purpose: message.content,
      runId: run.id,
      status: 'awaiting_approval',
    },
  })
  const approval = await prisma.approvalRequest.create({
    data: {
      action: 'tool.invoke',
      agentId: seed.agentId,
      argsHash: 'expected-args-hash',
      channelId: seed.channelId,
      context: { inputSummary: '{}', toolName: 'message_send' },
      continuationToken: randomUUID(),
      expiresAt: new Date(Date.now() - 60_000),
      organizationId: seed.organizationId,
      projectId: seed.projectId,
      reason: 'Tool message_send requires approval before it can run.',
      requesterId: seed.agentId,
      runId: run.id,
      status,
      taskId: task.id,
      teamId: seed.teamId,
      toolCallId: `tool-call-${randomUUID()}`,
      toolName: 'message_send',
    },
  })
  return { approval, message, run, task }
}

runDatabaseTest(
  'an approval already expired with its run still waiting_approval is terminalised',
  async (t) => {
    const prisma = new PrismaClient()
    const seed = await seedTeam(prisma)
    t.after(async () => {
      await cleanup(prisma, seed)
      await prisma.$disconnect()
    })
    // Exactly the state a kill between the old claim and the old
    // terminalisation left behind.
    const parked = await seedParkedApproval(prisma, seed, 'expired')

    await sweepExpiredApprovals(prisma)

    // The assertions that fail without the fix: the old sweep selected
    // `status: 'pending'` only, so this row was invisible forever and the run
    // stayed `waiting_approval`.
    assert.equal((await prisma.run.findUnique({ where: { id: parked.run.id } }))?.status, 'failed')
    assert.equal((await prisma.task.findUnique({ where: { id: parked.task.id } }))?.status, 'failed')
    const notice = await prisma.message.findFirst({
      where: {
        metadata: { equals: parked.approval.id, path: ['approvalGate', 'approvalId'] },
        threadId: seed.threadId,
      },
    })
    assert.ok(notice, 'the thread is told the approval expired')
    assert.equal(
      (await prisma.agent.findUnique({ where: { id: seed.agentId } }))?.status,
      'idle',
    )
    assert.equal(
      await prisma.taskEvent.count({
        where: { eventType: 'run.approval_expired', taskId: parked.task.id },
      }),
      1,
    )
  },
)

/**
 * Interleave a competing resolution between the sweep's SELECT and its
 * conditional UPDATE — the race the claim exists to lose safely.
 */
const clientLosingTheClaim = (prisma: PrismaClient, approvalId: string): PrismaClient =>
  new Proxy(prisma, {
    get(target, property) {
      if (property !== 'approvalRequest') {
        const value = Reflect.get(target, property) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      }
      return new Proxy(target.approvalRequest, {
        get(delegate, delegateProperty) {
          if (delegateProperty !== 'findMany') {
            const value = Reflect.get(delegate, delegateProperty) as unknown
            return typeof value === 'function' ? value.bind(delegate) : value
          }
          return async (args: never) => {
            const rows = await delegate.findMany(args)
            await target.approvalRequest.updateMany({
              where: { id: approvalId },
              data: { status: 'approved' },
            })
            return rows
          }
        },
      })
    },
  }) as PrismaClient

runDatabaseTest('a claim that loses writes nothing', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedTeam(prisma)
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })
  const parked = await seedParkedApproval(prisma, seed, 'pending')

  await sweepExpiredApprovals(clientLosingTheClaim(prisma, parked.approval.id))

  // The assertions that fail without the `expiredClaim.count !== 1` guard: the
  // sweep would terminalise a request somebody had just approved, failing the
  // run and posting an "Approval expired" notice over the top of it.
  assert.equal(
    (await prisma.approvalRequest.findUnique({ where: { id: parked.approval.id } }))?.status,
    'approved',
  )
  assert.equal(
    (await prisma.run.findUnique({ where: { id: parked.run.id } }))?.status,
    'waiting_approval',
  )
  assert.equal(
    (await prisma.task.findUnique({ where: { id: parked.task.id } }))?.status,
    'awaiting_approval',
  )
  assert.equal(
    await prisma.message.count({ where: { role: 'assistant', threadId: seed.threadId } }),
    0,
  )
  assert.equal(
    await prisma.taskEvent.count({ where: { taskId: parked.task.id } }),
    0,
  )
})
