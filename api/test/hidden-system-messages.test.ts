import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import Fastify from 'fastify'
import { PrismaClient } from '@prisma/client'
import { AuthorizedActionContextSchema } from '@nessie/schemas'
import { registerThreadReplyRoutes } from '../src/routes/thread-replies.js'
import { loadAgentMessages } from '../src/services/agent-message-history.js'
import { searchMessages } from '../src/services/message-search.js'
import { seed } from './disclosure-read-fixtures.js'

const databaseTest = process.env.DATABASE_URL ? test : test.skip

databaseTest('internal system messages stay out of search, paginated agent history and direct reads', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const app = Fastify({ logger: false })
  t.after(async () => {
    await app.close()
    await prisma.organization.deleteMany({ where: { name: `disclosure-org-${suffix}` } })
    await prisma.user.deleteMany({ where: { email: { contains: suffix } } })
    await prisma.$disconnect()
  })
  const s = await seed(prisma, suffix)
  const base = new Date('2026-09-21T12:00:00Z').getTime()
  const visibleHuman = await prisma.message.create({ data: {
    threadId: s.threadId, role: 'user', userId: s.outsiderId,
    content: 'reportneedle visible human', createdAt: new Date(base),
  } })
  const visibleAgent = await prisma.message.create({ data: {
    threadId: s.threadId, role: 'assistant', agentId: s.agentId,
    content: 'reportneedle visible reply', createdAt: new Date(base + 20),
  } })
  // No basis rows: system visibility is independent of disclosure restrictions.
  // One direct-agent kickoff and two run-derived legacy rows exercise both arms.
  const hiddenIds: string[] = []
  for (const [index, agentId] of [s.agentId, null, null].entries()) {
    const hidden = await prisma.message.create({ data: {
      threadId: s.threadId, role: 'system', agentId,
      content: `reportneedle internal instructions ${index}`,
      createdAt: new Date(base + 10 + index * 20),
      ...(index === 0 ? { rootMessageId: visibleHuman.id } : {}),
    } })
    hiddenIds.push(hidden.id)
  }
  await prisma.run.create({ data: { agentId: s.agentId, threadId: s.threadId, status: 'completed' } })

  await t.test('search returns only visible messages with matching text', async () => {
    const results = await searchMessages(prisma, {
      organizationId: s.organizationId, userId: s.outsiderId, query: 'reportneedle',
    })
    assert.deepEqual(new Set(results.map((row) => row.id)), new Set([visibleHuman.id, visibleAgent.id]))
    assert.ok(!JSON.stringify(results).includes('internal instructions'))
  })

  await t.test('forward and backward agent-history pages skip hidden rows before pagination', async () => {
    const input = {
      cursorSecret: 'hidden-system-history-test', limit: 1,
      visibility: { organizationId: s.organizationId, userId: s.outsiderId, uoaIdentity: undefined },
    }
    const first = await loadAgentMessages(prisma, s.agentId, input)
    assert.deepEqual(first.data.items.map((row) => row.messageId), [visibleAgent.id])
    assert.ok(first.meta.nextCursor)
    const second = await loadAgentMessages(prisma, s.agentId, { ...input, cursor: first.meta.nextCursor })
    assert.deepEqual(second.data.items.map((row) => row.messageId), [visibleHuman.id])
    assert.equal(second.meta.nextCursor, null)
    assert.ok(second.meta.prevCursor)
    const previous = await loadAgentMessages(prisma, s.agentId, {
      ...input, cursor: second.meta.prevCursor, direction: 'backward',
    })
    assert.deepEqual(previous.data.items.map((row) => row.messageId), [visibleAgent.id])
  })

  const actorContext = AuthorizedActionContextSchema.parse({
    actor: { actorType: 'user', actorId: s.outsiderId, roles: ['member'] },
    tenant: { organizationId: s.organizationId, projectId: s.projectId, teamId: s.teamId },
    actionContext: { requestId: randomUUID() },
  })
  registerThreadReplyRoutes(app, {
    prisma, requireActorContext: () => actorContext,
  } as unknown as Parameters<typeof registerThreadReplyRoutes>[1])

  await t.test('direct reads and follows refuse system rows even to a channel member', async () => {
    const visibleUrl = `/api/threads/${s.threadId}/messages/${visibleHuman.id}`
    assert.equal((await app.inject({ method: 'GET', url: visibleUrl })).statusCode, 200)
    assert.equal((await app.inject({
      method: 'PUT', url: `${visibleUrl}/follow`, payload: { following: true },
    })).statusCode, 200)
    for (const id of hiddenIds) {
      const url = `/api/threads/${s.threadId}/messages/${id}`
      const read = await app.inject({ method: 'GET', url })
      assert.equal(read.statusCode, 404)
      assert.ok(!read.body.includes('internal instructions'))
      assert.equal((await app.inject({
        method: 'PUT', url: `${url}/follow`, payload: { following: true },
      })).statusCode, 404)
    }
    assert.equal(await prisma.messageThreadFollow.count({
      where: { rootMessageId: { in: hiddenIds }, userId: s.outsiderId },
    }), 0)
  })

  await t.test('a guessed message id cannot cross threads or grant access to another person’s DM', async () => {
    const otherThread = await prisma.thread.create({ data: { channelId: s.channelId } })
    assert.equal((await app.inject({
      method: 'GET', url: `/api/threads/${otherThread.id}/messages/${visibleHuman.id}`,
    })).statusCode, 404)
    const dm = await prisma.channel.create({ data: {
      organizationId: s.organizationId, projectId: s.projectId, teamId: s.teamId,
      label: 'Private DM', type: 'dm', visibility: 'public', dmKey: randomUUID(),
      members: { create: { userId: s.insiderId } },
    } })
    const dmThread = await prisma.thread.create({ data: { channelId: dm.id } })
    const privateMessage = await prisma.message.create({ data: {
      threadId: dmThread.id, role: 'user', userId: s.insiderId, content: 'Private direct-message content',
    } })
    const response = await app.inject({
      method: 'GET', url: `/api/threads/${dmThread.id}/messages/${privateMessage.id}`,
    })
    assert.equal(response.statusCode, 404)
    assert.ok(!response.body.includes(privateMessage.content))
  })
})
