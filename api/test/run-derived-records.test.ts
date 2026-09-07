import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import { loadAgentActivity, loadAgentStatus } from '../src/services/agent-read-model.js'
import { listPlans, getPlan } from '../src/services/plans.js'
import { getTask, listTasks } from '../src/services/tasks.js'
import { seed } from './disclosure-read-fixtures.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

runDatabaseTest('run-derived task and plan records require source-channel access and run disclosure', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  t.after(async () => {
    await prisma.organization.deleteMany({ where: { name: `disclosure-org-${suffix}` } })
    await prisma.user.deleteMany({ where: { email: { contains: suffix } } })
    await prisma.$disconnect()
  })

  const s = await seed(prisma, suffix)
  // A owns the agent and the organisation, but never joins B's source channel.
  const ownerId = s.outsiderId
  await prisma.organizationMember.update({
    data: { role: 'owner' },
    where: { organizationId_userId: { organizationId: s.organizationId, userId: ownerId } },
  })
  const member = await prisma.user.create({
    data: { displayName: 'member', email: `member-${suffix}@example.test` },
  })
  await prisma.organizationMember.create({
    data: { organizationId: s.organizationId, role: 'member', userId: member.id },
  })
  await prisma.channelMember.create({ data: { channelId: s.channelId, userId: member.id } })
  const privateChannel = await prisma.channel.create({
    data: {
      label: `private-${suffix}`,
      slug: `private-${suffix.slice(0, 8)}`,
      organizationId: s.organizationId,
      projectId: s.projectId,
      teamId: s.teamId,
      type: 'standard',
      visibility: 'private',
    },
  })
  const privateThread = await prisma.thread.create({ data: { channelId: privateChannel.id } })
  await prisma.channelMember.create({ data: { channelId: privateChannel.id, userId: s.insiderId } })

  const privateRun = await prisma.run.create({
    data: { agentId: s.agentId, status: 'completed', threadId: privateThread.id },
  })
  const restrictedPublicRun = await prisma.run.create({
    data: { agentId: s.agentId, status: 'completed', threadId: s.threadId },
  })
  const childAgent = await prisma.agent.create({
    data: {
      name: `restricted-child-${suffix}`,
      organizationId: s.organizationId,
      parentAgentId: s.agentId,
      projectId: s.projectId,
      teamId: s.teamId,
    },
  })
  const childRestrictedRun = await prisma.run.create({
    data: { agentId: childAgent.id, status: 'completed', threadId: s.threadId },
  })
  const publicChildAgent = await prisma.agent.create({
    data: {
      name: `public-child-${suffix}`,
      organizationId: s.organizationId,
      parentAgentId: s.agentId,
      projectId: s.projectId,
      teamId: s.teamId,
    },
  })
  const publicChildRun = await prisma.run.create({
    data: { agentId: publicChildAgent.id, status: 'completed', threadId: s.threadId },
  })
  const publicRun = await prisma.run.create({
    data: { agentId: s.agentId, status: 'completed', threadId: s.threadId },
  })
  const hiddenTrigger = await prisma.message.create({
    data: { content: 'B-HIDDEN-TRIGGER-CANARY', role: 'system', threadId: s.threadId },
  })
  await prisma.messageBasisScope.create({
    data: {
      messageId: hiddenTrigger.id,
      organizationId: s.organizationId,
      scopeId: privateChannel.id,
      scopeType: 'channel',
    },
  })
  await prisma.messageDisclosureSource.create({
    data: {
      messageId: hiddenTrigger.id,
      organizationId: s.organizationId,
      sourceAuthorUserId: s.insiderId,
      sourceChannelId: privateChannel.id,
    },
  })
  const activeRestrictedRun = await prisma.run.create({
    data: {
      agentId: s.agentId,
      status: 'running',
      threadId: s.threadId,
      triggerMessageId: hiddenTrigger.id,
    },
  })
  await prisma.runBasisScope.createMany({ data: [
    { organizationId: s.organizationId, runId: privateRun.id, scopeId: privateChannel.id, scopeType: 'channel' },
    { organizationId: s.organizationId, runId: restrictedPublicRun.id, scopeId: privateChannel.id, scopeType: 'channel' },
    { organizationId: s.organizationId, runId: childRestrictedRun.id, scopeId: privateChannel.id, scopeType: 'channel' },
  ] })
  const privateTask = await prisma.task.create({
    data: { agentId: s.agentId, organizationId: s.organizationId, purpose: 'B-PRIVATE-TASK-CANARY', runId: privateRun.id, status: 'inbox' },
  })
  const restrictedPublicTask = await prisma.task.create({
    data: { agentId: s.agentId, organizationId: s.organizationId, purpose: 'B-RESTRICTED-PUBLIC-CANARY', runId: restrictedPublicRun.id, status: 'inbox' },
  })
  const childRestrictedTask = await prisma.task.create({
    data: {
      agentId: childAgent.id,
      organizationId: s.organizationId,
      purpose: 'B-CHILD-PURPOSE-CANARY',
      runId: childRestrictedRun.id,
      status: 'inbox',
    },
  })
  const publicChildTask = await prisma.task.create({
    data: {
      agentId: publicChildAgent.id,
      organizationId: s.organizationId,
      purpose: 'public child task',
      runId: publicChildRun.id,
      status: 'inbox',
    },
  })
  const publicTask = await prisma.task.create({
    data: { agentId: s.agentId, organizationId: s.organizationId, purpose: 'public task', runId: publicRun.id, status: 'inbox' },
  })
  const activeRestrictedTask = await prisma.task.create({
    data: { agentId: s.agentId, organizationId: s.organizationId, purpose: 'B-ACTIVE-METADATA-CANARY', runId: activeRestrictedRun.id, status: 'inbox' },
  })
  const humanTask = await prisma.task.create({ data: { organizationId: s.organizationId, purpose: 'ordinary projectless task', status: 'inbox' } })
  const privatePlan = await prisma.plan.create({ data: { agentId: s.agentId, channelId: privateChannel.id, createdByActorId: s.insiderId, createdByActorType: 'user', goal: 'B-PRIVATE-PLAN-CANARY', organizationId: s.organizationId, runId: privateRun.id } })
  await prisma.planStep.create({ data: { payload: { task: 'B-PRIVATE-STEP-CANARY' }, planId: privatePlan.id, sequence: 1, title: 'B-PRIVATE-STEP-CANARY', type: 'spawn_task' } })
  const publicPlan = await prisma.plan.create({ data: { agentId: s.agentId, channelId: s.channelId, createdByActorId: s.insiderId, createdByActorType: 'user', goal: 'public plan', organizationId: s.organizationId, runId: publicRun.id } })

  const ownerTasks = await listTasks(prisma, s.organizationId, {}, undefined, ownerId)
  assert.deepEqual(ownerTasks.map((task) => task.id).sort(), [humanTask.id, publicTask.id].sort())
  assert.equal(await getTask(prisma, privateTask.id, s.organizationId, undefined, ownerId), null)
  assert.equal(await getTask(prisma, restrictedPublicTask.id, s.organizationId, undefined, ownerId), null)
  assert.equal(await getTask(prisma, activeRestrictedTask.id, s.organizationId, undefined, ownerId), null)
  assert.equal((await getTask(prisma, publicTask.id, s.organizationId, undefined, ownerId))?.purpose, 'public task')
  assert.equal(
    (await listPlans(prisma, s.organizationId, ownerId, {})).some((plan) => plan.id === privatePlan.id),
    false,
  )
  assert.equal(await getPlan(prisma, s.organizationId, privatePlan.id, ownerId), null)
  assert.equal((await getPlan(prisma, s.organizationId, publicPlan.id, ownerId))?.plan.goal, 'public plan')
  const ownerActivity = await loadAgentActivity(prisma, s.agentId, {
    visibility: { includeAllOrgChannels: true, organizationId: s.organizationId, userId: ownerId },
  })
  assert.equal(ownerActivity?.subAgents.some((child) => child.taskId === childRestrictedTask.id), false)
  const ownerStatus = await loadAgentStatus(prisma, s.agentId, {
    visibility: { includeAllOrgChannels: true, organizationId: s.organizationId, userId: ownerId },
  })
  assert.equal(ownerStatus?.activeSubAgents.some((child) => child.taskId === childRestrictedTask.id), false)
  assert.equal(ownerStatus?.activeSubAgents.some((child) => child.taskId === publicChildTask.id), true)

  const sourceAuthorTasks = await listTasks(prisma, s.organizationId, {}, undefined, s.insiderId)
  assert.equal(sourceAuthorTasks.some((task) => task.id === privateTask.id), true)
  assert.equal(
    (await getPlan(prisma, s.organizationId, privatePlan.id, s.insiderId))?.steps[0]?.title,
    'B-PRIVATE-STEP-CANARY',
  )
  const sourceAuthorActivity = await loadAgentActivity(prisma, s.agentId, {
    visibility: { organizationId: s.organizationId, userId: s.insiderId },
  })
  assert.equal(sourceAuthorActivity?.subAgents.some((child) => child.taskId === childRestrictedTask.id), true)
  const memberTasks = await listTasks(prisma, s.organizationId, {}, undefined, member.id)
  assert.equal(memberTasks.some((task) => task.id === privateTask.id || task.id === restrictedPublicTask.id), false)
  assert.equal(memberTasks.some((task) => task.id === activeRestrictedTask.id), false)
})
