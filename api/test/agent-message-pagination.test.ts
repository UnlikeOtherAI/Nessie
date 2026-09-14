import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import {
  AGENT_MESSAGE_CURSOR_TTL_MS,
  AgentMessageCursorError,
  decodeAgentMessageCursor,
  encodeAgentMessageCursor,
} from '../src/services/agent-message-cursor.js'
import { loadAgentMessages } from '../src/services/agent-read-model.js'
import { seed } from './disclosure-read-fixtures.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip
const CURSOR_SECRET = 'agent-history-pagination-test-secret'

const visibility = (organizationId: string, userId: string) => ({
  organizationId,
  uoaIdentity: undefined,
  userId,
})

const loadPage = (
  prisma: PrismaClient,
  input: {
    agentId: string
    cursor?: string
    direction?: 'backward' | 'forward'
    organizationId: string
    userId: string
  },
) => loadAgentMessages(prisma, input.agentId, {
  cursor: input.cursor,
  cursorSecret: CURSOR_SECRET,
  direction: input.direction,
  limit: 25,
  visibility: visibility(input.organizationId, input.userId),
})

const cleanup = (prisma: PrismaClient, suffix: string) => async () => {
  await prisma.organization.deleteMany({ where: { name: `disclosure-org-${suffix}` } })
  await prisma.user.deleteMany({ where: { email: { contains: suffix } } })
  await prisma.$disconnect()
}

test('agent history cursors are encrypted, scope-bound, versioned, and expiring', () => {
  const now = new Date('2026-09-10T12:00:00.000Z')
  const cursor = encodeAgentMessageCursor({
    agentId: 'agent-1',
    createdAt: '2026-09-10T11:00:00.000Z',
    id: 'withheld-row-id',
    organizationId: 'org-1',
    userId: 'user-1',
  }, CURSOR_SECRET, now)

  assert.match(cursor, /^amc1\./)
  assert.ok(!cursor.includes('withheld-row-id'))
  assert.deepEqual(
    decodeAgentMessageCursor(cursor, {
      agentId: 'agent-1', organizationId: 'org-1', secret: CURSOR_SECRET, userId: 'user-1',
    }, now),
    { createdAt: new Date('2026-09-10T11:00:00.000Z'), id: 'withheld-row-id' },
  )
  assert.throws(() => decodeAgentMessageCursor(cursor, {
    agentId: 'agent-1', organizationId: 'org-1', secret: CURSOR_SECRET, userId: 'other-user',
  }, now), AgentMessageCursorError)
  assert.throws(() => decodeAgentMessageCursor(cursor, {
    agentId: 'agent-1', organizationId: 'org-1', secret: CURSOR_SECRET, userId: 'user-1',
  }, new Date(now.getTime() + AGENT_MESSAGE_CURSOR_TTL_MS + 1)), AgentMessageCursorError)
})

runDatabaseTest('agent history walks tied timestamps without repeats and previous returns the adjacent page', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  t.after(cleanup(prisma, suffix))
  const s = await seed(prisma, suffix)
  const at = new Date('2026-09-10T12:00:00.000Z')
  const expected = new Set<string>()
  for (let index = 0; index < 125; index += 1) {
    const content = `tied-message-${index}`
    expected.add(content)
    await prisma.message.create({
      data: { agentId: s.agentId, content, createdAt: at, role: 'assistant', threadId: s.threadId },
    })
  }

  const pages = [await loadPage(prisma, { ...s, userId: s.outsiderId })]
  await prisma.message.create({
    data: {
      agentId: s.agentId,
      content: 'concurrent-new-message',
      createdAt: new Date('2026-09-10T12:01:00.000Z'),
      role: 'assistant',
      threadId: s.threadId,
    },
  })
  while (pages.at(-1)?.meta.nextCursor) {
    pages.push(await loadPage(prisma, {
      ...s,
      cursor: pages.at(-1)?.meta.nextCursor ?? undefined,
      userId: s.outsiderId,
    }))
  }

  assert.equal(pages.length, 5)
  const received = pages.flatMap((page) => page.data.items.map((item) => item.fullContent))
  assert.equal(new Set(received).size, 125)
  assert.deepEqual(new Set(received), expected)
  assert.ok(!received.includes('concurrent-new-message'))

  let current = pages.at(-1)
  for (let index = pages.length - 2; index >= 0; index -= 1) {
    const cursor = current?.meta.prevCursor
    assert.ok(cursor)
    current = await loadPage(prisma, {
      ...s,
      cursor,
      direction: 'backward',
      userId: s.outsiderId,
    })
    assert.deepEqual(
      current.data.items.map((item) => item.fullContent),
      pages[index]?.data.items.map((item) => item.fullContent),
    )
  }
  assert.equal(current?.meta.prevCursor, null)
})

