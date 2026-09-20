import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import { visibleUserAlertWhere } from '../src/user-alerts.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

runDatabaseTest('team invitation alerts disappear when the recipient is deactivated', async (t) => {
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
      eventKey: `team-invite:${suffix}`,
      kind: 'team_invitation',
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

runDatabaseTest('local inference health remains private to the current host custodian', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const organization = await prisma.organization.create({ data: { name: `local alert visibility ${suffix}` } })
  const [custodian, other] = await Promise.all([
    prisma.user.create({ data: { displayName: 'Custodian', email: `local-alert-owner-${suffix}@example.com` } }),
    prisma.user.create({ data: { displayName: 'Other', email: `local-alert-other-${suffix}@example.com` } }),
  ])
  await prisma.organizationMember.createMany({ data: [
    { organizationId: organization.id, userId: custodian.id },
    { organizationId: organization.id, userId: other.id },
  ] })
  const host = await prisma.localInferenceHost.create({
    data: {
      custodianUserId: custodian.id,
      displayLabel: 'Private executor',
      executorId: randomUUID(),
      healthReason: 'ollama_unreachable',
      organizationId: organization.id,
      transport: 'executor',
    },
  })
  await prisma.userAlert.create({
    data: {
      eventKey: `local-inference-health:${host.id}:1`,
      kind: 'local_inference_health',
      localInferenceHostId: host.id,
      organizationId: organization.id,
      userId: custodian.id,
    },
  })
  t.after(async () => {
    await prisma.organization.delete({ where: { id: organization.id } }).catch(() => undefined)
    await prisma.user.deleteMany({ where: { id: { in: [custodian.id, other.id] } } }).catch(() => undefined)
    await prisma.$disconnect()
  })

  assert.equal(await prisma.userAlert.count({ where: visibleUserAlertWhere({
    organizationId: organization.id, userId: custodian.id,
  }) }), 1)
  assert.equal(await prisma.userAlert.count({ where: visibleUserAlertWhere({
    organizationId: organization.id, userId: other.id,
  }) }), 0)

  await prisma.localInferenceHost.update({ where: { id: host.id }, data: { healthReason: null } })
  assert.equal(await prisma.userAlert.count({ where: visibleUserAlertWhere({
    organizationId: organization.id, userId: custodian.id,
  }) }), 0, 'a repair removes the attention row without a separate delete')
})
