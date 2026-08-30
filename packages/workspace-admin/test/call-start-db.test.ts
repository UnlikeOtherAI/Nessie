import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import { CallStartError, startCallForUser } from '../src/index.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

const jitsi = { callLink: { env: { NESSIE_JITSI_DOMAIN: 'meet.example.test' } } }

type Seed = {
  channelId: string
  organizationId: string
  otherChannelId: string
  otherOrganizationId: string
  inviteeId: string
  userId: string
}

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const suffix = randomUUID()
  const user = await prisma.user.create({
    data: { displayName: 'Caller', email: `call-caller-${suffix}@example.test` },
  })
  const invitee = await prisma.user.create({
    data: { displayName: 'Invitee', email: `call-invitee-${suffix}@example.test` },
  })
  const otherOrg = await prisma.organization.create({ data: { name: `other-${suffix}` } })
  const org = await prisma.organization.create({ data: { name: `calls-${suffix}` } })
  const [project, otherProject] = await Promise.all([
    prisma.project.create({ data: { name: 'project', organizationId: org.id } }),
    prisma.project.create({ data: { name: 'other project', organizationId: otherOrg.id } }),
  ])
  const [team, otherTeam] = await Promise.all([
    prisma.team.create({ data: { callProvider: 'jitsi', name: 'team', projectId: project.id } }),
    prisma.team.create({ data: { callProvider: 'jitsi', name: 'other team', projectId: otherProject.id } }),
  ])
  await prisma.organizationMember.createMany({
    data: [
      { organizationId: org.id, userId: user.id },
      { organizationId: org.id, userId: invitee.id },
    ],
  })
  const channel = await prisma.channel.create({
    data: {
      label: 'calls', organizationId: org.id, projectId: project.id, teamId: team.id,
      members: { create: [{ userId: user.id }, { userId: invitee.id }] },
    },
  })
  const otherChannel = await prisma.channel.create({
    data: {
      label: 'other calls', organizationId: otherOrg.id, projectId: otherProject.id, teamId: otherTeam.id,
    },
  })
  return {
    channelId: channel.id,
    organizationId: org.id,
    otherChannelId: otherChannel.id,
    otherOrganizationId: otherOrg.id,
    inviteeId: invitee.id,
    userId: user.id,
  }
}

const cleanup = async (prisma: PrismaClient, input: Seed): Promise<void> => {
  await prisma.$executeRaw`
    DELETE FROM queue_jobs
    WHERE topic = 'call.ring-timeout'
      AND payload->>'callId' IN (SELECT id::text FROM calls WHERE channel_id = ${input.channelId}::uuid)
  `
  await prisma.organization.deleteMany({ where: { id: { in: [input.organizationId, input.otherOrganizationId] } } })
  await prisma.user.deleteMany({ where: { id: { in: [input.userId, input.inviteeId] } } })
}

runDatabaseTest('startCallForUser uses the target channel organisation and the partial live-call index', async (t) => {
  const prisma = new PrismaClient()
  const workspace = await seed(prisma)
  t.after(() => cleanup(prisma, workspace).then(() => prisma.$disconnect()))

  await assert.rejects(
    startCallForUser(prisma, { actingUserId: workspace.userId, channelId: workspace.otherChannelId }, jitsi),
    (error: unknown) => error instanceof CallStartError && error.code === 'CHANNEL_NOT_FOUND',
  )

  const attempts = await Promise.allSettled([
    startCallForUser(prisma, { actingUserId: workspace.userId, channelId: workspace.channelId }, jitsi),
    startCallForUser(prisma, { actingUserId: workspace.userId, channelId: workspace.channelId }, jitsi),
  ])
  assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1)
  const rejected = attempts.find((attempt) => attempt.status === 'rejected')
  assert.ok(rejected?.status === 'rejected' && rejected.reason instanceof CallStartError)
  if (rejected?.status === 'rejected') assert.equal(rejected.reason.code, 'ACTIVE_CALL_EXISTS')
  assert.equal(await prisma.call.count({ where: { channelId: workspace.channelId, status: 'ringing' } }), 1)
})
