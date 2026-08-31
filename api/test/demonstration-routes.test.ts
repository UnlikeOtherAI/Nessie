import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import Fastify from 'fastify'
import { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

import { registerDemonstrationRoutes } from '../src/routes/demonstrations.js'
import type { RouteDeps } from '../src/routes/types.js'

const dbTest = process.env.DATABASE_URL ? test : test.skip

type Seed = {
  agentId: string
  channelId: string
  organizationId: string
  peerContext: AuthorizedActionContext
  threadId: string
  userContext: AuthorizedActionContext
  userId: string
  userIds: string[]
}

const contextFor = (
  organizationId: string,
  projectId: string,
  teamId: string,
  userId: string,
): AuthorizedActionContext => ({
  actionContext: { requestId: randomUUID() },
  actor: { actorId: userId, actorType: 'user', roles: ['member'] },
  tenant: { organizationId, projectId, teamId },
}) as AuthorizedActionContext

const seedRoute = async (prisma: PrismaClient): Promise<Seed> => {
  const organization = await prisma.organization.create({ data: { name: `demo-route-${randomUUID()}` } })
  const [user, peer] = await Promise.all([
    prisma.user.create({ data: { displayName: 'Demo owner', email: `demo-owner-${randomUUID()}@example.test` } }),
    prisma.user.create({ data: { displayName: 'Demo peer', email: `demo-peer-${randomUUID()}@example.test` } }),
  ])
  await prisma.organizationMember.createMany({
    data: [user.id, peer.id].map((userId) => ({ organizationId: organization.id, userId })),
  })
  const project = await prisma.project.create({
    data: { name: 'Demonstration route project', organizationId: organization.id },
  })
  const team = await prisma.team.create({ data: { name: 'Demonstration route team', projectId: project.id } })
  const channel = await prisma.channel.create({
    data: {
      label: `demo-route-${randomUUID()}`,
      slug: `demo-route-${randomUUID()}`,
      organizationId: organization.id,
      projectId: project.id,
      teamId: team.id,
      visibility: 'private',
    },
  })
  await prisma.channelMember.createMany({
    data: [user.id, peer.id].map((userId) => ({ channelId: channel.id, userId })),
  })
  const thread = await prisma.thread.create({ data: { channelId: channel.id } })
  const agent = await prisma.agent.create({
    data: {
      name: 'Demonstration route agent',
      organizationId: organization.id,
      ownerUserId: user.id,
      projectId: project.id,
      teamId: team.id,
    },
  })
  await prisma.agentBinding.create({ data: { agentId: agent.id, channelId: channel.id } })
  return {
    agentId: agent.id,
    channelId: channel.id,
    organizationId: organization.id,
    peerContext: contextFor(organization.id, project.id, team.id, peer.id),
    threadId: thread.id,
    userContext: contextFor(organization.id, project.id, team.id, user.id),
    userId: user.id,
    userIds: [user.id, peer.id],
  }
}

const routeApp = (prisma: PrismaClient, actorContext: AuthorizedActionContext) => {
  const app = Fastify({ logger: false })
  registerDemonstrationRoutes(app, {
    prisma,
    requireActorContext: () => actorContext,
    requireUserActor: () => true,
  } as unknown as RouteDeps)
  return app
}

dbTest('demonstration routes scope draft reads to the demonstrating user and stop the same recording', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedRoute(prisma)
  const ownerApp = routeApp(prisma, seed.userContext)
  const peerApp = routeApp(prisma, seed.peerContext)
  t.after(async () => {
    await ownerApp.close()
    await peerApp.close()
    await prisma.organization.deleteMany({ where: { id: seed.organizationId } })
    await prisma.user.deleteMany({ where: { id: { in: seed.userIds } } })
    await prisma.$disconnect()
  })

  const created = await ownerApp.inject({
    method: 'POST',
    payload: { agentId: seed.agentId, channelId: seed.channelId, threadId: seed.threadId },
    url: '/api/demonstrations',
  })
  assert.equal(created.statusCode, 201)
  const demonstrationId = (created.json() as { data: { id: string } }).data.id

  const ownerList = await ownerApp.inject({ method: 'GET', url: '/api/demonstrations' })
  assert.equal(ownerList.statusCode, 200)
  assert.equal((ownerList.json() as { data: unknown[] }).data.length, 1)

  const peerDetail = await peerApp.inject({
    method: 'GET',
    url: `/api/demonstrations/${demonstrationId}`,
  })
  assert.equal(peerDetail.statusCode, 404)

  const stopped = await ownerApp.inject({
    method: 'POST',
    url: `/api/demonstrations/${demonstrationId}/stop`,
  })
  assert.equal(stopped.statusCode, 200)
  assert.equal((stopped.json() as { data: { status: string } }).data.status, 'captured')
})
