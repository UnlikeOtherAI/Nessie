import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import { resolveUoaWorkspaceContext } from '../src/services/workspace-context.js'

// This suite has the same global-scope dependency as its sibling
// (`workspace-context-postgres-race.test.ts`), but it cannot be anchored the
// same way: its subject IS the first-ever login, so it asserts that the
// database holds no organization and no user at all, and it leaves behind the
// bootstrap records it creates. It therefore needs a database of its own, and
// stays opt-in rather than flaking against the shared one — an unset
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
  'concurrent first-ever UOA callbacks atomically bootstrap one shared organization',
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
    assert.equal(await prisma.organization.count(), 1)
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
  },
)
