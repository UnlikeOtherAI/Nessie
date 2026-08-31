import type { Prisma } from '@prisma/client'
import { buildVisibleAgentWhere } from './agent-visibility.js'

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
      kind: 'knowledge_published',
      // This mirrors the human-reader access rules in @nessie/knowledge's
      // canReadSpace. Keep changes to that access policy synchronized here:
      // Prisma must express the relation predicate for list/count queries.
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
                {
                  // Agent documents derive their human audience from the one
                  // agent-visibility fragment, while an explicit space member
                  // remains a deliberate grant. Do not fall through to stored
                  // visibility; see docs/plans/2026-08-31-agent-documents.md §4.1.
                  ownerAgentId: { not: null },
                  OR: [
                    { members: { some: { userId: input.userId } } },
                    {
                      ownerAgent: {
                        is: buildVisibleAgentWhere(input),
                      },
                    },
                  ],
                },
                {
                  // Non-agent spaces retain the established creator, member,
                  // organization, and project arms. The owner-null guard keeps
                  // an agent home from widening through any of them.
                  ownerAgentId: null,
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
              ],
            },
          },
        },
      },
    },
  ],
})
