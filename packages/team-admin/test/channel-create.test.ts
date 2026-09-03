import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import {
  ChannelSlugConflictError,
  createChannelForUser,
} from '../src/index.js'

const IDS = {
  channel: '00000000-0000-4000-8000-000000000001',
  organization: '00000000-0000-4000-8000-000000000002',
  project: '00000000-0000-4000-8000-000000000003',
  team: '00000000-0000-4000-8000-000000000004',
  thread: '00000000-0000-4000-8000-000000000005',
  user: '00000000-0000-4000-8000-000000000006',
} as const

const createStandalonePrisma = (slugTaken = false) => {
  let createdProject = false
  let createdTeam = false
  let channelCreateData: Record<string, unknown> | undefined

  const transaction = {
    $executeRaw: async () => 0,
    project: {
      create: async () => {
        createdProject = true
        return { id: IDS.project }
      },
    },
    team: {
      create: async () => {
        createdTeam = true
        return { id: IDS.team }
      },
      findFirst: async () => null,
    },
  }

  const prisma = {
    $queryRaw: async () => [],
    $transaction: async (callback: (value: typeof transaction) => unknown) => callback(transaction),
    channel: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        channelCreateData = data
        return {
          archivedAt: null,
          createdAt: new Date('2026-08-20T10:00:00.000Z'),
          dmKey: null,
          id: IDS.channel,
          label: 'general',
          organizationId: IDS.organization,
          projectId: IDS.project,
          slug: 'general',
          systemChannelType: null,
          team: {
            name: 'Standalone channels',
            project: { channelRoot: true, id: IDS.project, name: 'Standalone channels' },
          },
          teamId: IDS.team,
          type: 'standard',
          updatedAt: new Date('2026-08-20T10:00:00.000Z'),
          visibility: 'public',
        }
      },
      findFirst: async () => slugTaken ? { id: IDS.channel } : null,
    },
    thread: {
      findFirst: async () => ({ id: IDS.thread }),
    },
  } as unknown as PrismaClient

  return {
    createdProject: () => createdProject,
    createdTeam: () => createdTeam,
    getChannelCreateData: () => channelCreateData,
    prisma,
  }
}

test('standalone channels use a hidden organization-level container', async () => {
  const fake = createStandalonePrisma()

  const created = await createChannelForUser(fake.prisma, {
    label: 'General',
    organizationId: IDS.organization,
    scope: 'standalone',
    userId: IDS.user,
    visibility: 'public',
  })

  assert.equal(fake.createdProject(), true)
  assert.equal(fake.createdTeam(), true)
  assert.deepEqual(fake.getChannelCreateData(), {
    label: 'general',
    slug: 'general',
    organizationId: IDS.organization,
    projectId: IDS.project,
    teamId: IDS.team,
    visibility: 'public',
    members: { create: { userId: IDS.user, role: 'owner' } },
  })
  assert.equal(created?.scope, 'standalone')
})

test('a duplicate standalone slug names its own scope', async () => {
  const fake = createStandalonePrisma(true)

  await assert.rejects(
    createChannelForUser(fake.prisma, {
      label: 'General',
      organizationId: IDS.organization,
      scope: 'standalone',
      userId: IDS.user,
      visibility: 'public',
    }),
    (error: unknown) => error instanceof ChannelSlugConflictError
      && error.message === 'A standalone channel with slug "general" already exists',
  )
})
