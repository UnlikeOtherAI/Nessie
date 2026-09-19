import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { Prisma, PrismaClient } from '@prisma/client'

const dbTest = process.env.DATABASE_URL ? test : test.skip

type Fixture = Awaited<ReturnType<typeof seedFixture>>

const seedFixture = async (prisma: PrismaClient) => {
  const suffix = randomUUID()
  const sourceExternalOrgId = `source-org-${suffix}`
  const recipientExternalOrgId = `recipient-org-${suffix}`
  const sourceExternalTeamId = `source-team-${suffix}`
  const recipientExternalTeamId = `recipient-team-${suffix}`
  const sourceOrganization = await prisma.organization.create({
    data: { name: `Source ${suffix}`, externalOrgId: sourceExternalOrgId },
  })
  const recipientOrganization = await prisma.organization.create({
    data: { name: `Recipient ${suffix}`, externalOrgId: recipientExternalOrgId },
  })
  const sourceProject = await prisma.project.create({
    data: { name: `Source project ${suffix}`, organizationId: sourceOrganization.id },
  })
  const recipientProject = await prisma.project.create({
    data: { name: `Recipient project ${suffix}`, organizationId: recipientOrganization.id },
  })
  const sourceTeam = await prisma.team.create({
    data: {
      name: `Source team ${suffix}`,
      projectId: sourceProject.id,
      externalOrgId: sourceExternalOrgId,
      externalTeamId: sourceExternalTeamId,
    },
  })
  const recipientTeam = await prisma.team.create({
    data: {
      name: `Recipient team ${suffix}`,
      projectId: recipientProject.id,
      externalOrgId: recipientExternalOrgId,
      externalTeamId: recipientExternalTeamId,
    },
  })
  await Promise.all([
    prisma.project.update({ where: { id: sourceProject.id }, data: { teamId: sourceTeam.id } }),
    prisma.project.update({ where: { id: recipientProject.id }, data: { teamId: recipientTeam.id } }),
  ])
  const [boardA, boardB] = await Promise.all([
    prisma.board.create({
      data: {
        name: `Board A ${suffix}`,
        organizationId: sourceOrganization.id,
        projectId: sourceProject.id,
        position: 0,
      },
    }),
    prisma.board.create({
      data: {
        name: `Board B ${suffix}`,
        organizationId: sourceOrganization.id,
        projectId: sourceProject.id,
        position: 1,
      },
    }),
  ])
  const [field, iteration, space] = await Promise.all([
    prisma.taskFieldDefinition.create({
      data: {
        name: `Field ${suffix}`,
        type: 'select',
        position: 0,
        organizationId: sourceOrganization.id,
        projectId: sourceProject.id,
      },
    }),
    prisma.iteration.create({
      data: {
        name: `Iteration ${suffix}`,
        position: 0,
        organizationId: sourceOrganization.id,
        projectId: sourceProject.id,
      },
    }),
    prisma.knowledgeSpace.create({
      data: {
        name: `Space ${suffix}`,
        createdBy: `subject-${suffix}`,
        organizationId: sourceOrganization.id,
        projectId: sourceProject.id,
      },
    }),
  ])
  const page = await prisma.knowledgePage.create({
    data: {
      title: `Page ${suffix}`,
      createdBy: `subject-${suffix}`,
      organizationId: sourceOrganization.id,
      projectId: sourceProject.id,
      spaceId: space.id,
    },
  })
  return {
    sourceOrganization,
    recipientOrganization,
    sourceProject,
    recipientProject,
    sourceTeam,
    recipientTeam,
    sourceExternalOrgId,
    recipientExternalOrgId,
    sourceExternalTeamId,
    recipientExternalTeamId,
    boardA,
    boardB,
    field,
    iteration,
    page,
  }
}

