import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import Fastify from 'fastify'
import { PrismaClient } from '@prisma/client'
import {
  issueCallActionToken,
  startCallForUser,
} from '@nessie/workspace-admin'

import { registerCallRoutes } from '../src/routes/calls.js'
import type { RouteDeps } from '../src/routes/types.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip
const AUTH_SECRET = 'call-action-response-test-secret'
const jitsi = { callLink: { env: { NESSIE_JITSI_DOMAIN: 'meet.example.test' } } }

runDatabaseTest('a Web Push response token is single-use and rejects a token bound to another user', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const org = await prisma.organization.create({ data: { name: `call-action-${suffix}` } })
  const project = await prisma.project.create({ data: { name: 'project', organizationId: org.id } })
  const team = await prisma.team.create({ data: { callProvider: 'jitsi', name: 'team', projectId: project.id } })
  const caller = await prisma.user.create({ data: { displayName: 'Caller', email: `caller-${suffix}@example.test` } })
  const invitee = await prisma.user.create({ data: { displayName: 'Invitee', email: `invitee-${suffix}@example.test` } })
  const outsider = await prisma.user.create({ data: { displayName: 'Outsider', email: `outsider-${suffix}@example.test` } })
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
    await prisma.user.deleteMany({ where: { id: { in: [caller.id, invitee.id, outsider.id] } } })
    await prisma.$disconnect()
  })

  const expiresAt = Math.floor(Date.now() / 1000) + 60
  const wrongUserToken = issueCallActionToken({
    action: 'accept', callId: call.id, expiresAt, revision: call.revision, userId: outsider.id,
  }, AUTH_SECRET)
  const wrongUser = await app.inject({
    method: 'POST',
    url: `/api/calls/${call.id}/respond`,
    payload: { token: wrongUserToken },
  })
  assert.equal(wrongUser.statusCode, 401)
  assert.equal(wrongUser.body.includes('meetingUri'), false)

  const token = issueCallActionToken({
    action: 'accept', callId: call.id, expiresAt, revision: call.revision, userId: invitee.id,
  }, AUTH_SECRET)
  const accepted = await app.inject({
    method: 'POST',
    url: `/api/calls/${call.id}/respond`,
    payload: { token },
  })
  assert.equal(accepted.statusCode, 204)
  assert.equal(accepted.body, '')

  const replay = await app.inject({
    method: 'POST',
    url: `/api/calls/${call.id}/respond`,
    payload: { token },
  })
  assert.equal(replay.statusCode, 401)
  assert.equal(replay.body.includes('meetingUri'), false)
  const invite = await prisma.callInvite.findUniqueOrThrow({
    where: { callId_userId: { callId: call.id, userId: invitee.id } },
  })
  assert.equal(invite.state, 'accepted')
})
