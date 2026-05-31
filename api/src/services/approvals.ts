import type { Prisma, PrismaClient } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import type { AuthorizedActionContext } from '@nessie/schemas'
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

export const listApprovalRequests = async (
  prisma: PrismaClient,
  organizationId: string,
  filters?: {
    status?: string
    agentId?: string
    channelId?: string
    cursor?: string
    limit?: number
  },
) => {
  const limit = Math.min(filters?.limit ?? 50, 200)
  const where: Record<string, unknown> = { organizationId }
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
  organizationId: string,
) => {
  const approval = await prisma.approvalRequest.findFirst({
    where: { id: approvalId, organizationId },
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
    await prisma.approvalRequest.updateMany({
      where: { id: approvalId, status: 'pending' },
      data: { status: 'expired' },
    })
    return { error: 'EXPIRED' as const, approval: mapApproval(approval) }
  }

  // Atomic claim: only the first resolver of a still-`pending` request wins.
  // A second approver racing the same request sees `count === 0` and is told
  // the request is already resolved (re-reading the now-resolved row).
  const { count } = await prisma.approvalRequest.updateMany({
    where: { id: approvalId, status: 'pending' },
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
    return {
      error: 'ALREADY_RESOLVED' as const,
      approval: current ? mapApproval(current) : mapApproval(approval),
    }
  }

  const updated = await prisma.approvalRequest.findFirstOrThrow({
    where: { id: approvalId },
  })

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
  organizationId: string,
) => {
  return prisma.approvalRequest.count({
    where: { organizationId, status: 'pending' },
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
    await prisma.approvalRequest.update({
      where: { id: approval.id },
      data: { status: 'expired' },
    })

    // Fail associated runs
    if (approval.runId) {
      await prisma.run.updateMany({
        where: { id: approval.runId, status: 'waiting_approval' },
        data: { status: 'failed', finishedAt: new Date() },
      })
    }

    // Reset agent to idle
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
  continuationToken: approval.continuationToken,
  expiresAt: approval.expiresAt.toISOString(),
  createdAt: approval.createdAt.toISOString(),
  updatedAt: approval.updatedAt.toISOString(),
})
