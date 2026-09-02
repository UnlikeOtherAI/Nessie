import assert from 'node:assert/strict'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import { AGENT_DESIGNER_SLUG, type AuthorizedActionContext } from '@nessie/schemas'

import {
  continueDesignInChat,
  GlobalAgentChatError,
} from '../src/services/global-agent-chat.js'

/**
 * "Continue in chat" (D9): the sidebar's draft moves into the person's own
 * Agent Designer DM.
 *
 * What matters here is the *shape* of the transfer, which is the same shape
 * `agent_handoff` uses and for the same reasons: the draft becomes a hidden
 * `system` message rather than a `user` turn written under the person's id, the
 * run is claimed through the thread slot, and a person with no live membership
 * is refused. Against a real database, because the bootstrap it stands on is a
 * chain of advisory-locked upserts and channel CHECK constraints a fake cannot
 * see.
 *
 * Seed-scoped throughout: this database is shared with suites running
 * concurrently, so nothing here deletes or counts globally.
 */

const suite = 'cc41'
const orgId = `00000000-0000-4000-8000-${suite}00000001`
const projectId = `00000000-0000-4000-8000-${suite}00000002`
const teamId = `00000000-0000-4000-8000-${suite}00000003`
const userId = `00000000-0000-4000-8000-${suite}00000010`

const dbTest = process.env.DATABASE_URL ? test : test.skip

const actorContext = (): AuthorizedActionContext => ({
  actor: { actorType: 'user', actorId: userId, roles: ['member'] },
  tenant: { organizationId: orgId, projectId, teamId },
  actionContext: { requestId: `req-${suite}` },
}) as AuthorizedActionContext

const formState = {
  model: 'kimi-k2',
  name: 'Namesday',
  provider: 'kimi',
  role: 'assistant',
  systemPrompt: 'Tell people whose name day it is.',
  tools: { web_search: true },
}

const cleanup = async (prisma: PrismaClient) => {
  const channels = await prisma.channel.findMany({
    where: { organizationId: orgId },
    select: { id: true },
  })
  const channelIds = channels.map((channel) => channel.id)
  await prisma.queueJob.deleteMany({
    where: { idempotencyKey: { startsWith: `gagent-draft:${userId}:` } },
  })
  await prisma.message.deleteMany({ where: { thread: { channelId: { in: channelIds } } } })
  await prisma.task.deleteMany({ where: { organizationId: orgId } })
  await prisma.run.deleteMany({ where: { thread: { channelId: { in: channelIds } } } })
  await prisma.agentBinding.deleteMany({ where: { channelId: { in: channelIds } } })
  await prisma.thread.deleteMany({ where: { channelId: { in: channelIds } } })
  // Deliberately no explicit `channelMember` delete: each Prisma call is its
  // own transaction, and emptying a `gagent:` DM while the channel still exists
  // trips the deferred "must contain exactly its owner" trigger. The channel
  // delete cascades to its members anyway.
  await prisma.channel.deleteMany({ where: { organizationId: orgId } })
  await prisma.agent.deleteMany({ where: { organizationId: orgId } })
  await prisma.teamMember.deleteMany({ where: { userId } })
  await prisma.team.deleteMany({ where: { project: { organizationId: orgId } } })
  await prisma.project.deleteMany({ where: { organizationId: orgId } })
  await prisma.organizationMember.deleteMany({ where: { userId } })
  await prisma.user.deleteMany({ where: { id: userId } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
}

const seed = async (prisma: PrismaClient) => {
  await prisma.organization.create({ data: { id: orgId, name: `continue-${suite}` } })
  await prisma.user.create({
    data: {
      displayName: 'Continue tester',
      email: `continue-${suite}@test.local`,
      id: userId,
    },
  })
  await prisma.organizationMember.create({
    data: { organizationId: orgId, role: 'member', userId },
  })
  await prisma.project.create({
    data: { id: projectId, name: `p-${suite}`, organizationId: orgId },
  })
  await prisma.team.create({ data: { id: teamId, name: `t-${suite}`, projectId } })
}

const withDb = async (run: (prisma: PrismaClient) => Promise<void>) => {
  const prisma = new PrismaClient()
  try {
    await cleanup(prisma)
    await seed(prisma)
    await run(prisma)
  } finally {
    await cleanup(prisma)
    await prisma.$disconnect()
  }
}

dbTest('the draft lands as a hidden system brief that starts one run', async () => {
  await withDb(async (prisma) => {
    const result = await continueDesignInChat(prisma, {
      actorContext: actorContext(),
      body: { formState },
      slug: AGENT_DESIGNER_SLUG,
    })

    assert.equal(result.started, true)

    const channel = await prisma.channel.findUniqueOrThrow({
      where: { id: result.channelId },
      select: { dmKey: true, systemChannelType: true, visibility: true },
    })
    assert.equal(channel.systemChannelType, 'system_agent')
    assert.equal(channel.visibility, 'private')
    assert.equal(channel.dmKey, `gagent:${AGENT_DESIGNER_SLUG}:${orgId}:${userId}`)

    const messages = await prisma.message.findMany({
      where: { threadId: result.threadId },
      select: { content: true, metadata: true, role: true },
    })
    assert.equal(messages.length, 1)
    const brief = messages[0]!
    // A hidden `system` row, never a `user` turn impersonating the person.
    assert.equal(brief.role, 'system')
    assert.match(brief.content, /Namesday/)
    assert.match(brief.content, /Tell people whose name day it is\./)
    assert.match(brief.content, /web_search/)
    assert.equal(
      (brief.metadata as { globalAgentDraft?: { source?: string } }).globalAgentDraft?.source,
      'designer_form',
    )

    const runs = await prisma.run.findMany({ where: { threadId: result.threadId } })
    assert.equal(runs.length, 1)
    assert.equal(runs[0]!.replyPlacement, 'channel')
    assert.equal(runs[0]!.agentId, result.agentId)
  })
})

dbTest('the same draft sent twice converges on one queued run', async () => {
  await withDb(async (prisma) => {
    const first = await continueDesignInChat(prisma, {
      actorContext: actorContext(),
      body: { formState },
      slug: AGENT_DESIGNER_SLUG,
    })
    // The second click finds the thread slot held by the first run and pends
    // rather than starting a second one — the same discipline a handoff takes.
    const second = await continueDesignInChat(prisma, {
      actorContext: actorContext(),
      body: { formState },
      slug: AGENT_DESIGNER_SLUG,
    })

    assert.equal(second.channelId, first.channelId)
    assert.equal(second.started, false)
    const runs = await prisma.run.findMany({ where: { threadId: first.threadId } })
    assert.equal(runs.length, 1)
  })
})

dbTest('a deactivated member is refused, and an unknown specialist 404s', async () => {
  await withDb(async (prisma) => {
    await assert.rejects(
      () =>
        continueDesignInChat(prisma, {
          actorContext: actorContext(),
          body: { formState },
          slug: 'no-such-specialist',
        }),
      (error: unknown) =>
        error instanceof GlobalAgentChatError && error.status === 404,
    )

    await prisma.organizationMember.update({
      data: { deactivatedAt: new Date() },
      where: { organizationId_userId: { organizationId: orgId, userId } },
    })
    await assert.rejects(
      () =>
        continueDesignInChat(prisma, {
          actorContext: actorContext(),
          body: { formState },
          slug: AGENT_DESIGNER_SLUG,
        }),
      (error: unknown) =>
        error instanceof GlobalAgentChatError && error.status === 403,
    )
  })
})
