import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { PrismaClient } from '@prisma/client'
import {
  parseOrganizationId,
  parseProjectId,
  parseTeamId,
  type AuthorizedActionContext,
} from '@nessie/schemas'
import { resolveApprovalRequest } from '../src/services/approvals.js'

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

const actorFor = (seed: Seed): AuthorizedActionContext => ({
  actor: { actorId: seed.userId, actorType: 'user', roles: ['owner'] },
  actionContext: { requestId: `approval-resume-${randomUUID()}` },
  tenant: {
    organizationId: parseOrganizationId(seed.organizationId),
    projectId: parseProjectId(seed.projectId),
    teamId: parseTeamId(seed.teamId),
  },
})

const seedTeam = async (prisma: PrismaClient): Promise<Seed> => {
  const organization = await prisma.organization.create({ data: { name: `approval-${randomUUID()}` } })
  const project = await prisma.project.create({ data: { name: 'project', organizationId: organization.id } })
  const team = await prisma.team.create({ data: { name: 'team', projectId: project.id } })
  const channel = await prisma.channel.create({
    data: {
      label: 'approvals',
      organizationId: organization.id,
      projectId: project.id,
      slug: `approvals-${randomUUID()}`,
      teamId: team.id,
      visibility: 'public',
    },
  })
  const thread = await prisma.thread.create({ data: { channelId: channel.id } })
  const agent = await prisma.agent.create({ data: { name: 'Approvals agent', organizationId: organization.id } })
  const user = await prisma.user.create({
    data: { displayName: 'Approver', email: `approver-${randomUUID()}@example.com` },
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

const seedSuspendedApproval = async (prisma: PrismaClient, seed: Seed) => {
  const message = await prisma.message.create({
    data: { content: 'Send the Czech update', role: 'user', threadId: seed.threadId, userId: seed.userId },
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
  const checkpoint = await prisma.runCheckpoint.create({
    data: {
      agentId: seed.agentId,
      generation: 1,
      note: 'Untrusted working notes.',
      organizationId: seed.organizationId,
      reason: 'approval_required',
      runId: run.id,
      threadId: seed.threadId,
    },
  })
  const continuationToken = randomUUID()
  const approval = await prisma.approvalRequest.create({
    data: {
      action: 'tool.invoke',
      agentId: seed.agentId,
      argsHash: 'expected-args-hash',
      channelId: seed.channelId,
      context: { inputSummary: '{"message":"Ahoj"}', toolName: 'message_send' },
      continuationToken,
      expiresAt: new Date(Date.now() + 60_000),
      organizationId: seed.organizationId,
      projectId: seed.projectId,
      reason: 'Tool message_send requires approval before it can run.',
      requesterId: seed.agentId,
      resumeState: {
        actorContext: actorFor(seed),
        args: { message: 'Ahoj', target: 'team' },
        interactive: true,
        messageId: message.id,
      },
      runId: run.id,
      taskId: task.id,
      teamId: seed.teamId,
      toolCallId: 'tool-call-1',
      toolName: 'message_send',
    },
  })
  return { approval, checkpoint, run, task }
}

runDatabaseTest('approving a tool gate claims its checkpoint and queues one approval continuation', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedTeam(prisma)
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })
  const suspended = await seedSuspendedApproval(prisma, seed)

  const result = await resolveApprovalRequest(
    prisma,
    suspended.approval.id,
    actorFor(seed),
    'approved',
  )
  assert.ok(result && !('error' in result))
  if (!result || 'error' in result) return
  assert.equal('resumeState' in result.approval, false)
  assert.equal('continuationToken' in result.approval, false)

  const continuation = await prisma.run.findFirst({
    where: { continuationOfRunId: suspended.run.id },
  })
  assert.ok(continuation)
  assert.equal((await prisma.run.findUnique({ where: { id: suspended.run.id } }))?.status, 'completed')
  const claimedCheckpoint = await prisma.runCheckpoint.findUnique({
    where: { id: suspended.checkpoint.id },
  })
  assert.equal(claimedCheckpoint?.consumedByRunId, continuation?.id)
  const job = await prisma.$queryRaw<{ payload: { actorContext: { approval: { approvalId: string; approvalProof: string } } } }[]>`
    SELECT payload FROM queue_jobs WHERE idempotency_key = ${`run:approval:${continuation?.id}`}
  `
  assert.equal(job.length, 1)
  assert.equal(job[0]?.payload.actorContext.approval.approvalId, suspended.approval.id)
  assert.equal(job[0]?.payload.actorContext.approval.approvalProof, suspended.approval.continuationToken)
  // The queue transports only an opaque handle. The frozen tool arguments stay
  // in ApprovalRequest.resumeState until the worker reaches final dispatch.
  assert.doesNotMatch(JSON.stringify(job[0]?.payload), /Ahoj|target/)
})

runDatabaseTest('approving a hosted email tool.invoke queues an opaque waiting-run continuation', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedTeam(prisma)
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })
  const suspended = await seedSuspendedApproval(prisma, seed)
  const sealedArgs = {
    body: 'Private board update for Nina.',
    approvalProposal: {
      bcc: ['audit@example.test'],
      cc: ['team@example.test'],
      conversationId: null,
      mailboxId: randomUUID(),
      subject: 'Confidential launch plan',
      to: ['nina@example.test'],
    },
  }
  await prisma.approvalRequest.update({
    where: { id: suspended.approval.id },
    data: {
      argsHash: 'sealed-hosted-email-args',
      context: { inputSummary: 'Send from the agent mailbox.', toolName: 'email_send' },
      reason: 'Send an email from the agent mailbox',
      resumeState: {
        actorContext: actorFor(seed),
        args: sealedArgs,
        interactive: true,
        messageId: suspended.run.triggerMessageId,
      },
      toolName: 'email_send',
    },
  })

  const result = await resolveApprovalRequest(prisma, suspended.approval.id, actorFor(seed), 'approved')
  assert.ok(result && !('error' in result))
  const continuation = await prisma.run.findFirst({
    where: { continuationOfRunId: suspended.run.id },
  })
  assert.ok(continuation)
  const job = await prisma.$queryRaw<{ payload: unknown }[]>`
    SELECT payload FROM queue_jobs WHERE idempotency_key = ${`run:approval:${continuation?.id}`}
  `
  assert.equal(job.length, 1)
  const queued = JSON.stringify(job[0]?.payload)
  assert.doesNotMatch(queued, /Private board update|nina@example|team@example|audit@example|Confidential launch/)
})

runDatabaseTest('concurrent approvers can create only one continuation', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedTeam(prisma)
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })
  const suspended = await seedSuspendedApproval(prisma, seed)
  const [first, second] = await Promise.all([
    resolveApprovalRequest(prisma, suspended.approval.id, actorFor(seed), 'approved'),
    resolveApprovalRequest(prisma, suspended.approval.id, actorFor(seed), 'approved'),
  ])
  assert.equal([first, second].filter((result) => result && !('error' in result)).length, 1)
  assert.equal(await prisma.run.count({ where: { continuationOfRunId: suspended.run.id } }), 1)
})
