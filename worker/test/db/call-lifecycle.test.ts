import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { Prisma, PrismaClient } from '@prisma/client'
import { startCallForUser } from '@nessie/team-admin'

import { handleCallRingTimeout } from '../../src/control/call-lifecycle.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip
const jitsi = { callLink: { env: { NESSIE_JITSI_DOMAIN: 'meet.example.test' } } }

runDatabaseTest('timeout commits a missed call when its later transition realtime publish fails', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const org = await prisma.organization.create({ data: { name: `call-missed-${suffix}` } })
  const project = await prisma.project.create({ data: { name: 'project', organizationId: org.id } })
  const team = await prisma.team.create({ data: { callProvider: 'jitsi', name: 'team', projectId: project.id } })
  const caller = await prisma.user.create({ data: { displayName: 'Caller', email: `missed-caller-${suffix}@example.test` } })
  const invitee = await prisma.user.create({ data: { displayName: 'Invitee', email: `missed-invitee-${suffix}@example.test` } })
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
    await prisma.$executeRaw`
      DELETE FROM queue_jobs WHERE payload->>'callId' = ${started.id}
    `
    await prisma.$executeRaw`
      DELETE FROM queue_jobs
      WHERE topic = 'attention.dispatch'
        AND payload->>'alertId' IN (SELECT id::text FROM user_alerts WHERE call_id = ${started.id}::uuid)
    `
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => undefined)
    await prisma.user.deleteMany({ where: { id: { in: [caller.id, invitee.id] } } })
    await prisma.$disconnect()
  })

  const publications: Array<{ data: Record<string, unknown>; event: string; scopes: unknown }> = []
  let transitionPublishAttempts = 0
  const realtimeTransport = {
    publishWs: async (scopes: unknown, input: { data: Record<string, unknown>; event: string }) => {
      publications.push({ ...input, scopes })
      if (input.event === 'call.updated') {
        transitionPublishAttempts += 1
        throw new Error('simulated transition realtime failure')
      }
    },
  }
  assert.equal(await handleCallRingTimeout(prisma, realtimeTransport as never, started.id), true)
  assert.equal(transitionPublishAttempts, 1)
  const call = await prisma.call.findUniqueOrThrow({ where: { id: started.id }, include: { invites: true } })
  assert.equal(call.status, 'missed')
  assert.equal(call.invites[0]?.state, 'missed')
  const message = await prisma.message.findFirstOrThrow({
    where: { thread: { channelId: channel.id }, metadata: { path: ['kind'], equals: 'call_missed' } },
  })
  assert.equal(message.role, 'assistant')
  assert.equal(message.content, 'Missed call from Caller')
  const messagePublished = publications.find((publication) => publication.event === 'message.new')
  assert.ok(messagePublished)
  assert.deepEqual(messagePublished.scopes, [
    { kind: 'organization', organizationId: org.id },
    { channelId: channel.id, kind: 'channel' },
  ])
  assert.equal(messagePublished.data.messageId, message.id)
  assert.equal(messagePublished.data.threadId, message.threadId)
  assert.equal(messagePublished.data.contentPreview, message.content)
  assert.equal(messagePublished.data.role, 'assistant')
  const alert = await prisma.userAlert.findUniqueOrThrow({
    where: { userId_eventKey: { userId: invitee.id, eventKey: `call:${started.id}:missed:${invitee.id}` } },
  })
  assert.equal(alert.kind, 'call_missed')
  assert.equal(alert.callId, started.id)
})

runDatabaseTest('a timeout waiting behind an accepted invite never stomps it to missed', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const org = await prisma.organization.create({ data: { name: `call-timeout-race-${suffix}` } })
  const project = await prisma.project.create({ data: { name: 'project', organizationId: org.id } })
  const team = await prisma.team.create({ data: { callProvider: 'jitsi', name: 'team', projectId: project.id } })
  const caller = await prisma.user.create({ data: { displayName: 'Caller', email: `timeout-race-caller-${suffix}@example.test` } })
  const invitee = await prisma.user.create({ data: { displayName: 'Invitee', email: `timeout-race-invitee-${suffix}@example.test` } })
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

  let signalLock!: () => void
  let releaseAcceptance!: () => void
  const locked = new Promise<void>((resolve) => { signalLock = resolve })
  const release = new Promise<void>((resolve) => { releaseAcceptance = resolve })
  const acceptance = prisma.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT id FROM calls WHERE id = ${started.id}::uuid FOR UPDATE`)
    signalLock()
    await release
    assert.equal((await tx.callInvite.updateMany({
      where: { callId: started.id, state: 'ringing', userId: invitee.id },
      data: { respondedAt: new Date(), state: 'accepted' },
    })).count, 1)
    assert.equal((await tx.call.updateMany({
      where: { id: started.id, status: 'ringing' },
      data: { revision: { increment: 1 }, status: 'active' },
    })).count, 1)
  })
  await locked
  const timeout = handleCallRingTimeout(prisma, { publishWs: async () => undefined } as never, started.id)
  releaseAcceptance()
  await acceptance

  assert.equal(await timeout, false)
  const call = await prisma.call.findUniqueOrThrow({ where: { id: started.id }, include: { invites: true } })
  assert.equal(call.status, 'active')
  assert.equal(call.invites[0]?.state, 'accepted')
})
