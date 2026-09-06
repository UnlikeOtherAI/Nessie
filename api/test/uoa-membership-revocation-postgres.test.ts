import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import {
  buildUoaAssertedTeams,
  reconcileUoaMembershipProjection,
} from '../src/services/uoa-roles.js'

/**
 * The revocation half of the membership projection (2026-09-05 API review,
 * FO2-1). `projectUoaRoles` re-applies the roles UOA still claims; nothing
 * removed a membership UOA had withdrawn, so the local rows — which
 * `authenticateRequest` reads as the live authorization — were append-only.
 *
 * Database-backed on purpose: the rule is expressed as a relational query
 * (bound team, inside a bound organisation, held by this user) and a Prisma
 * fake would assert the query I wrote rather than the rows it selects
 * (docs/standards/testing.md, "Prisma fakes").
 *
 * Seed-scoped: every row is created under ids unique to this run and removed
 * afterwards, because these suites share one database and run concurrently.
 */

const dbTest = process.env.DATABASE_URL ? test : test.skip

type Seed = {
  boundOrgId: string
  externalOrgId: string
  localTeamId: string
  teamAId: string
  teamBId: string
  unboundOrgId: string
  unboundTeamId: string
  userId: string
}

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const suffix = randomUUID()
  const user = await prisma.user.create({
    data: { email: `revocation-${suffix}@test.local`, displayName: 'Revocation' },
  })
  const externalOrgId = `uoa-org-${suffix}`
  const boundOrg = await prisma.organization.create({
    data: { name: `bound-${suffix}`, externalOrgId },
  })
  const unboundOrg = await prisma.organization.create({
    data: { name: `unbound-${suffix}` },
  })

  // Two UOA teams in the bound organisation, each with its own fabricated
  // project (`createTeamEnvironment`'s shape), plus a purely local team beside
  // them and a team in the unbound organisation.
  const projectA = await prisma.project.create({
    data: { name: `a-${suffix}`, organizationId: boundOrg.id },
  })
  const projectB = await prisma.project.create({
    data: { name: `b-${suffix}`, organizationId: boundOrg.id },
  })
  const unboundProject = await prisma.project.create({
    data: { name: `u-${suffix}`, organizationId: unboundOrg.id },
  })
  const teamA = await prisma.team.create({
    data: {
      name: `team-a-${suffix}`,
      projectId: projectA.id,
      externalOrgId,
      externalTeamId: `uoa-team-a-${suffix}`,
    },
  })
  const teamB = await prisma.team.create({
    data: {
      name: `team-b-${suffix}`,
      projectId: projectB.id,
      externalOrgId,
      externalTeamId: `uoa-team-b-${suffix}`,
    },
  })
  const localTeam = await prisma.team.create({
    data: { name: `local-${suffix}`, projectId: projectA.id },
  })
  const unboundTeam = await prisma.team.create({
    data: { name: `unbound-team-${suffix}`, projectId: unboundProject.id },
  })

  for (const organizationId of [boundOrg.id, unboundOrg.id]) {
    await prisma.organizationMember.create({
      data: { organizationId, role: 'member', userId: user.id },
    })
  }
  for (const projectId of [projectA.id, projectB.id, unboundProject.id]) {
    await prisma.projectMember.create({
      data: { projectId, role: 'member', userId: user.id },
    })
  }
  for (const teamId of [teamA.id, teamB.id, localTeam.id, unboundTeam.id]) {
    await prisma.teamMember.create({
      data: { teamId, role: 'member', userId: user.id },
    })
  }

  return {
    boundOrgId: boundOrg.id,
    externalOrgId,
    localTeamId: localTeam.id,
    teamAId: teamA.id,
    teamBId: teamB.id,
    unboundOrgId: unboundOrg.id,
    unboundTeamId: unboundTeam.id,
    userId: user.id,
  }
}

const cleanup = async (prisma: PrismaClient, seeded: Seed): Promise<void> => {
  await prisma.user.deleteMany({ where: { id: seeded.userId } })
  await prisma.organization.deleteMany({
    where: { id: { in: [seeded.boundOrgId, seeded.unboundOrgId] } },
  })
}

