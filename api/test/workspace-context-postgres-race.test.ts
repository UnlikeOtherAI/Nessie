import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import { resolveUoaWorkspaceContext } from '../src/services/workspace-context.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

runDatabaseTest('concurrent first UOA logins converge on one exact workspace', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const externalOrgId = `uoa-org-${suffix}`
  const externalTeamId = `uoa-team-${suffix}`
  const organization = await prisma.organization.create({
    data: { name: `Workspace race ${suffix}` },
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
    data: { name: `Principal race ${suffix}` },
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

  const [left, right] = await Promise.all([
    resolveUoaWorkspaceContext(prisma, {
      displayName: 'Same Principal',
      email,
      workspace,
    }),
    resolveUoaWorkspaceContext(prisma, {
      displayName: 'Same Principal',
      email,
      workspace,
    }),
  ])

  assert.ok(left && right)
  workspaceProjectId = left.projectId
  assert.equal(left.userId, right.userId)
  assert.equal(left.teamId, right.teamId)
  assert.equal(await prisma.user.count({ where: { email } }), 1)
  assert.equal(await prisma.teamMember.count({
    where: { teamId: left.teamId, userId: left.userId },
  }), 1)
})
