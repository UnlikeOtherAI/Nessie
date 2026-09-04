import type { Prisma, PrismaClient } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { buildPage, decodeKeysetCursor, resolvePageLimit, type PaginationDirection } from '@nessie/schemas'
import type { AuthorizedActionContext } from '@nessie/schemas'
import { runApprovalEffect } from './approval-effects.js'
import { terminalizeExpiredToolApproval, terminalizeRejectedToolApproval } from './approval-resume.js'
import { emitAuditEvent } from './audit.js'
import { mapApproval } from './approval-presenter.js'

const DEFAULT_EXPIRY_MS = 30 * 60 * 1000 // 30 minutes

export type CreateApprovalInput = {
  actorContext: AuthorizedActionContext
  agentId: string
  action: string
  reason: string
  context?: Record<string, unknown>
  taskId?: string
  runId?: string
  requiredApproverRole?: string
}

export const createApprovalRequest = async (
  prisma: PrismaClient,
  input: CreateApprovalInput,
) => {
  const continuationToken = randomUUID()
  const expiresAt = new Date(Date.now() + DEFAULT_EXPIRY_MS)

  const approval = await prisma.approvalRequest.create({
    data: {
      organizationId: input.actorContext.tenant.organizationId,
      projectId: input.actorContext.tenant.projectId ?? null,
      teamId: input.actorContext.tenant.teamId ?? null,
      channelId: input.actorContext.actionContext.channelId ?? null,
      taskId: input.taskId ?? null,
      runId: input.runId ?? null,
      agentId: input.agentId,
      requesterId: input.actorContext.actor.actorId,
      action: input.action,
      reason: input.reason,
      context: (input.context as Prisma.InputJsonValue) ?? undefined,
      requiredApproverRole: input.requiredApproverRole ?? null,
      continuationToken,
      expiresAt,
    },
  })

  await emitAuditEvent(prisma, {
    actorContext: input.actorContext,
    action: 'approval.created',
    resourceType: 'approval',
    resourceId: approval.id,
    outcome: 'success',
    metadata: { action: input.action, agentId: input.agentId },
  })

  return mapApproval(approval)
}

/**
 * Which approvals an actor may see. An approval carries a free-text `reason`,
 * a `context` blob and the originating channel/task ids, so org scope alone
 * leaks private-channel activity — and the task ids it exposes are usable
 * against other endpoints. A pinned approval is visible only to its exact
 * approver; otherwise owners see their organization and members see what they
 * requested plus what happened in a channel they can reach.
 */
