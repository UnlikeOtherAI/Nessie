import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import { resolveUoaWorkspaceContext } from '../src/services/workspace-context.js'

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
