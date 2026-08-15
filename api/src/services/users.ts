import { randomUUID } from 'node:crypto'
import type { MemberRole, Prisma, PrismaClient, User } from '@prisma/client'
import { parseChannelId, parseUserId } from '@nessie/schemas'
import type { UserRecord } from '../contracts.js'
import { assertNotLastOwner } from './organization-owner-lock.js'
import { revokeUserRefreshFamilies } from './refresh-session-management.js'
import {
  AUTH_LOCK_TRANSACTION_OPTIONS,
  lockUserSessions,
} from './user-session-lock.js'
import { resolveActiveStatus, type StatusWithRelations } from './user-statuses.js'

const mapUserRecord = (record: {
  avatarUrl: string | null
  avatarAttachmentId: string | null
  channelMembers: Array<{ channelId: string }>
  createdAt: Date
  displayName: string
  email: string
  id: string
  organizationMembers: Array<{ role: string; deactivatedAt?: Date | null }>
  statuses: StatusWithRelations[]
  updatedAt: Date
}): UserRecord => ({
  id: parseUserId(record.id),
  email: record.email,
  displayName: record.displayName,
  role: record.organizationMembers[0]?.role ?? 'member',
  deactivatedAt: record.organizationMembers[0]?.deactivatedAt?.toISOString() ?? null,
  channelIds: record.channelMembers.map((member) => parseChannelId(member.channelId)),
  activeStatus: resolveActiveStatus(record.statuses),
  avatarUrl: record.avatarUrl ?? undefined,
  avatarAttachmentId: record.avatarAttachmentId ?? undefined,
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

// Shared include so the list and single-member fetch hydrate identical
// UserRecord shapes (channels in-org, the in-org membership role + deactivation,
// and active status).
const buildOrganizationUserInclude = (organizationId: string) =>
  ({
    channelMembers: {
      where: { channel: { organizationId } },
      select: { channelId: true },
    },
    organizationMembers: {
      where: { organizationId },
      select: { role: true, deactivatedAt: true },
      take: 1,
    },
    statuses: {
      where: { organizationId },
      include: { schedules: true, rules: true },
      orderBy: { createdAt: 'asc' },
    },
  }) satisfies Prisma.UserInclude

export const listUsersForOrganization = async (
  prisma: PrismaClient,
  organizationId: string,
): Promise<UserRecord[]> => {
  const users = await prisma.user.findMany({
    where: { organizationMembers: { some: { organizationId } } },
    include: buildOrganizationUserInclude(organizationId),
    orderBy: { createdAt: 'asc' },
  })

  return users.map(mapUserRecord)
}

export const getOrganizationUserRecord = async (
  prisma: PrismaClient,
  organizationId: string,
  userId: string,
): Promise<UserRecord | null> => {
  const user = await prisma.user.findFirst({
    where: { id: userId, organizationMembers: { some: { organizationId } } },
    include: buildOrganizationUserInclude(organizationId),
  })

  return user ? mapUserRecord(user) : null
}

export type MembershipSummary = {
  role: MemberRole
  deactivatedAt: Date | null
}

// Membership for one (org, user) pair — null when the user is not a member of
// the org, which lets routes 404 instead of mutating across tenants.
export const getOrganizationMembership = async (
  prisma: PrismaClient,
  organizationId: string,
  userId: string,
): Promise<MembershipSummary | null> =>
  prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
    select: { role: true, deactivatedAt: true },
  })

export const updateOrganizationMemberRole = async (
  prisma: PrismaClient,
  input: { organizationId: string; userId: string; role: MemberRole },
): Promise<void> => {
  await prisma.$transaction(async (transaction) => {
    // Demoting an owner could remove the last one — guard atomically under the
    // owner-row lock so concurrent demotions/deactivations can't both pass.
    if (input.role !== 'owner') {
      await assertNotLastOwner(transaction, input.organizationId, input.userId)
    }
    await transaction.organizationMember.update({
      where: {
        organizationId_userId: { organizationId: input.organizationId, userId: input.userId },
      },
      data: { role: input.role },
    })
  })
}

// Deactivation is reversible: keep the row + history, flip `deactivatedAt`, and
// on deactivate revoke the user's refresh tokens so the session cannot be
// renewed (the access token is rejected immediately in authenticateRequest).
// Refresh tokens are global per user, so this also ends sessions in any other
// org the user belongs to — acceptable for a security-sensitive action.
export const setOrganizationMemberDeactivated = async (
  prisma: PrismaClient,
  input: { organizationId: string; userId: string; deactivated: boolean },
): Promise<void> => {
  await prisma.$transaction(async (transaction) => {
    await lockUserSessions(transaction, input.userId)
    if (input.deactivated) {
      await assertNotLastOwner(transaction, input.organizationId, input.userId)
    }
    await transaction.organizationMember.update({
      where: {
        organizationId_userId: { organizationId: input.organizationId, userId: input.userId },
      },
      data: { deactivatedAt: input.deactivated ? new Date() : null },
    })

    if (input.deactivated) {
      await revokeUserRefreshFamilies(transaction, {
        userId: input.userId,
      })
      // Channel memberships and device tokens remain as audit/device history,
      // but an inactive member must not retain an in-app suppression target.
      await transaction.userPushSurfacePresence.deleteMany({
        where: { userId: input.userId },
      })
    }
  }, AUTH_LOCK_TRANSACTION_OPTIONS)
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
        statuses: {
          include: { schedules: true, rules: true },
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
      statuses: {
        where: { organizationId: input.organizationId },
        include: { schedules: true, rules: true },
        orderBy: { createdAt: 'asc' },
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
