import assert from 'node:assert/strict'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import { visibleUserAlertWhere } from '@nessie/db'

import { canReadSpace, canWriteSpace, loadSpaceViewer } from '../src/access.js'
import { createNativeKnowledgeProvider } from '../src/native-provider.js'
import {
  readableSpaceIdsSql,
  readableSpaceIdsSqlForAgent,
} from '../src/native-search-access.js'

const suite = 'ad0c'
const organizationId = `00000000-0000-4000-8000-${suite}00000001`
const projectId = `00000000-0000-4000-8000-${suite}00000002`
const teamId = `00000000-0000-4000-8000-${suite}00000003`
const channelId = `00000000-0000-4000-8000-${suite}00000004`
const stewardUserId = `00000000-0000-4000-8000-${suite}00000005`
const readerUserId = `00000000-0000-4000-8000-${suite}00000006`
const hiddenUserId = `00000000-0000-4000-8000-${suite}00000007`
const agentId = `00000000-0000-4000-8000-${suite}00000008`
const childAgentId = `00000000-0000-4000-8000-${suite}00000009`
const unrelatedAgentId = `00000000-0000-4000-8000-${suite}0000000a`
const spaceId = `00000000-0000-4000-8000-${suite}0000000b`
const pageId = `00000000-0000-4000-8000-${suite}0000000c`

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

const cleanup = async (prisma: PrismaClient) => {
  await prisma.userAlert.deleteMany({ where: { organizationId } })
  await prisma.knowledgePage.deleteMany({ where: { organizationId } })
  await prisma.knowledgeSpace.deleteMany({ where: { organizationId } })
  await prisma.agentBinding.deleteMany({ where: { agent: { organizationId } } })
  await prisma.agent.deleteMany({ where: { organizationId } })
  await prisma.channel.deleteMany({ where: { organizationId } })
  await prisma.team.deleteMany({ where: { id: teamId } })
  await prisma.project.deleteMany({ where: { id: projectId } })
  await prisma.organizationMember.deleteMany({ where: { organizationId } })
  await prisma.user.deleteMany({
    where: { id: { in: [stewardUserId, readerUserId, hiddenUserId] } },
  })
  await prisma.organization.deleteMany({ where: { id: organizationId } })
}

const seed = async (prisma: PrismaClient) => {
  await prisma.organization.create({ data: { id: organizationId, name: `agent-docs-${suite}` } })
  await prisma.user.createMany({
    data: [
      { displayName: 'Steward', email: `agent-docs-steward-${suite}@test.local`, id: stewardUserId },
      { displayName: 'Reader', email: `agent-docs-reader-${suite}@test.local`, id: readerUserId },
      { displayName: 'Hidden', email: `agent-docs-hidden-${suite}@test.local`, id: hiddenUserId },
    ],
  })
  await prisma.organizationMember.createMany({
    data: [stewardUserId, readerUserId, hiddenUserId].map((userId) => ({
      organizationId,
      userId,
    })),
  })
  await prisma.project.create({ data: { id: projectId, name: `project-${suite}`, organizationId } })
  await prisma.team.create({ data: { id: teamId, name: `team-${suite}`, projectId } })
  await prisma.channel.create({
    data: {
      id: channelId,
      label: `private-${suite}`,
      organizationId,
      projectId,
      slug: `private-${suite}`,
      teamId,
      visibility: 'private',
      members: { create: { userId: readerUserId } },
    },
  })
  await prisma.agent.create({
    data: {
      id: agentId,
      name: `owner-${suite}`,
      organizationId,
      ownerUserId: stewardUserId,
      role: 'assistant',
      bindings: { create: { channelId } },
    },
  })
  await prisma.agent.createMany({
    data: [
      {
        id: childAgentId,
        name: `child-${suite}`,
        organizationId,
        ownerUserId: stewardUserId,
        parentAgentId: agentId,
        role: 'researcher',
      },
      {
        id: unrelatedAgentId,
        name: `unrelated-${suite}`,
        organizationId,
        role: 'assistant',
      },
    ],
  })
  await prisma.knowledgeSpace.create({
    data: {
      createdBy: agentId,
      id: spaceId,
      name: `Agent documents ${suite}`,
      organizationId,
      ownerAgentId: agentId,
      projectId,
      visibility: 'private',
    },
  })
  await prisma.knowledgePage.create({
    data: {
      createdBy: agentId,
      id: pageId,
      organizationId,
      projectId,
      spaceId,
      status: 'published',
      title: `Working notes ${suite}`,
      visibility: 'private',
    },
  })
  await prisma.userAlert.createMany({
    data: [readerUserId, hiddenUserId].map((userId) => ({
      eventKey: `agent-docs-published-${suite}-${userId}`,
      kind: 'knowledge_published' as const,
      knowledgePageId: pageId,
      organizationId,
      projectId,
      userId,
    })),
  })
}

