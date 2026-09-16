import assert from 'node:assert/strict'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import { readChannelForViewer, readChannelRoster } from '../src/services/channel-directory.js'
import { listChannelsForUser } from '../src/services/channels.js'

/**
 * What a person may read of ONE channel, including one they are not in.
 *
 * `GET /api/channels` lists rooms somebody participates in or may browse; these
 * are the two reads a direct URL makes — `GET /api/channels/:channelId` and its
 * roster — which is how a protected room is reached at all, since it is
 * deliberately absent from the browse list.
 *
 * Against a real database, because every arm is a row: the `ChannelMember`
 * row, the organisation role, the channel's `visibility`, and the DM/system
 * columns that must exclude a conversation from all of it.
 *
 * The rule the whole file exists to hold: **a refusal is `null`, which the
 * route turns into `404 channel_not_found`, never a 403.** A 403 confirms the
 * room exists, and for a direct message the label alone discloses who is
 * talking to whom.
 */

const suite = 'c4e1'
const orgId = `00000000-0000-4000-8000-${suite}00000001`
const projectId = `00000000-0000-4000-8000-${suite}00000002`
const teamId = `00000000-0000-4000-8000-${suite}00000003`

const publicChannelId = `00000000-0000-4000-8000-${suite}00000010`
const protectedChannelId = `00000000-0000-4000-8000-${suite}00000011`
const dmChannelId = `00000000-0000-4000-8000-${suite}00000012`
const systemChannelId = `00000000-0000-4000-8000-${suite}00000013`

const memberUserId = `00000000-0000-4000-8000-${suite}00000020`
const outsiderUserId = `00000000-0000-4000-8000-${suite}00000021`
const adminUserId = `00000000-0000-4000-8000-${suite}00000022`
const dmPartnerUserId = `00000000-0000-4000-8000-${suite}00000023`
const deactivatedUserId = `00000000-0000-4000-8000-${suite}00000024`

const userIds = [
  memberUserId,
  outsiderUserId,
  adminUserId,
  dmPartnerUserId,
  deactivatedUserId,
]

const dbTest = process.env.DATABASE_URL ? test : test.skip

const viewer = (userId: string, isOrganizationAdmin = false) => ({
  isOrganizationAdmin,
  organizationId: orgId,
  userId,
})

const seed = async (prisma: PrismaClient) => {
  await prisma.organization.create({ data: { id: orgId, name: `chan-vis-${suite}` } })
  await prisma.user.createMany({
    data: userIds.map((id, index) => ({
      displayName: `Channel visibility ${index}`,
      email: `chan-vis-${suite}-${index}@test.local`,
      id,
    })),
  })
  await prisma.organizationMember.createMany({
    data: userIds.map((userId) => ({
      organizationId: orgId,
      role: userId === adminUserId ? 'admin' : 'member',
      userId,
      // A membership row outlives somebody's access, so a roster must drop
      // them. This person is in the protected channel and must not be listed.
      ...(userId === deactivatedUserId ? { deactivatedAt: new Date() } : {}),
    })),
  })
  await prisma.project.create({ data: { id: projectId, name: `p-${suite}`, organizationId: orgId } })
  await prisma.team.create({ data: { id: teamId, name: `t-${suite}`, projectId } })

  await prisma.channel.createMany({
    data: [
      {
        id: publicChannelId,
        label: `pub-${suite}`,
        organizationId: orgId,
        projectId,
        slug: `pub-${suite}`,
        teamId,
        visibility: 'public',
      },
      {
        id: protectedChannelId,
        label: `prot-${suite}`,
        description: 'Where the launch gets planned',
        organizationId: orgId,
        projectId,
        slug: `prot-${suite}`,
        teamId,
        visibility: 'protected',
      },
      // A two-person direct message, and an `agent_email` system surface —
      // which is stored `type: 'standard'`, so `type` alone would let it
      // through and the system column is what actually excludes it.
      {
        dmKey: [orgId, teamId, ...[memberUserId, dmPartnerUserId].sort()].join(':'),
        id: dmChannelId,
        label: `dm-${suite}`,
        organizationId: orgId,
        projectId,
        teamId,
        type: 'dm',
        visibility: 'private',
      },
      {
        id: systemChannelId,
        label: `mail-${suite}`,
        organizationId: orgId,
        projectId,
        slug: `mail-${suite}`,
        systemChannelType: 'agent_email',
        teamId,
        visibility: 'private',
      },
    ],
  })
  await prisma.channelMember.createMany({
    data: [
      { channelId: publicChannelId, role: 'owner', userId: memberUserId },
      { channelId: protectedChannelId, role: 'owner', userId: memberUserId },
      { channelId: protectedChannelId, role: 'member', userId: deactivatedUserId },
      { channelId: dmChannelId, role: 'member', userId: memberUserId },
      { channelId: dmChannelId, role: 'member', userId: dmPartnerUserId },
      { channelId: systemChannelId, role: 'member', userId: memberUserId },
    ],
  })
}

