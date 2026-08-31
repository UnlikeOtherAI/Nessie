import type { Prisma } from '@prisma/client'
import { visibleKnowledgeSpaceWhere } from './knowledge-space-visibility.js'

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
      // A schedule that stopped. Revalidated against the trigger's live health
      // exactly as the other kinds revalidate their resource: once somebody
      // repairs it the alert stops surfacing, the same way a completed task's
      // does. Deletion is handled by the FK cascade, and the outer clause
      // already scopes the recipient to an active membership of the alert's
      // organisation.
      kind: 'trigger_health',
      trigger: {
        is: { status: { in: ['error', 'needs_reauthorization'] } },
      },
    },
    {
      // The foreign key cascade removes this row on deletion, while this
      // relation check keeps a concurrent source deletion from leaking a stale
      // bell item through a read/count/write query.
      kind: 'call_missed',
      call: { is: {} },
    },
    {
      kind: 'knowledge_published',
      knowledgePage: {
        is: {
          deletedAt: null,
          organizationId: input.organizationId,
          status: 'published',
          space: {
            is: visibleKnowledgeSpaceWhere(input),
          },
        },
      },
    },
  ],
})
