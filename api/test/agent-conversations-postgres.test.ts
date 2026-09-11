import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import {
  DEFAULT_CONVERSATION_TITLE,
  listAgentConversationsForUser,
  loadConversationForUser,
  renameThreadForUser,
  startAgentConversation,
} from '@nessie/team-admin'

import { listChannelsForUser } from '../src/services/channels.js'
import { createThreadMessage } from '../src/services/message-create.js'
import { findThreadForUser } from '../src/services/message-read-state.js'

/**
 * Agent conversations, against real rows.
 *
 * Every property here is a *relationship between tables* — a thread's audience
 * is its channel's membership, an agent's list is two arms over bindings, a
 * preview is the newest message the viewer satisfies the `message_basis_scopes`
 * of, a progress line is gated by `run_basis_scopes`, a conversation's title is
 * a conditional update racing its own first message — and a fake would only
 * restate the code. What is proved is that the queries say what the rules say.
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
    // Stored titles: the third had neither a title nor an opening line, so it
    // is unnamed — NULL, not the words a person might type. The record and the
    // outcome both project `DEFAULT_CONVERSATION_TITLE` for it.
    assert.deepEqual(
      rows.map((row) => row.title),
      ['Pricing review', 'Draft the brief', null],
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

    // The other agent is bound only to a room B cannot see — so B cannot see
    // the agent either, and "nowhere to start" would confirm it exists. The
    // read answers 404 for exactly this pair; the write says the same thing.
    assert.deepEqual(
      await startAgentConversation(prisma, {
        agentId: s.otherAgentId,
        organizationId: s.organizationId,
        startedByUserId: s.userB,
      }),
      { kind: 'agent_not_found' },
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

/**
 * The write says exactly what the read says about an agent's existence.
 *
 * `no_room` (409) and `channel_not_allowed` (403) are both "that agent is real,
 * and here is why this room will not do" — answers only somebody who can see
 * the agent may have. For everybody else the outcome is the one
 * `listAgentConversationsForUser` gives: not found.
 */
runDatabaseTest('a refusal never confirms an agent the caller cannot see', async () => {
  await withSeed(async (prisma, s) => {
    // Naming a room does not change the answer: B cannot see the other agent,
    // so the room is not what is wrong.
    assert.deepEqual(
      await startAgentConversation(prisma, {
        agentId: s.otherAgentId,
        channelId: s.strangerChannelId,
        organizationId: s.organizationId,
        startedByUserId: s.userB,
      }),
      { kind: 'agent_not_found' },
    )
    assert.equal(
      await listAgentConversationsForUser(prisma, {
        agentId: s.otherAgentId,
        organizationId: s.organizationId,
        userId: s.userB,
      }),
      null,
    )

    // A *visible* agent keeps the room-shaped answer. Archiving both of its
    // rooms leaves A able to see it working and unable to post anywhere it is.
    await prisma.channel.updateMany({
      where: { id: { in: [s.publicChannelId, s.privateChannelId] } },
      data: { archivedAt: new Date() },
    })
    assert.deepEqual(
      await startAgentConversation(prisma, {
        agentId: s.agentId,
        organizationId: s.organizationId,
        startedByUserId: s.userA,
      }),
      { kind: 'no_room' },
    )
    await prisma.channel.updateMany({
      where: { id: { in: [s.publicChannelId, s.privateChannelId] } },
      data: { archivedAt: null },
    })
  })
})

/**
 * A room bound to two agents appears in both their lists, and each list is
 * about its own agent: the row names the agent it is listed under, and the run
 * it reports is that agent's run in that thread. Keyed on `(thread, agent)`,
 * never on the thread alone — one General thread holds both agents' work.
 */
