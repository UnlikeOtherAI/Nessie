import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import {
  listAgentConversationsForUser,
  loadConversationForUser,
  renameThreadForUser,
  startAgentConversation,
} from '@nessie/team-admin'

import { listChannelsForUser } from '../src/services/channels.js'
import { findThreadForUser } from '../src/services/message-read-state.js'

/**
 * Agent conversations, against real rows.
 *
 * Every property here is a *relationship between tables* — a thread's audience
 * is its channel's membership, an agent's list is two arms over bindings, a
 * preview fails closed on a `message_basis_scopes` row, a progress line is
 * gated by `run_basis_scopes` — and a fake would only restate the code. What
 * is proved is that the queries say what the rules say.
 *
 * Integration test against the local Postgres (see AGENTS.md). Every cleanup is
 * scoped to this seed and no global count is asserted: several suites create
 * and delete organisations at the same time.
 */
const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

type Seed = {
  agentId: string
  organizationId: string
  otherAgentId: string
  paAgentId: string
  paChannelA: string
  paChannelB: string
  privateChannelId: string
  projectId: string
  publicChannelId: string
  strangerChannelId: string
  teamId: string
  userA: string
  userB: string
}

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const suffix = randomUUID()
  const short = suffix.slice(0, 8)
  const org = await prisma.organization.create({ data: { name: `agent-conv ${suffix}` } })
  const project = await prisma.project.create({
    data: { name: `project ${suffix}`, organizationId: org.id },
  })
  const team = await prisma.team.create({
    data: { name: `team ${suffix}`, projectId: project.id },
  })

  const makeUser = async (label: string): Promise<string> => {
    const user = await prisma.user.create({
      data: { displayName: `${label} ${short}`, email: `${label}-${suffix}@example.test` },
    })
    await prisma.organizationMember.create({
      data: { organizationId: org.id, role: 'member', userId: user.id },
    })
    return user.id
  }
  const userA = await makeUser('a')
  const userB = await makeUser('b')

  const makeChannel = async (input: {
    label: string
    memberIds: string[]
    visibility: 'public' | 'private'
  }): Promise<string> => {
    const channel = await prisma.channel.create({
      data: {
        label: input.label,
        organizationId: org.id,
        projectId: project.id,
        slug: `${input.label}-${short}`,
        teamId: team.id,
        visibility: input.visibility,
        members: { create: input.memberIds.map((userId) => ({ userId })) },
      },
      select: { id: true },
    })
    // Every room starts with its own General thread, exactly as the channel
    // list would materialise one.
    await prisma.thread.create({ data: { channelId: channel.id, title: 'General' } })
    return channel.id
  }

  const publicChannelId = await makeChannel({
    label: 'public',
    memberIds: [userA, userB],
    visibility: 'public',
  })
  const privateChannelId = await makeChannel({
    label: 'private',
    memberIds: [userA],
    visibility: 'private',
  })
  // A room neither the agent nor (for the `channel_not_allowed` case) its
  // binding reaches. A is a member, so visibility is not what refuses it.
  const strangerChannelId = await makeChannel({
    label: 'stranger',
    memberIds: [userA],
    visibility: 'private',
  })

  const makeAgent = async (input: {
    agentKind?: 'shared' | 'personal_assistant'
    name: string
    systemManaged?: boolean
  }): Promise<string> => {
    const isAssistant = input.agentKind === 'personal_assistant'
    const agent = await prisma.agent.create({
      data: {
        agentKind: input.agentKind ?? 'shared',
        // `agents_system_managed_invariants_chk` couples the three: the
        // assistant is DM-only and acts as the person who asked.
        delegationMode: isAssistant ? 'act_as_requesting_user' : 'none',
        name: input.name,
        organizationId: org.id,
        projectId: project.id,
        surfacePolicy: isAssistant ? 'dm_only' : 'shared',
        systemManaged: input.systemManaged ?? false,
        teamId: team.id,
      },
      select: { id: true },
    })
    return agent.id
  }
  const agentId = await makeAgent({ name: `X ${short}` })
  const otherAgentId = await makeAgent({ name: `Y ${short}` })
  const paAgentId = await makeAgent({
    agentKind: 'personal_assistant',
    name: `PA ${short}`,
    systemManaged: true,
  })

  await prisma.agentBinding.createMany({
    data: [
      { agentId, channelId: publicChannelId },
      { agentId, channelId: privateChannelId },
      { agentId: otherAgentId, channelId: strangerChannelId },
    ],
  })

  // Each person's own Personal Assistant DM: single-member, system-typed, and
  // bound to the organisation-singleton assistant with no principal.
  const makePaDm = async (userId: string): Promise<string> => {
    const channel = await prisma.channel.create({
      data: {
        dmKey: `pa:${org.id}:${userId}`,
        label: 'Personal Assistant',
        organizationId: org.id,
        projectId: project.id,
        systemChannelType: 'personal_assistant',
        teamId: team.id,
        type: 'dm',
        visibility: 'private',
        members: { create: [{ userId }] },
      },
      select: { id: true },
    })
    await prisma.thread.create({ data: { channelId: channel.id, title: 'General' } })
    await prisma.agentBinding.create({ data: { agentId: paAgentId, channelId: channel.id } })
    return channel.id
  }

  return {
    agentId,
    organizationId: org.id,
    otherAgentId,
    paAgentId,
    paChannelA: await makePaDm(userA),
    paChannelB: await makePaDm(userB),
    privateChannelId,
    projectId: project.id,
    publicChannelId,
    strangerChannelId,
    teamId: team.id,
    userA,
    userB,
  }
}

