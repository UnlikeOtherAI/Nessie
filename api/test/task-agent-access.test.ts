import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import { createAgentRecord, listAgentsForUser } from '@nessie/team-admin'

import { assignTask, createHumanTask } from '../src/services/tasks.js'

const dbTest = process.env.DATABASE_URL ? test : test.skip

const actorFor = (
  organizationId: string,
  userId: string,
  role: 'member' | 'owner',
): AuthorizedActionContext => ({
  actionContext: { requestId: `task-agent-access-${role}` },
  actor: { actorId: userId, actorType: 'user', roles: [role] },
  tenant: { organizationId },
}) as AuthorizedActionContext

const seed = async (prisma: PrismaClient) => {
  const organizationId = randomUUID()
  const privateOwnerId = randomUUID()
  const memberId = randomUUID()
  const ownerId = randomUUID()
  await prisma.organization.create({ data: { id: organizationId, name: `task-agent-${organizationId}` } })
  await prisma.user.createMany({
    data: [
      { displayName: 'Private owner', email: `${privateOwnerId}@test.local`, id: privateOwnerId },
      { displayName: 'Member', email: `${memberId}@test.local`, id: memberId },
      { displayName: 'Organization owner', email: `${ownerId}@test.local`, id: ownerId },
    ],
  })
  await prisma.organizationMember.createMany({
    data: [
      { organizationId, role: 'member', userId: privateOwnerId },
      { organizationId, role: 'member', userId: memberId },
      { organizationId, role: 'owner', userId: ownerId },
    ],
  })
  const project = await prisma.project.create({
    data: { name: `task-agent-${organizationId}`, organizationId },
  })
  const team = await prisma.team.create({
    data: { name: `task-agent-${organizationId}`, projectId: project.id },
  })
  return { memberId, organizationId, ownerId, privateOwnerId, projectId: project.id, teamId: team.id }
}

const withDb = async (run: (prisma: PrismaClient, seed: Awaited<ReturnType<typeof seed>>) => Promise<void>) => {
  const prisma = new PrismaClient()
  const fixture = await seed(prisma)
  try {
    await run(prisma, fixture)
  } finally {
    await prisma.organization.deleteMany({ where: { id: fixture.organizationId } })
    await prisma.user.deleteMany({
      where: { id: { in: [fixture.privateOwnerId, fixture.memberId, fixture.ownerId] } },
    })
    await prisma.$disconnect()
  }
}

dbTest('a member cannot assign another member’s private agent to a task', async () => {
  await withDb(async (prisma, fixture) => {
    const privateAgent = await createAgentRecord(prisma, {
      name: 'Private task agent',
      organizationId: fixture.organizationId,
      ownerUserId: fixture.privateOwnerId,
      role: 'assistant',
      teamId: fixture.teamId,
      visibility: 'private',
    })
    assert.equal(privateAgent.visibility, 'private', 'the assignee is a private agent')
    assert.ok(privateAgent.homeChannelId, 'private creation provisions the owner-only home DM')
    const privateHome = await prisma.channel.findUniqueOrThrow({
      where: { id: privateAgent.homeChannelId },
      select: { organizationId: true, projectId: true, teamId: true },
    })
    assert.deepEqual(
      privateHome,
      {
        organizationId: fixture.organizationId,
        projectId: fixture.projectId,
        teamId: fixture.teamId,
      },
      'the private agent home belongs to this test fixture’s organization, project, and team',
    )
    const actorContext = actorFor(fixture.organizationId, fixture.memberId, 'member')

    const created = await createHumanTask(prisma, {
      actorContext,
      assigneeAgentId: privateAgent.id,
      createdByUserId: fixture.memberId,
      organizationId: fixture.organizationId,
      title: 'Should not expose a private assignee',
    })
    assert.deepEqual(created, { error: 'ASSIGNEE_AGENT_NOT_FOUND' })

    const task = await prisma.task.create({
      data: {
        createdByUserId: fixture.memberId,
        organizationId: fixture.organizationId,
        title: 'Existing task',
      },
      select: { id: true },
    })
    const assigned = await assignTask(prisma, {
      actorContext,
      assigneeAgentId: privateAgent.id,
      organizationId: fixture.organizationId,
      taskId: task.id,
    })
    assert.deepEqual(assigned, { error: 'ASSIGNEE_AGENT_NOT_FOUND' })
  })
})

dbTest('an owner can assign an unbound team agent offered by their picker', async () => {
  await withDb(async (prisma, fixture) => {
    const teamAgent = await createAgentRecord(prisma, {
      name: 'Unbound team task agent',
      organizationId: fixture.organizationId,
      ownerUserId: fixture.privateOwnerId,
      role: 'assistant',
    })
    const actorContext = actorFor(fixture.organizationId, fixture.ownerId, 'owner')
    const pickerAgents = await listAgentsForUser(prisma, fixture.ownerId, fixture.organizationId, true)
    assert.equal(pickerAgents.some((agent) => agent.id === teamAgent.id), true)

    const created = await createHumanTask(prisma, {
      actorContext,
      assigneeAgentId: teamAgent.id,
      createdByUserId: fixture.ownerId,
      organizationId: fixture.organizationId,
      title: 'Owner can assign an unbound team agent',
    })
    assert.ok(!('error' in created))
    assert.equal(created.assigneeAgentId, teamAgent.id)

    const task = await prisma.task.create({
      data: {
        createdByUserId: fixture.ownerId,
        organizationId: fixture.organizationId,
        title: 'Owner can reassign an unbound team agent',
      },
      select: { id: true },
    })
    const assigned = await assignTask(prisma, {
      actorContext,
      assigneeAgentId: teamAgent.id,
      organizationId: fixture.organizationId,
      taskId: task.id,
    })
    assert.ok(!('error' in assigned))
    assert.equal(assigned.assigneeAgentId, teamAgent.id)
  })
})
