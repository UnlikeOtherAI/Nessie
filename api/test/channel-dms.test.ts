import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import { findOrCreateDmChannel } from '../src/services/channel-dms.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const projectId = '00000000-0000-4000-8000-000000000002'
const teamId = '00000000-0000-4000-8000-000000000003'
const userId = '00000000-0000-4000-8000-00000000000a'
const channelId = '00000000-0000-4000-8000-000000000010'
const threadId = '00000000-0000-4000-8000-000000000011'
const legacyChannelId = '00000000-0000-4000-8000-000000000012'

type ChannelUpsertArgs = {
  create: {
    dmKey: string
    label: string
    members: { create: Array<{ userId: string }> }
    projectId: string
  }
}

test('findOrCreateDmChannel creates a one-member self DM', async () => {
  let upsertArgs: ChannelUpsertArgs | null = null

  const prisma = {
    organizationMember: {
      count: async ({ where }: { where: { userId: { in: string[] } } }) =>
        where.userId.in.includes(userId) ? 1 : 0,
    },
    user: {
      findUnique: async () => ({ displayName: 'Owner' }),
    },
    team: {
      findUnique: async () => ({
        name: 'Default Team',
        project: {
          id: projectId,
          name: 'Default Project',
          organizationId,
        },
      }),
    },
    channel: {
      findUnique: async () => null,
      upsert: async (args: ChannelUpsertArgs) => {
        upsertArgs = args
        return {
          archivedAt: null,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          description: null,
          dmKey: args.create.dmKey,
          id: channelId,
          label: args.create.label,
          organizationId,
          systemChannelType: null,
          team: {
            name: 'Default Team',
            project: { id: projectId, name: 'Default Project' },
          },
          teamId,
          topic: null,
          type: 'dm',
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
          visibility: 'private',
        }
      },
      findUniqueOrThrow: async () => {
        throw new Error('unexpected existing DM lookup')
      },
    },
    thread: {
      findFirst: async () => ({ id: threadId }),
    },
    $queryRaw: async () => [{ thread_id: threadId, unread_count: 0 }],
  } as unknown as PrismaClient

  const channel = await findOrCreateDmChannel(prisma, {
    currentUserId: userId,
    organizationId,
    targetUserId: userId,
    teamId,
  })

  assert.equal(channel?.id, channelId)
  assert.equal(channel?.label, 'Owner')
  assert.equal(upsertArgs?.create.dmKey, `${organizationId}:${teamId}:${userId}:${userId}`)
  assert.deepEqual(upsertArgs?.create.members.create, [{ userId }])
  assert.equal(upsertArgs?.create.projectId, projectId)
})

test('findOrCreateDmChannel migrates a legacy one-member self DM key', async () => {
  let updateArgs: { data: { dmKey?: string; projectId?: string }; where: { id: string } } | null =
    null
  const legacyDmKey = `${organizationId}:${teamId}:${userId}`
  const canonicalDmKey = `${organizationId}:${teamId}:${userId}:${userId}`

  const channelRecord = (id: string, dmKey: string) => ({
    archivedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    description: null,
    dmKey,
    id,
    label: 'Owner',
    organizationId,
    projectId,
    slug: null,
    systemChannelType: null,
    team: {
      name: 'Default Team',
      project: { id: projectId, name: 'Default Project' },
    },
    teamId,
    topic: null,
    type: 'dm',
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    visibility: 'private',
  })

  const prisma = {
    organizationMember: {
      count: async ({ where }: { where: { userId: { in: string[] } } }) =>
        where.userId.in.includes(userId) ? 1 : 0,
    },
    user: {
      findUnique: async () => ({ displayName: 'Owner' }),
    },
    team: {
      findUnique: async () => ({
        name: 'Default Team',
        project: {
          id: projectId,
          name: 'Default Project',
          organizationId,
        },
      }),
    },
    channel: {
      findUnique: async () => channelRecord(legacyChannelId, legacyDmKey),
      update: async (args: { data: { dmKey?: string; projectId?: string }; where: { id: string } }) => {
        updateArgs = args
        return channelRecord(legacyChannelId, canonicalDmKey)
      },
      upsert: async () => {
        throw new Error('unexpected self DM upsert')
      },
      findUniqueOrThrow: async () => {
        throw new Error('unexpected existing DM lookup')
      },
    },
    thread: {
      findFirst: async () => ({ id: threadId }),
    },
    $queryRaw: async () => [{ thread_id: threadId, unread_count: 0 }],
  } as unknown as PrismaClient

  const channel = await findOrCreateDmChannel(prisma, {
    currentUserId: userId,
    organizationId,
    targetUserId: userId,
    teamId,
  })

  assert.equal(channel?.id, legacyChannelId)
  assert.equal(updateArgs?.where.id, legacyChannelId)
  assert.equal(updateArgs?.data.dmKey, canonicalDmKey)
  assert.equal(updateArgs?.data.projectId, projectId)
})
