import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import { CallLinkError, createCallLinkForTeamUser } from '../src/index.js'

/**
 * Whose tenant mints the link, and who is allowed to ask.
 *
 * `Team` carries no `organizationId` — tenancy runs through its project — so
 * `createCallLinkForTeamUser` used to read `team.project.organizationId` from
 * the caller-supplied `teamId` and then act in THAT organisation, including as
 * the organisation it loaded the user's Google credential under. Both refusals
 * below are joins across `team → project → organization` and `team_members`;
 * a Prisma fake answering `findUnique` with a fixed row proves neither, which
 * is exactly how the bug survived the existing unit tests.
 */

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

const JITSI = { NESSIE_JITSI_DOMAIN: 'jitsi.example.test' }

type Seed = {
  homeOrganizationId: string
  homeTeamId: string
  otherOrganizationId: string
  otherTeamId: string
  outsiderId: string
  userId: string
}

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const suffix = randomUUID()
  const user = await prisma.user.create({
    data: { displayName: 'Person', email: `call-link-${suffix}@example.test` },
  })
  const outsider = await prisma.user.create({
    data: { displayName: 'Outsider', email: `call-link-out-${suffix}@example.test` },
  })

  const make = async (label: string) => {
    const organization = await prisma.organization.create({
      data: { name: `call-link-${label}-${suffix}` },
    })
    const project = await prisma.project.create({
      data: { name: label, organizationId: organization.id },
    })
    const team = await prisma.team.create({
      data: { name: label, projectId: project.id, callProvider: 'jitsi' },
    })
    return { organizationId: organization.id, teamId: team.id }
  }

  const home = await make('home')
  const other = await make('other')

  // The person is an active member of BOTH organisations and of both teams:
  // every refusal below is therefore about which tenant the caller asserted,
  // not about the person lacking access somewhere.
  await prisma.organizationMember.createMany({
    data: [
      { organizationId: home.organizationId, role: 'member', userId: user.id },
      { organizationId: other.organizationId, role: 'member', userId: user.id },
      { organizationId: home.organizationId, role: 'member', userId: outsider.id },
    ],
  })
  await prisma.teamMember.createMany({
    data: [
      { teamId: home.teamId, userId: user.id },
      { teamId: other.teamId, userId: user.id },
    ],
  })

  return {
    homeOrganizationId: home.organizationId,
    homeTeamId: home.teamId,
    otherOrganizationId: other.organizationId,
    otherTeamId: other.teamId,
    outsiderId: outsider.id,
    userId: user.id,
  }
}

const cleanup = async (prisma: PrismaClient, sown: Seed): Promise<void> => {
  await prisma.organization.deleteMany({
    where: { id: { in: [sown.homeOrganizationId, sown.otherOrganizationId] } },
  })
  await prisma.user.deleteMany({
    where: { id: { in: [sown.userId, sown.outsiderId] } },
  })
}

const withSeed = async (
  body: (prisma: PrismaClient, sown: Seed) => Promise<void>,
): Promise<void> => {
  const prisma = new PrismaClient()
  const sown = await seed(prisma)
  try {
    await body(prisma, sown)
  } finally {
    await cleanup(prisma, sown)
    await prisma.$disconnect()
  }
}

const rejectsTeamNotFound = (promise: Promise<unknown>) =>
  assert.rejects(
    promise,
    (error: unknown) => error instanceof CallLinkError
      && error.code === 'TEAM_NOT_FOUND',
  )

runDatabaseTest('a team in the caller\'s own organisation mints a link', async () => {
  await withSeed(async (prisma, sown) => {
    const result = await createCallLinkForTeamUser(
      prisma,
      {
        entitlement: 'team_member',
        organizationId: sown.homeOrganizationId,
        teamId: sown.homeTeamId,
        userId: sown.userId,
      },
      { env: JITSI, randomBytes: () => new Uint8Array(16) },
    )
    assert.equal(result.provider, 'jitsi')
    assert.match(result.meetingUri, /^https:\/\/jitsi\.example\.test\/nessie-/)
  })
})

runDatabaseTest('a team id from the caller\'s OTHER organisation is refused', async () => {
  await withSeed(async (prisma, sown) => {
    // The person is an active member of both organisations and of both teams.
    // Before the fix the operation simply adopted the named team's tenant, so
    // this succeeded and minted the link under the wrong organisation.
    await rejectsTeamNotFound(createCallLinkForTeamUser(
      prisma,
      {
        entitlement: 'team_member',
        organizationId: sown.homeOrganizationId,
        teamId: sown.otherTeamId,
        userId: sown.userId,
      },
      { env: JITSI, randomBytes: () => new Uint8Array(16) },
    ))
  })
})

runDatabaseTest('org membership alone does not mint a link for a team you are not in', async () => {
  await withSeed(async (prisma, sown) => {
    // `docs/standards/team-model.md` makes the team the unit people are
    // members of; the outsider is in the organisation and in no team.
    await rejectsTeamNotFound(createCallLinkForTeamUser(
      prisma,
      {
        entitlement: 'team_member',
        organizationId: sown.homeOrganizationId,
        teamId: sown.homeTeamId,
        userId: sown.outsiderId,
      },
      { env: JITSI, randomBytes: () => new Uint8Array(16) },
    ))
  })
})

runDatabaseTest('a channel-derived call still mints for a non-team channel member', async () => {
  await withSeed(async (prisma, sown) => {
    // `startCallForUser` derives the team from a channel and has already
    // required membership of that channel. A public channel's members are not
    // necessarily in its team, so this arm must NOT re-check `TeamMember` —
    // otherwise calls the call route allows would start failing.
    const result = await createCallLinkForTeamUser(
      prisma,
      {
        entitlement: 'channel_member',
        organizationId: sown.homeOrganizationId,
        teamId: sown.homeTeamId,
        userId: sown.outsiderId,
      },
      { env: JITSI, randomBytes: () => new Uint8Array(16) },
    )
    assert.equal(result.provider, 'jitsi')
  })
})

runDatabaseTest('the channel-derived arm is still bounded by the organisation', async () => {
  await withSeed(async (prisma, sown) => {
    await rejectsTeamNotFound(createCallLinkForTeamUser(
      prisma,
      {
        entitlement: 'channel_member',
        organizationId: sown.homeOrganizationId,
        teamId: sown.otherTeamId,
        userId: sown.userId,
      },
      { env: JITSI, randomBytes: () => new Uint8Array(16) },
    ))
  })
})
