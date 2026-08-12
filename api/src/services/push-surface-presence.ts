import type { Prisma, PrismaClient } from '@prisma/client'
import type { PushSurface } from '@nessie/schemas'
import {
  AUTH_LOCK_TRANSACTION_OPTIONS,
  lockUserSessions,
} from './user-session-lock.js'

const PUSH_SURFACE_RETENTION_MS = 5 * 60_000

type PushSurfacePresencePrisma = Pick<
  PrismaClient,
  '$transaction'
>

type PushSurfacePresenceTransaction = Pick<
  Prisma.TransactionClient,
  | '$queryRaw'
  | 'channelMember'
  | 'organizationMember'
  | 'knowledgeSpace'
  | 'projectMember'
  | 'refreshToken'
  | 'thread'
  | 'userPushSurfacePresence'
>

type PushSurfacePresenceSweepPrisma = Pick<PrismaClient, 'userPushSurfacePresence'>

type PushSurfacePresenceClearPrisma = Pick<PrismaClient, 'userPushSurfacePresence'>

const resolveRecordableSurface = async (
  prisma: PushSurfacePresenceTransaction,
  input: {
    organizationId: string
    surface: PushSurface | null
    userId: string
  },
): Promise<PushSurface | null> => {
  if (!input.surface) {
    return null
  }

  if (input.surface.kind === 'ops_usage') {
    const membership = await prisma.organizationMember.findFirst({
      where: {
        organizationId: input.organizationId,
        userId: input.userId,
        deactivatedAt: null,
        role: 'owner',
      },
      select: { id: true },
    })
    return membership ? input.surface : null
  }

  if (input.surface.kind === 'project_board') {
    const membership = await prisma.projectMember.findFirst({
      where: {
        projectId: input.surface.projectId,
        userId: input.userId,
        project: { organizationId: input.organizationId },
        user: {
          organizationMembers: {
            some: { deactivatedAt: null, organizationId: input.organizationId },
          },
        },
      },
      select: { id: true },
    })
    return membership ? input.surface : null
  }

  if (input.surface.kind === 'knowledge_space') {
    const space = await prisma.knowledgeSpace.findFirst({
      where: {
        id: input.surface.spaceId,
        organizationId: input.organizationId,
        deletedAt: null,
        OR: [
          { createdBy: input.userId },
          { members: { some: { userId: input.userId } } },
          { visibility: 'organization' },
          {
            visibility: 'project',
            project: { members: { some: { userId: input.userId } } },
          },
        ],
      },
      select: { id: true },
    })
    return space ? input.surface : null
  }

  if (input.surface.kind !== 'channel') {
    return null
  }

  const membership = await prisma.channelMember.findFirst({
    where: {
      channelId: input.surface.channelId,
      userId: input.userId,
      channel: { organizationId: input.organizationId },
      user: {
        organizationMembers: {
          some: { deactivatedAt: null, organizationId: input.organizationId },
        },
      },
    },
    select: { id: true },
  })
  if (!membership) {
    return null
  }

  // The caller may only report a thread within the channel they can read.
  // Keeping this relation exact lets delivery suppress only the conversation
  // actually in focus, rather than every message in a broad channel surface.
  const thread = await prisma.thread.findFirst({
    where: {
      channelId: input.surface.channelId,
      id: input.surface.threadId,
    },
    select: { id: true },
  })
  return thread ? input.surface : null
}

/**
 * Record one browser/WebView's current foreground destination. Rows are keyed
 * by a session-local client id, so an iPhone and iPad can independently report
 * their pages and either one can suppress the matching notification. Session
 * locking makes a revoked session's stale access token unable to recreate the
 * row after the revocation has cleared it.
 */
export const recordPushSurfacePresence = async (
  prisma: PushSurfacePresencePrisma,
  input: {
    clientId: string
    organizationId: string
    sequence: bigint
    sessionId: string
    surface: PushSurface | null
    userId: string
  },
): Promise<void> => {
  await prisma.$transaction(async (transaction) => {
    await lockUserSessions(transaction, input.userId)
    const activeSession = await transaction.refreshToken.findFirst({
      where: {
        expiresAt: { gt: new Date() },
        revokedAt: null,
        sessionId: input.sessionId,
        userId: input.userId,
      },
      select: { id: true },
    })
    if (!activeSession) return

    const surface = await resolveRecordableSurface(transaction, input)
    const now = new Date()
    const surfaceKind = surface?.kind ?? null
    const channelId = surface?.kind === 'channel' ? surface.channelId : null
    const threadId = surface?.kind === 'channel' ? surface.threadId : null
    const projectId = surface?.kind === 'project_board'
      ? surface.projectId
      : null
    const knowledgeSpaceId = surface?.kind === 'knowledge_space' ? surface.spaceId : null
    const uniqueWhere = { clientId: input.clientId, userId: input.userId }
    const writeWhere = {
      ...uniqueWhere,
      heartbeatSequence: { lte: input.sequence },
    }
    const writeData = {
      channelId,
      threadId,
      projectId,
      knowledgeSpaceId,
      heartbeatSequence: input.sequence,
      lastSeenAt: now,
      organizationId: input.organizationId,
      surfaceKind,
    }

    // An earlier foreground heartbeat can be delayed while it validates a channel
    // membership. Its later completion must never overwrite a newer background
    // `surface: null` signal (or a heartbeat from a switched organization).
    const updated = await transaction.userPushSurfacePresence.updateMany({
      data: writeData,
      where: writeWhere,
    })
    if (updated.count > 0) return

    try {
      await transaction.userPushSurfacePresence.create({
        data: {
          ...writeData,
          ...uniqueWhere,
        },
      })
    } catch (error) {
      if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002')) {
        throw error
      }
      // A parallel heartbeat created the row after updateMany observed no row.
      // The same monotonic predicate decides which of the two writes survives.
      await transaction.userPushSurfacePresence.updateMany({
        data: writeData,
        where: writeWhere,
      })
    }
  }, AUTH_LOCK_TRANSACTION_OPTIONS)
}

/** Remove abandoned browser-session rows after the suppression safety window. */
export const sweepStalePushSurfacePresence = async (
  prisma: PushSurfacePresenceSweepPrisma,
  now = new Date(),
): Promise<void> => {
  await prisma.userPushSurfacePresence.deleteMany({
    where: { lastSeenAt: { lt: new Date(now.getTime() - PUSH_SURFACE_RETENTION_MS) } },
  })
}

/** A sign-out must stop the former session from suppressing any device push. */
export const clearPushSurfacePresenceForUser = async (
  prisma: PushSurfacePresenceClearPrisma,
  userId: string,
): Promise<void> => {
  await prisma.userPushSurfacePresence.deleteMany({ where: { userId } })
}
