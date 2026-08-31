import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import { ensureAgentDocsSpace } from '../src/provisioning.js'

const dbTest = process.env.DATABASE_URL ? test : test.skip

const createAgentHomeFixture = async (prisma: PrismaClient, suffix: string) => {
  const organization = await prisma.organization.create({
    data: { name: `agent-doc-provision-${suffix}` },
  })
  const project = await prisma.project.create({
    data: { name: `agent-doc-provision-project-${suffix}`, organizationId: organization.id },
  })
  const agent = await prisma.agent.create({
    data: {
      name: `Documents agent ${suffix}`,
      organizationId: organization.id,
      role: 'researcher',
    },
  })
  return { agent, organization, project }
}

dbTest('ensureAgentDocsSpace serializes concurrent provisioning into one valid home', async (t) => {
  const prisma = new PrismaClient()
  const { agent, organization, project } = await createAgentHomeFixture(prisma, randomUUID())
  t.after(async () => {
    await prisma.organization.delete({ where: { id: organization.id } })
    await prisma.$disconnect()
  })

  const input = {
    agentId: agent.id,
    agentName: agent.name,
    organizationId: organization.id,
    projectId: project.id,
  }
  const [first, second] = await Promise.all([
    ensureAgentDocsSpace(prisma, input),
    ensureAgentDocsSpace(prisma, input),
  ])

  assert.equal(first.spaceId, second.spaceId)
  assert.deepEqual([first.created, second.created].sort(), [false, true])

  const homes = await prisma.knowledgeSpace.findMany({
    where: { organizationId: organization.id, ownerAgentId: agent.id, deletedAt: null },
    select: {
      id: true,
      metadata: true,
      ownerAgentId: true,
      privateToAgentId: true,
      visibility: true,
    },
  })
  assert.equal(homes.length, 1, 'the advisory lock must prevent duplicate homes')
  assert.deepEqual(homes[0], {
    id: first.spaceId,
    metadata: { agentDocs: true },
    ownerAgentId: agent.id,
    privateToAgentId: agent.id,
    visibility: 'private',
  })
})

dbTest('ensureAgentDocsSpace refuses a system-managed agent', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const organization = await prisma.organization.create({
    data: { name: `system-agent-doc-provision-${suffix}` },
  })
  const project = await prisma.project.create({
    data: { name: `system-agent-doc-project-${suffix}`, organizationId: organization.id },
  })
  const agent = await prisma.agent.create({
    data: {
      name: `Personal Assistant ${suffix}`,
      organizationId: organization.id,
      role: 'assistant',
      systemManaged: true,
    },
  })
  t.after(async () => {
    await prisma.organization.delete({ where: { id: organization.id } })
    await prisma.$disconnect()
  })

  await assert.rejects(
    ensureAgentDocsSpace(prisma, {
      agentId: agent.id,
      agentName: agent.name,
      organizationId: organization.id,
      projectId: project.id,
    }),
    /system-managed/i,
  )
  assert.equal(
    await prisma.knowledgeSpace.count({
      where: { organizationId: organization.id, ownerAgentId: agent.id },
    }),
    0,
  )
})