const cleanup = async (prisma: PrismaClient, s: Seed): Promise<void> => {
  const channelIds = [
    s.publicChannelId,
    s.privateChannelId,
    s.strangerChannelId,
    s.paChannelA,
    s.paChannelB,
  ]
  const threads = await prisma.thread.findMany({
    where: { channelId: { in: channelIds } },
    select: { id: true },
  })
  const threadIds = threads.map((thread) => thread.id)
  await prisma.runThinkingChunk.deleteMany({ where: { run: { threadId: { in: threadIds } } } })
  await prisma.runBasisScope.deleteMany({ where: { run: { threadId: { in: threadIds } } } })
  await prisma.run.deleteMany({ where: { threadId: { in: threadIds } } })
  await prisma.messageBasisScope.deleteMany({
    where: { message: { threadId: { in: threadIds } } },
  })
  await prisma.message.deleteMany({ where: { threadId: { in: threadIds } } })
  await prisma.thread.deleteMany({ where: { id: { in: threadIds } } })
  await prisma.agentBinding.deleteMany({ where: { channelId: { in: channelIds } } })
  await prisma.channelMember.deleteMany({ where: { channelId: { in: channelIds } } })
  await prisma.channel.deleteMany({ where: { id: { in: channelIds } } })
  await prisma.agent.deleteMany({
    where: { id: { in: [s.agentId, s.otherAgentId, s.paAgentId] } },
  })
  await prisma.team.deleteMany({ where: { id: s.teamId } })
  await prisma.project.deleteMany({ where: { id: s.projectId } })
  await prisma.organizationMember.deleteMany({ where: { organizationId: s.organizationId } })
  await prisma.user.deleteMany({ where: { id: { in: [s.userA, s.userB] } } })
  await prisma.organization.deleteMany({ where: { id: s.organizationId } })
}

const postMessage = async (
  prisma: PrismaClient,
  input: { content: string; createdAt: Date; threadId: string; userId: string },
): Promise<string> => {
  const message = await prisma.message.create({
    data: {
      content: input.content,
      createdAt: input.createdAt,
      role: 'user',
      threadId: input.threadId,
      userId: input.userId,
    },
    select: { id: true },
  })
  return message.id
}

