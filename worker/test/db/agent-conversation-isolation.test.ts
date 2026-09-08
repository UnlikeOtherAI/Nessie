import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import {
  parseOrganizationId,
  parseProjectId,
  parseTeamId,
  type AuthorizedActionContext,
} from '@nessie/schemas'

import { claimThreadRunOrPend } from '../../src/run/thread-serialization.js'
import { loadConversation } from '../../src/run/execute/prompt.js'
import { createConsumedSourceSink } from '../../src/run/execute/disclosure-basis.js'
import {
  assertGlobalQueuesQuiet,
  deleteThreadQueueJobs,
  runDatabaseTest,
} from './support.js'

/**
 * Many conversations with one agent, isolated — in the database, where the two
 * properties actually live (docs/plans/2026-09-08-agent-conversations.md §2).
 *
 * The design turns on a claim that no unit test can make: run serialisation is
 * keyed on `(agent, principal, thread)`, so two conversations with the SAME
 * agent in the SAME room run at the same time while a second message inside one
 * of them still pends — and the model's window is keyed on `threadId`, so
 * neither conversation can see the other's turns. Both are consequences of real
 * rows and real indexes, and both would be silently untrue if a conversation
 * were anything but a `Thread`.
 *
 * Scoped to its own seed throughout, and it asserts no global count: the sweep
 * and the drain are global pollers (see `./support.ts`).
 */

type Seed = {
  agentId: string
  channelId: string
  generalThreadId: string
  organizationId: string
  projectId: string
  teamId: string
  threadOneId: string
  threadTwoId: string
  userId: string
}

const seedTeam = async (prisma: PrismaClient): Promise<Seed> => {
  const org = await prisma.organization.create({
    data: { name: `agent-conv ${randomUUID()}` },
  })
  const project = await prisma.project.create({
    data: { name: 'p', organizationId: org.id },
  })
  const team = await prisma.team.create({ data: { name: 't', projectId: project.id } })
  const user = await prisma.user.create({
    data: { email: `agent-conv-${randomUUID()}@example.com`, displayName: 'Owner' },
  })
  const channel = await prisma.channel.create({
    data: {
      label: 'c',
      slug: `c-${randomUUID()}`,
      organizationId: org.id,
      projectId: project.id,
      teamId: team.id,
    },
  })
  const agent = await prisma.agent.create({ data: { name: 'X', organizationId: org.id } })
  // The room's own thread, plus two conversations with the same agent in it.
  const general = await prisma.thread.create({
    data: { channelId: channel.id, title: 'General' },
  })
  const one = await prisma.thread.create({
    data: {
      agentId: agent.id,
      channelId: channel.id,
      startedByUserId: user.id,
      title: 'Pricing page',
    },
  })
  const two = await prisma.thread.create({
    data: {
      agentId: agent.id,
      channelId: channel.id,
      startedByUserId: user.id,
      title: 'Competitor scan',
    },
  })

  return {
    agentId: agent.id,
    channelId: channel.id,
    generalThreadId: general.id,
    organizationId: org.id,
    projectId: project.id,
    teamId: team.id,
    threadOneId: one.id,
    threadTwoId: two.id,
    userId: user.id,
  }
}

const cleanup = async (prisma: PrismaClient, seed: Seed): Promise<void> => {
  for (const threadId of [seed.threadOneId, seed.threadTwoId, seed.generalThreadId]) {
    await deleteThreadQueueJobs(prisma, threadId)
    await prisma.runThreadPendingMessage.deleteMany({ where: { threadId } })
  }
  await prisma.taskEvent.deleteMany({
    where: { task: { organizationId: seed.organizationId } },
  })
  await prisma.task.deleteMany({ where: { organizationId: seed.organizationId } })
  await prisma.message.deleteMany({ where: { thread: { channelId: seed.channelId } } })
  await prisma.run.deleteMany({ where: { thread: { channelId: seed.channelId } } })
  await prisma.thread.deleteMany({ where: { channelId: seed.channelId } })
  await prisma.channel.deleteMany({ where: { id: seed.channelId } })
  await prisma.agent.deleteMany({ where: { id: seed.agentId } })
  await prisma.team.deleteMany({ where: { id: seed.teamId } })
  await prisma.project.deleteMany({ where: { id: seed.projectId } })
  await prisma.user.deleteMany({ where: { id: seed.userId } })
  await prisma.organization.deleteMany({ where: { id: seed.organizationId } })
}

const actorFor = (seed: Seed): AuthorizedActionContext => ({
  actor: { actorType: 'user', actorId: seed.userId, roles: ['owner'] },
  tenant: {
    organizationId: parseOrganizationId(seed.organizationId),
    projectId: parseProjectId(seed.projectId),
    teamId: parseTeamId(seed.teamId),
  },
  actionContext: {
    requestId: `req-${randomUUID()}`,
    teamId: parseTeamId(seed.teamId),
  },
})