const cleanupFixture = async (prisma: PrismaClient, fixture: Fixture) => {
  await prisma.resourceShare.deleteMany({
    where: {
      OR: [
        { sourceOrganizationId: fixture.sourceOrganization.id },
        { recipientOrganizationId: fixture.recipientOrganization.id },
      ],
    },
  })
  await prisma.boardSharePublication.deleteMany({
    where: { sourceOrganizationId: fixture.sourceOrganization.id },
  })
  await prisma.project.updateMany({
    where: { id: { in: [fixture.sourceProject.id, fixture.recipientProject.id] } },
    data: { teamId: null },
  })
  await prisma.organization.deleteMany({
    where: { id: { in: [fixture.sourceOrganization.id, fixture.recipientOrganization.id] } },
  })
}

const withFixture = async (run: (prisma: PrismaClient, fixture: Fixture) => Promise<void>) => {
  const prisma = new PrismaClient()
  const fixture = await seedFixture(prisma)
  try {
    await run(prisma, fixture)
  } finally {
    await cleanupFixture(prisma, fixture)
    await prisma.$disconnect()
  }
}

const pendingShare = (
  fixture: Fixture,
  scope: 'project' | 'board',
): Prisma.ResourceShareUncheckedCreateInput => ({
  id: randomUUID(),
  scope,
  sourceOrganizationId: fixture.sourceOrganization.id,
  sourceExternalOrgId: fixture.sourceExternalOrgId,
  sourceTeamId: fixture.sourceTeam.id,
  sourceExternalTeamId: fixture.sourceExternalTeamId,
  projectId: fixture.sourceProject.id,
  targetBoardId: scope === 'board' ? fixture.boardA.id : null,
  boardId: scope === 'board' ? fixture.boardA.id : null,
  recipientOrganizationId: fixture.recipientOrganization.id,
  recipientExternalOrgId: fixture.recipientExternalOrgId,
  recipientTeamId: fixture.recipientTeam.id,
  recipientExternalTeamId: fixture.recipientExternalTeamId,
  proposedAccess: 'read',
  createdBySubject: `creator-${randomUUID()}`,
  createdByActingOrgRef: fixture.sourceExternalOrgId,
  updatedAt: new Date(),
})

const expectDatabaseRejection = async (
  operation: Promise<unknown>,
  message?: RegExp,
): Promise<void> => {
  await assert.rejects(operation, (error: unknown) => {
    if (message) {
      assert.match(String(error), message)
    }
    return true
  })
}

const createPublication = (prisma: PrismaClient, fixture: Fixture, boardId: string) =>
  prisma.boardSharePublication.create({
    data: {
      boardId,
      projectId: fixture.sourceProject.id,
      sourceOrganizationId: fixture.sourceOrganization.id,
      updatedAt: new Date(),
    },
  })

const publicationRevision = async (prisma: PrismaClient, boardId: string) => {
  const publication = await prisma.boardSharePublication.findUniqueOrThrow({
    where: { boardId },
    select: { revision: true },
  })
  return publication.revision
}

dbTest('resource-sharing migration: scope and live-board requirements preserve terminal target audit', () =>
  withFixture(async (prisma, fixture) => {
    await expectDatabaseRejection(
      prisma.resourceShare.create({
        data: {
          ...pendingShare(fixture, 'project'),
          targetBoardId: fixture.boardA.id,
          boardId: fixture.boardA.id,
        },
      }),
    )
    await expectDatabaseRejection(
      prisma.resourceShare.create({
        data: { ...pendingShare(fixture, 'board'), boardId: null },
      }),
    )

    const terminal = await prisma.resourceShare.create({
      data: {
        ...pendingShare(fixture, 'board'),
        boardId: null,
        status: 'declined',
        declinedBySubject: `decliner-${randomUUID()}`,
        declinedByActingOrgRef: fixture.recipientExternalOrgId,
        declinedAt: new Date(),
      },
    })
    assert.equal(terminal.targetBoardId, fixture.boardA.id)
    assert.equal(terminal.boardId, null)
  }))

