import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import { syncTeamInviteAlerts } from '../src/services/team-invite-alerts.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

runDatabaseTest('verified invite sync creates, moves, updates, and deletes durable alerts', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const [organizationA, organizationB] = await Promise.all([
    prisma.organization.create({ data: { name: `invite alerts A ${suffix}` } }),
    prisma.organization.create({ data: { name: `invite alerts B ${suffix}` } }),
  ])
  const user = await prisma.user.create({
    data: {
      displayName: 'Invitee',
      email: `invite-alert-${suffix}@example.com`,
      uoaSub: `uoa-invite-alert-${suffix}`,
    },
  })
  await prisma.organizationMember.createMany({
    data: [organizationA, organizationB].map((organization) => ({
      organizationId: organization.id,
      userId: user.id,
    })),
  })
  t.after(async () => {
    await prisma.organization.deleteMany({
      where: { id: { in: [organizationA.id, organizationB.id] } },
    }).catch(() => undefined)
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined)
    await prisma.$disconnect()
  })

  const firstInvites = [
    {
      inviteId: `invite-one-${suffix}`,
      organizationId: `uoa-org-one-${suffix}`,
      teamId: `uoa-team-one-${suffix}`,
      teamName: 'Engineering',
      invitedBy: 'Ada Lovelace',
      expiresAt: '2026-09-30T12:00:00.000Z',
    },
    {
      inviteId: `invite-two-${suffix}`,
      organizationId: `uoa-org-two-${suffix}`,
      teamId: `uoa-team-two-${suffix}`,
      teamName: 'Research',
    },
  ]

  await syncTeamInviteAlerts(prisma, {
    organizationId: organizationA.id,
    pendingInvites: firstInvites,
    userId: user.id,
  })
  await syncTeamInviteAlerts(prisma, {
    organizationId: organizationA.id,
    pendingInvites: firstInvites,
    userId: user.id,
  })

  const idempotentRows = await prisma.userAlert.findMany({
    where: { kind: 'team_invitation', userId: user.id },
    orderBy: { eventKey: 'asc' },
  })
  assert.equal(idempotentRows.length, 2)
  assert.equal(idempotentRows[0]?.organizationId, organizationA.id)
  assert.deepEqual(idempotentRows[0]?.metadata, {
    inviteId: firstInvites[0]!.inviteId,
    organizationId: firstInvites[0]!.organizationId,
    teamId: firstInvites[0]!.teamId,
    teamName: 'Engineering',
    invitedBy: 'Ada Lovelace',
    expiresAt: '2026-09-30T12:00:00.000Z',
  })

  await syncTeamInviteAlerts(prisma, {
    organizationId: organizationB.id,
    pendingInvites: [{ ...firstInvites[0]!, teamName: 'Engineering renamed' }],
    userId: user.id,
  })

  const movedRows = await prisma.userAlert.findMany({
    where: { kind: 'team_invitation', userId: user.id },
  })
  assert.equal(movedRows.length, 1, 'the vanished invitation is deleted')
  assert.equal(movedRows[0]?.organizationId, organizationB.id)
  assert.equal(
    (movedRows[0]?.metadata as { teamName?: string } | null)?.teamName,
    'Engineering renamed',
  )

  await syncTeamInviteAlerts(prisma, {
    organizationId: organizationB.id,
    pendingInvites: [],
    userId: user.id,
  })
  assert.equal(await prisma.userAlert.count({
    where: { kind: 'team_invitation', userId: user.id },
  }), 0)
})

test('invite sync propagates database failures for its best-effort callers to log', async () => {
  await assert.rejects(
    syncTeamInviteAlerts({
      $transaction: async () => {
        throw new Error('database unavailable')
      },
    } as never, {
      organizationId: randomUUID(),
      pendingInvites: [],
      userId: randomUUID(),
    }),
    /database unavailable/,
  )
})
