import type { Prisma, PrismaClient } from '@prisma/client'
import { visibleKnowledgeSpaceWhere } from '@nessie/db'
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
  | '$executeRaw'
  | '$queryRaw'
  | 'channelMember'
  | 'organizationMember'
  | 'knowledgeSpace'
  | 'message'
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
        ...visibleKnowledgeSpaceWhere(input),
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
  if (!thread) {
    return null
  }

  // The channel feed has no reply root. A reply-panel heartbeat must name a
  // top-level message in this exact container thread, never a reply or a root
  // from another conversation.
  if (input.surface.rootMessageId === null) {
    return input.surface
  }

  const rootMessage = await prisma.message.findFirst({
    where: {
      id: input.surface.rootMessageId,
      rootMessageId: null,
      threadId: input.surface.threadId,
    },
    select: { id: true },
  })
  return rootMessage ? input.surface : null
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
    const rootMessageId = surface?.kind === 'channel' ? surface.rootMessageId : null
    const projectId = surface?.kind === 'project_board'
      ? surface.projectId
      : null
    const knowledgeSpaceId = surface?.kind === 'knowledge_space' ? surface.spaceId : null
    // One atomic upsert carries the monotonic predicate in the `DO UPDATE`
    // qualifier, so a brand-new row is inserted and an existing one is only
    // advanced when the incoming heartbeat is at least as recent. An earlier
    // foreground heartbeat delayed while it validated a channel membership can
    // therefore never overwrite a newer background `surface: null` signal (or a
    // heartbeat from a switched organization), and two concurrent heartbeats for
    // the same (user, client) both succeed — there is no read-then-write window
    // to lose, and no failed INSERT to abort the surrounding transaction.
    await transaction.$executeRaw`
      INSERT INTO "user_push_surface_presence" (
        "user_id", "organization_id", "client_id", "surface_kind",
        "channel_id", "thread_id", "root_message_id", "project_id",
        "knowledge_space_id", "heartbeat_sequence", "last_seen_at", "updated_at"
      ) VALUES (
        ${input.userId}::uuid,
        ${input.organizationId}::uuid,
        ${input.clientId}::uuid,
        ${surfaceKind}::"PushSurfaceKind",
        ${channelId}::uuid,
        ${threadId}::uuid,
        ${rootMessageId}::uuid,
        ${projectId}::uuid,
        ${knowledgeSpaceId}::uuid,
        ${input.sequence},
        ${now},
        ${now}
      )
      ON CONFLICT ("user_id", "client_id") DO UPDATE SET
        "organization_id" = EXCLUDED."organization_id",
        "surface_kind" = EXCLUDED."surface_kind",
        "channel_id" = EXCLUDED."channel_id",
        "thread_id" = EXCLUDED."thread_id",
        "root_message_id" = EXCLUDED."root_message_id",
        "project_id" = EXCLUDED."project_id",
        "knowledge_space_id" = EXCLUDED."knowledge_space_id",
        "heartbeat_sequence" = EXCLUDED."heartbeat_sequence",
        "last_seen_at" = EXCLUDED."last_seen_at",
        "updated_at" = EXCLUDED."updated_at"
      WHERE "user_push_surface_presence"."heartbeat_sequence"
        <= EXCLUDED."heartbeat_sequence"
    `
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
