import assert from 'node:assert/strict'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import { softDeleteMessage } from '../src/services/message-edit.js'

/**
 * Only the author deletes a message. A fellow channel member and an
 * organisation owner or admin may not remove what somebody else said
 * (`docs/standards/team-model.md` → "Who may change a project or a channel").
 * `softDeleteMessage` takes no role at all, so no caller can hand one in.
 */

const suite = 'd41e'
const orgId = `00000000-0000-4000-8000-${suite}00000001`
const projectId = `00000000-0000-4000-8000-${suite}00000002`
const teamId = `00000000-0000-4000-8000-${suite}00000003`
const channelId = `00000000-0000-4000-8000-${suite}00000004`
const threadId = `00000000-0000-4000-8000-${suite}00000005`
const messageId = `00000000-0000-4000-8000-${suite}00000006`

const authorUserId = `00000000-0000-4000-8000-${suite}00000010`
const fellowUserId = `00000000-0000-4000-8000-${suite}00000011`
const orgAdminUserId = `00000000-0000-4000-8000-${suite}00000012`
const userIds = [authorUserId, fellowUserId, orgAdminUserId]

const dbTest = process.env.DATABASE_URL ? test : test.skip

const cleanup = async (prisma: PrismaClient) => {
  await prisma.message.deleteMany({ where: { threadId } })
  await prisma.thread.deleteMany({ where: { channelId } })
  await prisma.channelMember.deleteMany({ where: { channelId } })
  await prisma.channel.deleteMany({ where: { organizationId: orgId } })
  await prisma.team.deleteMany({ where: { id: teamId } })
  await prisma.project.deleteMany({ where: { id: projectId } })
  await prisma.organizationMember.deleteMany({ where: { organizationId: orgId } })
  await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
}

const seed = async (prisma: PrismaClient) => {
  await prisma.organization.create({ data: { id: orgId, name: `msg-delete-${suite}` } })
  await prisma.user.createMany({
    data: userIds.map((id, index) => ({
      displayName: `Message delete ${index}`,
      email: `msg-delete-${suite}-${index}@test.local`,
      id,
    })),
  })
  await prisma.organizationMember.createMany({
    data: userIds.map((userId) => ({
      organizationId: orgId,
      role: userId === orgAdminUserId ? 'admin' : 'member',
      userId,
    })),
  })
  await prisma.project.create({ data: { id: projectId, name: `p-${suite}`, organizationId: orgId } })
  await prisma.team.create({ data: { id: teamId, name: `t-${suite}`, projectId } })
  await prisma.channel.create({
    data: {
      id: channelId,
      label: `room-${suite}`,
      organizationId: orgId,
      projectId,
      slug: `room-${suite}`,
      teamId,
      visibility: 'public',
      members: {
        create: userIds.map((userId) => ({
          role: userId === authorUserId ? 'owner' : 'member',
          userId,
        })),
      },
    },
  })
  await prisma.thread.create({ data: { channelId, id: threadId, title: 'General' } })
  await prisma.message.create({
    data: {
      content: 'Said by the author',
      id: messageId,
      role: 'user',
      threadId,
      userId: authorUserId,
    },
  })
}

dbTest('a fellow member and an organisation admin cannot delete somebody else’s message', async () => {
  const prisma = new PrismaClient()
  try {
    await cleanup(prisma)
    await seed(prisma)

    for (const userId of [fellowUserId, orgAdminUserId]) {
      // The route used to hand in `isChannelManager: true` for exactly these two
      // people. The service must refuse them even if a caller still does.
      const result = await softDeleteMessage(
        prisma,
        { isChannelManager: true, messageId, threadId, userId } as Parameters<typeof softDeleteMessage>[1],
      )
      assert.deepEqual(result, { kind: 'forbidden' }, userId)
    }
    const kept = await prisma.message.findUniqueOrThrow({ where: { id: messageId } })
    assert.equal(kept.deletedAt, null)
    assert.equal(kept.content, 'Said by the author')

    const deleted = await softDeleteMessage(prisma, { messageId, threadId, userId: authorUserId })
    assert.equal(deleted.kind, 'deleted')
    const tombstone = await prisma.message.findUniqueOrThrow({ where: { id: messageId } })
    assert.notEqual(tombstone.deletedAt, null)
  } finally {
    await cleanup(prisma)
    await prisma.$disconnect()
  }
})