const generalThreadId = async (prisma: PrismaClient, channelId: string): Promise<string> => {
  const thread = await prisma.thread.findFirstOrThrow({
    where: { agentId: null, channelId },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  })
  return thread.id
}

const withSeed = async (
  body: (prisma: PrismaClient, s: Seed) => Promise<void>,
): Promise<void> => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    await body(prisma, s)
  } finally {
    await cleanup(prisma, s)
    await prisma.$disconnect()
  }
}

runDatabaseTest('three conversations are three threads, and General is untouched', async () => {
  await withSeed(async (prisma, s) => {
    const titles = ['Pricing review', undefined, undefined]
    const messages = [undefined, 'Draft   the   brief\nsecond line', undefined]
    const created: string[] = []
    for (const [index, title] of titles.entries()) {
      const outcome = await startAgentConversation(prisma, {
        agentId: s.agentId,
        channelId: s.privateChannelId,
        message: messages[index],
        organizationId: s.organizationId,
        startedByUserId: s.userA,
        title,
      })
      assert.equal(outcome.kind, 'created')
      if (outcome.kind !== 'created') return
      created.push(outcome.thread.id)
    }

    assert.equal(new Set(created).size, 3)
    const rows = await prisma.thread.findMany({
      where: { id: { in: created } },
      select: { agentId: true, id: true, startedByUserId: true, title: true },
      orderBy: { createdAt: 'asc' },
    })
    for (const row of rows) {
      assert.equal(row.agentId, s.agentId)
      assert.equal(row.startedByUserId, s.userA)
    }
    assert.deepEqual(
      rows.map((row) => row.title),
      ['Pricing review', 'Draft the brief', 'New conversation'],
    )

    // The room's feed is still the room's feed.
    const channels = await listChannelsForUser(prisma, s.userA, s.organizationId)
    const privateRecord = channels.find((channel) => channel.id === s.privateChannelId)
    assert.ok(privateRecord)
    assert.equal(
      privateRecord.defaultThreadId,
      await generalThreadId(prisma, s.privateChannelId),
    )
    assert.equal(created.includes(privateRecord.defaultThreadId), false)
  })
})

runDatabaseTest('the list is scoped to the room, and ordered by activity', async () => {
  await withSeed(async (prisma, s) => {
    const started = await startAgentConversation(prisma, {
      agentId: s.agentId,
      channelId: s.privateChannelId,
      organizationId: s.organizationId,
      startedByUserId: s.userA,
      title: 'Private work',
    })
    assert.equal(started.kind, 'created')
    if (started.kind !== 'created') return

    // Timestamps are `timestamp(3)` and Postgres rounds into them, so back-to-
    // back inserts tie. Order that is asserted is set explicitly. Every thread
    // here carries a message, so the order under test is activity and nothing
    // else (an empty thread's own rule has its own case below).
    await postMessage(prisma, {
      content: 'oldest',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      threadId: await generalThreadId(prisma, s.publicChannelId),
      userId: s.userA,
    })
    await postMessage(prisma, {
      content: 'in the middle',
      createdAt: new Date('2026-01-02T00:00:00.000Z'),
      threadId: await generalThreadId(prisma, s.privateChannelId),
      userId: s.userA,
    })
    await postMessage(prisma, {
      content: 'newest',
      createdAt: new Date('2026-01-03T00:00:00.000Z'),
      threadId: started.thread.id,
      userId: s.userA,
    })

    const forA = await listAgentConversationsForUser(prisma, {
      agentId: s.agentId,
      organizationId: s.organizationId,
      userId: s.userA,
    })
    assert.ok(forA)
    assert.deepEqual(
      forA.data.map((row) => row.title),
      ['Private work', 'private', 'public'],
    )
    assert.deepEqual(
      forA.data.map((row) => row.isGeneral),
      [false, true, true],
    )
    assert.equal(forA.data[0]?.lastMessagePreview, 'newest')
    assert.equal(forA.data[0]?.startedByUserId, s.userA)

    // B is not in the private room, so neither its conversation nor its
    // General row exists as far as B is concerned.
    const forB = await listAgentConversationsForUser(prisma, {
      agentId: s.agentId,
      organizationId: s.organizationId,
      userId: s.userB,
    })
    assert.ok(forB)
    assert.deepEqual(forB.data.map((row) => row.title), ['public'])

    // The same refusal from the read behind the card.
    assert.equal(
      await loadConversationForUser(prisma, {
        organizationId: s.organizationId,
        threadId: started.thread.id,
        userId: s.userB,
      }),
      null,
    )
    assert.ok(await loadConversationForUser(prisma, {
      organizationId: s.organizationId,
      threadId: started.thread.id,
      userId: s.userA,
    }))
  })
})

