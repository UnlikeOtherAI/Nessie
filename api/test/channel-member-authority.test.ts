import assert from 'node:assert/strict'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import {
  parseOrganizationId,
  parseProjectId,
  parseTeamId,
  type AuthorizedActionContext,
} from '@nessie/schemas'

import { addMemberToChannel, removeMemberFromChannel } from '../src/services/channel-members.js'
import {
  createChannelForUser,
  deleteChannel,
  listChannelsForUser,
  setChannelArchived,
  updateChannel,
} from '../src/services/channels.js'

/**
 * Who may change a channel — rename it, archive it, and change who is in it.
 *
 * The model (`docs/standards/team-model.md` → "Who may change a project or a
 * channel"): any organisation member creates a channel; every member of a
 * channel has equal rights in it, whatever `ChannelMember.role` says; and only
 * an organisation owner or admin reaches into a channel they are not in. A
 * person may always leave a channel themselves.
 *
 * Against a real database because every arm of `canModifyChannel` is a row:
 * the `ChannelMember` row, the organisation membership role, and — to prove it
 * no longer counts — the `TeamMember` role. It also checks the audit row the
 * membership writes record, which a Prisma fake would silently swallow.
 */

const suite = 'b7d2'
const orgId = `00000000-0000-4000-8000-${suite}00000001`
const projectId = `00000000-0000-4000-8000-${suite}00000002`
const teamId = `00000000-0000-4000-8000-${suite}00000003`
const channelId = `00000000-0000-4000-8000-${suite}00000004`
const publicChannelId = `00000000-0000-4000-8000-${suite}00000005`
const dmChannelId = `00000000-0000-4000-8000-${suite}00000006`

const creatorUserId = `00000000-0000-4000-8000-${suite}00000010`
const plainMemberUserId = `00000000-0000-4000-8000-${suite}00000011`
const targetUserId = `00000000-0000-4000-8000-${suite}00000012`
const outsiderUserId = `00000000-0000-4000-8000-${suite}00000013`
const orgAdminUserId = `00000000-0000-4000-8000-${suite}00000014`
const teamAdminUserId = `00000000-0000-4000-8000-${suite}00000015`

const userIds = [
  creatorUserId,
  plainMemberUserId,
  targetUserId,
  outsiderUserId,
  orgAdminUserId,
  teamAdminUserId,
]

const dbTest = process.env.DATABASE_URL ? test : test.skip

const actorFor = (userId: string, role = 'member'): AuthorizedActionContext => ({
  actor: { actorType: 'user', actorId: userId, roles: [role] },
  tenant: {
    organizationId: parseOrganizationId(orgId),
    projectId: parseProjectId(projectId),
    teamId: parseTeamId(teamId),
  },
  actionContext: {
    requestId: `req-channel-members-${userId}`,
    teamId: parseTeamId(teamId),
  },
})

