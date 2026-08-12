import type { Prisma } from '@prisma/client'

const TERMINAL_TASK_STATUSES = ['done', 'cancelled'] as const

/**
 * A durable alert row is not proof that its recipient can still see its
 * source. Every list, count, read, and delivery caller uses this predicate so
 * revoked access and superseded work leave no stale attention behind.
 */
export const visibleUserAlertWhere = (input: {
  organizationId: string
  userId: string
}): Prisma.UserAlertWhereInput => ({
  organizationId: input.organizationId,
  userId: input.userId,
  user: {
    organizationMembers: {
      some: { deactivatedAt: null, organizationId: input.organizationId },
    },
  },
  OR: [
    {
      kind: 'mention',
      channel: {
        is: {
          organizationId: input.organizationId,
          members: { some: { userId: input.userId } },
        },
      },
    },
    {
      kind: 'task_assigned',
      task: {
        is: {
          archivedAt: null,
          assigneeUserId: input.userId,
          organizationId: input.organizationId,
          status: { notIn: [...TERMINAL_TASK_STATUSES] },
          project: { is: { members: { some: { userId: input.userId } } } },
        },
      },
    },
    {
      kind: 'knowledge_published',
      knowledgePage: {
        is: {
          deletedAt: null,
          organizationId: input.organizationId,
          status: 'published',
          space: {
            is: {
              deletedAt: null,
              organizationId: input.organizationId,
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
          },
        },
      },
    },
  ],
})
