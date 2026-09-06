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
      // An automatic-membership rule that stopped granting. Revalidated against
      // the rule's live health exactly as trigger_health revalidates its
      // trigger: the moment an administrator re-authorizes it, the bell item
      // stops surfacing without anything having to remember to delete it.
      kind: 'automatic_membership_health',
      automaticMembershipRule: {
        is: { healthState: 'needs_reauthorization' },
      },
    },
    {
      // A project board's source that stopped syncing. Revalidated against the
      // source's live health exactly as trigger_health revalidates its trigger:
      // the moment somebody reconnects, resumes or re-maps it, the bell item
      // stops surfacing without anything having to remember to delete it.
      // `paused` is deliberately absent — a person pausing a source is not a
      // fault, and does not ring a bell.
      kind: 'board_source_health',
      boardSource: {
        is: {
          healthState: {
            in: ['needs_reauthorization', 'owner_inactive', 'misconfigured', 'error'],
          },
        },
      },
    },
    {
      // An agent waiting on this person. Revalidated against the request's live
      // status exactly as trigger_health revalidates its trigger: once the
      // person approves, rejects, or it expires, the bell item stops surfacing
      // without anything having to remember to delete it.
      kind: 'approval_requested',
      approvalRequest: { is: { status: 'pending' } },
    },
    {
      // The foreign key cascade removes this row on deletion, while this
      // relation check keeps a concurrent source deletion from leaking a stale
      // bell item through a read/count/write query.
      kind: 'call_missed',
      call: { is: {} },
    },
    {
      // Invitations live in UOA, so there is no local relation to revalidate.
      // Every verified /org/me read at login and token rotation reconciles
      // these rows, and acceptance deletes one immediately. The outer user
      // membership clause still requires an active membership in whichever
      // organisation currently owns the recipient's bell.
      kind: 'team_invitation',
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