const seed = async (prisma: PrismaClient) => {
  await prisma.organization.create({ data: { id: orgId, name: `chan-members-${suite}` } })
  await prisma.user.createMany({
    data: userIds.map((id, index) => ({
      displayName: `Channel member ${index}`,
      email: `chan-members-${suite}-${index}@test.local`,
      id,
    })),
  })
  // Ordinary organisation members throughout, except the one admin: the
  // channel's own membership is what decides for everyone else.
  await prisma.organizationMember.createMany({
    data: userIds.map((userId) => ({
      organizationId: orgId,
      role: userId === orgAdminUserId ? 'admin' : 'member',
      userId,
    })),
  })
  await prisma.project.create({ data: { id: projectId, name: `p-${suite}`, organizationId: orgId } })
  await prisma.team.create({ data: { id: teamId, name: `t-${suite}`, projectId } })
  // A team administrator who is not in either channel. Under the previous rule
  // the team role alone managed every channel in the team.
  await prisma.teamMember.create({ data: { role: 'admin', teamId, userId: teamAdminUserId } })
  await prisma.channel.create({
    data: {
      id: channelId,
      label: `priv-${suite}`,
      organizationId: orgId,
      projectId,
      slug: `priv-${suite}`,
      teamId,
      // `protected`, not `private`: a standard room a person closed is stored
      // `protected` since the visibility change, and the migration moved every
      // existing one. `private` is now reserved for DMs and system surfaces,
      // which the direct message below still carries.
      visibility: 'protected',
    },
  })
  await prisma.channel.create({
    data: {
      id: publicChannelId,
      label: `pub-${suite}`,
      organizationId: orgId,
      projectId,
      slug: `pub-${suite}`,
      teamId,
      visibility: 'public',
    },
  })
  // A direct message between two people, neither of them an administrator.
  await prisma.channel.create({
    data: {
      dmKey: [orgId, teamId, ...[creatorUserId, targetUserId].sort()].join(':'),
      id: dmChannelId,
      label: `dm-${suite}`,
      organizationId: orgId,
      projectId,
      teamId,
      type: 'dm',
      visibility: 'private',
    },
  })
  await prisma.channelMember.createMany({
    data: [
      { channelId, role: 'owner', userId: creatorUserId },
      { channelId, role: 'member', userId: plainMemberUserId },
      { channelId: publicChannelId, role: 'owner', userId: creatorUserId },
      { channelId: dmChannelId, role: 'member', userId: creatorUserId },
      { channelId: dmChannelId, role: 'member', userId: targetUserId },
    ],
  })
}