runDatabaseTest('a conversation with nothing in it sorts by when it was opened', async () => {
  await withSeed(async (prisma, s) => {
    // A room with history, and a conversation opened just now with nothing in
    // it. The empty one is what the person just pressed a button to make, so
    // it belongs at the top of the list they pressed it from — its own
    // `lastActivityAt` is still honestly null.
    await postMessage(prisma, {
      content: 'yesterday',
      createdAt: new Date(Date.now() - 86_400_000),
      threadId: await generalThreadId(prisma, s.publicChannelId),
      userId: s.userA,
    })
    const started = await startAgentConversation(prisma, {
      agentId: s.agentId,
      channelId: s.publicChannelId,
      organizationId: s.organizationId,
      startedByUserId: s.userA,
      title: 'Just opened',
    })
    assert.equal(started.kind, 'created')

    const page = await listAgentConversationsForUser(prisma, {
      agentId: s.agentId,
      organizationId: s.organizationId,
      userId: s.userB,
    })
    assert.ok(page)
    assert.deepEqual(page.data.map((row) => row.title), ['Just opened', 'public'])
    assert.equal(page.data[0]?.lastActivityAt, null)
    assert.equal(page.data[0]?.lastMessagePreview, null)
  })
})

runDatabaseTest('an agent the viewer cannot see at all is not found', async () => {
  await withSeed(async (prisma, s) => {
    await prisma.agentBinding.deleteMany({
      where: { agentId: s.agentId, channelId: s.publicChannelId },
    })
    // B now reaches the agent through nothing: it is bound only to a private
    // room B is not in, and B stewards nothing.
    assert.equal(
      await listAgentConversationsForUser(prisma, {
        agentId: s.agentId,
        organizationId: s.organizationId,
        userId: s.userB,
      }),
      null,
    )
    // A still sees it, so the 404 is about the viewer and not about the agent.
    const forA = await listAgentConversationsForUser(prisma, {
      agentId: s.agentId,
      organizationId: s.organizationId,
      userId: s.userA,
    })
    assert.ok(forA)
    assert.deepEqual(forA.data.map((row) => row.title), ['private'])
  })
})

