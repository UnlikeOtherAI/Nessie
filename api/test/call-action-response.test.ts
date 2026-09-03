import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import Fastify from 'fastify'
import { PrismaClient } from '@prisma/client'
import {
  issueCallActionToken,
  startCallForUser,
} from '@nessie/team-admin'

import { registerCallRoutes } from '../src/routes/calls.js'
import type { RouteDeps } from '../src/routes/types.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip
const AUTH_SECRET = 'call-action-response-test-secret'
const jitsi = { callLink: { env: { NESSIE_JITSI_DOMAIN: 'meet.example.test' } } }

runDatabaseTest('Web Push response tokens stay valid for another ringing invitee and remain single-use', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const org = await prisma.organization.create({ data: { name: `call-action-${suffix}` } })
  const project = await prisma.project.create({ data: { name: 'project', organizationId: org.id } })
  const team = await prisma.team.create({ data: { callProvider: 'jitsi', name: 'team', projectId: project.id } })
  const caller = await prisma.user.create({ data: { displayName: 'Caller', email: `caller-${suffix}@example.test` } })
  const decliningInvitee = await prisma.user.create({ data: { displayName: 'Declining invitee', email: `declining-invitee-${suffix}@example.test` } })
  const acceptingInvitee = await prisma.user.create({ data: { displayName: 'Accepting invitee', email: `accepting-invitee-${suffix}@example.test` } })
  const outsider = await prisma.user.create({ data: { displayName: 'Outsider', email: `outsider-${suffix}@example.test` } })
  await prisma.organizationMember.createMany({ data: [
    { organizationId: org.id, userId: caller.id },
    { organizationId: org.id, userId: decliningInvitee.id },
    { organizationId: org.id, userId: acceptingInvitee.id },
  ] })
  const channel = await prisma.channel.create({
    data: {
      label: 'calls', slug: 'calls', organizationId: org.id, projectId: project.id, teamId: team.id,
      members: { create: [{ userId: caller.id }, { userId: decliningInvitee.id }, { userId: acceptingInvitee.id }] },
    },
  })
  const call = await startCallForUser(prisma, { actingUserId: caller.id, channelId: channel.id }, jitsi)
  const app = Fastify({ logger: false })
  registerCallRoutes(app, {
    authSecret: AUTH_SECRET,
    getChannelIfMember: async () => null,
    getVisibleChannel: async () => null,
    prisma,
    realtimeHub: { publishWs: async () => undefined },
    requireActorContext: () => null,
  } as unknown as RouteDeps)
  t.after(async () => {
    await app.close()
    await prisma.$executeRaw`DELETE FROM queue_jobs WHERE payload->>'callId' = ${call.id}`
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => undefined)
    await prisma.user.deleteMany({ where: { id: { in: [caller.id, decliningInvitee.id, acceptingInvitee.id, outsider.id] } } })
    await prisma.$disconnect()
  })

  const expiresAt = Math.floor(Date.now() / 1000) + 60
  const wrongUserToken = issueCallActionToken({
    action: 'accept', callId: call.id, expiresAt, userId: outsider.id,
  }, AUTH_SECRET)
  const wrongUser = await app.inject({
    method: 'POST',
    url: `/api/calls/${call.id}/respond`,
    payload: { token: wrongUserToken },
  })
  assert.equal(wrongUser.statusCode, 401)
  assert.equal(wrongUser.body.includes('meetingUri'), false)

  const declineToken = issueCallActionToken({
    action: 'decline', callId: call.id, expiresAt, userId: decliningInvitee.id,
  }, AUTH_SECRET)
  const acceptToken = issueCallActionToken({
    action: 'accept', callId: call.id, expiresAt, userId: acceptingInvitee.id,
  }, AUTH_SECRET)
  const declined = await app.inject({
    method: 'POST',
    url: `/api/calls/${call.id}/respond`,
    payload: { token: declineToken },
  })
  assert.equal(declined.statusCode, 204)
  const afterDecline = await prisma.call.findUniqueOrThrow({ where: { id: call.id } })
  assert.equal(afterDecline.status, 'ringing')
  assert.equal(afterDecline.revision, call.revision + 1)

  const accepted = await app.inject({
    method: 'POST',
    url: `/api/calls/${call.id}/respond`,
    payload: { token: acceptToken },
  })
  assert.equal(accepted.statusCode, 204)
  assert.equal(accepted.body, '')

  const replay = await app.inject({
    method: 'POST',
    url: `/api/calls/${call.id}/respond`,
    payload: { token: acceptToken },
  })
  assert.equal(replay.statusCode, 401)
  assert.equal(replay.body.includes('meetingUri'), false)
  const [declinedInvite, acceptedInvite, completedCall] = await Promise.all([
    prisma.callInvite.findUniqueOrThrow({
      where: { callId_userId: { callId: call.id, userId: decliningInvitee.id } },
    }),
    prisma.callInvite.findUniqueOrThrow({
      where: { callId_userId: { callId: call.id, userId: acceptingInvitee.id } },
    }),
    prisma.call.findUniqueOrThrow({ where: { id: call.id } }),
  ])
  assert.equal(declinedInvite.state, 'declined')
  assert.equal(acceptedInvite.state, 'accepted')
  assert.equal(completedCall.status, 'active')
})

runDatabaseTest('the call-start route refuses a channel outside the session organization', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const sessionOrg = await prisma.organization.create({ data: { name: `call-session-${suffix}` } })
  const targetOrg = await prisma.organization.create({ data: { name: `call-target-${suffix}` } })
  const project = await prisma.project.create({ data: { name: 'project', organizationId: targetOrg.id } })
  const team = await prisma.team.create({ data: { callProvider: 'jitsi', name: 'team', projectId: project.id } })
  const caller = await prisma.user.create({ data: { displayName: 'Caller', email: `cross-org-caller-${suffix}@example.test` } })
  const invitee = await prisma.user.create({ data: { displayName: 'Invitee', email: `cross-org-invitee-${suffix}@example.test` } })
  await prisma.organizationMember.createMany({ data: [
    { organizationId: sessionOrg.id, userId: caller.id },
    { organizationId: targetOrg.id, userId: caller.id },
    { organizationId: targetOrg.id, userId: invitee.id },
  ] })
  const channel = await prisma.channel.create({
    data: {
      label: 'calls', slug: 'calls', organizationId: targetOrg.id, projectId: project.id, teamId: team.id,
      members: { create: [{ userId: caller.id }, { userId: invitee.id }] },
    },
  })
  const app = Fastify({ logger: false })
  registerCallRoutes(app, {
    authSecret: AUTH_SECRET,
    getChannelIfMember: async () => null,
    getVisibleChannel: async () => null,
    prisma,
    realtimeHub: { publishWs: async () => undefined },
    requireActorContext: () => ({
      actionContext: { requestId: randomUUID() },
      actor: { actorId: caller.id, actorType: 'user' },
      tenant: { organizationId: sessionOrg.id },
    }),
  } as unknown as RouteDeps)
  t.after(async () => {
    await app.close()
    await prisma.organization.deleteMany({ where: { id: { in: [sessionOrg.id, targetOrg.id] } } })
    await prisma.user.deleteMany({ where: { id: { in: [caller.id, invitee.id] } } })
    await prisma.$disconnect()
  })

  const response = await app.inject({ method: 'POST', url: `/api/channels/${channel.id}/call` })

  assert.equal(response.statusCode, 404)
  assert.equal((response.json() as { error: { code: string } }).error.code, 'CHANNEL_NOT_FOUND')
  assert.equal(await prisma.call.count({ where: { channelId: channel.id } }), 0)
})
