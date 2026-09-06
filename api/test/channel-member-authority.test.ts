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

/**
 * Who may change who is in a channel — the same gate rename and archive take,
 * plus the one carve-out that a person may leave a channel themselves.
 *
 * Against a real database because every arm of `canManageChannel` is a row:
 * the `ChannelMember` role, the `TeamMember` role, and the organisation
 * membership role. It also checks the audit row the mutation now writes, which
 * a Prisma fake would silently swallow.
 */

const suite = 'b7d2'
const orgId = `00000000-0000-4000-8000-${suite}00000001`
const projectId = `00000000-0000-4000-8000-${suite}00000002`
const teamId = `00000000-0000-4000-8000-${suite}00000003`
const channelId = `00000000-0000-4000-8000-${suite}00000004`

const channelAdminUserId = `00000000-0000-4000-8000-${suite}00000010`
const plainMemberUserId = `00000000-0000-4000-8000-${suite}00000011`
const targetUserId = `00000000-0000-4000-8000-${suite}00000012`
const outsiderUserId = `00000000-0000-4000-8000-${suite}00000013`

const userIds = [channelAdminUserId, plainMemberUserId, targetUserId, outsiderUserId]

const dbTest = process.env.DATABASE_URL ? test : test.skip

const actorFor = (userId: string): AuthorizedActionContext => ({
  actor: { actorType: 'user', actorId: userId, roles: ['member'] },
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
  // Ordinary members throughout: nobody here is an organisation owner or admin,
  // so the channel's own roles are what decide.
  await prisma.organizationMember.createMany({
    data: userIds.map((userId) => ({ organizationId: orgId, role: 'member', userId })),
  })
  await prisma.project.create({ data: { id: projectId, name: `p-${suite}`, organizationId: orgId } })
  await prisma.team.create({ data: { id: teamId, name: `t-${suite}`, projectId } })
  await prisma.channel.create({
    data: {
      id: channelId,
      label: `priv-${suite}`,
      organizationId: orgId,
      projectId,
      slug: `priv-${suite}`,
      teamId,
      visibility: 'private',
    },
  })
  await prisma.channelMember.createMany({
    data: [
      { channelId, role: 'admin', userId: channelAdminUserId },
      { channelId, role: 'member', userId: plainMemberUserId },
    ],
  })
}

const cleanup = async (prisma: PrismaClient) => {
  await prisma.auditLog.deleteMany({ where: { organizationId: orgId } })
  await prisma.channelMember.deleteMany({ where: { channelId } })
  await prisma.channel.deleteMany({ where: { id: channelId } })
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

const isChannelMember = async (prisma: PrismaClient, userId: string) =>
  (await prisma.channelMember.count({ where: { channelId, userId } })) > 0

dbTest('a plain channel member cannot add somebody to the channel', async () => {
  await withDb(async (prisma) => {
    const result = await addMemberToChannel(prisma, actorFor(plainMemberUserId), {
      channelId,
      userId: targetUserId,
    })
    assert.deepEqual(result, { kind: 'forbidden' })
    assert.equal(await isChannelMember(prisma, targetUserId), false)
  })
})

dbTest('a plain channel member cannot evict anybody else', async () => {
  await withDb(async (prisma) => {
    const result = await removeMemberFromChannel(prisma, actorFor(plainMemberUserId), {
      channelId,
      userId: channelAdminUserId,
    })
    assert.deepEqual(result, { kind: 'forbidden' })
    assert.equal(await isChannelMember(prisma, channelAdminUserId), true)
  })
})

dbTest('a channel admin adds and evicts, and both writes are audited', async () => {
  await withDb(async (prisma) => {
    const added = await addMemberToChannel(prisma, actorFor(channelAdminUserId), {
      channelId,
      userId: targetUserId,
    })
    assert.deepEqual(added, { kind: 'changed' })
    assert.equal(await isChannelMember(prisma, targetUserId), true)

    const removed = await removeMemberFromChannel(prisma, actorFor(channelAdminUserId), {
      channelId,
      userId: targetUserId,
    })
    assert.deepEqual(removed, { kind: 'changed' })
    assert.equal(await isChannelMember(prisma, targetUserId), false)

    const audited = await prisma.auditLog.findMany({
      where: { organizationId: orgId, resourceId: channelId },
      orderBy: { createdAt: 'asc' },
      select: { action: true, actorId: true },
    })
    assert.deepEqual(
      audited.map((row) => row.action),
      ['channel.member_added', 'channel.member_removed'],
    )
    assert.ok(audited.every((row) => row.actorId === channelAdminUserId))
  })
})

dbTest('a plain member may leave the channel themselves', async () => {
  await withDb(async (prisma) => {
    const result = await removeMemberFromChannel(prisma, actorFor(plainMemberUserId), {
      channelId,
      userId: plainMemberUserId,
    })
    assert.deepEqual(result, { kind: 'changed' })
    assert.equal(await isChannelMember(prisma, plainMemberUserId), false)
  })
})

dbTest('somebody who cannot see the private channel is told it does not exist', async () => {
  await withDb(async (prisma) => {
    const result = await addMemberToChannel(prisma, actorFor(outsiderUserId), {
      channelId,
      userId: targetUserId,
    })
    assert.deepEqual(result, { kind: 'channel_not_found' })
    assert.equal(await isChannelMember(prisma, targetUserId), false)
  })
})
