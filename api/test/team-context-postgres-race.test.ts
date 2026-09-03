import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import { resolveUoaTeamContext } from '../src/services/team-context.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

// A UOA login resolves its Organization 1:1 by `Organization.externalOrgId`
// under a per-external-org advisory lock — never the old "globally oldest
// organization" lookup, whose instability under concurrent suites AGENTS.md
// documents (each suite had to anchor an epoch-dated org). With per-suite
// unique external org ids the resolution is deterministic by construction, so
// these suites no longer anchor anything: they assert the login landed in the
// Organization carrying exactly their external org id.

const deleteContext = async (
  prisma: PrismaClient,
  input: { emails: string[]; externalOrgId: string },
): Promise<void> => {
  await prisma.user.deleteMany({ where: { email: { in: input.emails } } })
  // Organization delete cascades projects → teams → channels, members, and
  // policy rules.
  await prisma.organization.deleteMany({
    where: { externalOrgId: input.externalOrgId },
  })
}

runDatabaseTest('concurrent first UOA logins converge on one exact organization and team', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const externalOrgId = `uoa-org-${suffix}`
  const externalTeamId = `uoa-team-${suffix}`
  const emails = [
    `team-a-${suffix}@example.com`,
    `team-b-${suffix}@example.com`,
  ]
  t.after(async () => {
    await deleteContext(prisma, { emails, externalOrgId })
    await prisma.$disconnect()
  })
  const team = {
    activeOrgId: externalOrgId,
    activeTeamId: externalTeamId,
    teamIds: [externalTeamId],
    teamRoles: { [externalTeamId]: 'member' },
  }

  const [left, right] = await Promise.all(emails.map((email) =>
    resolveUoaTeamContext(prisma, {
      displayName: email.split('@')[0]!,
      email,
      team,
    })))

  assert.ok(left && right)
  // Exactly one Organization materialized for the UOA organisation, and both
  // logins landed in it.
  assert.equal(left.organizationId, right.organizationId)
  const organization = await prisma.organization.findUnique({
    where: { externalOrgId },
    select: { id: true, name: true },
  })
  assert.equal(organization?.id, left.organizationId)
  // Placeholder name until the team directory supplies UOA's orgName.
  assert.equal(organization?.name, `Organisation ${externalOrgId.slice(0, 8)}`)
  assert.equal(left.teamId, right.teamId)
  assert.equal(left.projectId, right.projectId)
  assert.equal(await prisma.team.count({
    where: {
      externalOrgId,
      externalTeamId: externalTeamId,
    },
  }), 1)
  assert.equal(await prisma.teamMember.count({
    where: { teamId: left.teamId },
  }), 2)
  // The fresh org got its default policy rules (deny-by-default engine).
  assert.ok(await prisma.policyRule.count({
    where: { organizationId: left.organizationId },
  }) > 0)
})

runDatabaseTest('concurrent callbacks for one UOA principal create one local user', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const externalOrgId = `uoa-org-principal-${suffix}`
  const externalTeamId = `uoa-team-principal-${suffix}`
  const email = `team-principal-${suffix}@example.com`
  t.after(async () => {
    await deleteContext(prisma, { emails: [email], externalOrgId })
    await prisma.$disconnect()
  })
  const team = {
    activeOrgId: externalOrgId,
    activeTeamId: externalTeamId,
    teamIds: [externalTeamId],
    teamRoles: { [externalTeamId]: 'member' },
  }

  // The same UOA principal (one stable subject) completing the callback on two
  // devices at once — the production shape of this race, serialized by the
  // subject advisory lock.
  const uoaSub = `uoa-sub-principal-${suffix}`
  const [left, right] = await Promise.all([
    resolveUoaTeamContext(prisma, {
      displayName: 'Same Principal',
      email,
      uoaSub,
      team,
    }),
    resolveUoaTeamContext(prisma, {
      displayName: 'Same Principal',
      email,
      uoaSub,
      team,
    }),
  ])

  assert.ok(left && right)
  assert.equal(left.organizationId, right.organizationId)
  assert.equal(
    (await prisma.organization.findUnique({
      where: { externalOrgId },
      select: { id: true },
    }))?.id,
    left.organizationId,
  )
  assert.equal(left.userId, right.userId)
  assert.equal(left.teamId, right.teamId)
  assert.equal(await prisma.user.count({ where: { email } }), 1)
  const principal = await prisma.user.findUnique({
    where: { email },
    select: { uoaSub: true },
  })
  assert.equal(principal?.uoaSub, uoaSub)
  assert.equal(await prisma.teamMember.count({
    where: { teamId: left.teamId, userId: left.userId },
  }), 1)
})
