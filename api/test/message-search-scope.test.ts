import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import { searchMessages } from '../src/services/message-search.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

// Message search spans every channel a person can read, and a snippet is the
// message itself. Its scope follows the Slack/Teams rule: public standard
// channels plus the channels the searcher is a member of — for everyone.
// Organisation owners and admins get no wider reach: before this, an owner's
// search dropped the membership filter and returned snippets from other
// people's private channels, direct messages and Personal Assistant rooms.

type Seed = {
  adminId: string
  canary: string
  memberId: string
  organizationId: string
  ownerId: string
  privateChannelId: string
  publicChannelId: string
  userIds: string[]
}

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const suffix = randomUUID()
  const short = suffix.slice(0, 8)
  // One searchable token no other suite writes, so the query sees only this seed.
  const canary = `zebracanary${short.replace(/[^a-z]/g, 'q')}`
  const makeUser = (name: string) =>
    prisma.user.create({ data: { displayName: name, email: `search-${name}-${suffix}@example.test` } })
  const [owner, admin, member, alice, bob] = await Promise.all([
    makeUser('owner'),
    makeUser('admin'),
    makeUser('member'),
    makeUser('alice'),
    makeUser('bob'),
  ])
  const organization = await prisma.organization.create({ data: { name: `search-scope-${suffix}` } })
  await prisma.organizationMember.createMany({
    data: [
      { organizationId: organization.id, role: 'owner', userId: owner.id },
      { organizationId: organization.id, role: 'admin', userId: admin.id },
      { organizationId: organization.id, role: 'member', userId: member.id },
      { organizationId: organization.id, role: 'member', userId: alice.id },
      { organizationId: organization.id, role: 'member', userId: bob.id },
    ],
  })
  const project = await prisma.project.create({
    data: { name: `search-project-${suffix}`, organizationId: organization.id },
  })
  const team = await prisma.team.create({ data: { name: `search-team-${suffix}`, projectId: project.id } })
  // The owner and the admin also administer the channel's team: team authority
  // is not read authority either.
  await prisma.teamMember.createMany({
    data: [
      { role: 'owner', teamId: team.id, userId: owner.id },
      { role: 'admin', teamId: team.id, userId: admin.id },
    ],
  })

  const base = { organizationId: organization.id, projectId: project.id, teamId: team.id }
  const publicChannel = await prisma.channel.create({
    data: { ...base, label: `pub-${short}`, slug: `pub-${short}`, type: 'standard', visibility: 'public' },
  })
  const privateChannel = await prisma.channel.create({
    data: { ...base, label: `priv-${short}`, slug: `priv-${short}`, type: 'standard', visibility: 'private' },
  })
  const directMessage = await prisma.channel.create({
    data: { ...base, dmKey: `dm-${suffix}`, label: 'alice-bob', type: 'dm', visibility: 'private' },
  })
  const assistantRoom = await prisma.channel.create({
    data: {
      ...base,
      dmKey: `pa:${alice.id}:${suffix}`,
      label: 'Personal Assistant',
      systemChannelType: 'personal_assistant',
      type: 'dm',
      visibility: 'private',
    },
  })
  // A system room can be a standard channel whose visibility says public; it is
  // still a participant-only conversation.
  const systemRoom = await prisma.channel.create({
    data: {
      ...base,
      label: `mail-ops-${short}`,
      slug: `mail-ops-${short}`,
      systemChannelType: 'agent_email',
      type: 'standard',
      visibility: 'public',
    },
  })
  await prisma.channelMember.createMany({
    data: [
      { channelId: privateChannel.id, userId: alice.id },
      { channelId: directMessage.id, userId: alice.id },
      { channelId: directMessage.id, userId: bob.id },
      { channelId: assistantRoom.id, userId: alice.id },
      { channelId: systemRoom.id, userId: alice.id },
    ],
  })

  for (const [channel, label] of [
    [publicChannel, 'public'],
    [privateChannel, 'private'],
    [directMessage, 'dm'],
    [assistantRoom, 'assistant'],
    [systemRoom, 'system'],
  ] as const) {
    const thread = await prisma.thread.create({ data: { channelId: channel.id, title: 'General' } })
    await prisma.message.create({
      data: { content: `${label} ${canary} note`, role: 'user', threadId: thread.id, userId: alice.id },
    })
  }

  return {
    adminId: admin.id,
    canary,
    memberId: member.id,
    organizationId: organization.id,
    ownerId: owner.id,
    privateChannelId: privateChannel.id,
    publicChannelId: publicChannel.id,
    userIds: [owner.id, admin.id, member.id, alice.id, bob.id],
  }
}

const search = (
  prisma: PrismaClient,
  s: Seed,
  userId: string,
  extra: { channelId?: string } = {},
) =>
  searchMessages(prisma, {
    // The pre-fix signature took `isOwner`; passing it keeps this suite able to
    // prove, against the old implementation, that an owner used to see these.
    ...({ isOwner: true } as object),
    organizationId: s.organizationId,
    query: s.canary,
    userId,
    ...extra,
  } as Parameters<typeof searchMessages>[1])

runDatabaseTest('an organisation owner or admin searches only public channels and their own', async (t) => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  t.after(async () => {
    await prisma.organization.deleteMany({ where: { id: s.organizationId } })
    await prisma.user.deleteMany({ where: { id: { in: s.userIds } } })
    await prisma.$disconnect()
  })

  for (const [role, userId] of [['owner', s.ownerId], ['admin', s.adminId], ['member', s.memberId]] as const) {
    const results = await search(prisma, s, userId)
    const snippets = results.map((result) => result.snippet).sort()
    assert.deepEqual(
      snippets,
      [`public ${s.canary} note`],
      `an organisation ${role} who is in none of these rooms reached ${JSON.stringify(snippets)}`,
    )
    assert.deepEqual(results.map((result) => result.channelId), [s.publicChannelId])
  }

  // Naming the private channel directly does not widen reach either.
  assert.deepEqual(await search(prisma, s, s.ownerId, { channelId: s.privateChannelId }), [])
})

runDatabaseTest('a participant still finds their own private, direct and system conversations', async (t) => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  t.after(async () => {
    await prisma.organization.deleteMany({ where: { id: s.organizationId } })
    await prisma.user.deleteMany({ where: { id: { in: s.userIds } } })
    await prisma.$disconnect()
  })

  const alice = await prisma.user.findFirstOrThrow({
    where: { id: { in: s.userIds }, displayName: 'alice' },
    select: { id: true },
  })
  const snippets = (await search(prisma, s, alice.id)).map((result) => result.snippet).sort()
  assert.deepEqual(snippets, [
    `assistant ${s.canary} note`,
    `dm ${s.canary} note`,
    `private ${s.canary} note`,
    `public ${s.canary} note`,
    `system ${s.canary} note`,
  ])
})