runDatabaseTest('each person sees their own assistant conversations, never another’s', async () => {
  await withSeed(async (prisma, s) => {
    const forEach = await Promise.all([
      startAgentConversation(prisma, {
        agentId: s.paAgentId,
        organizationId: s.organizationId,
        startedByUserId: s.userA,
        title: 'A’s errand',
      }),
      startAgentConversation(prisma, {
        agentId: s.paAgentId,
        organizationId: s.organizationId,
        startedByUserId: s.userB,
        title: 'B’s errand',
      }),
    ])
    for (const outcome of forEach) assert.equal(outcome.kind, 'created')
    // No channel was named, so each landed in its own person's assistant DM.
    assert.equal(
      forEach[0].kind === 'created' ? forEach[0].thread.channelId : null,
      s.paChannelA,
    )
    assert.equal(
      forEach[1].kind === 'created' ? forEach[1].thread.channelId : null,
      s.paChannelB,
    )

    const forA = await listAgentConversationsForUser(prisma, {
      agentId: s.paAgentId,
      organizationId: s.organizationId,
      userId: s.userA,
    })
    const forB = await listAgentConversationsForUser(prisma, {
      agentId: s.paAgentId,
      organizationId: s.organizationId,
      userId: s.userB,
    })
    assert.ok(forA)
    assert.ok(forB)
    assert.deepEqual(forA.data.map((row) => row.title).sort(), ['A’s errand', 'Personal Assistant'])
    assert.deepEqual(forB.data.map((row) => row.title).sort(), ['B’s errand', 'Personal Assistant'])
    assert.deepEqual(
      forA.data.map((row) => row.channel.id).filter((id) => id === s.paChannelB),
      [],
    )
  })
})

runDatabaseTest('a room the agent is not in refuses, and no room at all says so', async () => {
  await withSeed(async (prisma, s) => {
    assert.deepEqual(
      await startAgentConversation(prisma, {
        agentId: s.agentId,
        channelId: s.strangerChannelId,
        organizationId: s.organizationId,
        startedByUserId: s.userA,
      }),
      { kind: 'channel_not_allowed' },
    )

    // A channel that does not exist is the same answer: the caller named a
    // room, and it is not one they may start here.
    assert.deepEqual(
      await startAgentConversation(prisma, {
        agentId: s.agentId,
        channelId: randomUUID(),
        organizationId: s.organizationId,
        startedByUserId: s.userA,
      }),
      { kind: 'channel_not_allowed' },
    )

    // The other agent is bound only to a room B cannot see, so B has nowhere
    // to start — and the door does not invent one.
    assert.deepEqual(
      await startAgentConversation(prisma, {
        agentId: s.otherAgentId,
        organizationId: s.organizationId,
        startedByUserId: s.userB,
      }),
      { kind: 'no_room' },
    )

    assert.deepEqual(
      await startAgentConversation(prisma, {
        agentId: randomUUID(),
        organizationId: s.organizationId,
        startedByUserId: s.userA,
      }),
      { kind: 'agent_not_found' },
    )
  })
})

runDatabaseTest('renaming: the starter may, a bystander may not, General cannot', async () => {
  await withSeed(async (prisma, s) => {
    const started = await startAgentConversation(prisma, {
      agentId: s.agentId,
      channelId: s.publicChannelId,
      organizationId: s.organizationId,
      startedByUserId: s.userA,
      title: 'Before',
    })
    assert.equal(started.kind, 'created')
    if (started.kind !== 'created') return

    assert.equal(
      (await renameThreadForUser(prisma, {
        organizationId: s.organizationId,
        threadId: started.thread.id,
        title: 'By a bystander',
        userId: s.userB,
      })).kind,
      'forbidden',
    )
    assert.equal(
      (await renameThreadForUser(prisma, {
        organizationId: s.organizationId,
        threadId: started.thread.id,
        title: 'After',
        userId: s.userA,
      })).kind,
      'renamed',
    )
    assert.equal(
      (await prisma.thread.findUniqueOrThrow({
        where: { id: started.thread.id },
        select: { title: true },
      })).title,
      'After',
    )

    assert.equal(
      (await renameThreadForUser(prisma, {
        organizationId: s.organizationId,
        threadId: await generalThreadId(prisma, s.publicChannelId),
        title: 'Not this one',
        userId: s.userA,
      })).kind,
      'title_fixed',
    )

    // A thread the caller cannot see is missing, not forbidden.
    assert.equal(
      (await renameThreadForUser(prisma, {
        organizationId: s.organizationId,
        threadId: await generalThreadId(prisma, s.privateChannelId),
        title: 'Nor this',
        userId: s.userB,
      })).kind,
      'not_found',
    )
  })
})

