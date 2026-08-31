import type { Prisma, PrismaClient } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import type { AuthorizedActionContext } from '@nessie/schemas'
import { runApprovalEffect } from './approval-effects.js'
import { terminalizeExpiredToolApproval, terminalizeRejectedToolApproval } from './approval-resume.js'
import { emitAuditEvent } from './audit.js'

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

const parseCursor = (raw: string): { cursorDate: Date; cursorId: string } | null => {
  const [isoPart, idPart] = raw.split('|')
  if (!isoPart || !idPart) return null
  const d = new Date(isoPart)
  if (Number.isNaN(d.getTime())) return null
  return { cursorDate: d, cursorId: idPart }
}

/**
 * Which approvals an actor may see. An approval carries a free-text `reason`,
 * a `context` blob and the originating channel/task ids, so org scope alone
 * leaks private-channel activity — and the task ids it exposes are usable
 * against other endpoints. Owners see everything in their org; everyone else
 * sees what they requested plus what happened in a channel they can reach.
 */
export const approvalVisibilityWhere = (
  actorContext: AuthorizedActionContext,
): Prisma.ApprovalRequestWhereInput => {
  if (actorContext.actor.roles?.includes('owner')) return {}
  const userId = actorContext.actor.actorId
  return {
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
    limit?: number
  },
) => {
  const limit = Math.min(filters?.limit ?? 50, 200)
  const where: Record<string, unknown> = {
    organizationId: actorContext.tenant.organizationId,
    AND: [approvalVisibilityWhere(actorContext)],
  }
  if (filters?.status) where['status'] = filters.status
  if (filters?.agentId) where['agentId'] = filters.agentId
  if (filters?.channelId) where['channelId'] = filters.channelId
  if (filters?.cursor) {
    const parsed = parseCursor(filters.cursor)
    if (parsed) {
      where['OR'] = [
        { createdAt: { lt: parsed.cursorDate } },
        { createdAt: parsed.cursorDate, id: { lt: parsed.cursorId } },
      ]
    }
  }

  const approvals = await prisma.approvalRequest.findMany({
    where: where as Prisma.ApprovalRequestWhereInput,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  })

  const hasMore = approvals.length > limit
  const data = hasMore ? approvals.slice(0, limit) : approvals
  const last = data.at(-1)

  return {
    data: data.map(mapApproval),
    meta: {
      cursor: hasMore && last ? `${last.createdAt.toISOString()}|${last.id}` : null,
      hasMore,
    },
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

  return { approval: mapApproval(updated) }
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

// ─── Helpers ────────────────────────────────────────────────────────────────

const mapApproval = (approval: {
  id: string
  organizationId: string
  projectId: string | null
  teamId: string | null
  channelId: string | null
  taskId: string | null
  runId: string | null
  agentId: string
  requesterId: string
  action: string
  reason: string
  context: unknown
  status: string
  resolverId: string | null
  resolvedAt: Date | null
  resolution: string | null
  resolutionNote: string | null
  requiredApproverRole: string | null
  continuationToken: string
  expiresAt: Date
  createdAt: Date
  updatedAt: Date
}) => ({
  id: approval.id,
  organizationId: approval.organizationId,
  projectId: approval.projectId,
  teamId: approval.teamId,
  channelId: approval.channelId,
  taskId: approval.taskId,
  runId: approval.runId,
  agentId: approval.agentId,
  requesterId: approval.requesterId,
  action: approval.action,
  reason: approval.reason,
  context: approval.context as Record<string, unknown> | null,
  status: approval.status,
  resolverId: approval.resolverId,
  resolvedAt: approval.resolvedAt?.toISOString() ?? null,
  resolution: approval.resolution,
  resolutionNote: approval.resolutionNote,
  requiredApproverRole: approval.requiredApproverRole,
  expiresAt: approval.expiresAt.toISOString(),
  createdAt: approval.createdAt.toISOString(),
  updatedAt: approval.updatedAt.toISOString(),
})
