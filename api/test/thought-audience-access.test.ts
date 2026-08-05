import assert from 'node:assert/strict'
import test from 'node:test'

import type { Prisma, PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

import { checkThoughtAudienceAccess } from '../src/services/thought-audience-access.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const memberId = '00000000-0000-4000-8000-000000000002'
const strangerId = '00000000-0000-4000-8000-000000000003'
const ownerId = '00000000-0000-4000-8000-000000000004'
const memberChannelId = '00000000-0000-4000-8000-000000000005'
const privateChannelId = '00000000-0000-4000-8000-000000000006'
const publicChannelId = '00000000-0000-4000-8000-000000000007'
const memberTeamId = '00000000-0000-4000-8000-000000000008'
const foreignTeamId = '00000000-0000-4000-8000-000000000009'
const memberProjectId = '00000000-0000-4000-8000-00000000000a'
const foreignProjectId = '00000000-0000-4000-8000-00000000000b'

const actorCtx = (actorId: string, roles: string[] = []): AuthorizedActionContext =>
  ({
    actor: { actorType: 'user', actorId, roles },
    tenant: { organizationId },
  }) as unknown as AuthorizedActionContext

const channels = [
  { id: memberChannelId, organizationId, visibility: 'private', members: [memberId] },
  { id: privateChannelId, organizationId, visibility: 'private', members: [strangerId] },
  { id: publicChannelId, organizationId, visibility: 'public', members: [] },
]
const teamMembers = [{ teamId: memberTeamId, userId: memberId }]
const projectMembers = [{ projectId: memberProjectId, userId: memberId }]

const prisma = {
  channel: {
    count: async ({ where }: { where: Prisma.ChannelWhereInput }) => {
      const channel = channels.find((entry) => entry.id === where.id)
      if (!channel || channel.organizationId !== where.organizationId) return 0
      const alternatives = (where.OR ?? []) as Array<Record<string, unknown>>
      const ok = alternatives.some((alternative) => {
        if ('visibility' in alternative) return channel.visibility === 'public'
        const wanted = (
          alternative.members as { some?: { userId?: string } } | undefined
        )?.some?.userId
        return wanted !== undefined && channel.members.includes(wanted)
      })
      return ok ? 1 : 0
    },
  },
  teamMember: {
    count: async ({ where }: { where: Prisma.TeamMemberWhereInput }) =>
      teamMembers.filter(
        (entry) => entry.teamId === where.teamId && entry.userId === where.userId,
      ).length,
  },
  projectMember: {
    count: async ({ where }: { where: Prisma.ProjectMemberWhereInput }) =>
      projectMembers.filter(
        (entry) => entry.projectId === where.projectId && entry.userId === where.userId,
      ).length,
  },
} as unknown as PrismaClient

const check = (actorId: string, audienceType: string, audienceId: string, roles: string[] = []) =>
  checkThoughtAudienceAccess(prisma, actorCtx(actorId, roles), {
    audienceType: audienceType as 'channel' | 'team' | 'project' | 'user' | 'organization',
    audienceId,
  })

test('a member can file a channel memory in a channel they belong to', async () => {
  assert.equal(await check(memberId, 'channel', memberChannelId), null)
})

test('a member cannot file a channel memory into a private channel they are not in', async () => {
  // Without this the audience id is just a string from the request body, so any
  // member could poison what agents recall for a channel they cannot even read.
  assert.equal(await check(memberId, 'channel', privateChannelId), 'AUDIENCE_FORBIDDEN')
})

test('a public channel is a legitimate memory audience for any member', async () => {
  assert.equal(await check(memberId, 'channel', publicChannelId), null)
})

test('team memories require team membership', async () => {
  assert.equal(await check(memberId, 'team', memberTeamId), null)
  assert.equal(await check(memberId, 'team', foreignTeamId), 'AUDIENCE_FORBIDDEN')
})

test('project memories require project membership', async () => {
  assert.equal(await check(memberId, 'project', memberProjectId), null)
  assert.equal(await check(memberId, 'project', foreignProjectId), 'AUDIENCE_FORBIDDEN')
})

test('a private memory can only be filed against the actor themselves', async () => {
  assert.equal(await check(memberId, 'user', memberId), null)
  assert.equal(await check(memberId, 'user', strangerId), 'AUDIENCE_FORBIDDEN')
})

test('an organization memory must name the actor own organization', async () => {
  assert.equal(await check(memberId, 'organization', organizationId), null)
  assert.equal(
    await check(memberId, 'organization', '00000000-0000-4000-8000-0000000000ff'),
    'AUDIENCE_FORBIDDEN',
  )
})

test('an owner is not blocked from any audience in their organization', async () => {
  assert.equal(await check(ownerId, 'channel', privateChannelId, ['owner']), null)
  assert.equal(await check(ownerId, 'project', foreignProjectId, ['owner']), null)
})
