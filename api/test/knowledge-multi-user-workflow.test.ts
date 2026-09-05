import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import Fastify from 'fastify'
import { PrismaClient } from '@prisma/client'
import { createNativeKnowledgeProvider } from '@nessie/knowledge'
import type { AuthorizedActionContext } from '@nessie/schemas'
import { registerKnowledgeBaseRoutes } from '../src/routes/knowledge-base.js'
import { seedDefaultPolicies } from '../src/services/policy-seed.js'

const dbTest = process.env.DATABASE_URL ? test : test.skip

type Seed = {
  alphaProjectId: string
  betaProjectId: string
  bobId: string
  carolId: string
  foreignProjectId: string
  organizationId: string
  foreignOrganizationId: string
  ownerId: string
  outsiderId: string
  prisma: PrismaClient
  userIds: string[]
}

const seed = async (): Promise<Seed> => {
  const prisma = new PrismaClient()
  const organizationId = randomUUID()
  const foreignOrganizationId = randomUUID()
  const ownerId = randomUUID()
  const bobId = randomUUID()
  const carolId = randomUUID()
  const outsiderId = randomUUID()
  const userIds = [ownerId, bobId, carolId, outsiderId]

  await prisma.organization.createMany({
    data: [
      { id: organizationId, name: `knowledge-workflow-${organizationId}` },
      { id: foreignOrganizationId, name: `knowledge-foreign-${foreignOrganizationId}` },
    ],
  })
  await prisma.user.createMany({
    data: userIds.map((id) => ({
      id,
      email: `${id}@knowledge-workflow.test`,
      displayName: `Knowledge test ${id.slice(0, 8)}`,
    })),
  })
  await prisma.organizationMember.createMany({
    data: [
      { organizationId, userId: ownerId, role: 'owner' },
      { organizationId, userId: bobId, role: 'member' },
      { organizationId, userId: carolId, role: 'member' },
      // The owner also belongs to a second organization. This proves the
      // active organization fence on project memberships, rather than merely
      // checking that a project id exists somewhere.
      { organizationId: foreignOrganizationId, userId: ownerId, role: 'member' },
      { organizationId: foreignOrganizationId, userId: outsiderId, role: 'member' },
    ],
  })

  const [alpha, beta, foreign] = await Promise.all([
    prisma.project.create({ data: { organizationId, name: 'Alpha' } }),
    prisma.project.create({ data: { organizationId, name: 'Beta' } }),
    prisma.project.create({ data: { organizationId: foreignOrganizationId, name: 'Foreign' } }),
  ])
  await prisma.projectMember.createMany({
    data: [
      { projectId: alpha.id, userId: ownerId, role: 'owner' },
      { projectId: alpha.id, userId: bobId, role: 'member' },
      { projectId: beta.id, userId: carolId, role: 'member' },
      { projectId: foreign.id, userId: ownerId, role: 'member' },
    ],
  })
  await seedDefaultPolicies(prisma, organizationId, ownerId)

  return {
    alphaProjectId: alpha.id,
    betaProjectId: beta.id,
    bobId,
    carolId,
    foreignProjectId: foreign.id,
    foreignOrganizationId,
    organizationId,
    ownerId,
    outsiderId,
    prisma,
    userIds,
  }
}

const teardown = async (seeded: Seed): Promise<void> => {
  await seeded.prisma.organization.deleteMany({
    where: { id: { in: [seeded.organizationId, seeded.foreignOrganizationId] } },
  })
  await seeded.prisma.user.deleteMany({ where: { id: { in: seeded.userIds } } })
  await seeded.prisma.$disconnect()
}

const contextFor = (
  seeded: Seed,
  userId: string,
  role: 'member' | 'owner',
  projectId: string,
): AuthorizedActionContext => ({
  actionContext: { requestId: `knowledge-workflow-${userId}` },
  actor: { actorId: userId, actorType: 'user', roles: [role] },
  tenant: { organizationId: seeded.organizationId, projectId },
}) as AuthorizedActionContext