runDatabaseTest('a General row names the agent whose list it is, with that agent’s run', async () => {
  await withSeed(async (prisma, s) => {
    // `agentId` was bound to the public room first, so the oldest-binding rule
    // would name every General row of that room after it — in both lists.
    await prisma.agentBinding.create({
      data: { agentId: s.otherAgentId, channelId: s.publicChannelId },
    })
    const generalId = await generalThreadId(prisma, s.publicChannelId)

    const generalRowFor = async (agentId: string) => {
      const page = await listAgentConversationsForUser(prisma, {
        agentId,
        organizationId: s.organizationId,
        userId: s.userA,
      })
      assert.ok(page)
      return page.data.find((row) => row.isGeneral && row.channel.id === s.publicChannelId)
    }

    assert.equal((await generalRowFor(s.agentId))?.agentId, s.agentId)
    assert.equal((await generalRowFor(s.otherAgentId))?.agentId, s.otherAgentId)

    // One run in that thread, belonging to the agent bound first.
    const firstRun = await prisma.run.create({
      data: { agentId: s.agentId, status: 'running', threadId: generalId },
      select: { id: true },
    })
    assert.equal((await generalRowFor(s.agentId))?.activeRun?.id, firstRun.id)
    // The newest active run in the thread is not this agent's, so its row says
    // nothing is running — because for it, nothing is.
    assert.equal((await generalRowFor(s.otherAgentId))?.activeRun, null)

    // A newer run for the second agent does not move the first agent's row.
    const secondRun = await prisma.run.create({
      data: { agentId: s.otherAgentId, status: 'running', threadId: generalId },
      select: { id: true },
    })
    assert.equal((await generalRowFor(s.agentId))?.activeRun?.id, firstRun.id)
    assert.equal((await generalRowFor(s.otherAgentId))?.activeRun?.id, secondRun.id)

    // The same pairing decides how the last run ended.
    await prisma.run.update({ where: { id: firstRun.id }, data: { status: 'failed' } })
    assert.equal((await generalRowFor(s.agentId))?.lastRunOutcome, 'failed')
    assert.equal((await generalRowFor(s.otherAgentId))?.lastRunOutcome, null)
  })
})

runDatabaseTest('with no room named, the most recently active bound room wins', async () => {
  await withSeed(async (prisma, s) => {
    // A has no DM with this agent, so the choice is between its two rooms.
    // `private` was created after `public`, so with nothing said anywhere the
    // newest room is the answer.
    const quiet = await startAgentConversation(prisma, {
      agentId: s.agentId,
      organizationId: s.organizationId,
      startedByUserId: s.userA,
    })
    assert.equal(quiet.kind, 'created')
    if (quiet.kind !== 'created') return
    assert.equal(quiet.thread.channelId, s.privateChannelId)

    // One message in the older room, and it is the room being worked in.
    await postMessage(prisma, {
      content: 'about the pricing page',
      createdAt: new Date('2026-02-01T00:00:00.000Z'),
      threadId: await generalThreadId(prisma, s.publicChannelId),
      userId: s.userA,
    })
    const active = await startAgentConversation(prisma, {
      agentId: s.agentId,
      organizationId: s.organizationId,
      startedByUserId: s.userA,
    })
    assert.equal(active.kind, 'created')
    if (active.kind !== 'created') return
    assert.equal(active.thread.channelId, s.publicChannelId)
  })
})