runDatabaseTest('a withheld candidate window advances without leaking a count or anchor', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  t.after(cleanup(prisma, suffix))
  const s = await seed(prisma, suffix)
  const base = new Date('2026-09-10T12:00:00.000Z').getTime()
  let withheldId = ''
  for (let index = 0; index < 100; index += 1) {
    const message = await prisma.message.create({
      data: {
        agentId: s.agentId,
        content: `withheld-${index}`,
        createdAt: new Date(base - index),
        role: 'assistant',
        threadId: s.threadId,
      },
    })
    if (index === 0) withheldId = message.id
    await prisma.messageBasisScope.create({
      data: {
        messageId: message.id,
        organizationId: s.organizationId,
        scopeId: s.insiderId,
        scopeType: 'user',
      },
    })
  }
  for (let index = 0; index < 25; index += 1) {
    await prisma.message.create({
      data: {
        agentId: s.agentId,
        content: `public-${index}`,
        createdAt: new Date(base - 1_000 - index),
        role: 'assistant',
        threadId: s.threadId,
      },
    })
  }

  const first = await loadPage(prisma, { ...s, userId: s.outsiderId })
  assert.deepEqual(first.data.items, [])
  assert.ok(first.meta.nextCursor)
  assert.ok(!JSON.stringify(first).includes(withheldId))
  assert.ok(!JSON.stringify(first).includes('withheld-'))

  const second = await loadPage(prisma, {
    ...s, cursor: first.meta.nextCursor ?? undefined, userId: s.outsiderId,
  })
  assert.equal(second.data.items.length, 25)
  assert.ok(second.data.items.every((item) => item.fullContent.startsWith('public-')))
  assert.equal(second.meta.nextCursor, null)
})

runDatabaseTest('each continuation rechecks revoked disclosure grants', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  t.after(cleanup(prisma, suffix))
  const s = await seed(prisma, suffix)
  const base = new Date('2026-09-10T12:00:00.000Z').getTime()
  for (let index = 0; index < 25; index += 1) {
    await prisma.message.create({
      data: {
        agentId: s.agentId,
        content: `public-${index}`,
        createdAt: new Date(base - index),
        role: 'assistant',
        threadId: s.threadId,
      },
    })
  }
  const restricted = await prisma.message.create({
    data: {
      agentId: s.agentId,
      content: 'grant-revoked-before-next-page',
      createdAt: new Date(base - 100),
      role: 'assistant',
      threadId: s.threadId,
    },
  })
  await prisma.messageBasisScope.create({
    data: {
      messageId: restricted.id,
      organizationId: s.organizationId,
      scopeId: s.insiderId,
      scopeType: 'user',
    },
  })
  const grant = await prisma.disclosureGrant.create({
    data: {
      audienceId: s.outsiderId,
      audienceKind: 'user',
      grantedByUserId: s.insiderId,
      messageId: restricted.id,
      organizationId: s.organizationId,
    },
  })

  const first = await loadPage(prisma, { ...s, userId: s.outsiderId })
  await prisma.disclosureGrant.update({ where: { id: grant.id }, data: { revokedAt: new Date() } })
  const second = await loadPage(prisma, {
    ...s, cursor: first.meta.nextCursor ?? undefined, userId: s.outsiderId,
  })
  assert.deepEqual(second.data.items, [])
  assert.equal(second.meta.nextCursor, null)
})

runDatabaseTest('a direct agent post in an inaccessible channel is withheld', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  t.after(cleanup(prisma, suffix))
  const s = await seed(prisma, suffix)
  const channel = await prisma.channel.create({
    data: {
      label: `private-${suffix}`,
      organizationId: s.organizationId,
      projectId: s.projectId,
      slug: `private-${suffix.slice(0, 8)}`,
      teamId: s.teamId,
      type: 'standard',
      visibility: 'private',
    },
  })
  const thread = await prisma.thread.create({
    data: { channelId: channel.id, title: 'private' },
  })
  await prisma.message.create({
    data: {
      agentId: s.agentId,
      content: 'private-agent-post',
      role: 'assistant',
      threadId: thread.id,
    },
  })

  const page = await loadPage(prisma, { ...s, userId: s.outsiderId })

  assert.equal(page.data.items.some((item) => item.fullContent === 'private-agent-post'), false)
})

runDatabaseTest('run-derived history merges the newest bounded slice from each conversation', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  t.after(cleanup(prisma, suffix))
  const s = await seed(prisma, suffix)
  const base = new Date('2026-09-10T12:00:00.000Z').getTime()
  const expected: Array<{ content: string; createdAt: number }> = []
  for (let threadIndex = 0; threadIndex < 5; threadIndex += 1) {
    const threadId = threadIndex === 0
      ? s.threadId
      : (await prisma.thread.create({
          data: { channelId: s.channelId, title: `run-${threadIndex}` },
        })).id
    await prisma.run.create({ data: { agentId: s.agentId, threadId } })
    for (let messageIndex = 0; messageIndex < 30; messageIndex += 1) {
      const content = `run-${threadIndex}-message-${messageIndex}`
      const createdAt = base - (threadIndex * 100 + messageIndex)
      expected.push({ content, createdAt })
      await prisma.message.create({
        data: {
          content,
          createdAt: new Date(createdAt),
          role: 'user',
          threadId,
        },
      })
    }
  }

  const page = await loadPage(prisma, { ...s, userId: s.outsiderId })

  assert.deepEqual(
    page.data.items.map((item) => item.fullContent),
    expected
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, 25)
      .map((item) => item.content),
  )
})
