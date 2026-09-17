import type { Prisma, PrismaClient } from '@prisma/client'
import {
  APPROVAL_ACTIONS,
  buildPage,
  decodeKeysetCursor,
  resolvePageLimit,
  type PaginationDirection,
} from '@nessie/schemas'
import type { AuthorizedActionContext } from '@nessie/schemas'
import { mapApprovalRequest } from '@nessie/team-admin'
import { runApprovalEffect } from './approval-effects.js'
import {
  drainTerminalizedRun,
  terminalizeExpiredToolApproval,
  terminalizeRejectedToolApproval,
  terminalizeWaitingApprovalRunInTransaction,
  type TerminalizedApprovalRun,
} from './approval-resume.js'

import { emitAuditEvent } from './audit.js'

// The approval creator — the advisory-locked, deduplicating, ceiling-checked
// open — lives in `@nessie/team-admin` so the worker's own doors (the PA
// tools, the run's tool gate, demonstration generalisation) open requests
// through the same implementation instead of four drifted copies; it is
// re-exported here so routes, MCP tools and tests keep one import site, the
// same pattern `policy.ts` uses for `checkPolicy`.
export {
  APPROVAL_EXPIRY_EXTERNAL_ACCOUNT_MS,
  APPROVAL_EXPIRY_SUSPENDED_RUN_MS,
  APPROVAL_EXPIRY_UNATTENDED_MS,
  createApprovalRequestOnce,
  PENDING_APPROVALS_PER_REQUESTER,
  TooManyPendingApprovalsError,
} from '@nessie/team-admin'
export type { ApprovalRequester, CreateApprovalInput } from '@nessie/team-admin'

/**
 * Which approvals an actor may see. An approval carries a free-text `reason`,
 * a `context` blob and the originating channel/task ids, so org scope alone
 * leaks private-channel activity — and the task ids it exposes are usable
 * against other endpoints. A named approver is a stricter disclosure boundary:
 * only that person may read the request, including its reason and context.
 * Unpinned approvals remain visible to owners and to their ordinary audience.
 */
