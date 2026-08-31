import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import { visibleUserAlertWhere } from '../src/user-alerts.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

runDatabaseTest('workspace invitation alerts disappear when the recipient is deactivated', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const organization = await prisma.organization.create({
    data: { name: `invite visibility ${suffix}` },
  })
  const user = await prisma.user.create({
    data: {
      displayName: 'Invitee',
      email: `invite-visibility-${suffix}@example.com`,
    },
  })
  await prisma.organizationMember.create({
    data: { organizationId: organization.id, userId: user.id },
  })
  await prisma.userAlert.create({
    data: {
      eventKey: `workspace-invite:${suffix}`,
      kind: 'workspace_invitation',
      metadata: {
        inviteId: `invite-${suffix}`,
        organizationId: `uoa-org-${suffix}`,
        teamId: `uoa-team-${suffix}`,
        teamName: 'Engineering',
      },
      organizationId: organization.id,
      userId: user.id,
    },
  })
  t.after(async () => {
    await prisma.organization.delete({ where: { id: organization.id } }).catch(() => undefined)
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined)
    await prisma.$disconnect()
  })

  const where = visibleUserAlertWhere({
    organizationId: organization.id,
    userId: user.id,
  })
  assert.equal(await prisma.userAlert.count({ where }), 1)

  await prisma.organizationMember.update({
    where: {
      organizationId_userId: {
        organizationId: organization.id,
        userId: user.id,
      },
    },
    data: { deactivatedAt: new Date() },
  })
  assert.equal(await prisma.userAlert.count({ where }), 0)
})