runDatabaseTest('a home DM is enough to see an agent the entitlement excludes', async () => {
  await withSeed(async (prisma, s) => {
    // The Personal Assistant is system-managed, so `buildVisibleAgentWhere`
    // refuses it for everybody — and A obviously can see their own assistant.
    // The home-DM arm the default-room resolution already understands is what
    // keeps a room-shaped mistake a room-shaped answer.
    assert.deepEqual(
      await startAgentConversation(prisma, {
        agentId: s.paAgentId,
        channelId: s.publicChannelId,
        organizationId: s.organizationId,
        startedByUserId: s.userA,
      }),
      { kind: 'channel_not_allowed' },
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

runDatabaseTest('a preview is null when the viewer does not satisfy the newest basis', async () => {
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
    // B's own DM as the lineage: a scope A holds no membership in, so A does
    // not satisfy it.
    await prisma.messageBasisScope.create({
      data: {
        messageId: restricted,
        organizationId: s.organizationId,
        scopeId: s.paChannelB,
        scopeType: 'channel',
      },
    })

    const withheld = await loadConversationForUser(prisma, {
      organizationId: s.organizationId,
      threadId: started.thread.id,
      userId: s.userA,
    })
    // Null, not the older readable line underneath it: reaching past the
    // withheld turn would tell A that something newer exists.
    assert.equal(withheld?.lastMessagePreview, null)
    assert.equal(withheld?.lastActivityAt, new Date('2026-01-02T00:00:00.000Z').toISOString())
  })
})

runDatabaseTest('a preview is present when the viewer satisfies the newest basis', async () => {
  await withSeed(async (prisma, s) => {
    const started = await startAgentConversation(prisma, {
      agentId: s.agentId,
      channelId: s.publicChannelId,
      organizationId: s.organizationId,
      startedByUserId: s.userA,
      title: 'Asked through the assistant',
    })
    assert.equal(started.kind, 'created')
    if (started.kind !== 'created') return

    const answered = await postMessage(prisma, {
      content: 'here is what I found',
      createdAt: new Date('2026-01-02T00:00:00.000Z'),
      threadId: started.thread.id,
      userId: s.userA,
    })
    // The lineage every assistant-started conversation's reply carries: the
    // requester's own Personal Assistant DM. A is its only member.
    await prisma.messageBasisScope.create({
      data: {
        messageId: answered,
        organizationId: s.organizationId,
        scopeId: s.paChannelA,
        scopeType: 'channel',
      },
    })

    // The person who asked reads their own answer.
    const forA = await loadConversationForUser(prisma, {
      organizationId: s.organizationId,
      threadId: started.thread.id,
      userId: s.userA,
    })
    assert.equal(forA?.lastMessagePreview, 'here is what I found')

    // The same row in the same public room still says nothing to somebody the
    // basis does not reach.
    const forB = await loadConversationForUser(prisma, {
      organizationId: s.organizationId,
      threadId: started.thread.id,
      userId: s.userB,
    })
    assert.equal(forB?.lastMessagePreview, null)

    // And the list read applies the same predicate as the single read.
    const listForA = await listAgentConversationsForUser(prisma, {
      agentId: s.agentId,
      organizationId: s.organizationId,
      userId: s.userA,
    })
    assert.equal(
      listForA?.data.find((row) => row.id === started.thread.id)?.lastMessagePreview,
      'here is what I found',
    )
    const listForB = await listAgentConversationsForUser(prisma, {
      agentId: s.agentId,
      organizationId: s.organizationId,
      userId: s.userB,
    })
    assert.equal(
      listForB?.data.find((row) => row.id === started.thread.id)?.lastMessagePreview,
      null,
    )
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

/**
 * A conversation opened empty ("New conversation" posts `{ channelId }` and no
 * message) is titled by the first thing said in it. Every condition below is
 * structural — an agent thread, a NULL title, a top-level `user` message — and
 * none of them reads the content for intent. NULL is the whole marker: the
 * words "New conversation" are a name a person may choose, and while they also
 * meant "unnamed" that choice was overwritten by whatever they said first.
 */
const threadTitle = async (prisma: PrismaClient, threadId: string): Promise<string | null> => {
  const thread = await prisma.thread.findUniqueOrThrow({
    where: { id: threadId },
    select: { title: true },
  })
  return thread.title
}

const openEmptyConversation = async (
  prisma: PrismaClient,
  s: Seed,
): Promise<string> => {
  const started = await startAgentConversation(prisma, {
    agentId: s.agentId,
    channelId: s.publicChannelId,
    organizationId: s.organizationId,
    startedByUserId: s.userA,
  })
  assert.equal(started.kind, 'created')
  if (started.kind !== 'created') throw new Error('the conversation was not created')
  // The outcome projects the displayed name; the row itself is unnamed, which
  // is what leaves the first message free to name it.
  assert.equal(started.thread.title, DEFAULT_CONVERSATION_TITLE)
  assert.equal(await threadTitle(prisma, started.thread.id), null)
  return started.thread.id
}

runDatabaseTest('the first message in an empty conversation becomes its title', async () => {
  await withSeed(async (prisma, s) => {
    const threadId = await openEmptyConversation(prisma, s)

    const first = await createThreadMessage(prisma, {
      content: 'Check the Q3 pricing sheet\nand the deck that goes with it',
      threadId,
      userId: s.userA,
    })
    assert.equal(first.kind, 'created')
    if (first.kind !== 'created') return
    // The one title helper: first non-empty line, whitespace collapsed.
    assert.equal(await threadTitle(prisma, threadId), 'Check the Q3 pricing sheet')
    // Additive on the wire, so the client can show the name it just caused.
    assert.equal(first.conversationTitle, 'Check the Q3 pricing sheet')

    // A conversation is named once. The second message is a message.
    const second = await createThreadMessage(prisma, {
      content: 'and while you are in there, the renewal dates',
      threadId,
      userId: s.userA,
    })
    assert.equal(second.kind, 'created')
    if (second.kind !== 'created') return
    assert.equal(second.conversationTitle, undefined)
    assert.equal(await threadTitle(prisma, threadId), 'Check the Q3 pricing sheet')

    // The list and the card read the same name.
    const record = await loadConversationForUser(prisma, {
      organizationId: s.organizationId,
      threadId,
      userId: s.userA,
    })
    assert.equal(record?.title, 'Check the Q3 pricing sheet')
  })
})

runDatabaseTest('a conversation somebody named "New conversation" keeps that name', async () => {
  await withSeed(async (prisma, s) => {
    const started = await startAgentConversation(prisma, {
      agentId: s.agentId,
      channelId: s.publicChannelId,
      organizationId: s.organizationId,
      startedByUserId: s.userA,
      title: DEFAULT_CONVERSATION_TITLE,
    })
    assert.equal(started.kind, 'created')
    if (started.kind !== 'created') return
    // Stored, not projected: this row carries a title because a person gave it
    // one, and it happens to read the same as the placeholder.
    assert.equal(await threadTitle(prisma, started.thread.id), DEFAULT_CONVERSATION_TITLE)

    const first = await createThreadMessage(prisma, {
      content: 'Payroll escalation',
      threadId: started.thread.id,
      userId: s.userA,
    })
    assert.equal(first.kind, 'created')
    if (first.kind !== 'created') return
    // Their name survives the first thing said in it.
    assert.equal(first.conversationTitle, undefined)
    assert.equal(await threadTitle(prisma, started.thread.id), DEFAULT_CONVERSATION_TITLE)
  })
})

runDatabaseTest('a reply never names the conversation it is written in', async () => {
  await withSeed(async (prisma, s) => {
    const threadId = await openEmptyConversation(prisma, s)
    // A root that did not come through this door, so the conversation is still
    // unnamed when the reply lands.
    const rootMessageId = await postMessage(prisma, {
      content: 'the opening turn',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      threadId,
      userId: s.userA,
    })

    const reply = await createThreadMessage(prisma, {
      content: 'a side remark about the opening turn',
      rootMessageId,
      threadId,
      userId: s.userA,
    })
    assert.equal(reply.kind, 'created')
    if (reply.kind !== 'created') return
    assert.equal(reply.conversationTitle, undefined)
    // Still unnamed, so the next top-level message may still name it.
    assert.equal(await threadTitle(prisma, threadId), null)
  })
})

runDatabaseTest('a room’s General thread and a renamed conversation keep their names', async () => {
  await withSeed(async (prisma, s) => {
    // A room's own thread is named by the room; `agent_id` is null and nothing
    // said in it may rename anything.
    const generalId = await generalThreadId(prisma, s.publicChannelId)
    const inGeneral = await createThreadMessage(prisma, {
      content: 'morning all',
      threadId: generalId,
      userId: s.userA,
    })
    assert.equal(inGeneral.kind, 'created')
    if (inGeneral.kind !== 'created') return
    assert.equal(inGeneral.conversationTitle, undefined)
    assert.equal(await threadTitle(prisma, generalId), 'General')

    // A conversation somebody has already named is theirs, not the first
    // message's.
    const started = await startAgentConversation(prisma, {
      agentId: s.agentId,
      channelId: s.publicChannelId,
      organizationId: s.organizationId,
      startedByUserId: s.userA,
      title: 'Pricing review',
    })
    assert.equal(started.kind, 'created')
    if (started.kind !== 'created') return
    const named = await createThreadMessage(prisma, {
      content: 'starting somewhere else entirely',
      threadId: started.thread.id,
      userId: s.userA,
    })
    assert.equal(named.kind, 'created')
    if (named.kind !== 'created') return
    assert.equal(named.conversationTitle, undefined)
    assert.equal(await threadTitle(prisma, started.thread.id), 'Pricing review')
  })
})
