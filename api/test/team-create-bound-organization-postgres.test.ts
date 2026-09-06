import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import {
  createTeamForUser,
  UoaBoundOrganizationError,
} from '@nessie/team-admin'

/**
 * Two doors created a team and only one of them told UOA (2026-09-05 API
 * review, FO2-3). `POST /api/teams` and the `team_create` agent tool both call
 * `createTeamForUser`, which wrote a purely local `Team` — a level of the org
 * hierarchy UOA has never heard of, inside an organisation UOA owns, with a
 * `TeamMember` row nothing upstream authorized. It now refuses there and names
 * `POST /api/teams/teams`, and still writes in an unbound organisation.
 *
 * Database-backed because the refusal is decided by a column on a row the
 * function reads for itself.
 */

const dbTest = process.env.DATABASE_URL ? test : test.skip

type Seed = { organizationId: string; projectId: string; userId: string }

const seed = async (
  prisma: PrismaClient,
  externalOrgId: string | null,
): Promise<Seed> => {
  const suffix = randomUUID()
  const organization = await prisma.organization.create({
    data: {
      name: `team-create-${suffix}`,
      ...(externalOrgId ? { externalOrgId } : {}),
    },
  })
  const project = await prisma.project.create({
    data: { name: `team-create-${suffix}`, organizationId: organization.id },
  })
  const user = await prisma.user.create({
    data: { email: `team-create-${suffix}@test.local`, displayName: 'Creator' },
  })
  return { organizationId: organization.id, projectId: project.id, userId: user.id }
}

const withSeed = async (
  externalOrgId: string | null,
  run: (prisma: PrismaClient, seeded: Seed) => Promise<void>,
): Promise<void> => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma, externalOrgId)
  try {
    await run(prisma, seeded)
  } finally {
    await prisma.user.deleteMany({ where: { id: seeded.userId } })
    await prisma.organization.deleteMany({ where: { id: seeded.organizationId } })
    await prisma.$disconnect()
  }
}

dbTest('a UOA-bound organisation refuses the local team door', async () => {
  await withSeed(`uoa-org-team-create-${randomUUID()}`, async (prisma, seeded) => {
    await assert.rejects(
      createTeamForUser(prisma, {
        name: 'Local team',
        organizationId: seeded.organizationId,
        projectId: seeded.projectId,
        userId: seeded.userId,
      }),
      (error: unknown) => {
        assert.ok(error instanceof UoaBoundOrganizationError)
        assert.equal(error.relayRoute, 'POST /api/teams/teams')
        return true
      },
    )
    assert.equal(
      await prisma.team.count({ where: { projectId: seeded.projectId } }),
      0,
      'nothing was written before the refusal',
    )
  })
})

dbTest('an unbound organisation still creates the team locally', async () => {
  await withSeed(null, async (prisma, seeded) => {
    const team = await createTeamForUser(prisma, {
      name: 'Local team',
      organizationId: seeded.organizationId,
      projectId: seeded.projectId,
      userId: seeded.userId,
    })

    assert.ok(team)
    assert.equal(team.name, 'Local team')
    assert.equal(
      await prisma.teamMember.count({
        where: { teamId: team.id, role: 'owner', userId: seeded.userId },
      }),
      1,
    )
  })
})
