import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import { createNativeKnowledgeProvider, loadSpaceViewer, type SpaceViewer } from '../src/index.js'

const dbTest = process.env.DATABASE_URL ? test : test.skip

dbTest('shared-space pagination excludes My Docs before counting and keyset selection', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const email = `kb-space-page-${suffix}@test.local`
  let organizationId: string | null = null
  t.after(async () => {
    if (organizationId) {
      await prisma.organization.deleteMany({ where: { id: organizationId } })
    }
    await prisma.user.deleteMany({ where: { email } })
    await prisma.$disconnect()
  })

  const organization = await prisma.organization.create({ data: { name: `kb-space-page-${suffix}` } })
  organizationId = organization.id
  const user = await prisma.user.create({ data: { displayName: 'My Docs owner', email } })
  const project = await prisma.project.create({
    data: { name: `kb-space-page-project-${suffix}`, organizationId: organization.id },
  })
  const [sharedSpace, personalSpace] = await Promise.all([
    prisma.knowledgeSpace.create({
      data: {
        createdBy: user.id,
        name: 'Shared documents',
        organizationId: organization.id,
        projectId: project.id,
        visibility: 'project',
      },
    }),
    prisma.knowledgeSpace.create({
      data: {
        createdBy: user.id,
        metadata: { personal: true },
        name: 'My Docs',
        organizationId: organization.id,
        projectId: project.id,
        userId: user.id,
        visibility: 'private',
      },
    }),
  ])
  const provider = createNativeKnowledgeProvider(prisma)
  const viewer: SpaceViewer = {
    bypass: true,
    projectIds: new Set(),
    userId: user.id,
    visibleAgentIds: new Set(),
  }

  const shared = await provider.listSpaces({ organizationId: organization.id, viewer })
  assert.deepEqual(shared.data.map((space) => space.id), [sharedSpace.id])
  assert.equal(shared.meta.total, 1)

  const includingPersonal = await provider.listSpaces({
    includePersonal: true,
    organizationId: organization.id,
    viewer,
  })
  assert.deepEqual(
    new Set(includingPersonal.data.map((space) => space.id)),
    new Set([sharedSpace.id, personalSpace.id]),
  )
  assert.equal(includingPersonal.meta.total, 2)
})

dbTest('a member can discover another person\'s explicitly shared My Docs space', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const emails = [
    `kb-space-owner-${suffix}@test.local`,
    `kb-space-grantee-${suffix}@test.local`,
  ]
  let organizationId: string | null = null
  t.after(async () => {
    if (organizationId) {
      await prisma.organization.deleteMany({ where: { id: organizationId } })
    }
    await prisma.user.deleteMany({ where: { email: { in: emails } } })
    await prisma.$disconnect()
  })

  const organization = await prisma.organization.create({ data: { name: `kb-space-share-${suffix}` } })
  organizationId = organization.id
  const [owner, grantee] = await Promise.all(emails.map((email, index) => prisma.user.create({
    data: { displayName: index === 0 ? 'Personal space owner' : 'Personal space grantee', email },
  })))
  await prisma.organizationMember.createMany({
    data: [owner, grantee].map((user) => ({ organizationId: organization.id, userId: user.id })),
  })
  const project = await prisma.project.create({
    data: { name: `kb-space-share-project-${suffix}`, organizationId: organization.id },
  })
  const personalSpace = await prisma.knowledgeSpace.create({
    data: {
      createdBy: owner.id,
      metadata: { personal: true },
      name: 'Shared personal notes',
      organizationId: organization.id,
      projectId: project.id,
      userId: owner.id,
      visibility: 'private',
      members: { create: { organizationId: organization.id, userId: grantee.id } },
    },
  })
  const provider = createNativeKnowledgeProvider(prisma)
  const result = await provider.listSpaces({
    organizationId: organization.id,
    viewer: await loadSpaceViewer(prisma, organization.id, {
      actorId: grantee.id,
      actorType: 'user',
    }),
  })

  assert.deepEqual(result.data.map((space) => space.id), [personalSpace.id])
  assert.equal(result.meta.total, 1)
})