const externalTeamIdOf = async (
  prisma: PrismaClient,
  teamId: string,
): Promise<string> => {
  const team = await prisma.team.findUniqueOrThrow({
    where: { id: teamId },
    select: { externalTeamId: true },
  })
  assert.ok(team.externalTeamId)
  return team.externalTeamId
}

const heldTeamIds = async (
  prisma: PrismaClient,
  userId: string,
): Promise<string[]> => (await prisma.teamMember.findMany({
  where: { userId },
  select: { teamId: true },
})).map((row) => row.teamId).sort()

const withSeed = async (run: (
  prisma: PrismaClient,
  seeded: Seed,
) => Promise<void>): Promise<void> => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    await run(prisma, seeded)
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
}

dbTest('a bound team UOA no longer asserts loses its membership row', async () => {
  await withSeed(async (prisma, seeded) => {
    const asserted = buildUoaAssertedTeams({
      activeExternalOrgId: seeded.externalOrgId,
      claimedTeamIds: [await externalTeamIdOf(prisma, seeded.teamAId)],
      entries: [],
    })

    const result = await prisma.$transaction((tx) =>
      reconcileUoaMembershipProjection(tx, { asserted, userId: seeded.userId }))

    assert.deepEqual(result.revokedTeamIds, [seeded.teamBId])
    assert.deepEqual(
      await heldTeamIds(prisma, seeded.userId),
      [seeded.teamAId, seeded.localTeamId, seeded.unboundTeamId].sort(),
      'the asserted team, the local team and the unbound organisation are untouched',
    )
    // The project row is the team row's other half, so it follows it out —
    // and the still-held team's project stays.
    const projects = await prisma.projectMember.findMany({
      where: { userId: seeded.userId },
      select: { project: { select: { organizationId: true } } },
    })
    assert.equal(projects.length, 2)
    assert.deepEqual(result.deactivatedOrganizationIds, [])
    const membership = await prisma.organizationMember.findFirstOrThrow({
      where: { organizationId: seeded.boundOrgId, userId: seeded.userId },
    })
    assert.equal(membership.deactivatedAt, null)
  })
})

dbTest('an organisation UOA no longer places the person in is deactivated', async () => {
  await withSeed(async (prisma, seeded) => {
    // The local team keeps the membership alive while it exists: the question
    // is whether UOA still places this person in the organisation at all.
    await prisma.teamMember.deleteMany({
      where: { teamId: seeded.localTeamId, userId: seeded.userId },
    })

    const result = await prisma.$transaction((tx) =>
      reconcileUoaMembershipProjection(tx, {
        asserted: buildUoaAssertedTeams({ entries: [] }),
        userId: seeded.userId,
      }))

    assert.deepEqual(result.revokedTeamIds.sort(), [seeded.teamAId, seeded.teamBId].sort())
    assert.deepEqual(result.deactivatedOrganizationIds, [seeded.boundOrgId])
    const bound = await prisma.organizationMember.findFirstOrThrow({
      where: { organizationId: seeded.boundOrgId, userId: seeded.userId },
    })
    assert.notEqual(bound.deactivatedAt, null, 'the row is kept, not deleted')
    const unbound = await prisma.organizationMember.findFirstOrThrow({
      where: { organizationId: seeded.unboundOrgId, userId: seeded.userId },
    })
    assert.equal(
      unbound.deactivatedAt,
      null,
      'an unbound organisation has no upstream authority to be reconciled against',
    )
  })
})

dbTest('a directory that still asserts every team changes nothing', async () => {
  await withSeed(async (prisma, seeded) => {
    const before = await heldTeamIds(prisma, seeded.userId)
    const asserted = buildUoaAssertedTeams({
      entries: [
        {
          organizationId: seeded.externalOrgId,
          teamId: await externalTeamIdOf(prisma, seeded.teamAId),
        },
        {
          organizationId: seeded.externalOrgId,
          teamId: await externalTeamIdOf(prisma, seeded.teamBId),
        },
      ],
    })

    const result = await prisma.$transaction((tx) =>
      reconcileUoaMembershipProjection(tx, { asserted, userId: seeded.userId }))

    assert.deepEqual(result.revokedTeamIds, [])
    assert.deepEqual(result.deactivatedOrganizationIds, [])
    assert.deepEqual(await heldTeamIds(prisma, seeded.userId), before)
  })
})