dbTest('resource-sharing migration: identity, target, audience, and creation audit are immutable', () =>
  withFixture(async (prisma, fixture) => {
    const share = await prisma.resourceShare.create({ data: pendingShare(fixture, 'project') })
    const writes = [
      Prisma.sql`UPDATE "resource_shares" SET "id" = ${randomUUID()}::uuid, "revision" = 2 WHERE "id" = ${share.id}::uuid`,
      Prisma.sql`UPDATE "resource_shares" SET "scope" = 'board', "revision" = 2 WHERE "id" = ${share.id}::uuid`,
      Prisma.sql`UPDATE "resource_shares" SET "source_organization_id" = ${randomUUID()}::uuid, "revision" = 2 WHERE "id" = ${share.id}::uuid`,
      Prisma.sql`UPDATE "resource_shares" SET "source_external_org_id" = 'changed', "revision" = 2 WHERE "id" = ${share.id}::uuid`,
      Prisma.sql`UPDATE "resource_shares" SET "source_team_id" = ${randomUUID()}::uuid, "revision" = 2 WHERE "id" = ${share.id}::uuid`,
      Prisma.sql`UPDATE "resource_shares" SET "source_external_team_id" = 'changed', "revision" = 2 WHERE "id" = ${share.id}::uuid`,
      Prisma.sql`UPDATE "resource_shares" SET "project_id" = ${randomUUID()}::uuid, "revision" = 2 WHERE "id" = ${share.id}::uuid`,
      Prisma.sql`UPDATE "resource_shares" SET "target_board_id" = ${fixture.boardA.id}::uuid, "revision" = 2 WHERE "id" = ${share.id}::uuid`,
      Prisma.sql`UPDATE "resource_shares" SET "recipient_organization_id" = ${randomUUID()}::uuid, "revision" = 2 WHERE "id" = ${share.id}::uuid`,
      Prisma.sql`UPDATE "resource_shares" SET "recipient_external_org_id" = 'changed', "revision" = 2 WHERE "id" = ${share.id}::uuid`,
      Prisma.sql`UPDATE "resource_shares" SET "recipient_team_id" = ${randomUUID()}::uuid, "revision" = 2 WHERE "id" = ${share.id}::uuid`,
      Prisma.sql`UPDATE "resource_shares" SET "recipient_external_team_id" = 'changed', "revision" = 2 WHERE "id" = ${share.id}::uuid`,
      Prisma.sql`UPDATE "resource_shares" SET "created_by_subject" = 'changed', "revision" = 2 WHERE "id" = ${share.id}::uuid`,
      Prisma.sql`UPDATE "resource_shares" SET "created_by_acting_org_ref" = 'changed', "revision" = 2 WHERE "id" = ${share.id}::uuid`,
      Prisma.sql`UPDATE "resource_shares" SET "created_at" = "created_at" + INTERVAL '1 second', "revision" = 2 WHERE "id" = ${share.id}::uuid`,
    ]
    for (const write of writes) {
      await expectDatabaseRejection(
        prisma.$executeRaw(write),
        /identity, target, audience and creation audit are immutable/,
      )
    }
  }))

dbTest('resource-sharing migration: terminal lifecycle and recorded audit are append-only', () =>
  withFixture(async (prisma, fixture) => {
    const terminalCases = [
      {
        status: 'declined' as const,
        data: {
          declinedBySubject: 'decliner',
          declinedByActingOrgRef: fixture.recipientExternalOrgId,
          declinedAt: new Date(),
        },
        auditWrite: Prisma.sql`"declined_by_subject" = 'changed'`,
        message: /decline audit is append-only/,
      },
      {
        status: 'revoked' as const,
        data: {
          revokedBySubject: 'revoker',
          revokedByActingOrgRef: fixture.sourceExternalOrgId,
          revokedAt: new Date(),
        },
        auditWrite: Prisma.sql`"revoked_by_subject" = 'changed'`,
        message: /revocation audit is append-only/,
      },
      {
        status: 'expired' as const,
        data: { expiredAt: new Date() },
        auditWrite: Prisma.sql`"expired_at" = "expired_at" + INTERVAL '1 second'`,
        message: /expiry audit is append-only/,
      },
    ]
    for (const terminalCase of terminalCases) {
      const share = await prisma.resourceShare.create({
        data: {
          ...pendingShare(fixture, 'project'),
          status: terminalCase.status,
          ...terminalCase.data,
        },
      })
      await expectDatabaseRejection(
        prisma.$executeRaw(Prisma.sql`
          UPDATE "resource_shares"
          SET "status" = 'pending', "revision" = 2, "updated_at" = CURRENT_TIMESTAMP
          WHERE "id" = ${share.id}::uuid
        `),
      )
      await expectDatabaseRejection(
        prisma.$executeRaw(Prisma.sql`
          UPDATE "resource_shares"
          SET ${terminalCase.auditWrite}, "revision" = 2, "updated_at" = CURRENT_TIMESTAMP
          WHERE "id" = ${share.id}::uuid
        `),
        terminalCase.message,
      )
    }
  }))