runDatabaseTest('a preview fails closed on a restricted newest message', async () => {
  await withSeed(async (prisma, s) => {
    const started = await startAgentConversation(prisma, {
      agentId: s.agentId,
      channelId: s.privateChannelId,
      organizationId: s.organizationId,
      startedByUserId: s.userA,
      title: 'Restricted',
    })
    assert.equal(started.kind, 'created')
    if (started.kind !== 'created') return

    await postMessage(prisma, {
      content: 'plainly readable',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      threadId: started.thread.id,
      userId: s.userA,
    })
    const readable = await loadConversationForUser(prisma, {
      organizationId: s.organizationId,
      threadId: started.thread.id,
      userId: s.userA,
    })
    assert.equal(readable?.lastMessagePreview, 'plainly readable')

    const restricted = await postMessage(prisma, {
      content: 'the restricted answer',
      createdAt: new Date('2026-01-02T00:00:00.000Z'),
      threadId: started.thread.id,
      userId: s.userA,
    })
    await prisma.messageBasisScope.create({
      data: {
        messageId: restricted,
        organizationId: s.organizationId,
        scopeId: s.userA,
        scopeType: 'user',
      },
    })

    const withheld = await loadConversationForUser(prisma, {
      organizationId: s.organizationId,
      threadId: started.thread.id,
      userId: s.userA,
    })
    // Even for the person the basis names: a preview never redacts, and the
    // newest message is the only one it may quote.
    assert.equal(withheld?.lastMessagePreview, null)
    assert.equal(withheld?.lastActivityAt, new Date('2026-01-02T00:00:00.000Z').toISOString())
  })
})

runDatabaseTest('an active run reports what it is doing, and withholds it when it must', async () => {
  await withSeed(async (prisma, s) => {
    const started = await startAgentConversation(prisma, {
      agentId: s.agentId,
      channelId: s.publicChannelId,
      organizationId: s.organizationId,
      startedByUserId: s.userA,
      title: 'Running',
    })
    assert.equal(started.kind, 'created')
    if (started.kind !== 'created') return

    const finished = await prisma.run.create({
      data: {
        agentId: s.agentId,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        finishedAt: new Date('2026-01-01T00:01:00.000Z'),
        status: 'failed',
        threadId: started.thread.id,
      },
      select: { id: true },
    })
    const running = await prisma.run.create({
      data: {
        agentId: s.agentId,
        createdAt: new Date('2026-01-02T00:00:00.000Z'),
        startedAt: new Date('2026-01-02T00:00:01.000Z'),
        status: 'running',
        threadId: started.thread.id,
      },
      select: { id: true },
    })
    await prisma.runThinkingChunk.create({
      data: { content: 'older thought', kind: 'reasoning', runId: running.id },
    })
    await prisma.runThinkingChunk.create({
      data: { content: 'reading the   pricing sheet', kind: 'reasoning', runId: running.id },
    })

    const visible = await loadConversationForUser(prisma, {
      organizationId: s.organizationId,
      threadId: started.thread.id,
      userId: s.userA,
    })
    assert.equal(visible?.activeRun?.id, running.id)
    assert.equal(visible?.activeRun?.status, 'running')
    assert.equal(visible?.activeRun?.progressLine, 'reading the pricing sheet')
    assert.equal(visible?.activeRun?.startedAt, new Date('2026-01-02T00:00:01.000Z').toISOString())
    // The last terminal run, not the live one.
    assert.equal(visible?.lastRunOutcome, 'failed')
    assert.equal(finished.id !== running.id, true)

    // A basis B does not satisfy withholds the thought, not the run: the row
    // still says something is happening, exactly as the thinking bubble does.
    await prisma.runBasisScope.create({
      data: {
        organizationId: s.organizationId,
        runId: running.id,
        scopeId: s.userA,
        scopeType: 'user',
      },
    })
    const withheld = await loadConversationForUser(prisma, {
      organizationId: s.organizationId,
      threadId: started.thread.id,
      userId: s.userB,
    })
    assert.equal(withheld?.activeRun?.id, running.id)
    assert.equal(withheld?.activeRun?.progressLine, null)
  })
})