export const approvalVisibilityWhere = (
  actorContext: AuthorizedActionContext,
): Prisma.ApprovalRequestWhereInput => {
  const userId = actorContext.actor.actorId
  // A pin is an audience boundary, not just a resolution rule. It takes
  // precedence over owner and channel visibility because approval reason and
  // context can describe a private recipient/body. The explicit approver still
  // reaches their existing /approvals home even when they are not in the source
  // channel.
  if (actorContext.actor.roles?.includes('owner')) {
    return {
      OR: [
        { requiredApproverUserId: userId },
        { requiredApproverUserId: null },
      ],
    }
  }
  return {
    OR: [
      { requiredApproverUserId: userId },
      {
        AND: [
          { requiredApproverUserId: null },
          {
            OR: [
              { requesterId: userId },
              {
                channel: {
                  OR: [
                    { visibility: 'public' },
                    { members: { some: { userId } } },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  }
}

export const listApprovalRequests = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  filters?: {
    status?: string
    agentId?: string
    channelId?: string
    cursor?: string
    direction?: PaginationDirection
    limit?: number
  },
) => {
  const limit = resolvePageLimit(filters?.limit)
  const where: Record<string, unknown> = {
    organizationId: actorContext.tenant.organizationId,
    AND: [approvalVisibilityWhere(actorContext)],
  }
  if (filters?.status) where['status'] = filters.status
  if (filters?.agentId) where['agentId'] = filters.agentId
  if (filters?.channelId) where['channelId'] = filters.channelId

  // The total is counted against the same filters but before the cursor is
  // applied: "26–50 of 134" has to mean 134 matching records, not 134 records
  // after the one this page starts at.
  const total = await prisma.approvalRequest.count({ where: where as Prisma.ApprovalRequestWhereInput })

  const parsed = decodeKeysetCursor(filters?.cursor)
  const backwards = filters?.direction === 'backward'
  if (parsed) {
    where['OR'] = [
      { createdAt: { [backwards ? 'gt' : 'lt']: parsed.createdAt } },
      { createdAt: parsed.createdAt, id: { [backwards ? 'gt' : 'lt']: parsed.id } },
    ]
  }

  const approvals = await prisma.approvalRequest.findMany({
    where: where as Prisma.ApprovalRequestWhereInput,
    orderBy: backwards
      ? [{ createdAt: 'asc' }, { id: 'asc' }]
      : [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  })

  const page = buildPage({
    direction: filters?.direction,
    hasCursor: Boolean(parsed),
    limit,
    rows: approvals,
    total,
  })

  return {
    data: page.data.map(mapApproval),
    meta: page.meta,
  }
}

export const getApprovalRequest = async (
  prisma: PrismaClient,
  approvalId: string,
  actorContext: AuthorizedActionContext,
) => {
  const approval = await prisma.approvalRequest.findFirst({
    where: {
      id: approvalId,
      organizationId: actorContext.tenant.organizationId,
      AND: [approvalVisibilityWhere(actorContext)],
    },
  })
  return approval ? mapApproval(approval) : null
}

export const resolveApprovalRequest = async (
  prisma: PrismaClient,
  approvalId: string,
  actorContext: AuthorizedActionContext,
  resolution: 'approved' | 'rejected',
  note?: string,
) => {
  // Resolution returns a distinct refusal for a known pin. The GET/list paths
  // remain indistinguishable for other viewers, but collapsing this into a
  // generic 400 makes an approver-facing client unable to tell a stale action
  // from a decision reserved for somebody else.
  const identity = await prisma.approvalRequest.findFirst({
    where: {
      id: approvalId,
      organizationId: actorContext.tenant.organizationId,
    },
    select: { requiredApproverUserId: true },
  })
  if (!identity) return null
  if (
    identity.requiredApproverUserId
    && identity.requiredApproverUserId !== actorContext.actor.actorId
  ) {
    return { error: 'APPROVER_REQUIRED' as const }
  }

  const approval = await prisma.approvalRequest.findFirst({
    where: {
      id: approvalId,
      organizationId: actorContext.tenant.organizationId,
      // Resolving is a stronger act than reading, so it takes the same gate:
      // an org member with no line of sight to the channel must not be able to
      // approve an agent action inside it.
      AND: [approvalVisibilityWhere(actorContext)],
    },
  })

  if (!approval) return null
  if (approval.status !== 'pending') {
    return { error: 'ALREADY_RESOLVED' as const, approval: mapApproval(approval) }
  }

  // Requester cannot approve their own request
  if (approval.requesterId === actorContext.actor.actorId) {
    return { error: 'SELF_APPROVAL' as const, approval: mapApproval(approval) }
  }

  // When the approval is routed to a role, only an actor holding that role may
  // resolve it. Check the LIVE organization membership rather than the JWT `roles`
  // claim — tokens are long-lived (default 24h), so a user demoted after their
  // token was issued must not retain approval power on a stale claim.
  if (approval.requiredApproverRole) {
    const membership = await prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId: actorContext.tenant.organizationId,
          userId: actorContext.actor.actorId,
        },
      },
      select: { role: true },
    })
    if (membership?.role !== approval.requiredApproverRole) {
      return { error: 'ROLE_REQUIRED' as const, approval: mapApproval(approval) }
    }
  }

  // Check expiry. Guard the transition on `status === 'pending'` so a
  // concurrent resolve can't be clobbered, and skip writing if it already
  // moved off pending.
  if (approval.expiresAt < new Date()) {
    const expired = await prisma.approvalRequest.updateMany({
      where: { id: approvalId, status: 'pending' },
      data: { status: 'expired' },
    })
    if (expired.count === 1 && approval.action === 'tool.invoke') {
      await terminalizeExpiredToolApproval(prisma, approval.id)
    }
    return {
      error: 'EXPIRED' as const,
      approval: mapApproval({ ...approval, status: 'expired' }),
    }
  }

  // Atomic claim: only the first resolver of a still-`pending` request wins.
  // A tool gate cannot be resolved until its worker has committed the durable
  // checkpoint and entered `waiting_approval`; otherwise a fast approver could
  // mark it approved between request creation and suspension, with no future
  // effect invocation to resume it.
  const resolutionWhere: Prisma.ApprovalRequestWhereInput = {
    id: approvalId,
    status: 'pending',
  }
  if (approval.action === 'tool.invoke') {
    resolutionWhere.run = { is: { status: 'waiting_approval' } }
  }
  // A second approver racing the same request sees `count === 0` and is told
  // the request is already resolved (re-reading the now-resolved row).
  const { count } = await prisma.approvalRequest.updateMany({
    where: resolutionWhere,
    data: {
      status: resolution,
      resolution,
      resolverId: actorContext.actor.actorId,
      resolvedAt: new Date(),
      resolutionNote: note ?? null,
    },
  })

  if (count === 0) {
    const current = await prisma.approvalRequest.findFirst({
      where: { id: approvalId, organizationId: actorContext.tenant.organizationId },
    })
    if (current?.status === 'pending' && approval.action === 'tool.invoke') {
      return { error: 'RUN_NOT_WAITING' as const, approval: mapApproval(current) }
    }
    return {
      error: 'ALREADY_RESOLVED' as const,
      approval: current ? mapApproval(current) : mapApproval(approval),
    }
  }

  let updated = await prisma.approvalRequest.findFirstOrThrow({
    where: { id: approvalId },
  })

  // The effect (e.g. resuming a tool-gated run or publishing a knowledge page) runs after the
  // atomic claim above, so a crash mid-effect never leaves the approval
  // un-resolved or double-claimable. A failed effect does not un-approve the
  // request — it stays approved and the failure is appended to the note, so
  // a human can see what happened and re-trigger the follow-up manually.
  if (resolution === 'approved') {
    try {
      const effect = await runApprovalEffect(
        prisma,
        { id: updated.id, action: updated.action, context: updated.context as Record<string, unknown> | null },
        actorContext,
      )
      if (effect.note) {
        const resolutionNote = updated.resolutionNote
          ? `${updated.resolutionNote} · effect: ${effect.note}`
          : `effect: ${effect.note}`
        updated = await prisma.approvalRequest.update({
          where: { id: approvalId },
          data: { resolutionNote },
        })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const resolutionNote = updated.resolutionNote
        ? `${updated.resolutionNote} · effect failed: ${message}`
        : `effect failed: ${message}`
      updated = await prisma.approvalRequest.update({
        where: { id: approvalId },
        data: { resolutionNote },
      })
    }
  } else if (updated.action === 'tool.invoke') {
    try {
      const terminalized = await terminalizeRejectedToolApproval(prisma, updated.id)
      const effectNote = terminalized ? 'run rejected' : 'run no longer waiting'
      const resolutionNote = updated.resolutionNote
        ? `${updated.resolutionNote} · effect: ${effectNote}`
        : `effect: ${effectNote}`
      updated = await prisma.approvalRequest.update({
        where: { id: approvalId },
        data: { resolutionNote },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const resolutionNote = updated.resolutionNote
        ? `${updated.resolutionNote} · effect failed: ${message}`
        : `effect failed: ${message}`
      updated = await prisma.approvalRequest.update({
        where: { id: approvalId },
        data: { resolutionNote },
      })
    }
  }

  const auditAction = resolution === 'approved' ? 'approval.approved' : 'approval.rejected'
  await emitAuditEvent(prisma, {
    actorContext,
    action: auditAction as 'approval.approved' | 'approval.rejected',
    resourceType: 'approval',
    resourceId: approvalId,
    outcome: 'success',
    metadata: { resolution, agentId: approval.agentId, action: approval.action },
  })

  // Keep the pin available to the route that chooses the realtime audience,
  // but deliberately do not add it to the client presenter. A pin is an
  // internal delivery decision, not an approval-list field.
  return {
    approval: mapApproval(updated),
    requiredApproverUserId: updated.requiredApproverUserId,
  }
}

export const getPendingApprovalCount = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
) => {
  return prisma.approvalRequest.count({
    where: {
      organizationId: actorContext.tenant.organizationId,
      status: 'pending',
      AND: [approvalVisibilityWhere(actorContext)],
    },
  })
}

export const sweepExpiredApprovals = async (prisma: PrismaClient) => {
  const expired = await prisma.approvalRequest.findMany({
    where: {
      status: 'pending',
      expiresAt: { lt: new Date() },
    },
    take: 100,
  })

  for (const approval of expired) {
    const expiredClaim = await prisma.approvalRequest.updateMany({
      where: { id: approval.id, status: 'pending', expiresAt: { lt: new Date() } },
      data: { status: 'expired' },
    })
    if (expiredClaim.count !== 1) continue

    if (approval.action === 'tool.invoke') {
      await terminalizeExpiredToolApproval(prisma, approval.id)
      continue
    }
    // Existing deferred-effect approvals have no suspended run to close.
    await prisma.agent.updateMany({
      where: { id: approval.agentId, status: 'waiting_approval' },
      data: { status: 'idle' },
    })
  }

  return expired.length
}
