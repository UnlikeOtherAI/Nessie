import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import {
  FavoriteServiceError,
  listFavorites,
  setFavorite,
  unsetFavorite,
} from '../src/services/favorites.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const userId = '00000000-0000-4000-8000-00000000000a'
const channelId = '00000000-0000-4000-8000-000000000003'
const inaccessibleUserId = '00000000-0000-4000-8000-000000000099'

type FavoriteRow = {
  createdAt: Date
  organizationId: string
  targetId: string
  targetType: 'agent' | 'channel' | 'user'
  userId: string
}

const matchesFavorite = (
  row: FavoriteRow,
  where: Partial<FavoriteRow>,
): boolean =>
  row.organizationId === where.organizationId
  && row.userId === where.userId
  && row.targetId === where.targetId
  && row.targetType === where.targetType

const makePrisma = (favorites: FavoriteRow[]): PrismaClient =>
  ({
    agent: {
      count: async () => 0,
    },
    channel: {
      count: async ({ where }: { where: { id: string; organizationId: string } }) =>
        where.id === channelId && where.organizationId === organizationId ? 1 : 0,
    },
    favorite: {
      createMany: async ({ data }: { data: FavoriteRow[] }) => {
        for (const favorite of data) {
          if (!favorites.some((row) => matchesFavorite(row, favorite))) {
            favorites.push({ ...favorite, createdAt: new Date('2026-06-13T10:00:00.000Z') })
          }
        }
      },
      deleteMany: async ({ where }: { where: Partial<FavoriteRow> }) => {
        const remaining = favorites.filter((row) => !matchesFavorite(row, where))
        favorites.splice(0, favorites.length, ...remaining)
      },
      findFirstOrThrow: async ({ where }: { where: Partial<FavoriteRow> }) => {
        const favorite = favorites.find((row) => matchesFavorite(row, where))
        if (!favorite) {
          throw new Error('Favorite not found')
        }
        return favorite
      },
      findMany: async ({ where }: { where: Partial<FavoriteRow> }) =>
        favorites.filter(
          (row) =>
            row.organizationId === where.organizationId && row.userId === where.userId,
        ),
    },
    organizationMember: {
      count: async ({ where }: { where: { organizationId: string; userId: string } }) =>
        where.organizationId === organizationId && where.userId !== inaccessibleUserId ? 1 : 0,
    },
  }) as unknown as PrismaClient

test('setFavorite stores a visible channel favorite idempotently', async () => {
  const rows: FavoriteRow[] = []
  const prisma = makePrisma(rows)

  const input = {
    organizationId,
    targetId: channelId,
    targetType: 'channel' as const,
    userId,
  }

  const first = await setFavorite(prisma, input)
  const second = await setFavorite(prisma, input)

  assert.equal(rows.length, 1)
  assert.equal(first.targetId, channelId)
  assert.deepEqual(second, first)
})

test('unsetFavorite removes only the matching user favorite', async () => {
  const rows: FavoriteRow[] = [
    {
      createdAt: new Date('2026-06-13T10:00:00.000Z'),
      organizationId,
      targetId: channelId,
      targetType: 'channel',
      userId,
    },
    {
      createdAt: new Date('2026-06-13T10:00:00.000Z'),
      organizationId,
      targetId: '00000000-0000-4000-8000-000000000004',
      targetType: 'channel',
      userId,
    },
  ]
  const prisma = makePrisma(rows)

  await unsetFavorite(prisma, {
    organizationId,
    targetId: channelId,
    targetType: 'channel',
    userId,
  })
  const favorites = await listFavorites(prisma, { organizationId, userId })

  assert.equal(favorites.length, 1)
  assert.equal(favorites[0]?.targetId, '00000000-0000-4000-8000-000000000004')
})

test('setFavorite rejects an inaccessible user target', async () => {
  const prisma = makePrisma([])

  await assert.rejects(
    setFavorite(prisma, {
      organizationId,
      targetId: inaccessibleUserId,
      targetType: 'user',
      userId,
    }),
    (error) =>
      error instanceof FavoriteServiceError
      && error.code === 'FAVORITE_TARGET_NOT_FOUND',
  )
})
