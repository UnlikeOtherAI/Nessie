import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import {
  acceptResourceShare,
  createResourceShare,
  declineResourceShare,
  expireResourceShare,
  ResourceShareLifecycleError,
  revokeResourceShare,
} from '../src/resource-shares.js'
import { resolveResourceAccess } from '../src/resource-share-authority.js'
import {
  cleanupResourceShare as cleanup,
  createBoardOffer,
  loadResourceShareActors as loadActors,
  resourceShareDependencies as dependencies,
  seedResourceShare as seed,
} from './resource-shares-db-fixture.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

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

runDatabaseTest('shared authority re-qualifies the live grant and project in PostgreSQL', async (t) => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  t.after(() => cleanup(prisma, seeded).then(() => prisma.$disconnect()))
  const actors = await loadActors(prisma, seeded)
  const offered = await createBoardOffer(prisma, seeded, actors.source)
  const accepted = await acceptResourceShare(prisma, {
    actor: actors.recipient,
    expectedRevision: offered.revision,
    shareId: offered.id,
  }, dependencies())
  const recipientIdentity = actors.recipient.actionContext.uoaIdentity
  assert.ok(recipientIdentity)
  const accessInput = {
    action: 'read' as const,
    actor: {
      isOrganizationAdmin: true,
      organizationId: seeded.recipientOrganizationId,
      uoaIdentity: recipientIdentity,
      userId: seeded.recipientUserId,
    },
    shareId: accepted.id,
    target: {
      boardId: seeded.boardId,
      kind: 'board' as const,
      projectId: seeded.sourceProjectId,
      sourceOrganizationId: seeded.sourceOrganizationId,
    },
  }
  const authorityDeps = {
    isSharingEnabled: () => true,
    isSharingPolicyEligible: async () => true,
    resolveLiveRecipientEntitlements: async () => ({
      kind: 'uoa' as const,
      organizationId: seeded.recipientOrganizationId,
      organizationRole: 'owner' as const,
      teamIds: [seeded.recipientTeamId],
      userId: seeded.recipientUserId,
    }),
  }
  assert.equal((await resolveResourceAccess(prisma, accessInput, authorityDeps)).kind, 'shared')

  await prisma.project.update({
    where: { id: seeded.sourceProjectId },
    data: { deletedAt: new Date() },
  })
  assert.deepEqual(await resolveResourceAccess(prisma, accessInput, authorityDeps), {
    kind: 'denied',
    reason: 'target_not_found',
  })
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

runDatabaseTest('accept and revoke cannot both transition one pending revision', async (t) => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  t.after(() => cleanup(prisma, seeded).then(() => prisma.$disconnect()))
  const actors = await loadActors(prisma, seeded)
  const offered = await createBoardOffer(prisma, seeded, actors.source)

  let releaseAuthorization!: () => void
  const authorizationReleased = new Promise<void>((resolve) => {
    releaseAuthorization = resolve
  })
  let authorizationCalls = 0
  let bothAuthorizing!: () => void
  const bothAuthorizingPromise = new Promise<void>((resolve) => {
    bothAuthorizing = resolve
  })
  const waitAtAuthorization = async () => {
    authorizationCalls += 1
    if (authorizationCalls === 2) bothAuthorizing()
    await authorizationReleased
    return true
  }
  const deps = dependencies({
    authorizeRecipientTeamManager: waitAtAuthorization,
    authorizeSourceManager: waitAtAuthorization,
  })

  const accepted = acceptResourceShare(prisma, {
    actor: actors.recipient,
    expectedRevision: offered.revision,
    shareId: offered.id,
  }, deps)
  const revoked = revokeResourceShare(prisma, {
    actor: actors.source,
    expectedRevision: offered.revision,
    shareId: offered.id,
  }, deps)
  await bothAuthorizingPromise
  releaseAuthorization()

  const outcomes = await Promise.allSettled([accepted, revoked])
  assert.equal(outcomes.filter(({ status }) => status === 'fulfilled').length, 1)
  const rejected = outcomes.find(({ status }) => status === 'rejected')
  assert.equal(rejected?.status, 'rejected')
  if (rejected?.status === 'rejected') {
    assert.ok(rejected.reason instanceof ResourceShareLifecycleError)
    assert.equal(rejected.reason.code, 'conflict')
  }
  const stored = await prisma.resourceShare.findUniqueOrThrow({ where: { id: offered.id } })
  assert.equal(stored.revision, 2)
  assert.ok(stored.status === 'active' || stored.status === 'revoked')
})

runDatabaseTest('a future revision is rejected before stale authorization can run', async (t) => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  t.after(() => cleanup(prisma, seeded).then(() => prisma.$disconnect()))
  const actors = await loadActors(prisma, seeded)
  const offered = await createBoardOffer(prisma, seeded, actors.source)
  let authorizationCalls = 0

  await assert.rejects(
    revokeResourceShare(prisma, {
      actor: actors.source,
      expectedRevision: offered.revision + 1,
      shareId: offered.id,
    }, dependencies({
      authorizeSourceManager: async () => {
        authorizationCalls += 1
        return true
      },
    })),
    (error: unknown) =>
      error instanceof ResourceShareLifecycleError && error.code === 'conflict',
  )
  assert.equal(authorizationCalls, 0)
})

runDatabaseTest('offer creation refuses expiry crossed during policy evaluation', async (t) => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  t.after(() => cleanup(prisma, seeded).then(() => prisma.$disconnect()))
  const actors = await loadActors(prisma, seeded)
  const expiresAt = new Date(Date.now() + 30)

  await assert.rejects(
    createResourceShare(prisma, {
      access: 'read',
      actor: actors.source,
      boardId: seeded.boardId,
      expiresAt,
      projectId: seeded.sourceProjectId,
      recipientOrganizationId: seeded.recipientOrganizationId,
      recipientTeamId: seeded.recipientTeamId,
      scope: 'board',
    }, dependencies({
      isSharingPolicyEligible: async () => {
        await new Promise((resolve) => setTimeout(resolve, 60))
        return true
      },
    })),
    (error: unknown) =>
      error instanceof ResourceShareLifecycleError && error.code === 'invalid_target',
  )
  assert.equal(await prisma.resourceShare.count({
    where: { sourceOrganizationId: seeded.sourceOrganizationId },
  }), 0)
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
  }, { now: () => new Date(Date.now() + 1_200_000) })
  assert.deepEqual(expired, { id: offered.id, revision: 2, status: 'expired' })
  assert.equal(await prisma.auditLog.count({
    where: { action: 'resource_share.expired', resourceId: offered.id },
  }), 2)
})
