import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import { resolveUoaWorkspaceContext } from '../src/services/workspace-context.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

// `resolveUoaWorkspaceContext` resolves "the shared organization" with a
// GLOBAL lookup — the oldest `Organization` row in the database, with no
// caller scope. That is correct in production, where a self-hosted instance
// has exactly one organization and never deletes it, but it is not stable in a
// test database: `node --test` runs a package's files in parallel, and several
// api suites create and delete organizations while this one runs. Left to
// chance the login under test resolves a *foreign*, ephemeral organization,
// and dies with a foreign-key violation the moment that suite's cleanup
// deletes it mid-call — `projects_organization_id_fkey` while the workspace
// project is created, `organization_members_organization_id_fkey` a moment
// later while the membership is upserted.
//
// So these suites anchor their own organization behind every row a
// concurrently running suite can create. No `@default(now())` row can be older
// than the epoch, which makes the shared-organization lookup resolve the row
// this suite owns — and only this suite deletes. The assertions below state
// that precondition instead of leaving it implicit, so a leaked anchor from a
// killed run fails loudly rather than quietly retargeting the test.
//
// The two tests use distinct anchors because `findFirst` breaks a `created_at`
// tie arbitrarily; they run sequentially today, but a tie must not become the
// thing holding this together.
const WORKSPACE_RACE_ANCHOR = new Date('1970-01-01T00:00:00.000Z')
const PRINCIPAL_RACE_ANCHOR = new Date('1970-01-01T00:00:00.001Z')

const FOREIGN_ORGANIZATION_RESOLVED =
  'the shared-organization lookup resolved an organization this suite does not own; '
  + 'point DATABASE_URL at a freshly migrated database'

runDatabaseTest('concurrent first UOA logins converge on one exact workspace', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const externalOrgId = `uoa-org-${suffix}`
  const externalTeamId = `uoa-team-${suffix}`
  const organization = await prisma.organization.create({
    data: { name: `Workspace race ${suffix}`, createdAt: WORKSPACE_RACE_ANCHOR },
  })
  const emails = [
    `workspace-a-${suffix}@example.com`,
    `workspace-b-${suffix}@example.com`,
  ]
  let workspaceProjectId: string | null = null
  t.after(async () => {
    await prisma.user.deleteMany({ where: { email: { in: emails } } })
    if (workspaceProjectId) {
      await prisma.project.delete({
        where: { id: workspaceProjectId },
      }).catch(() => undefined)
    }
    await prisma.organization.delete({
      where: { id: organization.id },
    }).catch(() => undefined)
    await prisma.$disconnect()
  })
  const workspace = {
    activeOrgId: externalOrgId,
    activeTeamId: externalTeamId,
    teamIds: [externalTeamId],
    teamRoles: { [externalTeamId]: 'member' },
  }

  const [left, right] = await Promise.all(emails.map((email) =>
    resolveUoaWorkspaceContext(prisma, {
      displayName: email.split('@')[0]!,
      email,
      workspace,
    })))

  assert.ok(left && right)
  workspaceProjectId = left.projectId
  assert.equal(left.organizationId, organization.id, FOREIGN_ORGANIZATION_RESOLVED)
  assert.equal(right.organizationId, organization.id, FOREIGN_ORGANIZATION_RESOLVED)
  assert.equal(left.teamId, right.teamId)
  assert.equal(left.projectId, right.projectId)
  assert.equal(await prisma.team.count({
    where: {
      externalOrgId,
      externalWorkspaceId: externalTeamId,
    },
  }), 1)
  assert.equal(await prisma.teamMember.count({
    where: { teamId: left.teamId },
  }), 2)
})

runDatabaseTest('concurrent callbacks for one UOA principal create one local user', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const externalOrgId = `uoa-org-principal-${suffix}`
  const externalTeamId = `uoa-team-principal-${suffix}`
  const email = `workspace-principal-${suffix}@example.com`
  const organization = await prisma.organization.create({
    data: { name: `Principal race ${suffix}`, createdAt: PRINCIPAL_RACE_ANCHOR },
  })
  let workspaceProjectId: string | null = null
  t.after(async () => {
    await prisma.user.deleteMany({ where: { email } })
    if (workspaceProjectId) {
      await prisma.project.delete({
        where: { id: workspaceProjectId },
      }).catch(() => undefined)
    }
    await prisma.organization.delete({
      where: { id: organization.id },
    }).catch(() => undefined)
    await prisma.$disconnect()
  })
  const workspace = {
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
    resolveUoaWorkspaceContext(prisma, {
      displayName: 'Same Principal',
      email,
      uoaSub,
      workspace,
    }),
    resolveUoaWorkspaceContext(prisma, {
      displayName: 'Same Principal',
      email,
      uoaSub,
      workspace,
    }),
  ])

  assert.ok(left && right)
  workspaceProjectId = left.projectId
  assert.equal(left.organizationId, organization.id, FOREIGN_ORGANIZATION_RESOLVED)
  assert.equal(right.organizationId, organization.id, FOREIGN_ORGANIZATION_RESOLVED)
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