dbTest('resource-sharing migration: live project and board grants are unique per audience', () =>
  withFixture(async (prisma, fixture) => {
    const projectShare = await prisma.resourceShare.create({
      data: pendingShare(fixture, 'project'),
    })
    await expectDatabaseRejection(
      prisma.resourceShare.create({ data: pendingShare(fixture, 'project') }),
    )
    assert.equal(
      await prisma.resourceShare.count({
        where: { projectId: fixture.sourceProject.id, scope: 'project', status: 'pending' },
      }),
      1,
    )
    await prisma.resourceShare.update({
      where: { id: projectShare.id },
      data: {
        status: 'declined',
        revision: 2,
        declinedBySubject: 'decliner',
        declinedByActingOrgRef: fixture.recipientExternalOrgId,
        declinedAt: new Date(),
      },
    })
    await prisma.resourceShare.create({ data: pendingShare(fixture, 'project') })

    await prisma.resourceShare.create({ data: pendingShare(fixture, 'board') })
    await expectDatabaseRejection(
      prisma.resourceShare.create({ data: pendingShare(fixture, 'board') }),
    )
    assert.equal(
      await prisma.resourceShare.count({
        where: { targetBoardId: fixture.boardA.id, status: { in: ['pending', 'active'] } },
      }),
      1,
    )
  }))

dbTest('resource-sharing migration: publication child mutations advance the owner revision', () =>
  withFixture(async (prisma, fixture) => {
    await createPublication(prisma, fixture, fixture.boardA.id)
    await prisma.$executeRaw`INSERT INTO "board_shared_fields"
      ("board_id", "project_id", "source_organization_id", "field_definition_id", "updated_at")
      VALUES (${fixture.boardA.id}::uuid, ${fixture.sourceProject.id}::uuid,
        ${fixture.sourceOrganization.id}::uuid, ${fixture.field.id}::uuid, CURRENT_TIMESTAMP)`
    assert.equal(await publicationRevision(prisma, fixture.boardA.id), 2)
    await prisma.$executeRaw`UPDATE "board_shared_fields" SET "allowed_option_ids" = ARRAY['one'],
      "updated_at" = CURRENT_TIMESTAMP WHERE "board_id" = ${fixture.boardA.id}::uuid`
    assert.equal(await publicationRevision(prisma, fixture.boardA.id), 3)
    await prisma.$executeRaw`DELETE FROM "board_shared_fields"
      WHERE "board_id" = ${fixture.boardA.id}::uuid`
    assert.equal(await publicationRevision(prisma, fixture.boardA.id), 4)

    await prisma.$executeRaw`INSERT INTO "board_shared_iterations"
      ("board_id", "project_id", "source_organization_id", "iteration_id")
      VALUES (${fixture.boardA.id}::uuid, ${fixture.sourceProject.id}::uuid,
        ${fixture.sourceOrganization.id}::uuid, ${fixture.iteration.id}::uuid)`
    assert.equal(await publicationRevision(prisma, fixture.boardA.id), 5)
    await prisma.$executeRaw`UPDATE "board_shared_iterations"
      SET "created_at" = "created_at" + INTERVAL '1 second'
      WHERE "board_id" = ${fixture.boardA.id}::uuid`
    assert.equal(await publicationRevision(prisma, fixture.boardA.id), 6)
    await prisma.$executeRaw`DELETE FROM "board_shared_iterations"
      WHERE "board_id" = ${fixture.boardA.id}::uuid`
    assert.equal(await publicationRevision(prisma, fixture.boardA.id), 7)

    await prisma.$executeRaw`INSERT INTO "board_shared_resources"
      ("board_id", "project_id", "source_organization_id", "page_id")
      VALUES (${fixture.boardA.id}::uuid, ${fixture.sourceProject.id}::uuid,
        ${fixture.sourceOrganization.id}::uuid, ${fixture.page.id}::uuid)`
    assert.equal(await publicationRevision(prisma, fixture.boardA.id), 8)
    await prisma.$executeRaw`UPDATE "board_shared_resources"
      SET "created_at" = "created_at" + INTERVAL '1 second'
      WHERE "board_id" = ${fixture.boardA.id}::uuid`
    assert.equal(await publicationRevision(prisma, fixture.boardA.id), 9)
    await prisma.$executeRaw`DELETE FROM "board_shared_resources"
      WHERE "board_id" = ${fixture.boardA.id}::uuid`
    assert.equal(await publicationRevision(prisma, fixture.boardA.id), 10)
  }))

