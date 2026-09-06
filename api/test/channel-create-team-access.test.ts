import assert from 'node:assert/strict'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import { ChannelTeamAccessError, createChannelForUser } from '@nessie/team-admin'

/**
 * A team is the unit people are members of, so an organisation membership does
 * not entitle somebody to place a channel in an arbitrary team named in the
 * request body. Against a real database because the rule is four rows —
 * `TeamMember`, `ProjectMember`, the organisation role, and the team's own
 * `systemManaged` flag.
 */

const suite = 'c93e'
const orgId = `00000000-0000-4000-8000-${suite}00000001`
const projectId = `00000000-0000-4000-8000-${suite}00000002`
const teamId = `00000000-0000-4000-8000-${suite}00000003`

const teamMemberUserId = `00000000-0000-4000-8000-${suite}00000010`
const projectMemberUserId = `00000000-0000-4000-8000-${suite}00000011`
const orgAdminUserId = `00000000-0000-4000-8000-${suite}00000012`
const strangerUserId = `00000000-0000-4000-8000-${suite}00000013`

const userIds = [teamMemberUserId, projectMemberUserId, orgAdminUserId, strangerUserId]

const dbTest = process.env.DATABASE_URL ? test : test.skip

const seed = async (prisma: PrismaClient) => {
  await prisma.organization.create({ data: { id: orgId, name: `chan-team-${suite}` } })
  await prisma.user.createMany({
    data: userIds.map((id, index) => ({
      displayName: `Channel team ${index}`,
      email: `chan-team-${suite}-${index}@test.local`,
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
  await prisma.teamMember.create({ data: { teamId, role: 'member', userId: teamMemberUserId } })
  await prisma.projectMember.create({
    data: { projectId, role: 'member', userId: projectMemberUserId },
  })
}

const cleanup = async (prisma: PrismaClient) => {
  await prisma.channelMember.deleteMany({ where: { channel: { organizationId: orgId } } })
  await prisma.channel.deleteMany({ where: { organizationId: orgId } })
  await prisma.teamMember.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.projectMember.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.team.deleteMany({ where: { projectId } })
  await prisma.project.deleteMany({ where: { organizationId: orgId } })
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

const create = (prisma: PrismaClient, userId: string, label: string) =>
  createChannelForUser(prisma, {
    label,
    organizationId: orgId,
    teamId,
    userId,
    visibility: 'public',
  })

dbTest('an organisation member with no standing in the team is refused', async () => {
  await withDb(async (prisma) => {
    await assert.rejects(
      create(prisma, strangerUserId, 'stranger'),
      (error: unknown) => error instanceof ChannelTeamAccessError,
    )
    assert.equal(await prisma.channel.count({ where: { organizationId: orgId } }), 0)
  })
})

dbTest('a team member, a project member and an organisation admin may each place one', async () => {
  await withDb(async (prisma) => {
    for (const [userId, label] of [
      [teamMemberUserId, 'by-team-member'],
      [projectMemberUserId, 'by-project-member'],
      [orgAdminUserId, 'by-org-admin'],
    ] as const) {
      const channel = await create(prisma, userId, label)
      assert.equal(channel?.label, label)
    }
    assert.equal(await prisma.channel.count({ where: { organizationId: orgId } }), 3)
  })
})
