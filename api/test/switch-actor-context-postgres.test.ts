import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

/**
 * Who may switch the organisation / project / team a session acts in
 * (2026-09-05 review, F1-5 / S2-F4).
 *
 * `POST /api/auth/switch-context` mints a new access token whose `org`,
 * `proj`, `team` and `roles` claims every downstream guard reads, so the
 * membership rules below ARE the authorization. They used to live inline in
 * the route with no schema and no typed refusal; they live in
 * `switchActorContext` now, and this exercises them against real rows —
 * a Prisma fake would assert the lookups rather than the rows they find.
 */

const dbTest = process.env.DATABASE_URL ? test : test.skip

const { issueSessionToken } = await import('../src/auth/session.js')
const {
  ActorContextSwitchError,
  switchActorContext,
} = await import('../src/services/actor-context-switch.js')
const { createSessionIssuers } = await import('../src/services/session-issuers.js')

const AUTH_SECRET = 'switch-actor-context-test-secret'

type Fixture = {
  organizationId: string
  otherOrganizationId: string
  otherProjectId: string
  projectId: string
  teamId: string
  userId: string
}

const seed = async (
  prisma: PrismaClient,
  input: { orgMember: boolean; projectMember: boolean; teamMember: boolean; deactivated?: boolean },
): Promise<Fixture> => {
  const suffix = randomUUID()
  const organization = await prisma.organization.create({ data: { name: `switch-${suffix}` } })
  const otherOrganization = await prisma.organization.create({
    data: { name: `switch-other-${suffix}` },
  })
  const project = await prisma.project.create({
    data: { name: `switch-${suffix}`, organizationId: organization.id },
  })
  const otherProject = await prisma.project.create({
    data: { name: `switch-other-${suffix}`, organizationId: otherOrganization.id },
  })
  const team = await prisma.team.create({
    data: { name: `switch-${suffix}`, projectId: project.id },
  })
  const user = await prisma.user.create({
    data: { email: `switch-${suffix}@test.local`, displayName: 'Switcher' },
  })
  if (input.orgMember) {
    await prisma.organizationMember.create({
      data: {
        organizationId: organization.id,
        role: 'admin',
        userId: user.id,
        ...(input.deactivated ? { deactivatedAt: new Date() } : {}),
      },
    })
  }
  if (input.projectMember) {
    await prisma.projectMember.create({ data: { projectId: project.id, userId: user.id } })
  }
  if (input.teamMember) {
    await prisma.teamMember.create({ data: { teamId: team.id, userId: user.id } })
  }
  return {
    organizationId: organization.id,
    otherOrganizationId: otherOrganization.id,
    otherProjectId: otherProject.id,
    projectId: project.id,
    teamId: team.id,
    userId: user.id,
  }
}

const claimsFor = (
  fixture: Fixture,
  providerType: 'local-bootstrap' | 'uoa',
  uoaIdentity?: { organizationId: string; subject: string; teamId: string; tokenVersion: number },
) =>
  issueSessionToken(
    {
      org: fixture.organizationId,
      proj: fixture.projectId,
      providerId: providerType,
      providerType,
      roles: ['admin'],
      sub: fixture.userId,
      team: fixture.teamId,
      tv: 0,
      ...(uoaIdentity ? { uoaIdentity } : {}),
    },
    AUTH_SECRET,
    3600,
  ).claims

const withPrisma = async (run: (prisma: PrismaClient) => Promise<void>) => {
  const prisma = new PrismaClient()
  try {
    await run(prisma)
  } finally {
    await prisma.$disconnect()
  }
}

const switchTo = (
  prisma: PrismaClient,
  fixture: Fixture,
  overrides: Partial<{
    organizationId: string
    projectId: string
    providerType: 'local-bootstrap' | 'uoa'
    uoaIdentity: { organizationId: string; subject: string; teamId: string; tokenVersion: number }
  }> = {},
) => switchActorContext(prisma, {
  buildSessionForUser: createSessionIssuers({
    authSecret: AUTH_SECRET,
    defaultProviderType: 'local-bootstrap',
    prisma,
    tokenTtlSeconds: 3600,
  }).buildSessionForUser,
  currentClaims: claimsFor(
    fixture,
    overrides.providerType ?? 'local-bootstrap',
    overrides.uoaIdentity,
  ),
  organizationId: overrides.organizationId ?? fixture.organizationId,
  projectId: overrides.projectId ?? fixture.projectId,
  teamId: fixture.teamId,
  userId: fixture.userId,
})

dbTest('a full member switches and gets a token carrying the new context', async () => {
  await withPrisma(async (prisma) => {
    const fixture = await seed(prisma, { orgMember: true, projectMember: true, teamMember: true })
    const { session, user } = await switchTo(prisma, fixture)

    assert.equal(user.id, fixture.userId)
    assert.equal(session.claims.org, fixture.organizationId)
    assert.equal(session.claims.proj, fixture.projectId)
    assert.equal(session.claims.team, fixture.teamId)
    assert.deepEqual(session.claims.roles, ['admin'])
    // The claims come from the mint, not from re-verifying the fresh token
    // (FO3-8) — so they must be the ones the token actually carries.
    assert.equal(session.claims.sid, session.sessionId)
  })
})

