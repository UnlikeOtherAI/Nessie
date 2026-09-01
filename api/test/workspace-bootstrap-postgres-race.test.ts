import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import { resolveUoaWorkspaceContext } from '../src/services/workspace-context.js'

// The first-ever logins into a fresh instance. A UOA login now materializes
// its per-UOA-org Organization directly (1:1 by `Organization.externalOrgId`)
// — the legacy shared-org bootstrap seed runs only for logins with no
// workspace claim. This suite's subject IS the first-ever login, so it asserts
// the database holds no organization and no user at all, and it leaves behind
// the records it creates. It therefore needs a database of its own, and stays
// opt-in rather than flaking against the shared one — an unset
// NESSIE_TEST_PRISTINE_DATABASE skips it, which is why it does not run in CI's
// shared-database test job.
//
// Run it against a dedicated, freshly migrated database:
//   DATABASE_URL=<pristine db> NESSIE_TEST_PRISTINE_DATABASE=1 \
//     node --test --import tsx test/workspace-bootstrap-postgres-race.test.ts
const runPristineDatabaseTest =
  process.env.DATABASE_URL && process.env.NESSIE_TEST_PRISTINE_DATABASE === '1'
    ? test
    : test.skip

runPristineDatabaseTest(
  'concurrent first-ever UOA callbacks atomically materialize one per-UOA-org organization',
  async (t) => {
    const prisma = new PrismaClient()
    t.after(() => prisma.$disconnect())

    assert.equal(await prisma.organization.count(), 0)
    assert.equal(await prisma.user.count(), 0)

    const suffix = randomUUID()
    const externalOrgId = `uoa-org-bootstrap-${suffix}`
    const externalTeamId = `uoa-team-bootstrap-${suffix}`
    const workspace = {
      activeOrgId: externalOrgId,
      activeTeamId: externalTeamId,
      teamIds: [externalTeamId],
      teamRoles: { [externalTeamId]: 'owner' },
    }
    const emails = [
      `bootstrap-a-${suffix}@example.com`,
      `bootstrap-b-${suffix}@example.com`,
    ]

    const [left, right] = await Promise.all(emails.map((email) =>
      resolveUoaWorkspaceContext(prisma, {
        displayName: email.split('@')[0]!,
        email,
        workspace,
      })))

    assert.ok(left && right)
    assert.equal(left.organizationId, right.organizationId)
    assert.equal(left.projectId, right.projectId)
    assert.equal(left.teamId, right.teamId)
    // Exactly ONE organization exists — the per-UOA-org one; the legacy
    // shared-org bootstrap seed never ran for these workspace-claim logins.
    assert.equal(await prisma.organization.count(), 1)
    const organization = await prisma.organization.findUnique({
      where: { externalOrgId },
      select: { id: true },
    })
    assert.equal(organization?.id, left.organizationId)
    assert.equal(await prisma.user.count({ where: { email: { in: emails } } }), 2)
    assert.equal(await prisma.team.count({
      where: {
        externalOrgId,
        externalWorkspaceId: externalTeamId,
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