const postMessage = async (
  prisma: PrismaClient,
  seed: Seed,
  threadId: string,
  content: string,
): Promise<{ id: string; content: string }> =>
  prisma.message.create({
    data: { content, role: 'user', threadId, userId: seed.userId },
    select: { id: true, content: true },
  })

/** The orchestrate.decide reply path, reduced to what serialisation observes. */
const claimReply = async (
  prisma: PrismaClient,
  seed: Seed,
  threadId: string,
  message: { id: string; content: string },
): Promise<'claimed' | 'pended' | 'duplicate'> =>
  prisma.$transaction(async (tx) => {
    const claim = await claimThreadRunOrPend(tx, {
      agentId: seed.agentId,
      threadId,
      pending: {
        actorContext: actorFor(seed),
        channelId: seed.channelId,
        interactive: true,
        messageId: message.id,
      },
    })
    if (claim !== 'claimed') return claim
    const run = await tx.run.create({
      data: {
        agentId: seed.agentId,
        status: 'pending',
        threadId,
        triggerMessageId: message.id,
      },
      select: { id: true },
    })
    await tx.task.create({
      data: {
        agentId: seed.agentId,
        organizationId: seed.organizationId,
        purpose: message.content.slice(0, 200),
        runId: run.id,
        status: 'inbox',
      },
      select: { id: true },
    })
    return 'claimed'
  })

runDatabaseTest(
  'two conversations with one agent run at once; a second message in one pends',
  async (t) => {
    const prisma = new PrismaClient()
    await assertGlobalQueuesQuiet(prisma)
    const seed = await seedTeam(prisma)
    t.after(async () => {
      await cleanup(prisma, seed)
      await prisma.$disconnect()
    })

    const first = await postMessage(prisma, seed, seed.threadOneId, 'sentinel-one-alpha')
    const second = await postMessage(prisma, seed, seed.threadTwoId, 'sentinel-two-alpha')

    // The whole point of keying the slot on the thread: same agent, same room,
    // two conversations, both claimed. Before conversations existed there was
    // one thread per channel, so the second of these could only ever pend.
    assert.equal(await claimReply(prisma, seed, seed.threadOneId, first), 'claimed')
    assert.equal(await claimReply(prisma, seed, seed.threadTwoId, second), 'claimed')

    const runs = await prisma.run.findMany({
      where: { agentId: seed.agentId, thread: { channelId: seed.channelId } },
      orderBy: { createdAt: 'asc' },
      select: { threadId: true },
    })
    assert.deepEqual(
      runs.map((run) => run.threadId).sort(),
      [seed.threadOneId, seed.threadTwoId].sort(),
    )

    // The invariant is unchanged INSIDE a conversation: a further message on T1
    // batches behind the run already in flight there.
    const third = await postMessage(prisma, seed, seed.threadOneId, 'sentinel-one-beta')
    assert.equal(await claimReply(prisma, seed, seed.threadOneId, third), 'pended')
    const pendings = await prisma.runThreadPendingMessage.findMany({
      where: { agentId: seed.agentId, threadId: seed.threadOneId },
      select: { messageId: true },
    })
    assert.deepEqual(pendings.map((pending) => pending.messageId), [third.id])
    // …and it did not spill into the other conversation.
    assert.equal(
      await prisma.runThreadPendingMessage.count({
        where: { agentId: seed.agentId, threadId: seed.threadTwoId },
      }),
      0,
    )
  },
)

runDatabaseTest('a conversation\'s window holds only its own turns', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedTeam(prisma)
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })

  await postMessage(prisma, seed, seed.threadOneId, 'sentinel-one-alpha')
  await postMessage(prisma, seed, seed.threadTwoId, 'sentinel-two-alpha')
  await postMessage(prisma, seed, seed.generalThreadId, 'sentinel-general-alpha')

  const window = await loadConversation(prisma, {
    consumedSources: createConsumedSourceSink(),
    organizationId: seed.organizationId,
    threadId: seed.threadTwoId,
    viewer: { kind: 'autonomous' },
  })

  const contents = window.map((message) => message.content)
  assert.deepEqual(contents, ['sentinel-two-alpha'])
  // Stated the other way round too, because "only its own" is the claim that
  // would fail quietly: the room's General turns are as absent as the sibling
  // conversation's.
  assert.equal(contents.some((content) => content.includes('sentinel-one')), false)
  assert.equal(contents.some((content) => content.includes('sentinel-general')), false)
})
