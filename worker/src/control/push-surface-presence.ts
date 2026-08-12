import type { PrismaClient } from '@prisma/client'

const ACTIVE_SURFACE_WINDOW_MS = 70_000

type PushSurfacePresencePrisma = Pick<PrismaClient, 'userPushSurfacePresence'>

// Queue payloads are already structural server data. Keep this internal shape
// unbranded so unit fakes can use their existing concise identifiers; the HTTP
// heartbeat boundary remains UUID-validated by @nessie/schemas.
export type PushSurfaceTarget =
  | { kind: 'channel'; channelId: string; threadId: string }
  | { kind: 'ops_usage' }
  | { kind: 'project_board'; projectId: string }
  | { kind: 'knowledge_space'; spaceId: string }

/**
 * Returns the recipient ids that are already viewing the exact destination of
 * a notification in a visible app/browser session. A stale page heartbeat is
 * deliberately ignored so a backgrounded or closed device still receives the
 * notification.
 */
export const findRecipientsViewingPushSurface = async (
  prisma: PushSurfacePresencePrisma,
  input: {
    now: Date
    organizationId: string
    recipientIds: string[]
    surface: PushSurfaceTarget
  },
): Promise<Set<string>> => {
  if (input.recipientIds.length === 0) {
    return new Set()
  }

  const rows = await prisma.userPushSurfacePresence.findMany({
    where: {
      organizationId: input.organizationId,
      userId: { in: input.recipientIds },
      surfaceKind: input.surface.kind,
      ...(input.surface.kind === 'channel'
        ? {
          channelId: input.surface.channelId,
          knowledgeSpaceId: null,
          projectId: null,
          threadId: input.surface.threadId,
        }
        : input.surface.kind === 'project_board'
          ? { channelId: null, projectId: input.surface.projectId, knowledgeSpaceId: null, threadId: null }
          : input.surface.kind === 'knowledge_space'
            ? { channelId: null, projectId: null, knowledgeSpaceId: input.surface.spaceId, threadId: null }
            : { channelId: null, projectId: null, knowledgeSpaceId: null, threadId: null }),
      lastSeenAt: { gte: new Date(input.now.getTime() - ACTIVE_SURFACE_WINDOW_MS) },
    },
    select: { userId: true },
  })

  return new Set(rows.map((row) => row.userId))
}
