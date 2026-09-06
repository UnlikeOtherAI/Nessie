import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'

import { wakeBoardWatcherAgent } from '../../src/control/board-watch-wake.js'
import { runDatabaseTest } from './support.js'

const seed = async (prisma: PrismaClient) => {
  const suffix = randomUUID()
  const user = await prisma.user.create({
    data: { displayName: 'Adder', email: `wake-${suffix}@example.test` },
  })
  const organization = await prisma.organization.create({ data: { name: `wake-${suffix}` } })
  await prisma.organizationMember.create({
    data: { organizationId: organization.id, userId: user.id, role: 'owner' },
  })
  const project = await prisma.project.create({
    data: { name: `project-${suffix}`, organizationId: organization.id },
  })
  const team = await prisma.team.create({
    data: { name: `team-${suffix}`, projectId: project.id },
  })
  const board = await prisma.board.create({
    data: {
      projectId: project.id,
      organizationId: organization.id,
      name: 'Release board',
      isDefault: true,
      position: 0,
    },
  })
  const agent = await prisma.agent.create({
    data: {
      name: 'Triage',
      organizationId: organization.id,
      projectId: project.id,
      role: 'assistant',
      visibility: 'team',
    },
  })
  const channel = await prisma.channel.create({
    data: {
      dmKey: `${organization.id}:wake:${randomUUID()}`,
      label: 'Triage',
      organization: { connect: { id: organization.id } },
      project: { connect: { id: project.id } },
      team: { connect: { id: team.id } },
      type: 'dm',
      visibility: 'private',
    },
  })
  const thread = await prisma.thread.create({
    data: { channelId: channel.id, title: 'General' },
  })
  await prisma.agentBinding.create({ data: { agentId: agent.id, channelId: channel.id } })
  const task = await prisma.task.create({
    data: {
      organizationId: organization.id,
      projectId: project.id,
      title: 'A mirrored ticket',
      priority: 'medium',
      status: 'in_progress',
    },
  })
  return { organization, project, board, agent, task, user, channel, thread }
}

runDatabaseTest('waking a watcher agent starts a run from a hidden kickoff', async (t) => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  t.after(async () => {
    await prisma.organization.deleteMany({ where: { id: seeded.organization.id } })
    await prisma.user.deleteMany({ where: { id: seeded.user.id } })
    await prisma.$disconnect()
  })

  const outcome = await wakeBoardWatcherAgent(prisma, {
    addedByUserId: seeded.user.id,
    agentId: seeded.agent.id,
    boardId: seeded.board.id,
    boardName: seeded.board.name,
    channelId: seeded.channel.id,
    launchOrigin: null,
    organizationId: seeded.organization.id,
    projectId: seeded.project.id,
    taskIds: [seeded.task.id],
    threadId: seeded.thread.id,
  })
  assert.equal(outcome, 'woken')

  const run = await prisma.run.findFirst({
    where: { agentId: seeded.agent.id },
    select: { id: true, status: true, replyPlacement: true, threadId: true },
  })
  assert.ok(run, 'the wake must produce a run, or the agent was never told')
  assert.equal(run.status, 'pending')
  // A standalone contribution to the room, not an answer owed to whoever last
  // spoke — and it must stay paired with the `system` kickoff below.
  assert.equal(run.replyPlacement, 'channel')

  const kickoff = await prisma.message.findFirst({
    where: { threadId: run.threadId },
    select: { role: true, content: true },
  })
  // `system`, never `user`: a user role would sign "a ticket moved" with the
  // name of whoever added the watcher and fill their DM with plumbing.
  assert.equal(kickoff?.role, 'system')
  assert.match(kickoff?.content ?? '', /Release board/)
  assert.match(kickoff?.content ?? '', /A mirrored ticket/)
})

runDatabaseTest('a second wake while a run is in flight pends instead of racing', async (t) => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  t.after(async () => {
    await prisma.organization.deleteMany({ where: { id: seeded.organization.id } })
    await prisma.user.deleteMany({ where: { id: seeded.user.id } })
    await prisma.$disconnect()
  })

  const wake = () =>
    wakeBoardWatcherAgent(prisma, {
      addedByUserId: seeded.user.id,
      agentId: seeded.agent.id,
      boardId: seeded.board.id,
      boardName: seeded.board.name,
      channelId: seeded.channel.id,
      launchOrigin: null,
      organizationId: seeded.organization.id,
      projectId: seeded.project.id,
      taskIds: [seeded.task.id],
      threadId: seeded.thread.id,
    })

  assert.equal(await wake(), 'woken')
  // This is what stops a busy board from being a bill: the agent runs once at a
  // time per thread, and the next ticket batches into the follow-up.
  assert.equal(await wake(), 'pending')
  assert.equal(await prisma.run.count({ where: { agentId: seeded.agent.id } }), 1)
})

runDatabaseTest('an agent with no conversation is reported, not silently dropped', async (t) => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  t.after(async () => {
    await prisma.organization.deleteMany({ where: { id: seeded.organization.id } })
    await prisma.user.deleteMany({ where: { id: seeded.user.id } })
    await prisma.$disconnect()
  })

  // A row written before the destination was captured. Reported rather than
  // re-resolved: a second guess at the destination is the defect the stored
  // column exists to remove.
  assert.equal(
    await wakeBoardWatcherAgent(prisma, {
      addedByUserId: seeded.user.id,
      agentId: seeded.agent.id,
      boardId: seeded.board.id,
      boardName: seeded.board.name,
      channelId: null,
      launchOrigin: null,
      organizationId: seeded.organization.id,
      projectId: seeded.project.id,
      taskIds: [seeded.task.id],
      threadId: null,
    }),
    'unreachable',
  )
})

runDatabaseTest('an agent no longer bound to its channel is unreachable', async (t) => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  t.after(async () => {
    await prisma.organization.deleteMany({ where: { id: seeded.organization.id } })
    await prisma.user.deleteMany({ where: { id: seeded.user.id } })
    await prisma.$disconnect()
  })

  // The run would be refused downstream without a binding; refusing here says
  // why, instead of starting a run that dies with no explanation.
  await prisma.agentBinding.deleteMany({
    where: { agentId: seeded.agent.id, channelId: seeded.channel.id },
  })
  assert.equal(
    await wakeBoardWatcherAgent(prisma, {
      addedByUserId: seeded.user.id,
      agentId: seeded.agent.id,
      boardId: seeded.board.id,
      boardName: seeded.board.name,
      channelId: seeded.channel.id,
      launchOrigin: null,
      organizationId: seeded.organization.id,
      projectId: seeded.project.id,
      taskIds: [seeded.task.id],
      threadId: seeded.thread.id,
    }),
    'unreachable',
  )
})
