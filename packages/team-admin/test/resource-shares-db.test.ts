import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import { AuthorizedActionContextSchema } from '@nessie/schemas'

import {
  acceptResourceShare,
  createResourceShare,
  declineResourceShare,
  expireResourceShare,
  ResourceShareLifecycleError,
  revokeResourceShare,
  type ResourceShareLifecycleActor,
  type ResourceShareLifecycleDependencies,
} from '../src/resource-shares.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip
const NOW = new Date('2026-09-19T12:00:00.000Z')

type Seed = {
  boardId: string
  recipientOrganizationId: string
  recipientTeamId: string
  recipientUserId: string
  sourceOrganizationId: string
  sourceProjectId: string
  sourceTeamId: string
  sourceUserId: string
}

const seed = async (prisma: PrismaClient): Promise<Seed> => {
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

const cleanup = async (prisma: PrismaClient, seeded: Seed): Promise<void> => {
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

const loadActors = async (prisma: PrismaClient, seeded: Seed) => {
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

const dependencies = (
  overrides: Partial<ResourceShareLifecycleDependencies> = {},
): ResourceShareLifecycleDependencies => ({
  authorizeRecipientTeamManager: async () => true,
  authorizeSourceManager: async () => true,
  isSharingEnabled: () => true,
  isSharingPolicyEligible: async () => true,
  now: () => NOW,
  ...overrides,
})

const createBoardOffer = async (
  prisma: PrismaClient,
  seeded: Seed,
  source: ResourceShareLifecycleActor,
  deps = dependencies(),
) => createResourceShare(prisma, {
  access: 'read',
  actor: source,
  boardId: seeded.boardId,
  expiresAt: new Date(NOW.getTime() + 60_000),
  projectId: seeded.sourceProjectId,
  recipientOrganizationId: seeded.recipientOrganizationId,
  recipientTeamId: seeded.recipientTeamId,
  scope: 'board',
}, deps)

runDatabaseTest('offer and acceptance are CAS transitions audited in both tenants', async (t) => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  t.after(() => cleanup(prisma, seeded).then(() => prisma.$disconnect()))
  const actors = await loadActors(prisma, seeded)
  const deps = dependencies()

  const offered = await createBoardOffer(prisma, seeded, actors.source, deps)
  assert.equal(offered.status, 'pending')
  assert.equal(offered.revision, 1)

  const accepted = await acceptResourceShare(prisma, {
    actor: actors.recipient,
    expectedRevision: offered.revision,
    shareId: offered.id,
  }, deps)
  assert.deepEqual(accepted, { id: offered.id, revision: 2, status: 'active' })

  const stored = await prisma.resourceShare.findUniqueOrThrow({ where: { id: offered.id } })
  assert.equal(stored.acceptedBySubject, `subject-${seeded.recipientUserId}`)
  assert.equal(stored.effectiveAccess, 'read')
  assert.equal(stored.effectiveRevision, 1)

  const audits = await prisma.auditLog.findMany({
    where: { resourceId: offered.id },
    orderBy: [{ organizationId: 'asc' }, { createdAt: 'asc' }],
    select: { action: true, organizationId: true, projectId: true, teamId: true },
  })
  assert.equal(audits.length, 4)
  assert.deepEqual(new Set(audits.map(({ organizationId }) => organizationId)), new Set([
    seeded.sourceOrganizationId,
    seeded.recipientOrganizationId,
  ]))
  assert.deepEqual(new Set(audits.map(({ action }) => action)), new Set([
    'resource_share.offered',
    'resource_share.accepted',
  ]))
  assert.ok(audits
    .filter(({ organizationId }) => organizationId === seeded.recipientOrganizationId)
    .every(({ projectId, teamId }) => projectId === null && teamId === seeded.recipientTeamId))
})

runDatabaseTest('two recipient managers cannot both accept one revision', async (t) => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  t.after(() => cleanup(prisma, seeded).then(() => prisma.$disconnect()))
  const actors = await loadActors(prisma, seeded)
  const deps = dependencies()
  const offered = await createBoardOffer(prisma, seeded, actors.source, deps)

  const results = await Promise.allSettled([
    acceptResourceShare(prisma, {
      actor: actors.recipient,
      expectedRevision: offered.revision,
      shareId: offered.id,
    }, deps),
    acceptResourceShare(prisma, {
      actor: actors.recipient,
      expectedRevision: offered.revision,
      shareId: offered.id,
    }, deps),
  ])
  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1)
  const rejection = results.find(({ status }) => status === 'rejected')
  assert.ok(rejection?.status === 'rejected')
  assert.ok(rejection.reason instanceof ResourceShareLifecycleError)
  assert.equal(rejection.reason.code, 'conflict')
  assert.equal(await prisma.auditLog.count({
    where: { action: 'resource_share.accepted', resourceId: offered.id },
  }), 2)
})