const cleanup = async (prisma: PrismaClient) => {
  await prisma.auditLog.deleteMany({ where: { organizationId: orgId } })
  await prisma.channelMember.deleteMany({ where: { channel: { organizationId: orgId } } })
  await prisma.thread.deleteMany({ where: { channel: { organizationId: orgId } } })
  await prisma.channel.deleteMany({ where: { organizationId: orgId } })
  await prisma.projectMember.deleteMany({ where: { projectId } })
  await prisma.teamMember.deleteMany({ where: { teamId } })
  await prisma.team.deleteMany({ where: { id: teamId } })
  await prisma.project.deleteMany({ where: { id: projectId } })
  await prisma.organizationMember.deleteMany({ where: { userId: { in: userIds } } })
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

const isChannelMember = async (prisma: PrismaClient, id: string, userId: string) =>
  (await prisma.channelMember.count({ where: { channelId: id, userId } })) > 0

const manageInput = (id: string, userId: string) => ({ channelId: id, organizationId: orgId, userId })

// ─── Rule 1: any member creates a channel ───────────────────────────────────

dbTest('a plain organisation member creates a channel and is its first member', async () => {
  await withDb(async (prisma) => {
    // Adding a room to a project changes the project (`canModifyProject`).
    await prisma.projectMember.create({ data: { projectId, role: 'member', userId: plainMemberUserId } })
    const created = await createChannelForUser(prisma, {
      label: `made-by-member-${suite}`,
      organizationId: orgId,
      projectId,
      teamId,
      userId: plainMemberUserId,
      visibility: 'public',
    })
    assert.ok(created)
    assert.equal(created.viewerCanManage, true)
    assert.equal(await isChannelMember(prisma, created.id, plainMemberUserId), true)
  })
})

// ─── Rule 2: every member of a channel has equal rights ─────────────────────

dbTest('a plain channel member adds somebody, and the write is audited', async () => {
  await withDb(async (prisma) => {
    const result = await addMemberToChannel(prisma, actorFor(plainMemberUserId), {
      channelId,
      userId: targetUserId,
    })
    assert.deepEqual(result, { kind: 'changed' })
    assert.equal(await isChannelMember(prisma, channelId, targetUserId), true)

    const audited = await prisma.auditLog.findMany({
      where: { organizationId: orgId, resourceId: channelId },
      select: { action: true, actorId: true },
    })
    assert.deepEqual(audited, [{ action: 'channel.member_added', actorId: plainMemberUserId }])
  })
})

dbTest('a plain channel member removes another member, the creator included', async () => {
  await withDb(async (prisma) => {
    const result = await removeMemberFromChannel(prisma, actorFor(plainMemberUserId), {
      channelId,
      userId: creatorUserId,
    })
    assert.deepEqual(result, { kind: 'changed' })
    assert.equal(await isChannelMember(prisma, channelId, creatorUserId), false)
  })
})

dbTest('a plain channel member renames and archives the channel', async () => {
  await withDb(async (prisma) => {
    const renamed = await updateChannel(prisma, {
      ...manageInput(channelId, plainMemberUserId),
      label: `renamed-${suite}`,
      topic: 'Set by a plain member',
    })
    assert.ok(renamed, 'a channel member may rename the channel')
    assert.equal(renamed.label, `renamed-${suite}`)

    const archived = await setChannelArchived(prisma, {
      ...manageInput(channelId, plainMemberUserId),
      archived: true,
    })
    assert.ok(archived?.archivedAt, 'a channel member may archive the channel')
  })
})

dbTest('a plain member may leave the channel themselves', async () => {
  await withDb(async (prisma) => {
    const result = await removeMemberFromChannel(prisma, actorFor(plainMemberUserId), {
      channelId,
      userId: plainMemberUserId,
    })
    assert.deepEqual(result, { kind: 'changed' })
    assert.equal(await isChannelMember(prisma, channelId, plainMemberUserId), false)
  })
})

// ─── Rule 3: outside the channel, only an organisation owner or admin ──────

dbTest('somebody who cannot see the private channel is told it does not exist', async () => {
  await withDb(async (prisma) => {
    const result = await addMemberToChannel(prisma, actorFor(outsiderUserId), {
      channelId,
      userId: targetUserId,
    })
    assert.deepEqual(result, { kind: 'channel_not_found' })
    assert.equal(await isChannelMember(prisma, channelId, targetUserId), false)
    assert.equal(
      await updateChannel(prisma, { ...manageInput(channelId, outsiderUserId), label: `x-${suite}` }),
      null,
    )
  })
})

dbTest('a non-member of a public channel may not change it', async () => {
  await withDb(async (prisma) => {
    const added = await addMemberToChannel(prisma, actorFor(outsiderUserId), {
      channelId: publicChannelId,
      userId: targetUserId,
    })
    assert.deepEqual(added, { kind: 'forbidden' })
    assert.equal(
      await setChannelArchived(prisma, { ...manageInput(publicChannelId, outsiderUserId), archived: true }),
      null,
    )
    const row = await prisma.channel.findUniqueOrThrow({ where: { id: publicChannelId } })
    assert.equal(row.archivedAt, null)
  })
})

dbTest('a team administrator who is not in the channel can no longer change it', async () => {
  await withDb(async (prisma) => {
    const added = await addMemberToChannel(prisma, actorFor(teamAdminUserId), {
      channelId: publicChannelId,
      userId: targetUserId,
    })
    assert.deepEqual(added, { kind: 'forbidden' })
    assert.equal(
      await updateChannel(prisma, { ...manageInput(publicChannelId, teamAdminUserId), topic: 'no' }),
      null,
    )
  })
})

dbTest('an organisation admin who is not in a public channel may change it', async () => {
  await withDb(async (prisma) => {
    const added = await addMemberToChannel(prisma, actorFor(orgAdminUserId, 'admin'), {
      channelId: publicChannelId,
      userId: targetUserId,
    })
    assert.deepEqual(added, { kind: 'changed' })

    const updated = await updateChannel(prisma, {
      ...manageInput(publicChannelId, orgAdminUserId),
      isOrganizationAdmin: true,
      topic: 'Set by an organisation admin',
    })
    assert.equal(updated?.topic, 'Set by an organisation admin')
    assert.equal(updated?.viewerCanManage, true)
    assert.equal(await isChannelMember(prisma, publicChannelId, orgAdminUserId), false)
  })
})

/**
 * The deliberate reversal of the Slack/Teams rule, and the reason
 * `docs/standards/team-model.md` changed in the same work.
 *
 * An organisation admin manages any standard room they can see, protected
 * included, without joining it — and MAY add themselves to one. Management is
 * not participation: nothing here makes them a member as a side effect, so the
 * membership assertions below are as load-bearing as the successes.
 */
dbTest('an organisation admin manages a protected channel without being in it', async () => {
  await withDb(async (prisma) => {
    const admin = actorFor(orgAdminUserId, 'admin')
    const asAdmin = { ...manageInput(channelId, orgAdminUserId), isOrganizationAdmin: true }

    // Renaming and archiving, neither of which joins them to the room.
    const renamed = await updateChannel(prisma, { ...asAdmin, topic: 'Set by an admin' })
    assert.equal(renamed?.topic, 'Set by an admin')
    assert.equal(renamed?.viewerCanManage, true)
    assert.equal(renamed?.viewerIsMember, false)
    assert.equal(await isChannelMember(prisma, channelId, orgAdminUserId), false)

    // Adding somebody else, still without joining.
    assert.deepEqual(
      await addMemberToChannel(prisma, admin, { channelId, userId: targetUserId }),
      { kind: 'changed' },
    )
    assert.equal(await isChannelMember(prisma, channelId, orgAdminUserId), false)

    // And adding THEMSELVES, which is the rule this change reversed.
    assert.deepEqual(
      await addMemberToChannel(prisma, admin, { channelId, userId: orgAdminUserId }),
      { kind: 'changed' },
    )
    assert.equal(await isChannelMember(prisma, channelId, orgAdminUserId), true)
  })
})

// An ordinary member outside the room is refused, and told it does not exist
// rather than that it is closed. Unchanged, and the half that must not drift.
dbTest('an outsider who is not an admin is told a protected channel does not exist', async () => {
  await withDb(async (prisma) => {
    const outsider = actorFor(outsiderUserId)
    assert.deepEqual(
      await addMemberToChannel(prisma, outsider, { channelId, userId: outsiderUserId }),
      { kind: 'channel_not_found' },
    )
    assert.deepEqual(
      await addMemberToChannel(prisma, outsider, { channelId, userId: targetUserId }),
      { kind: 'channel_not_found' },
    )
    const asOutsider = manageInput(channelId, outsiderUserId)
    assert.equal(await updateChannel(prisma, { ...asOutsider, label: `x-${suite}` }), null)
    assert.equal(await setChannelArchived(prisma, { ...asOutsider, archived: true }), null)

    const row = await prisma.channel.findUniqueOrThrow({ where: { id: channelId } })
    assert.equal(row.label, `priv-${suite}`)
    assert.equal(row.archivedAt, null)
    assert.equal(await isChannelMember(prisma, channelId, orgAdminUserId), false)
  })
})

// ─── The verified request role decides, not the membership row ──────────────

dbTest('a UOA promotion or demotion counts on the next request, not the next login', async () => {
  await withDb(async (prisma) => {
    // The row still says `member`; UOA's live authorization says admin.
    const promoted = await updateChannel(prisma, {
      ...manageInput(publicChannelId, outsiderUserId),
      isOrganizationAdmin: true,
      topic: 'Promoted upstream',
    })
    assert.equal(promoted?.topic, 'Promoted upstream')

    // The row still says `admin`; UOA's live authorization says member.
    const demoted = await setChannelArchived(prisma, {
      ...manageInput(publicChannelId, orgAdminUserId),
      archived: true,
      isOrganizationAdmin: false,
    })
    assert.equal(demoted, null)
    const row = await prisma.channelMember.findFirst({ where: { channelId: publicChannelId, userId: orgAdminUserId } })
    assert.equal(row, null)
  })
})

// ─── Direct messages: participants only ─────────────────────────────────────

dbTest('nobody outside a direct message renames or archives it, whatever their role', async () => {
  await withDb(async (prisma) => {
    for (const [userId, isOrganizationAdmin] of [
      [orgAdminUserId, true],
      [teamAdminUserId, false],
      [plainMemberUserId, false],
    ] as const) {
      const input = { ...manageInput(dmChannelId, userId), isOrganizationAdmin }
      assert.equal(await updateChannel(prisma, { ...input, topic: 'no' }), null, userId)
      assert.equal(await setChannelArchived(prisma, { ...input, archived: true }), null, userId)
    }
    const row = await prisma.channel.findUniqueOrThrow({ where: { id: dmChannelId } })
    assert.equal(row.archivedAt, null)
    assert.equal(row.topic, null)
  })
})

dbTest('a membership change on a DM tells an outsider only that it does not exist', async () => {
  await withDb(async (prisma) => {
    // A participant learns the pair is fixed; an outsider — even an admin —
    // gets the same answer a missing id gets, so the kind of channel behind an
    // id is not disclosed.
    assert.deepEqual(
      await addMemberToChannel(prisma, actorFor(creatorUserId), { channelId: dmChannelId, userId: outsiderUserId }),
      { kind: 'dm_members_fixed' },
    )
    for (const actor of [actorFor(outsiderUserId), actorFor(orgAdminUserId, 'admin')]) {
      assert.deepEqual(
        await addMemberToChannel(prisma, actor, { channelId: dmChannelId, userId: outsiderUserId }),
        { kind: 'channel_not_found' },
      )
      assert.deepEqual(
        await removeMemberFromChannel(prisma, actor, { channelId: dmChannelId, userId: targetUserId }),
        { kind: 'channel_not_found' },
      )
    }
  })
})

// ─── Deleting is a soft delete ──────────────────────────────────────────────

dbTest('a member deletes a channel: it is kept, hidden, and nothing changes it again', async () => {
  await withDb(async (prisma) => {
    const deleted = await deleteChannel(prisma, manageInput(publicChannelId, creatorUserId))
    assert.deepEqual(deleted, { id: publicChannelId })

    const row = await prisma.channel.findUniqueOrThrow({ where: { id: publicChannelId } })
    assert.notEqual(row.deletedAt, null)
    assert.notEqual(row.archivedAt, null)
    assert.equal(await isChannelMember(prisma, publicChannelId, creatorUserId), true, 'members are kept')

    for (const includeArchived of [false, true]) {
      const listed = await listChannelsForUser(prisma, creatorUserId, orgId, undefined, includeArchived)
      assert.equal(listed.some((channel) => channel.id === publicChannelId), false)
    }
    assert.equal(
      await setChannelArchived(prisma, { ...manageInput(publicChannelId, creatorUserId), archived: false }),
      null,
      'a deleted channel cannot be unarchived back into view',
    )
    assert.equal(
      await updateChannel(prisma, { ...manageInput(publicChannelId, orgAdminUserId), isOrganizationAdmin: true, topic: 'x' }),
      null,
    )
    assert.deepEqual(
      await addMemberToChannel(prisma, actorFor(creatorUserId), { channelId: publicChannelId, userId: targetUserId }),
      { kind: 'channel_not_found' },
    )
  })
})

dbTest('an outsider cannot delete a protected channel they cannot see', async () => {
  await withDb(async (prisma) => {
    assert.equal(await deleteChannel(prisma, manageInput(channelId, outsiderUserId)), null)
    const row = await prisma.channel.findUniqueOrThrow({ where: { id: channelId } })
    assert.equal(row.deletedAt, null)
  })
})

// The admin arm of the same question, and the reversal again: deleting a room
// is management, so an organisation admin reaches a protected one they never
// joined. Kept apart from the refusal above so neither can be weakened by
// accident while the other still passes.
dbTest('an organisation admin deletes a protected channel they are not in', async () => {
  await withDb(async (prisma) => {
    assert.notEqual(
      await deleteChannel(prisma, { ...manageInput(channelId, orgAdminUserId), isOrganizationAdmin: true }),
      null,
    )
    const row = await prisma.channel.findUniqueOrThrow({ where: { id: channelId } })
    assert.notEqual(row.deletedAt, null)
  })
})