const sqlContainsSpace = async (
  prisma: PrismaClient,
  query: Parameters<PrismaClient['$queryRaw']>[0],
): Promise<boolean> => {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>(query)
  return rows.some((row) => row.id === spaceId)
}

runDatabaseTest('all four access implementations agree for one agent-owned space', async (t) => {
  const prisma = new PrismaClient()
  await cleanup(prisma)
  await seed(prisma)
  t.after(() => cleanup(prisma).then(() => prisma.$disconnect()))

  const provider = createNativeKnowledgeProvider(prisma)
  const space = await provider.getSpace(organizationId, spaceId)
  assert.ok(space)
  assert.equal(space.ownerAgentId, agentId)

  const readerViewer = await loadSpaceViewer(
    prisma,
    organizationId,
    { actorType: 'user', actorId: readerUserId },
  )
  const hiddenViewer = await loadSpaceViewer(
    prisma,
    organizationId,
    { actorType: 'user', actorId: hiddenUserId },
  )
  const childViewer = await loadSpaceViewer(
    prisma,
    organizationId,
    { actorType: 'agent', actorId: childAgentId },
  )
  const unrelatedViewer = await loadSpaceViewer(
    prisma,
    organizationId,
    { actorType: 'agent', actorId: unrelatedAgentId },
  )

  assert.equal(canReadSpace(space, readerViewer), true)
  assert.equal(canWriteSpace(space, readerViewer), true)
  assert.equal(canReadSpace(space, hiddenViewer), false)
  assert.equal(canReadSpace(space, childViewer), true)
  assert.equal(canWriteSpace(space, childViewer), true)
  assert.equal(canReadSpace(space, unrelatedViewer), false)

  assert.equal(
    await sqlContainsSpace(prisma, readableSpaceIdsSql(organizationId, readerViewer)),
    true,
  )
  assert.equal(
    await sqlContainsSpace(prisma, readableSpaceIdsSql(organizationId, hiddenViewer)),
    false,
  )
  assert.ok(childViewer.agent)
  assert.equal(
    await sqlContainsSpace(
      prisma,
      readableSpaceIdsSqlForAgent(organizationId, childViewer.agent),
    ),
    true,
  )
  assert.ok(unrelatedViewer.agent)
  assert.equal(
    await sqlContainsSpace(
      prisma,
      readableSpaceIdsSqlForAgent(organizationId, unrelatedViewer.agent),
    ),
    false,
  )

  const visibleAlerts = await prisma.userAlert.findMany({
    where: visibleUserAlertWhere({ organizationId, userId: readerUserId }),
    select: { knowledgePageId: true },
  })
  const hiddenAlerts = await prisma.userAlert.findMany({
    where: visibleUserAlertWhere({ organizationId, userId: hiddenUserId }),
    select: { knowledgePageId: true },
  })
  assert.deepEqual(visibleAlerts, [{ knowledgePageId: pageId }])
  assert.deepEqual(hiddenAlerts, [])

  const activeStewardViewer = await loadSpaceViewer(
    prisma,
    organizationId,
    { actorType: 'user', actorId: stewardUserId },
  )
  assert.equal(canReadSpace(space, activeStewardViewer), true)
  await prisma.organizationMember.update({
    data: { deactivatedAt: new Date() },
    where: { organizationId_userId: { organizationId, userId: stewardUserId } },
  })
  const deactivatedStewardViewer = await loadSpaceViewer(
    prisma,
    organizationId,
    { actorType: 'user', actorId: stewardUserId },
  )
  assert.equal(canReadSpace(space, deactivatedStewardViewer), false)
})
