import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { Prisma, PrismaClient } from '@prisma/client'
import { visibleUserAlertWhere } from '@nessie/db'

import { canReadSpace, canWriteSpace, loadSpaceViewer } from '../src/access.js'
import { mapSpace, spaceInclude } from '../src/native-mappers.js'
import {
  readableSpaceIdsSql,
  readableSpaceIdsSqlForAgent,
} from '../src/native-search-access.js'

const dbTest = process.env.DATABASE_URL ? test : test.skip

const queryReadableSpaceIds = (
  prisma: PrismaClient,
  query: Prisma.Sql,
): Promise<Array<{ id: string }>> => prisma.$queryRaw(query)

dbTest('the four agent-document read implementations agree on one database fixture', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const emails = [
    `agent-doc-visible-${suffix}@test.local`,
    `agent-doc-hidden-${suffix}@test.local`,
  ]
  let organizationId: string | null = null
  t.after(async () => {
    if (organizationId) {
      await prisma.organization.deleteMany({ where: { id: organizationId } })
    }
    await prisma.user.deleteMany({ where: { email: { in: emails } } })
    await prisma.$disconnect()
  })

  const organization = await prisma.organization.create({
    data: { name: `agent-doc-access-${suffix}` },
  })
  organizationId = organization.id
  const [visibleUser, hiddenUser] = await Promise.all([
    prisma.user.create({
      data: { displayName: 'Visible reader', email: emails[0]! },
    }),
    prisma.user.create({
      data: { displayName: 'Hidden reader', email: emails[1]! },
    }),
  ])
  await prisma.organizationMember.createMany({
    data: [visibleUser, hiddenUser].map((user) => ({
      organizationId: organization.id,
      userId: user.id,
    })),
  })
  const project = await prisma.project.create({
    data: { name: `agent-doc-project-${suffix}`, organizationId: organization.id },
  })
  await prisma.projectMember.createMany({
    data: [visibleUser, hiddenUser].map((user) => ({
      projectId: project.id,
      userId: user.id,
    })),
  })
  const team = await prisma.team.create({
    data: { name: `agent-doc-team-${suffix}`, projectId: project.id },
  })
  const channel = await prisma.channel.create({
    data: {
      label: `agent-doc-private-${suffix}`,
      organizationId: organization.id,
      projectId: project.id,
      slug: `agent-doc-private-${suffix}`,
      teamId: team.id,
      visibility: 'private',
      members: { create: { userId: visibleUser.id } },
    },
  })
  const agent = await prisma.agent.create({
    data: {
      name: `Agent documents ${suffix}`,
      organizationId: organization.id,
      role: 'researcher',
      bindings: { create: { channelId: channel.id } },
    },
  })
  const space = await prisma.knowledgeSpace.create({
    data: {
      createdBy: agent.id,
      name: `${agent.name} — Documents`,
      organizationId: organization.id,
      ownerAgentId: agent.id,
      projectId: project.id,
      visibility: 'private',
    },
    include: spaceInclude,
  })
  const page = await prisma.knowledgePage.create({
    data: {
      createdBy: agent.id,
      organizationId: organization.id,
      projectId: project.id,
      spaceId: space.id,
      status: 'published',
      title: 'Agent field notes',
      visibility: 'private',
    },
  })
  await prisma.userAlert.createMany({
    data: [visibleUser, hiddenUser].map((user) => ({
      eventKey: `agent-doc-published:${suffix}:${user.id}`,
      kind: 'knowledge_published' as const,
      knowledgePageId: page.id,
      organizationId: organization.id,
      userId: user.id,
    })),
  })

  const [visibleViewer, hiddenViewer, agentViewer] = await Promise.all([
    loadSpaceViewer(prisma, organization.id, {
      actorId: visibleUser.id,
      actorType: 'user',
    }),
    loadSpaceViewer(prisma, organization.id, {
      actorId: hiddenUser.id,
      actorType: 'user',
    }),
    loadSpaceViewer(prisma, organization.id, {
      actorId: agent.id,
      actorType: 'agent',
    }),
  ])
  const mappedSpace = mapSpace(space)

  assert.equal(canReadSpace(mappedSpace, visibleViewer), true)
  assert.equal(canReadSpace(mappedSpace, hiddenViewer), false)
  assert.equal(canReadSpace(mappedSpace, agentViewer), true)
  assert.equal(canWriteSpace(mappedSpace, agentViewer), true)

  const [visibleSql, hiddenSql, agentSql] = await Promise.all([
    queryReadableSpaceIds(
      prisma,
      readableSpaceIdsSql(organization.id, visibleViewer),
    ),
    queryReadableSpaceIds(
      prisma,
      readableSpaceIdsSql(organization.id, hiddenViewer),
    ),
    queryReadableSpaceIds(
      prisma,
      readableSpaceIdsSqlForAgent(organization.id, agentViewer.agent!),
    ),
  ])
  assert.equal(visibleSql.some((row) => row.id === space.id), true)
  assert.equal(hiddenSql.some((row) => row.id === space.id), false)
  assert.equal(agentSql.some((row) => row.id === space.id), true)

  const [visibleAlerts, hiddenAlerts] = await Promise.all([
    prisma.userAlert.findMany({
      where: visibleUserAlertWhere({
        organizationId: organization.id,
        userId: visibleUser.id,
      }),
    }),
    prisma.userAlert.findMany({
      where: visibleUserAlertWhere({
        organizationId: organization.id,
        userId: hiddenUser.id,
      }),
    }),
  ])
  assert.equal(visibleAlerts.some((alert) => alert.knowledgePageId === page.id), true)
  assert.equal(hiddenAlerts.some((alert) => alert.knowledgePageId === page.id), false)
})

dbTest('a deactivated steward loses read access to an unbound agent home', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const email = `agent-doc-steward-${suffix}@test.local`
  let organizationId: string | null = null
  t.after(async () => {
    if (organizationId) {
      await prisma.organization.deleteMany({ where: { id: organizationId } })
    }
    await prisma.user.deleteMany({ where: { email } })
    await prisma.$disconnect()
  })

  const organization = await prisma.organization.create({
    data: { name: `agent-doc-steward-${suffix}` },
  })
  organizationId = organization.id
  const user = await prisma.user.create({
    data: { displayName: 'Agent steward', email },
  })
  await prisma.organizationMember.create({
    data: { organizationId: organization.id, userId: user.id },
  })
  const project = await prisma.project.create({
    data: { name: `agent-doc-project-${suffix}`, organizationId: organization.id },
  })
  const agent = await prisma.agent.create({
    data: {
      name: `Stewarded agent ${suffix}`,
      organizationId: organization.id,
      ownerUserId: user.id,
      role: 'assistant',
    },
  })
  const space = await prisma.knowledgeSpace.create({
    data: {
      createdBy: agent.id,
      name: `${agent.name} — Documents`,
      organizationId: organization.id,
      ownerAgentId: agent.id,
      projectId: project.id,
      visibility: 'private',
    },
    include: spaceInclude,
  })
  const mappedSpace = mapSpace(space)

  const before = await loadSpaceViewer(prisma, organization.id, {
    actorId: user.id,
    actorType: 'user',
  })
  assert.equal(canReadSpace(mappedSpace, before), true)

  await prisma.organizationMember.update({
    data: { deactivatedAt: new Date() },
    where: {
      organizationId_userId: {
        organizationId: organization.id,
        userId: user.id,
      },
    },
  })
  const after = await loadSpaceViewer(prisma, organization.id, {
    actorId: user.id,
    actorType: 'user',
  })
  assert.equal(canReadSpace(mappedSpace, after), false)
})