runDatabaseTest('acceptance refuses a board whose publication was withdrawn', async (t) => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  t.after(() => cleanup(prisma, seeded).then(() => prisma.$disconnect()))
  const actors = await loadActors(prisma, seeded)
  const deps = dependencies()
  const offered = await createBoardOffer(prisma, seeded, actors.source, deps)
  await prisma.boardSharePublication.delete({ where: { boardId: seeded.boardId } })

  await assert.rejects(
    acceptResourceShare(prisma, {
      actor: actors.recipient,
      expectedRevision: offered.revision,
      shareId: offered.id,
    }, deps),
    (error: unknown) => error instanceof ResourceShareLifecycleError &&
      error.code === 'invalid_target',
  )
  assert.equal((await prisma.resourceShare.findUniqueOrThrow({
    where: { id: offered.id },
  })).status, 'pending')
})

runDatabaseTest('a recipient manager can decline a pending offer', async (t) => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  t.after(() => cleanup(prisma, seeded).then(() => prisma.$disconnect()))
  const actors = await loadActors(prisma, seeded)
  const deps = dependencies()
  const offered = await createBoardOffer(prisma, seeded, actors.source, deps)

  const declined = await declineResourceShare(prisma, {
    actor: actors.recipient,
    expectedRevision: offered.revision,
    shareId: offered.id,
  }, deps)
  assert.deepEqual(declined, { id: offered.id, revision: 2, status: 'declined' })

  const stored = await prisma.resourceShare.findUniqueOrThrow({ where: { id: offered.id } })
  assert.equal(stored.declinedBySubject, `subject-${seeded.recipientUserId}`)
  assert.equal(stored.effectiveAccess, null)
  assert.equal(await prisma.auditLog.count({
    where: { action: 'resource_share.declined', resourceId: offered.id },
  }), 2)
})

runDatabaseTest('revocation remains reachable after rollout closes', async (t) => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  t.after(() => cleanup(prisma, seeded).then(() => prisma.$disconnect()))
  const actors = await loadActors(prisma, seeded)
  const enabled = dependencies()
  const offered = await createBoardOffer(prisma, seeded, actors.source, enabled)
  const accepted = await acceptResourceShare(prisma, {
    actor: actors.recipient,
    expectedRevision: offered.revision,
    shareId: offered.id,
  }, enabled)

  const revoked = await revokeResourceShare(prisma, {
    actor: actors.source,
    expectedRevision: accepted.revision,
    shareId: accepted.id,
  }, dependencies({ isSharingEnabled: () => false }))
  assert.deepEqual(revoked, { id: offered.id, revision: 3, status: 'revoked' })
})

runDatabaseTest('expiry is an audited system transition, not a read-time rewrite', async (t) => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  t.after(() => cleanup(prisma, seeded).then(() => prisma.$disconnect()))
  const actors = await loadActors(prisma, seeded)
  const offered = await createBoardOffer(prisma, seeded, actors.source)

  const expired = await expireResourceShare(prisma, {
    expectedRevision: offered.revision,
    requestId: `expiry-${randomUUID()}`,
    shareId: offered.id,
  }, { now: () => new Date(NOW.getTime() + 120_000) })
  assert.deepEqual(expired, { id: offered.id, revision: 2, status: 'expired' })
  assert.equal(await prisma.auditLog.count({
    where: { action: 'resource_share.expired', resourceId: offered.id },
  }), 2)
})