const cleanup = async (prisma: PrismaClient) => {
  await prisma.channelMember.deleteMany({ where: { channel: { organizationId: orgId } } })
  await prisma.thread.deleteMany({ where: { channel: { organizationId: orgId } } })
  await prisma.channel.deleteMany({ where: { organizationId: orgId } })
  await prisma.team.deleteMany({ where: { id: teamId } })
  await prisma.project.deleteMany({ where: { organizationId: orgId } })
  await prisma.organizationMember.deleteMany({ where: { organizationId: orgId } })
  await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
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

// ─── The single-channel read ────────────────────────────────────────────────

dbTest('a member reads their own protected room in full', async () => {
  await withDb(async (prisma) => {
    const entry = await readChannelForViewer(prisma, viewer(memberUserId), protectedChannelId)
    assert.equal(entry?.access, 'full')
    assert.equal(entry?.access === 'full' && entry.viewerIsMember, true)
    assert.equal(entry?.access === 'full' && entry.channel.viewerIsMember, true)
  })
})

/**
 * The shape this whole change exists to produce. A non-member gets the room's
 * name, description, visibility and members — and nothing derived from what has
 * been said in it.
 */
dbTest('a non-member of a protected room gets the limited overview and nothing else', async () => {
  await withDb(async (prisma) => {
    const entry = await readChannelForViewer(prisma, viewer(outsiderUserId), protectedChannelId)
    assert.equal(entry?.access, 'limited')
    if (entry?.access !== 'limited') return
    assert.deepEqual(
      Object.keys(entry).sort(),
      ['access', 'description', 'id', 'label', 'members', 'projectName', 'teamName', 'visibility'],
    )
    assert.equal(entry.visibility, 'protected')
    assert.equal(entry.description, 'Where the launch gets planned')
    // The deactivated member is dropped: a name on a list is a disclosure.
    assert.deepEqual(entry.members.map((member) => member.userId), [memberUserId])
  })
})

dbTest('a non-member of a PUBLIC room gets the full record, not the limited shape', async () => {
  await withDb(async (prisma) => {
    const entry = await readChannelForViewer(prisma, viewer(outsiderUserId), publicChannelId)
    assert.equal(entry?.access, 'full')
    // …and `viewerIsMember: false`, which is what suppresses the composer and
    // offers Join instead.
    assert.equal(entry?.access === 'full' && entry.viewerIsMember, false)
    assert.equal(entry?.access === 'full' && entry.channel.viewerIsMember, false)
  })
})

/**
 * Management is not participation, on the wire.
 */
dbTest('an admin outside a protected room gets the management record with no participation metadata', async () => {
  await withDb(async (prisma) => {
    const entry = await readChannelForViewer(
      prisma,
      viewer(adminUserId, true),
      protectedChannelId,
    )
    assert.equal(entry?.access, 'full')
    if (entry?.access !== 'full') return
    assert.equal(entry.viewerIsMember, false, 'they never joined')
    assert.equal(entry.channel.viewerCanManage, true, 'and they administer it')
    assert.equal(entry.channel.viewerCanManageAgents, true, 'including placing an agent')
    // Reading the room must not have made them a member of it.
    assert.equal(
      await prisma.channelMember.count({
        where: { channelId: protectedChannelId, userId: adminUserId },
      }),
      0,
    )
  })
})

dbTest('a direct message and a system surface are not found for anybody outside them', async () => {
  await withDb(async (prisma) => {
    for (const channelId of [dmChannelId, systemChannelId]) {
      // An organisation ADMIN too: a DM is not an organisational resource, and
      // a system surface is nobody's to browse.
      for (const who of [viewer(outsiderUserId), viewer(adminUserId, true)]) {
        assert.equal(
          await readChannelForViewer(prisma, who, channelId),
          null,
          `${channelId} must be invisible to ${who.userId}`,
        )
        assert.equal(await readChannelRoster(prisma, who, channelId), null)
      }
      // Its participant still reads it.
      assert.notEqual(await readChannelForViewer(prisma, viewer(memberUserId), channelId), null)
    }
  })
})

dbTest('another organisation cannot read a channel at all', async () => {
  await withDb(async (prisma) => {
    const stranger = { isOrganizationAdmin: true, organizationId: projectId, userId: adminUserId }
    assert.equal(await readChannelForViewer(prisma, stranger, publicChannelId), null)
    assert.equal(await readChannelRoster(prisma, stranger, publicChannelId), null)
  })
})

// ─── The roster ─────────────────────────────────────────────────────────────

dbTest('the roster answers everybody who may see the room, and refuses everybody else', async () => {
  await withDb(async (prisma) => {
    for (const who of [
      viewer(memberUserId),
      viewer(adminUserId, true),
      // An ordinary organisation member: the limited overview carries the
      // member list, because "whom do I ask to be let in" is its whole point.
      viewer(outsiderUserId),
    ]) {
      const roster = await readChannelRoster(prisma, who, protectedChannelId)
      assert.deepEqual(
        roster?.map((member) => member.userId),
        [memberUserId],
        `roster for ${who.userId}`,
      )
    }
  })
})

// ─── The browse listing ─────────────────────────────────────────────────────

dbTest('GET /api/channels excludes a protected room from non-members, admins included', async () => {
  await withDb(async (prisma) => {
    const listed = async (userId: string, isOrganizationAdmin = false) =>
      (await listChannelsForUser(prisma, userId, orgId, undefined, false, { isOrganizationAdmin }))
        .map((channel) => channel.id as string)

    const asMember = await listed(memberUserId)
    assert.ok(asMember.includes(protectedChannelId), 'their own room')
    assert.ok(asMember.includes(publicChannelId))

    const asOutsider = await listed(outsiderUserId)
    assert.ok(asOutsider.includes(publicChannelId), 'public is browsable')
    assert.ok(!asOutsider.includes(protectedChannelId), 'protected is not listed')

    // An admin gets no exception in the LIST. They reach a protected room by
    // direct URL or admin tooling, which is what keeps the sidebar a list of
    // rooms a person works in rather than an index of everything.
    const asAdmin = await listed(adminUserId, true)
    assert.ok(!asAdmin.includes(protectedChannelId), 'not even for an admin')
    assert.ok(!asAdmin.includes(dmChannelId), 'and never somebody else\'s DM')
  })
})