dbTest('a non-member, a deactivated member and a foreign project are all refused', async () => {
  await withPrisma(async (prisma) => {
    const noOrg = await seed(prisma, { orgMember: false, projectMember: true, teamMember: true })
    await assert.rejects(
      switchTo(prisma, noOrg),
      (error: unknown) =>
        error instanceof ActorContextSwitchError && error.code === 'NOT_A_MEMBER',
    )

    const deactivated = await seed(prisma, {
      orgMember: true,
      projectMember: true,
      teamMember: true,
      deactivated: true,
    })
    await assert.rejects(
      switchTo(prisma, deactivated),
      (error: unknown) =>
        error instanceof ActorContextSwitchError && error.code === 'ACCOUNT_DEACTIVATED',
    )

    // A project in another organisation, even for somebody who is a member of
    // both the named org and that project's team, must not be reachable.
    const crossTenant = await seed(prisma, {
      orgMember: true,
      projectMember: true,
      teamMember: true,
    })
    await assert.rejects(
      switchTo(prisma, crossTenant, { projectId: crossTenant.otherProjectId }),
      (error: unknown) =>
        error instanceof ActorContextSwitchError && error.code === 'NOT_A_MEMBER',
    )
  })
})

dbTest('a member of the org but not the team is refused', async () => {
  await withPrisma(async (prisma) => {
    const fixture = await seed(prisma, { orgMember: true, projectMember: true, teamMember: false })
    await assert.rejects(
      switchTo(prisma, fixture),
      (error: unknown) =>
        error instanceof ActorContextSwitchError && error.code === 'NOT_A_MEMBER',
    )
  })
})

dbTest('a UOA session cannot open a team UnlikeOtherAI has never heard of', async () => {
  await withPrisma(async (prisma) => {
    const fixture = await seed(prisma, { orgMember: true, projectMember: true, teamMember: true })
    // The team carries no external ids at all. The local rows say yes and
    // UnlikeOtherAI still has to say yes too — and there is nothing upstream
    // for it to say yes about.
    //
    // This is deliberately NOT reported as a re-authentication problem. A
    // fresh sign-in mints a credential for some team UnlikeOtherAI does know,
    // which is still not this row, so the person would be sent through SSO to
    // land back on the same refusal indefinitely.
    await assert.rejects(
      switchTo(prisma, fixture, { providerType: 'uoa' }),
      (error: unknown) =>
        error instanceof ActorContextSwitchError
        && error.code === 'TEAM_NOT_UOA_LINKED',
    )
  })
})

dbTest('a UOA session cannot switch to a team its credential was not issued for', async () => {
  await withPrisma(async (prisma) => {
    const fixture = await seed(prisma, { orgMember: true, projectMember: true, teamMember: true })
    // This time the team IS in UnlikeOtherAI — it carries both external ids —
    // but the credential in hand was issued for a different team. That one a
    // fresh sign-in really can fix, so it keeps the re-authentication code.
    // `external_team_id` is unique, so the ids have to be per-run.
    const externalOrgId = `uoa-org-${randomUUID()}`
    const externalTeamId = `uoa-team-${randomUUID()}`
    await prisma.team.update({
      data: { externalOrgId, externalTeamId },
      where: { id: fixture.teamId },
    })

    await assert.rejects(
      switchTo(prisma, fixture, {
        providerType: 'uoa',
        uoaIdentity: {
          organizationId: externalOrgId,
          subject: 'uoa-subject',
          teamId: `uoa-team-somewhere-else-${randomUUID()}`,
          tokenVersion: 0,
        },
      }),
      (error: unknown) =>
        error instanceof ActorContextSwitchError
        && error.code === 'SSO_TEAM_REAUTH_REQUIRED',
    )
  })
})

dbTest('a UOA session opens the team its credential was issued for', async () => {
  await withPrisma(async (prisma) => {
    const fixture = await seed(prisma, { orgMember: true, projectMember: true, teamMember: true })
    const externalOrgId = `uoa-org-${randomUUID()}`
    const externalTeamId = `uoa-team-${randomUUID()}`
    await prisma.team.update({
      data: { externalOrgId, externalTeamId },
      where: { id: fixture.teamId },
    })

    // The positive case, so the two refusals above cannot both be satisfied by
    // a check that simply never lets a UOA session through.
    const { session } = await switchTo(prisma, fixture, {
      providerType: 'uoa',
      uoaIdentity: {
        organizationId: externalOrgId,
        subject: 'uoa-subject',
        teamId: externalTeamId,
        tokenVersion: 0,
      },
    })
    assert.equal(session.claims.team, fixture.teamId)
  })
})

dbTest('a non-UOA session cannot enter a UOA-bound team either', async () => {
  await withPrisma(async (prisma) => {
    const fixture = await seed(prisma, { orgMember: true, projectMember: true, teamMember: true })
    await prisma.team.update({
      data: {
        externalOrgId: `uoa-org-${randomUUID()}`,
        externalTeamId: `uoa-team-${randomUUID()}`,
      },
      where: { id: fixture.teamId },
    })

    // The guard keys on what the TARGET is, not on how the caller signed in.
    // Keyed on the caller's provider — as it was — a local-bootstrap session
    // walked past UnlikeOtherAI entirely and was issued a session for a team
    // UOA never vouched for, on the strength of local membership rows alone.
    await assert.rejects(
      switchTo(prisma, fixture, { providerType: 'local-bootstrap' }),
      (error: unknown) =>
        error instanceof ActorContextSwitchError
        && error.code === 'SSO_TEAM_REAUTH_REQUIRED',
    )
  })
})

dbTest('a local-mode team is still enterable with a local session', async () => {
  await withPrisma(async (prisma) => {
    // No external ids: an install with no identity provider must keep working,
    // which is what stops the rule above from being a lock-out.
    const fixture = await seed(prisma, { orgMember: true, projectMember: true, teamMember: true })
    const { session } = await switchTo(prisma, fixture, { providerType: 'local-bootstrap' })
    assert.equal(session.claims.team, fixture.teamId)
  })
})