runDatabaseTest('a room’s unread badge counts its conversations too', async () => {
  await withSeed(async (prisma, s) => {
    const started = await startAgentConversation(prisma, {
      agentId: s.agentId,
      channelId: s.publicChannelId,
      organizationId: s.organizationId,
      startedByUserId: s.userA,
      title: 'Somewhere else',
    })
    assert.equal(started.kind, 'created')
    if (started.kind !== 'created') return

    await postMessage(prisma, {
      content: 'inside the conversation',
      createdAt: new Date('2026-01-04T00:00:00.000Z'),
      threadId: started.thread.id,
      userId: s.userA,
    })

    const channels = await listChannelsForUser(prisma, s.userB, s.organizationId)
    const publicRecord = channels.find((channel) => channel.id === s.publicChannelId)
    assert.ok(publicRecord)
    assert.equal(publicRecord.unreadCount, 1)
    assert.equal(publicRecord.defaultThreadId, await generalThreadId(prisma, s.publicChannelId))
  })
})

runDatabaseTest('a conversation thread is reachable by the same predicate as any other', async () => {
  await withSeed(async (prisma, s) => {
    const started = await startAgentConversation(prisma, {
      agentId: s.agentId,
      channelId: s.privateChannelId,
      organizationId: s.organizationId,
      startedByUserId: s.userA,
      title: 'Reachability',
    })
    assert.equal(started.kind, 'created')
    if (started.kind !== 'created') return

    assert.ok(await findThreadForUser(prisma, started.thread.id, s.userA, s.organizationId))
    assert.equal(
      await findThreadForUser(prisma, started.thread.id, s.userB, s.organizationId),
      null,
    )
  })
})

runDatabaseTest('the list pages by activity without repeating a row', async () => {
  await withSeed(async (prisma, s) => {
    for (const channelId of [s.publicChannelId, s.privateChannelId]) {
      await postMessage(prisma, {
        content: 'long ago',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        threadId: await generalThreadId(prisma, channelId),
        userId: s.userA,
      })
    }
    for (const index of [0, 1, 2, 3]) {
      const outcome = await startAgentConversation(prisma, {
        agentId: s.agentId,
        channelId: s.privateChannelId,
        organizationId: s.organizationId,
        startedByUserId: s.userA,
        title: `Conversation ${index}`,
      })
      assert.equal(outcome.kind, 'created')
      if (outcome.kind !== 'created') return
      await postMessage(prisma, {
        content: `turn ${index}`,
        createdAt: new Date(`2026-02-0${index + 1}T00:00:00.000Z`),
        threadId: outcome.thread.id,
        userId: s.userA,
      })
    }

    const first = await listAgentConversationsForUser(prisma, {
      agentId: s.agentId,
      limit: 2,
      organizationId: s.organizationId,
      userId: s.userA,
    })
    assert.ok(first)
    assert.deepEqual(first.data.map((row) => row.title), ['Conversation 3', 'Conversation 2'])
    assert.equal(first.meta.hasMore, true)
    assert.ok(first.meta.nextCursor)

    const second = await listAgentConversationsForUser(prisma, {
      agentId: s.agentId,
      cursor: first.meta.nextCursor ?? undefined,
      limit: 2,
      organizationId: s.organizationId,
      userId: s.userA,
    })
    assert.ok(second)
    assert.deepEqual(second.data.map((row) => row.title), ['Conversation 1', 'Conversation 0'])
    const seen = new Set([...first.data, ...second.data].map((row) => row.id))
    assert.equal(seen.size, 4)
  })
})