export const approvalVisibilityWhere = (
  actorContext: AuthorizedActionContext,
): Prisma.ApprovalRequestWhereInput => {
  const userId = actorContext.actor.actorId
  const ordinaryVisibility: Prisma.ApprovalRequestWhereInput =
    actorContext.actor.roles?.includes('owner')
      ? {}
      : {
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
  return {
    OR: [
      { requiredApproverUserId: userId },
      { AND: [{ requiredApproverUserId: null }, ordinaryVisibility] },
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
    data: page.data.map(mapApprovalRequest),
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
  return approval ? mapApprovalRequest(approval) : null
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
    return { error: 'ALREADY_RESOLVED' as const, approval: mapApprovalRequest(approval) }
  }

  // Requester cannot approve their own request
  if (approval.requesterId === actorContext.actor.actorId) {
    return { error: 'SELF_APPROVAL' as const, approval: mapApprovalRequest(approval) }
  }

  // An exact required approver outranks every other visibility rule. Approval
  // visibility otherwise reaches any member who can read a public channel, so
  // without this a colleague could authorise an email sent in your name.
  if (
    approval.requiredApproverUserId
    && approval.requiredApproverUserId !== actorContext.actor.actorId
  ) {
    return { error: 'APPROVER_REQUIRED' as const, approval: mapApprovalRequest(approval) }
  }

  // When the approval is routed to a role, only an actor holding that role may
  // resolve it — and the role that decides is the actor context's, not a second
  // read of `OrganizationMember`.
  //
  // This used to read the row and compare that instead, on the stated grounds
  // that `actor.roles` was a long-lived JWT claim a demotion would not reach.
  // That is not what `actor.roles` is: `request-admission.ts` replaces it on
  // every request from the live membership row, and for a UOA-bound
  // organisation replaces it again from a per-request `/org/me` call that
  // caches nothing and fails closed. So the row this used to read was the
  // *staler* of the two. UOA owns the organisation role and the local row is a
  // projection re-applied at login and at token rotation, so a demotion at UOA
  // is authoritative on the next request while this check could still have seen
  // the old role for the rest of that rotation.
  //
  // The membership lookup stays, and it is not redundant. It is what keeps this
  // closed in the one case where `actor.roles` really can be a stale claim:
  // `request-admission.ts` only overwrites the claim `if (membership)`, and its
  // `ORGANIZATION_MEMBERSHIP_REQUIRED` refusal fires only for a UOA-bound
  // organisation — so a local-mode organisation with no membership row would
  // arrive here still carrying whatever the token said. Nothing in production
  // deletes a membership row, which is the only reason that is theoretical.
  if (approval.requiredApproverRole) {
    const membership = await prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId: actorContext.tenant.organizationId,
          userId: actorContext.actor.actorId,
        },
      },
      select: { id: true },
    })
    if (
      !membership
      || !actorContext.actor.roles?.includes(approval.requiredApproverRole)
    ) {
      return { error: 'ROLE_REQUIRED' as const, approval: mapApprovalRequest(approval) }
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
    if (expired.count === 1 && approval.action === APPROVAL_ACTIONS.toolInvoke) {
      await terminalizeExpiredToolApproval(prisma, approval.id)
    }
    return {
      error: 'EXPIRED' as const,
      approval: mapApprovalRequest({ ...approval, status: 'expired' }),
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
  if (approval.action === APPROVAL_ACTIONS.toolInvoke) {
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
    if (current?.status === 'pending' && approval.action === APPROVAL_ACTIONS.toolInvoke) {
      return { error: 'RUN_NOT_WAITING' as const, approval: mapApprovalRequest(current) }
    }
    return {
      error: 'ALREADY_RESOLVED' as const,
      approval: current ? mapApprovalRequest(current) : mapApprovalRequest(approval),
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
  } else if (updated.action === APPROVAL_ACTIONS.toolInvoke) {
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

  return { approval: mapApprovalRequest(updated) }
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

/**
 * Expire timed-out approvals and close the runs parked behind them.
 *
 * Two properties this sweep must hold on N replicas (audit 1.5):
 *
 * - **Claim and terminalisation share one transaction.** They used to be two
 *   statements, so a kill between them left the run in `waiting_approval` with
 *   the approval already `expired` — and the sweep, selecting `pending` only,
 *   never revisited it.
 * - **Self-healing.** The select also picks up `expired` approvals whose run is
 *   still `waiting_approval`, so rows stranded by the old two-step code (or by
 *   the same shape still used in `resolveApprovalRequest`) are finished on the
 *   next tick. Those rows carry no `pending` claim, so the conditional
 *   `waiting_approval → failed` update inside the terminalisation is what
 *   admits exactly one replica.
 */
export const sweepExpiredApprovals = async (prisma: PrismaClient) => {
  const expired = await prisma.approvalRequest.findMany({
    where: {
      OR: [
        { status: 'pending', expiresAt: { lt: new Date() } },
        { status: 'expired', run: { status: 'waiting_approval' } },
      ],
    },
    take: 100,
  })

  const drains: TerminalizedApprovalRun[] = []
  for (const approval of expired) {
    const terminalized = await prisma.$transaction(async (tx) => {
      if (approval.status === 'pending') {
        const expiredClaim = await tx.approvalRequest.updateMany({
          where: { id: approval.id, status: 'pending', expiresAt: { lt: new Date() } },
          data: { status: 'expired' },
        })
        if (expiredClaim.count !== 1) return null
      }

      if (approval.action === APPROVAL_ACTIONS.toolInvoke) {
        return terminalizeWaitingApprovalRunInTransaction(tx, approval.id, 'expired')
      }
      // Existing deferred-effect approvals have no suspended run to close.
      // A request from a paired credential has no agent parked on it either —
      // the caller is a program over HTTP, not a run waiting in a channel.
      if (approval.agentId) {
        await tx.agent.updateMany({
          where: { id: approval.agentId, status: 'waiting_approval' },
          data: { status: 'idle' },
        })
      }
      return null
    })
    if (terminalized) drains.push(terminalized)
  }

  // Enqueueing belongs after the commit — a rolled-back claim must not leave a
  // drain job pointing at a run it never closed.
  for (const drain of drains) {
    await drainTerminalizedRun(prisma, drain)
  }

  return expired.length
}

