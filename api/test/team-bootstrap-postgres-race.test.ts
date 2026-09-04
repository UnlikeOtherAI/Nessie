import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import { resolveUoaTeamContext } from '../src/services/team-context.js'

// Concurrent first-time logins for one UOA org. A UOA login materializes its
// per-UOA-org Organization directly (1:1 by `Organization.externalOrgId`) —
// the legacy shared-org bootstrap seed runs only for logins with no team
// claim. Every assertion and cleanup below is scoped to this suite's unique
// UOA org, team, and people, so it remains safe in the shared test database.
//
const dbTest = process.env.DATABASE_URL ? test : test.skip

dbTest(
  'concurrent UOA callbacks atomically materialize one organization for their UOA org',
  async (t) => {
    const prisma = new PrismaClient()
    t.after(() => prisma.$disconnect())

    const suffix = randomUUID()
    const externalOrgId = `uoa-org-bootstrap-${suffix}`
    const externalTeamId = `uoa-team-bootstrap-${suffix}`
    const team = {
      activeOrgId: externalOrgId,
      activeTeamId: externalTeamId,
      teamIds: [externalTeamId],
      teamRoles: { [externalTeamId]: 'owner' },
    }
    const emails = [
      `bootstrap-a-${suffix}@example.com`,
      `bootstrap-b-${suffix}@example.com`,
    ]

    t.after(async () => {
      await prisma.organization.deleteMany({ where: { externalOrgId } })
      await prisma.user.deleteMany({ where: { email: { in: emails } } })
    })

    assert.equal(await prisma.organization.count({ where: { externalOrgId } }), 0)
    assert.equal(await prisma.team.count({
      where: { externalOrgId, externalTeamId },
    }), 0)
    assert.equal(await prisma.user.count({ where: { email: { in: emails } } }), 0)

    const [left, right] = await Promise.all(emails.map((email) =>
      resolveUoaTeamContext(prisma, {
        displayName: email.split('@')[0]!,
        email,
        team,
      })))

    assert.ok(left && right)
    assert.equal(left.organizationId, right.organizationId)
    assert.equal(left.projectId, right.projectId)
    assert.equal(left.teamId, right.teamId)
    // Exactly one organization exists for this UOA org; the legacy shared-org
    // bootstrap seed never ran for these team-claim logins.
    assert.equal(await prisma.organization.count({ where: { externalOrgId } }), 1)
    const organization = await prisma.organization.findUnique({
      where: { externalOrgId },
      select: { id: true },
    })
    assert.equal(organization?.id, left.organizationId)
    assert.equal(await prisma.user.count({ where: { email: { in: emails } } }), 2)
    assert.equal(await prisma.team.count({
      where: {
        externalOrgId,
        externalTeamId: externalTeamId,
      },
    }), 1)
    assert.equal(await prisma.teamMember.count({
      where: { teamId: left.teamId },
    }), 2)
    assert.ok(await prisma.policyRule.count({
      where: { organizationId: left.organizationId },
    }) > 0)
    // With no org_role claim, exactly ONE of the two racers became the org's
    // first materializer and owns it; the other joined as member.
    const roles = (await prisma.organizationMember.findMany({
      where: { organizationId: left.organizationId },
      select: { role: true },
    })).map((member) => member.role).sort()
    assert.deepEqual(roles, ['member', 'owner'])
  },
)
