import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import { AuthorizedActionContextSchema } from '@nessie/schemas'

import {
  createResourceShare,
  type ResourceShareLifecycleActor,
  type ResourceShareLifecycleDependencies,
} from '../src/resource-shares.js'

export type ResourceShareSeed = {
  boardId: string
  recipientOrganizationId: string
  recipientTeamId: string
  recipientUserId: string
  sourceOrganizationId: string
  sourceProjectId: string
  sourceTeamId: string
  sourceUserId: string
}

export const seedResourceShare = async (
  prisma: PrismaClient,
): Promise<ResourceShareSeed> => {
  const suffix = randomUUID()
  const [sourceUser, recipientUser] = await Promise.all([
    prisma.user.create({
      data: { displayName: 'Share source', email: `share-source-${suffix}@example.test` },
    }),
    prisma.user.create({
      data: { displayName: 'Share recipient', email: `share-recipient-${suffix}@example.test` },
    }),
  ])
  const sourceOrganization = await prisma.organization.create({
    data: { externalOrgId: `uoa-source-${suffix}`, name: `source-${suffix}` },
  })
  const recipientOrganization = await prisma.organization.create({
    data: { externalOrgId: `uoa-recipient-${suffix}`, name: `recipient-${suffix}` },
  })
  const sourceAnchor = await prisma.project.create({
    data: { name: 'Source team anchor', organizationId: sourceOrganization.id },
  })
  const recipientAnchor = await prisma.project.create({
    data: { name: 'Recipient team anchor', organizationId: recipientOrganization.id },
  })
  const sourceTeam = await prisma.team.create({
    data: {
      externalOrgId: sourceOrganization.externalOrgId,
      externalTeamId: `uoa-source-team-${suffix}`,
      name: 'Source team',
      projectId: sourceAnchor.id,
    },
  })
  const recipientTeam = await prisma.team.create({
    data: {
      externalOrgId: recipientOrganization.externalOrgId,
      externalTeamId: `uoa-recipient-team-${suffix}`,
      name: 'Recipient team',
      projectId: recipientAnchor.id,
    },
  })
  const sourceProject = await prisma.project.create({
    data: {
      name: 'Shareable project',
      organizationId: sourceOrganization.id,
      teamId: sourceTeam.id,
    },
  })
  const board = await prisma.board.create({
    data: {
      isDefault: true,
      name: 'Shareable board',
      organizationId: sourceOrganization.id,
      position: 0,
      projectId: sourceProject.id,
    },
  })
  await prisma.boardSharePublication.create({
    data: {
      boardId: board.id,
      projectId: sourceProject.id,
      sourceOrganizationId: sourceOrganization.id,
    },
  })
  return {
    boardId: board.id,
    recipientOrganizationId: recipientOrganization.id,
    recipientTeamId: recipientTeam.id,
    recipientUserId: recipientUser.id,
    sourceOrganizationId: sourceOrganization.id,
    sourceProjectId: sourceProject.id,
    sourceTeamId: sourceTeam.id,
    sourceUserId: sourceUser.id,
  }
}

export const cleanupResourceShare = async (
  prisma: PrismaClient,
  seeded: ResourceShareSeed,
): Promise<void> => {
  await prisma.resourceShare.deleteMany({
    where: { sourceOrganizationId: seeded.sourceOrganizationId },
  })
  await prisma.organization.deleteMany({
    where: { id: { in: [seeded.sourceOrganizationId, seeded.recipientOrganizationId] } },
  })
  await prisma.user.deleteMany({
    where: { id: { in: [seeded.sourceUserId, seeded.recipientUserId] } },
  })
}

const actor = (
  organizationId: string,
  userId: string,
  externalOrganizationId: string,
  externalTeamId: string,
  requestId: string,
): ResourceShareLifecycleActor => AuthorizedActionContextSchema.parse({
  actionContext: {
    requestId,
    uoaIdentity: {
      organizationId: externalOrganizationId,
      subject: `subject-${userId}`,
      teamId: externalTeamId,
      tokenVersion: 3,
    },
  },
  actor: { actorId: userId, actorType: 'user' },
  tenant: { organizationId },
})

export const loadResourceShareActors = async (
  prisma: PrismaClient,
  seeded: ResourceShareSeed,
) => {
  const [sourceOrganization, sourceTeam, recipientOrganization, recipientTeam] =
    await Promise.all([
      prisma.organization.findUniqueOrThrow({ where: { id: seeded.sourceOrganizationId } }),
      prisma.team.findUniqueOrThrow({ where: { id: seeded.sourceTeamId } }),
      prisma.organization.findUniqueOrThrow({ where: { id: seeded.recipientOrganizationId } }),
      prisma.team.findUniqueOrThrow({ where: { id: seeded.recipientTeamId } }),
    ])
  assert.ok(sourceOrganization.externalOrgId)
  assert.ok(sourceTeam.externalTeamId)
  assert.ok(recipientOrganization.externalOrgId)
  assert.ok(recipientTeam.externalTeamId)
  return {
    recipient: actor(
      seeded.recipientOrganizationId,
      seeded.recipientUserId,
      recipientOrganization.externalOrgId,
      recipientTeam.externalTeamId,
      `recipient-${randomUUID()}`,
    ),
    source: actor(
      seeded.sourceOrganizationId,
      seeded.sourceUserId,
      sourceOrganization.externalOrgId,
      sourceTeam.externalTeamId,
      `source-${randomUUID()}`,
    ),
  }
}

export const resourceShareDependencies = (
  overrides: Partial<ResourceShareLifecycleDependencies> = {},
): ResourceShareLifecycleDependencies => ({
  authorizeRecipientTeamManager: async () => true,
  authorizeSourceManager: async () => true,
  isSharingEnabled: () => true,
  isSharingPolicyEligible: async () => true,
  now: () => new Date(),
  ...overrides,
})

export const createBoardOffer = async (
  prisma: PrismaClient,
  seeded: ResourceShareSeed,
  source: ResourceShareLifecycleActor,
  deps = resourceShareDependencies(),
) => createResourceShare(prisma, {
  access: 'read',
  actor: source,
  boardId: seeded.boardId,
  expiresAt: new Date(Date.now() + 600_000),
  projectId: seeded.sourceProjectId,
  recipientOrganizationId: seeded.recipientOrganizationId,
  recipientTeamId: seeded.recipientTeamId,
  scope: 'board',
}, deps)
