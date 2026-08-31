import type { Prisma } from '@prisma/client'
import { listVisibleAgentIdsForUser } from '@nessie/db'
import { canReadSpace } from '@nessie/knowledge'

import { enqueueAttentionDispatch } from '../queue/pgqueue.js'

type AttentionTransaction = Pick<
  Prisma.TransactionClient,
  | 'agent'
  | 'organizationMember'
  | 'projectMember'
  | 'knowledgeSpace'
  | 'userAlert'
  | '$executeRaw'
>

/**
 * A newer assignment or publication supersedes every older unread generation
 * for the same target. Keep the old records for audit, but retire them before
 * creating the new one so an assignment-away/assign-back or re-publication
 * cannot make stale attention return to a person's badges.
 */
const retireSupersededAttention = async (
  tx: AttentionTransaction,
  input: {
    eventKey: string
    kind: 'knowledge_published' | 'task_assigned'
    knowledgePageId?: string
    organizationId: string
    taskId?: string
  },
): Promise<void> => {
  await tx.userAlert.updateMany({
    where: {
      kind: input.kind,
      organizationId: input.organizationId,
      readAt: null,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.knowledgePageId ? { knowledgePageId: input.knowledgePageId } : {}),
      // The idempotent retry of this exact source event must keep its newly
      // created row unread. `null` is included for safe handling of any
      // historic generation created before event keys were introduced.
      OR: [{ eventKey: { not: input.eventKey } }, { eventKey: null }],
    },
    data: { readAt: new Date() },
  })
}

/**
 * Persist one recipient-private assignment alert and its queue outbox row.
 * This is deliberately called from the task mutation transaction: no task can
 * commit with an attention record but without a recoverable delivery job.
 */
export const createTaskAssignmentAttention = async (
  tx: AttentionTransaction,
  input: {
    actorUserId: string
    assigneeUserId: string | null
    eventKey: string
    organizationId: string
    projectId: string | null
    taskId: string
  },
): Promise<void> => {
  await retireSupersededAttention(tx, {
    eventKey: input.eventKey,
    kind: 'task_assigned',
    organizationId: input.organizationId,
    taskId: input.taskId,
  })

  // There is no reachable Board doorway for a projectless task, nor a useful
  // notification when the actor just assigned the work to themself.
  if (!input.assigneeUserId || !input.projectId || input.assigneeUserId === input.actorUserId) {
    return
  }

  // The Board page is membership-gated. Existing tasks may still be assigned to
  // any org member, but we must not create a deep link they cannot open.
  const [organizationMember, projectMember] = await Promise.all([
    tx.organizationMember.findFirst({
      where: {
        organizationId: input.organizationId,
        userId: input.assigneeUserId,
        deactivatedAt: null,
      },
      select: { id: true },
    }),
    tx.projectMember.findFirst({
      where: { projectId: input.projectId, userId: input.assigneeUserId },
      select: { id: true },
    }),
  ])
  if (!organizationMember || !projectMember) return

  const alert = await tx.userAlert.upsert({
    where: {
      userId_eventKey: { eventKey: input.eventKey, userId: input.assigneeUserId },
    },
    create: {
      actorUserId: input.actorUserId,
      eventKey: input.eventKey,
      kind: 'task_assigned',
      organizationId: input.organizationId,
      projectId: input.projectId,
      taskId: input.taskId,
      userId: input.assigneeUserId,
    },
    update: {},
    select: { id: true },
  })
  await enqueueAttentionDispatch(tx, { alertId: alert.id })
}

/**
 * Writes one publication alert for every active human who can presently read
 * the space. The same `canReadSpace` rule the reader uses decides recipients;
 * therefore no separate, gradually-diverging access heuristic exists here.
 */
export const createKnowledgePublicationAttention = async (
  tx: AttentionTransaction,
  input: {
    actorUserId: string | null
    organizationId: string
    pageId: string
    projectId: string
    spaceId: string
    versionId: string
  },
): Promise<void> => {
  const eventKey = `knowledge-published:${input.pageId}:${input.versionId}`
  const space = await tx.knowledgeSpace.findFirst({
    where: { id: input.spaceId, organizationId: input.organizationId, deletedAt: null },
    select: {
      channelId: true,
      createdBy: true,
      id: true,
      members: { where: { userId: { not: null } }, select: { userId: true } },
      ownerAgentId: true,
      privateToAgentId: true,
      projectId: true,
      sensitivityTier: true,
      teamId: true,
      visibility: true,
      writeRestricted: true,
    },
  })
  if (!space) return

  await retireSupersededAttention(tx, {
    eventKey,
    kind: 'knowledge_published',
    knowledgePageId: input.pageId,
    organizationId: input.organizationId,
  })

  const [members, projectMembers] = await Promise.all([
    tx.organizationMember.findMany({
      where: { organizationId: input.organizationId, deactivatedAt: null },
      select: { userId: true },
    }),
    tx.projectMember.findMany({
      where: { projectId: input.projectId },
      select: { userId: true },
    }),
  ])

  const projectUserIds = new Set(projectMembers.map((member) => member.userId))
  const memberUserIds = space.members.flatMap((member) => member.userId ? [member.userId] : [])
  // Resolve each member's live agent audience before deciding publication
  // attention, keeping the loop below pure and avoiding serial audience reads.
  // See docs/plans/2026-08-31-agent-documents.md §4.1.
  const visibleAgentIdsByUser = new Map(await Promise.all(members.map(async (member) => [
    member.userId,
    new Set(await listVisibleAgentIdsForUser(tx, {
      organizationId: input.organizationId,
      userId: member.userId,
    })),
  ] as const)))
  for (const member of members) {
    if (member.userId === input.actorUserId) continue
    const readable = canReadSpace({
      ...space,
      memberAgentIds: [],
      memberUserIds,
    }, {
      bypass: false,
      projectIds: projectUserIds.has(member.userId) ? new Set([input.projectId]) : new Set(),
      userId: member.userId,
      visibleAgentIds: visibleAgentIdsByUser.get(member.userId) ?? new Set(),
    })
    if (!readable) continue
    const alert = await tx.userAlert.upsert({
      where: { userId_eventKey: { eventKey, userId: member.userId } },
      create: {
        actorUserId: input.actorUserId,
        eventKey,
        kind: 'knowledge_published',
        knowledgePageId: input.pageId,
        organizationId: input.organizationId,
        projectId: input.projectId,
        userId: member.userId,
      },
      update: {},
      select: { id: true },
    })
    await enqueueAttentionDispatch(tx, { alertId: alert.id })
  }
}