dbTest('documents persist multi-user project permissions, moves, updates, and explicit cross-project sharing', async () => {
  const seeded = await seed()
  const actors = new Map([
    ['owner', contextFor(seeded, seeded.ownerId, 'owner', seeded.alphaProjectId)],
    ['bob', contextFor(seeded, seeded.bobId, 'member', seeded.alphaProjectId)],
    ['carol', contextFor(seeded, seeded.carolId, 'member', seeded.betaProjectId)],
  ])
  const app = Fastify({ logger: false })
  registerKnowledgeBaseRoutes(app, {
    prisma: seeded.prisma,
    knowledgeProvider: createNativeKnowledgeProvider(seeded.prisma),
    requireActorContext: (request) => {
      const actor = request.headers['x-knowledge-workflow-actor']
      return typeof actor === 'string' ? actors.get(actor) : undefined
    },
  } as unknown as Parameters<typeof registerKnowledgeBaseRoutes>[1])

  const requestAs = (
    actor: 'owner' | 'bob' | 'carol',
    input: Parameters<typeof app.inject>[0],
  ) => app.inject({
    ...input,
    headers: { ...input.headers, 'x-knowledge-workflow-actor': actor },
  })

  try {
    const createSpace = await requestAs('owner', {
      method: 'POST',
      url: '/api/knowledge-base/spaces',
      payload: { name: 'Alpha documents', projectId: seeded.alphaProjectId, visibility: 'project' },
    })
    assert.equal(createSpace.statusCode, 201)
    const spaceId = (createSpace.json() as { data: { id: string } }).data.id

    const createParent = await requestAs('owner', {
      method: 'POST',
      url: `/api/knowledge-base/spaces/${spaceId}/pages`,
      payload: { body: '<p>Shared project guidance</p>', title: 'Runbook' },
    })
    assert.equal(createParent.statusCode, 201)
    const parentPageId = (createParent.json() as { data: { id: string } }).data.id

    const projectMemberReads = await requestAs('bob', {
      method: 'GET',
      url: `/api/knowledge-base/pages/${parentPageId}`,
    })
    assert.equal(projectMemberReads.statusCode, 200)

    const createChild = await requestAs('bob', {
      method: 'POST',
      url: `/api/knowledge-base/spaces/${spaceId}/pages`,
      payload: { body: '<p>Original change detail</p>', title: 'Change detail' },
    })
    assert.equal(createChild.statusCode, 201)
    const childPageId = (createChild.json() as { data: { id: string } }).data.id

    const editChild = await requestAs('bob', {
      method: 'PATCH',
      url: `/api/knowledge-base/pages/${childPageId}`,
      payload: { body: '<p>Edited by the Alpha project member</p>' },
    })
    assert.equal(editChild.statusCode, 200)
    assert.equal(
      (editChild.json() as { data: { latestVersion: { authorId: string; versionNumber: number } } })
        .data.latestVersion.authorId,
      seeded.bobId,
    )

    const moveChild = await requestAs('bob', {
      method: 'POST',
      url: `/api/knowledge-base/pages/${childPageId}/move`,
      headers: { 'if-match': '"1"' },
      payload: { parentPageId, position: 0 },
    })
    assert.equal(moveChild.statusCode, 200)
    assert.equal((moveChild.json() as { data: { parentPageId: string } }).data.parentPageId, parentPageId)

    const plainMemberCannotWiden = await requestAs('bob', {
      method: 'PATCH',
      url: `/api/knowledge-base/spaces/${spaceId}`,
      payload: { visibility: 'organization' },
    })
    assert.equal(plainMemberCannotWiden.statusCode, 403)

    const ownerRestrictsWrites = await requestAs('owner', {
      method: 'PATCH',
      url: `/api/knowledge-base/spaces/${spaceId}`,
      payload: { memberUserIds: [seeded.bobId], writeRestricted: true },
    })
    assert.equal(ownerRestrictsWrites.statusCode, 200)
    const explicitlyGrantedMemberEdits = await requestAs('bob', {
      method: 'PATCH',
      url: `/api/knowledge-base/pages/${childPageId}`,
      payload: { body: '<p>Still editable through the explicit grant</p>' },
    })
    assert.equal(explicitlyGrantedMemberEdits.statusCode, 200)

    const ownerSharesPrivatelyWithOtherProject = await requestAs('owner', {
      method: 'PATCH',
      url: `/api/knowledge-base/spaces/${spaceId}`,
      payload: { memberUserIds: [seeded.carolId], visibility: 'private' },
    })
    assert.equal(ownerSharesPrivatelyWithOtherProject.statusCode, 200)
    const formerProjectMemberDenied = await requestAs('bob', {
      method: 'GET',
      url: `/api/knowledge-base/pages/${childPageId}`,
    })
    assert.equal(formerProjectMemberDenied.statusCode, 403)
    const explicitlySharedOtherProjectReads = await requestAs('carol', {
      method: 'GET',
      url: `/api/knowledge-base/pages/${childPageId}`,
    })
    assert.equal(explicitlySharedOtherProjectReads.statusCode, 200)
    const explicitlySharedOtherProjectEdits = await requestAs('carol', {
      method: 'PATCH',
      url: `/api/knowledge-base/pages/${childPageId}`,
      payload: { body: '<p>Edited through a direct cross-project grant</p>' },
    })
    assert.equal(explicitlySharedOtherProjectEdits.statusCode, 200)

    const ownerRevokesCrossProjectGrant = await requestAs('owner', {
      method: 'PATCH',
      url: `/api/knowledge-base/spaces/${spaceId}`,
      payload: { memberUserIds: [] },
    })
    assert.equal(ownerRevokesCrossProjectGrant.statusCode, 200)
    const revokedUserDenied = await requestAs('carol', {
      method: 'GET',
      url: `/api/knowledge-base/pages/${childPageId}`,
    })
    assert.equal(revokedUserDenied.statusCode, 403)

    const foreignProjectCreationDenied = await requestAs('owner', {
      method: 'POST',
      url: '/api/knowledge-base/spaces',
      payload: { name: 'Foreign documents', projectId: seeded.foreignProjectId },
    })
    assert.equal(foreignProjectCreationDenied.statusCode, 403)

    const foreignUserGrantDenied = await requestAs('owner', {
      method: 'POST',
      url: '/api/knowledge-base/spaces',
      payload: {
        memberUserIds: [seeded.outsiderId],
        name: 'Invalid grant',
        projectId: seeded.alphaProjectId,
        visibility: 'private',
      },
    })
    assert.equal(foreignUserGrantDenied.statusCode, 409)

    const stored = await seeded.prisma.knowledgePage.findUniqueOrThrow({
      where: { id: childPageId },
      include: { versions: { orderBy: { versionNumber: 'desc' }, take: 1 } },
    })
    assert.equal(stored.projectId, seeded.alphaProjectId)
    assert.equal(stored.parentPageId, parentPageId)
    assert.equal(stored.versions[0]?.authorId, seeded.carolId)
    assert.equal(stored.revision, 4)
  } finally {
    await app.close()
    await teardown(seeded)
  }
})
