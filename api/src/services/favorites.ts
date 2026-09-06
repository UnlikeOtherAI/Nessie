import type { Prisma, PrismaClient } from '@prisma/client'
import { buildAccessibleChannelWhere } from '@nessie/team-admin'

import type { FavoriteRecord, FavoriteTargetType } from '../contracts/favorites.js'
type FavoriteOwner = {
  includeAllOrgChannels?: boolean
  organizationId: string
  userId: string
}

type FavoriteTarget = {
  targetId: string
  targetType: FavoriteTargetType
}

type FavoriteInput = FavoriteOwner & FavoriteTarget

type FavoriteRow = {
  createdAt: Date
  targetId: string
  targetType: string
}

export class FavoriteServiceError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

const favoriteWhere = (input: FavoriteInput): Prisma.FavoriteWhereInput => ({
  organizationId: input.organizationId,
  targetId: input.targetId,
  targetType: input.targetType,
  userId: input.userId,
})

const mapFavoriteRecord = (favorite: FavoriteRow): FavoriteRecord => ({
  createdAt: favorite.createdAt.toISOString(),
  targetId: favorite.targetId,
  targetType: favorite.targetType as FavoriteTargetType,
})

const canFavoriteUser = async (
  prisma: PrismaClient,
  input: FavoriteInput,
): Promise<boolean> =>
  (await prisma.organizationMember.count({
    where: {
      organizationId: input.organizationId,
      userId: input.targetId,
    },
  })) > 0

const canFavoriteChannel = async (
  prisma: PrismaClient,
  input: FavoriteInput,
): Promise<boolean> =>
  (await prisma.channel.count({
    where: {
      id: input.targetId,
      ...buildAccessibleChannelWhere(input),
    },
  })) > 0

const canFavoriteAgent = async (
  prisma: PrismaClient,
  input: FavoriteInput,
): Promise<boolean> => {
  const userVisibleAgent: Prisma.AgentWhereInput = input.includeAllOrgChannels
    ? {
        systemManaged: false,
        OR: [
          { organizationId: input.organizationId },
          {
            bindings: {
              some: {
                channel: { organizationId: input.organizationId },
              },
            },
          },
        ],
      }
    : {
        systemManaged: false,
        bindings: {
          some: {
            channel: buildAccessibleChannelWhere(input),
          },
        },
      }

  return (
    await prisma.agent.count({
      where: {
        id: input.targetId,
        OR: [
          userVisibleAgent,
          {
            agentKind: 'personal_assistant',
            organizationId: input.organizationId,
            systemManaged: true,
          },
        ],
      },
    })
  ) > 0
}

const canFavoriteTarget = async (
  prisma: PrismaClient,
  input: FavoriteInput,
): Promise<boolean> => {
  if (input.targetType === 'agent') {
    return canFavoriteAgent(prisma, input)
  }
  if (input.targetType === 'channel') {
    return canFavoriteChannel(prisma, input)
  }
  return canFavoriteUser(prisma, input)
}

export const listFavorites = async (
  prisma: PrismaClient,
  owner: FavoriteOwner,
): Promise<FavoriteRecord[]> => {
  const favorites = await prisma.favorite.findMany({
    where: {
      organizationId: owner.organizationId,
      userId: owner.userId,
    },
    orderBy: { createdAt: 'asc' },
    select: {
      createdAt: true,
      targetId: true,
      targetType: true,
    },
  })

  return favorites.map(mapFavoriteRecord)
}

export const setFavorite = async (
  prisma: PrismaClient,
  input: FavoriteInput,
): Promise<FavoriteRecord> => {
  if (!(await canFavoriteTarget(prisma, input))) {
    throw new FavoriteServiceError(404, 'FAVORITE_TARGET_NOT_FOUND', 'Favorite target not found')
  }

  await prisma.favorite.createMany({
    data: [{
      organizationId: input.organizationId,
      targetId: input.targetId,
      targetType: input.targetType,
      userId: input.userId,
    }],
    skipDuplicates: true,
  })

  const favorite = await prisma.favorite.findFirstOrThrow({
    where: favoriteWhere(input),
    select: {
      createdAt: true,
      targetId: true,
      targetType: true,
    },
  })

  return mapFavoriteRecord(favorite)
}

export const unsetFavorite = async (
  prisma: PrismaClient,
  input: FavoriteInput,
): Promise<void> => {
  await prisma.favorite.deleteMany({
    where: favoriteWhere(input),
  })
}
