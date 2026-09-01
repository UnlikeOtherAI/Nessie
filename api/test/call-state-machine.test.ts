import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import { startCallForUser } from '@nessie/workspace-admin'

import { acceptCallInvite, cancelCall, declineCallInvite } from '../src/services/calls.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip
const jitsi = { callLink: { env: { NESSIE_JITSI_DOMAIN: 'meet.example.test' } } }

runDatabaseTest('accept is idempotent and preserves the accepted state on a repeated request', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const org = await prisma.organization.create({ data: { name: `call-accept-${suffix}` } })
  const project = await prisma.project.create({ data: { name: 'project', organizationId: org.id } })
  const team = await prisma.team.create({ data: { callProvider: 'jitsi', name: 'team', projectId: project.id } })
  const caller = await prisma.user.create({ data: { displayName: 'Caller', email: `caller-${suffix}@example.test` } })
  const invitee = await prisma.user.create({ data: { displayName: 'Invitee', email: `invitee-${suffix}@example.test` } })
  await prisma.organizationMember.createMany({ data: [
    { organizationId: org.id, userId: caller.id },
    { organizationId: org.id, userId: invitee.id },
  ] })
  const channel = await prisma.channel.create({
    data: {
      label: 'calls', slug: 'calls', organizationId: org.id, projectId: project.id, teamId: team.id,
      members: { create: [{ userId: caller.id }, { userId: invitee.id }] },
    },
  })
  const started = await startCallForUser(prisma, { actingUserId: caller.id, channelId: channel.id }, jitsi)
  t.after(async () => {
    await prisma.$executeRaw`DELETE FROM queue_jobs WHERE payload->>'callId' = ${started.id}`
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => undefined)
    await prisma.user.deleteMany({ where: { id: { in: [caller.id, invitee.id] } } })
    await prisma.$disconnect()
  })

  const first = await acceptCallInvite(prisma, started.id, invitee.id)
  assert.equal(first.call.status, 'active')
  assert.equal(first.changed, true)
  const repeated = await acceptCallInvite(prisma, started.id, invitee.id)
  assert.equal(repeated.changed, false)
  assert.equal(repeated.call.status, 'active')
  assert.equal(repeated.call.invites[0]?.state, 'accepted')
})

runDatabaseTest('accept and caller-cancel serialize to one valid terminal-or-active outcome', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const org = await prisma.organization.create({ data: { name: `call-race-${suffix}` } })
  const project = await prisma.project.create({ data: { name: 'project', organizationId: org.id } })
  const team = await prisma.team.create({ data: { callProvider: 'jitsi', name: 'team', projectId: project.id } })
  const caller = await prisma.user.create({ data: { displayName: 'Caller', email: `race-caller-${suffix}@example.test` } })
  const invitee = await prisma.user.create({ data: { displayName: 'Invitee', email: `race-invitee-${suffix}@example.test` } })
  await prisma.organizationMember.createMany({ data: [
    { organizationId: org.id, userId: caller.id },
    { organizationId: org.id, userId: invitee.id },
  ] })
  const channel = await prisma.channel.create({
    data: {
      label: 'calls', slug: 'calls', organizationId: org.id, projectId: project.id, teamId: team.id,
      members: { create: [{ userId: caller.id }, { userId: invitee.id }] },
    },
  })
  const started = await startCallForUser(prisma, { actingUserId: caller.id, channelId: channel.id }, jitsi)
  t.after(async () => {
    await prisma.$executeRaw`DELETE FROM queue_jobs WHERE payload->>'callId' = ${started.id}`
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => undefined)
    await prisma.user.deleteMany({ where: { id: { in: [caller.id, invitee.id] } } })
    await prisma.$disconnect()
  })

  await Promise.allSettled([
    acceptCallInvite(prisma, started.id, invitee.id),
    cancelCall(prisma, started.id, caller.id),
  ])
  const call = await prisma.call.findUniqueOrThrow({ where: { id: started.id }, include: { invites: true } })
  assert.ok(call.status === 'active' || call.status === 'cancelled')
  assert.equal(call.invites[0]?.state, call.status === 'active' ? 'accepted' : 'cancelled')
})

runDatabaseTest('declining one invite leaves the call ringing for other invitees', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const org = await prisma.organization.create({ data: { name: `call-decline-${suffix}` } })
  const project = await prisma.project.create({ data: { name: 'project', organizationId: org.id } })
  const team = await prisma.team.create({ data: { callProvider: 'jitsi', name: 'team', projectId: project.id } })
  const caller = await prisma.user.create({ data: { displayName: 'Caller', email: `decline-caller-${suffix}@example.test` } })
  const firstInvitee = await prisma.user.create({ data: { displayName: 'First invitee', email: `decline-first-${suffix}@example.test` } })
  const secondInvitee = await prisma.user.create({ data: { displayName: 'Second invitee', email: `decline-second-${suffix}@example.test` } })
  await prisma.organizationMember.createMany({ data: [
    { organizationId: org.id, userId: caller.id },
    { organizationId: org.id, userId: firstInvitee.id },
    { organizationId: org.id, userId: secondInvitee.id },
  ] })
  const channel = await prisma.channel.create({
    data: {
      label: 'calls', slug: 'calls', organizationId: org.id, projectId: project.id, teamId: team.id,
      members: { create: [{ userId: caller.id }, { userId: firstInvitee.id }, { userId: secondInvitee.id }] },
    },
  })
  const started = await startCallForUser(prisma, { actingUserId: caller.id, channelId: channel.id }, jitsi)
  t.after(async () => {
    await prisma.$executeRaw`DELETE FROM queue_jobs WHERE payload->>'callId' = ${started.id}`
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => undefined)
    await prisma.user.deleteMany({ where: { id: { in: [caller.id, firstInvitee.id, secondInvitee.id] } } })
    await prisma.$disconnect()
  })

  const declined = await declineCallInvite(prisma, started.id, firstInvitee.id)

  assert.equal(declined.changed, true)
  assert.equal(declined.call.status, 'ringing')
  assert.equal(
    (await prisma.callInvite.findUniqueOrThrow({
      where: { callId_userId: { callId: started.id, userId: firstInvitee.id } },
    })).state,
    'declined',
  )
  assert.equal(
    (await prisma.callInvite.findUniqueOrThrow({
      where: { callId_userId: { callId: started.id, userId: secondInvitee.id } },
    })).state,
    'ringing',
  )
  assert.equal((await prisma.call.findUniqueOrThrow({ where: { id: started.id } })).status, 'ringing')
})
