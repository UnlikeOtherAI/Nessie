import { randomUUID } from 'node:crypto'
import type { MemberRole, Prisma, PrismaClient, User } from '@prisma/client'
import { parseChannelId, parseUserId } from '@nessie/schemas'
import type { UserRecord } from '../contracts.js'

const mapUserRecord = (record: {
  channelMembers: Array<{ channelId: string }>
  createdAt: Date
  displayName: string
  email: string
  id: string
  organizationMembers: Array<{ role: string }>
  updatedAt: Date
}): UserRecord => ({
  id: parseUserId(record.id),
  email: record.email,
  displayName: record.displayName,
  role: record.organizationMembers[0]?.role ?? 'member',
  channelIds: record.channelMembers.map((member) => parseChannelId(member.channelId)),
  createdAt: record.createdAt.toISOString(),
  updatedAt: record.updatedAt.toISOString(),
})

const sessionUserInclude = {
  organizationMembers: {
    orderBy: { createdAt: 'asc' },
    select: {
      organizationId: true,
      role: true,
    },
  },
  projectMembers: {
    orderBy: { createdAt: 'asc' },
    select: {
      projectId: true,
    },
  },
  teamMembers: {
    orderBy: { createdAt: 'asc' },
    select: {
      teamId: true,
    },
  },
} satisfies Prisma.UserInclude

export type SessionUserRecord = User & {
  organizationMembers: Array<{
    organizationId: string
    role: string
  }>
  projectMembers: Array<{
    projectId: string
  }>
  teamMembers: Array<{
    teamId: string
  }>
}

export const listUsersForOrganization = async (
  prisma: PrismaClient,
  organizationId: string,
): Promise<UserRecord[]> => {
  const users = await prisma.user.findMany({
    where: {
      organizationMembers: {
        some: { organizationId },
      },
    },
    include: {
      channelMembers: {
        where: {
          channel: {
            organizationId,
          },
        },
        select: { channelId: true },
      },
      organizationMembers: {
        where: { organizationId },
        select: { role: true },
        take: 1,
      },
    },
    orderBy: { createdAt: 'asc' },
  })

  return users.map(mapUserRecord)
}

export const createUserForOrganization = async (
  prisma: PrismaClient,
  input: {
    channelIds?: string[]
    displayName: string
    email: string
    organizationId: string
    passwordHash?: string
    projectId: string
    role: MemberRole
    teamId: string
    avatarUrl?: string
    pronouns?: string
  },
): Promise<UserRecord> => {
  const normalizedEmail = input.email.trim().toLowerCase()

  const existingUser = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    select: { id: true },
  })

  if (existingUser) {
    throw new Error('USER_ALREADY_EXISTS')
  }

  const requestedChannelIds = input.channelIds ?? []
  const organizationChannels = await prisma.channel.findMany({
    where: {
      id: requestedChannelIds.length > 0 ? { in: requestedChannelIds } : undefined,
      organizationId: input.organizationId,
    },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  })

  const channelIds =
    requestedChannelIds.length > 0
      ? organizationChannels.map((channel) => channel.id)
      : (
          await prisma.channel.findMany({
            where: { organizationId: input.organizationId },
            select: { id: true },
            orderBy: { createdAt: 'asc' },
            take: 1,
          })
        ).map((channel) => channel.id)

  const userId = parseUserId(randomUUID())

  const createdUser = await prisma.$transaction(async (transaction) => {
    const user = await transaction.user.create({
      data: {
        id: userId,
        email: normalizedEmail,
        displayName: input.displayName,
        passwordHash: input.passwordHash,
        avatarUrl: input.avatarUrl,
        pronouns: input.pronouns,
      },
      include: {
        channelMembers: {
          select: { channelId: true },
        },
        organizationMembers: {
          select: { role: true },
        },
      },
    })

    await transaction.organizationMember.create({
      data: {
        organizationId: input.organizationId,
        role: input.role,
        userId,
      },
    })

    await transaction.projectMember.create({
      data: {
        projectId: input.projectId,
        role: input.role,
        userId,
      },
    })

    await transaction.teamMember.create({
      data: {
        teamId: input.teamId,
        role: input.role,
        userId,
      },
    })

    if (channelIds.length > 0) {
      await transaction.channelMember.createMany({
        data: channelIds.map((channelId) => ({
          channelId,
          userId,
        })),
      })
    }

    return user
  })

  const hydratedUser = await prisma.user.findUniqueOrThrow({
    where: { id: createdUser.id },
    include: {
      channelMembers: {
        where: {
          channel: {
            organizationId: input.organizationId,
          },
        },
        select: { channelId: true },
      },
      organizationMembers: {
        where: { organizationId: input.organizationId },
        select: { role: true },
        take: 1,
      },
    },
  })

  return mapUserRecord(hydratedUser)
}

export const loadSessionUserByEmail = async (
  prisma: PrismaClient,
  email: string,
): Promise<SessionUserRecord | null> =>
  prisma.user.findUnique({
    where: { email: email.trim().toLowerCase() },
    include: sessionUserInclude,
  })

export const loadSessionUserById = async (
  prisma: PrismaClient,
  userId: string,
): Promise<SessionUserRecord | null> =>
  prisma.user.findUnique({
    where: { id: userId },
    include: sessionUserInclude,
  })