dbTest('resource-sharing migration: moving children advances both owners without stale edges', () =>
  withFixture(async (prisma, fixture) => {
    await Promise.all([
      createPublication(prisma, fixture, fixture.boardA.id),
      createPublication(prisma, fixture, fixture.boardB.id),
    ])
    await prisma.$executeRaw`INSERT INTO "board_shared_fields"
      ("board_id", "project_id", "source_organization_id", "field_definition_id", "updated_at")
      VALUES (${fixture.boardA.id}::uuid, ${fixture.sourceProject.id}::uuid,
        ${fixture.sourceOrganization.id}::uuid, ${fixture.field.id}::uuid, CURRENT_TIMESTAMP)`
    await prisma.$executeRaw`INSERT INTO "board_shared_iterations"
      ("board_id", "project_id", "source_organization_id", "iteration_id")
      VALUES (${fixture.boardA.id}::uuid, ${fixture.sourceProject.id}::uuid,
        ${fixture.sourceOrganization.id}::uuid, ${fixture.iteration.id}::uuid)`
    await prisma.$executeRaw`INSERT INTO "board_shared_resources"
      ("board_id", "project_id", "source_organization_id", "page_id")
      VALUES (${fixture.boardA.id}::uuid, ${fixture.sourceProject.id}::uuid,
        ${fixture.sourceOrganization.id}::uuid, ${fixture.page.id}::uuid)`
    assert.deepEqual(
      await Promise.all([
        publicationRevision(prisma, fixture.boardA.id),
        publicationRevision(prisma, fixture.boardB.id),
      ]),
      [4, 1],
    )

    for (const table of [
      'board_shared_fields',
      'board_shared_iterations',
      'board_shared_resources',
    ]) {
      await prisma.$executeRawUnsafe(
        `UPDATE "${table}" SET "board_id" = $1::uuid WHERE "board_id" = $2::uuid`,
        fixture.boardB.id,
        fixture.boardA.id,
      )
    }
    assert.deepEqual(
      await Promise.all([
        publicationRevision(prisma, fixture.boardA.id),
        publicationRevision(prisma, fixture.boardB.id),
      ]),
      [7, 4],
    )
    for (const table of [
      'board_shared_fields',
      'board_shared_iterations',
      'board_shared_resources',
    ]) {
      const [oldCount, newCount] = await Promise.all([
        prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
          `SELECT count(*) FROM "${table}" WHERE "board_id" = $1::uuid`,
          fixture.boardA.id,
        ),
        prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
          `SELECT count(*) FROM "${table}" WHERE "board_id" = $1::uuid`,
          fixture.boardB.id,
        ),
      ])
      assert.equal(oldCount[0]?.count, 0n)
      assert.equal(newCount[0]?.count, 1n)
    }
  }))
