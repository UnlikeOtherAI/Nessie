import { type Prisma, type PrismaClient } from '@prisma/client'
import { ExecutorCapabilityDescriptorSchema, type AuthorizedActionContext } from '@nessie/schemas'

import {
  canManageExecutor,
  requireHumanActor,
  resolveExecutorHumanAccess,
} from './executor-access.js'
import {
  lockExecutorMutation,
  requireManagedExecutor,
} from './executor-access-mutations.js'
import { closeExecutorCodingSessionsInTransaction } from './executor-coding-session-closes.js'
import {
  EXECUTOR_LOCAL_APPS_OPERATION_KEYS,
  endExecutorConversationLeasesInTransaction,
  executorLeaseAuditActor,
  type ExecutorLeaseEndReason,
} from './executor-conversation-lease.js'
import { EXECUTOR_ERROR_CODES, ExecutorError } from './executor-errors.js'

export type ExecutorLifecycleAction = 'pause' | 'resume' | 'drain' | 'revoke'

/** What each fencing transition records on the leases it ends. */
const LIFECYCLE_END_REASON = {
  drain: 'executor_drained',
  pause: 'executor_paused',
  revoke: 'executor_revoked',
} as const satisfies Record<Exclude<ExecutorLifecycleAction, 'resume'>, ExecutorLeaseEndReason>

const canBreakGlassRevoke = async (
  prisma: PrismaClient | Prisma.TransactionClient,
  actorContext: AuthorizedActionContext,
  executorId: string,
): Promise<boolean> => {
  const actorUserId = requireHumanActor(actorContext)
  if (!actorUserId) return false
  const [executor, membership] = await Promise.all([
    prisma.executor.findFirst({
      where: { id: executorId, organizationId: actorContext.tenant.organizationId },
      select: { id: true },
    }),
    prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId: actorContext.tenant.organizationId,
          userId: actorUserId,
        },
      },
      select: { deactivatedAt: true, role: true },
    }),
  ])
  return Boolean(executor && membership && !membership.deactivatedAt && membership.role === 'owner')
}

export const nextExecutorLifecycleStatus = (
  current: 'pending_pairing' | 'online' | 'offline' | 'paused' | 'draining' | 'revoked' | 'error',
  action: ExecutorLifecycleAction,
): 'offline' | 'paused' | 'draining' | 'revoked' => {
  if (action === 'revoke') return 'revoked'
  if (current === 'pending_pairing' || current === 'revoked' || current === 'draining') {
    throw new ExecutorError(
      EXECUTOR_ERROR_CODES.STATE_TRANSITION_INVALID,
      'This executor cannot accept that lifecycle transition.',
    )
  }
  if (action === 'pause') return 'paused'
  if (action === 'resume') {
    if (current !== 'paused') {
      throw new ExecutorError(
        EXECUTOR_ERROR_CODES.STATE_TRANSITION_INVALID,
        'Only a paused executor can resume.',
      )
    }
    // A resumed executor remains unavailable until its authenticated daemon
    // connection returns; the server never assumes a machine is online.
    return 'offline'
  }
  return 'draining'
}

export const transitionExecutorLifecycle = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  input: { executorId: string; action: ExecutorLifecycleAction },
): Promise<{ status: string; authorizationRevision: number }> => {
  return prisma.$transaction(async (tx) => {
    await lockExecutorMutation(tx, input.executorId)
    return transitionExecutorLifecycleInTransaction(tx, actorContext, input)
  })
}

export const transitionExecutorLifecycleInTransaction = async (
  tx: Prisma.TransactionClient,
  actorContext: AuthorizedActionContext,
  input: { executorId: string; action: ExecutorLifecycleAction },
): Promise<{ status: string; authorizationRevision: number }> => {
  const breakGlassRevoke = input.action === 'revoke'
    && await canBreakGlassRevoke(tx, actorContext, input.executorId)
  if (!breakGlassRevoke) {
    const managed = await requireManagedExecutor(tx, actorContext, input.executorId)
    if (!managed) {
      throw new ExecutorError(EXECUTOR_ERROR_CODES.NOT_FOUND, 'Executor not found.')
    }
  }
  const actorUserId = requireHumanActor(actorContext)
  const executor = actorUserId
    ? await tx.executor.findFirst({
        where: { id: input.executorId, organizationId: actorContext.tenant.organizationId },
      })
    : null
  if (!executor || !actorUserId) {
    throw new ExecutorError(EXECUTOR_ERROR_CODES.NOT_FOUND, 'Executor not found.')
  }
  if (breakGlassRevoke) {
    const membership = await tx.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId: executor.organizationId,
          userId: actorUserId,
        },
      },
      select: { deactivatedAt: true, role: true },
    })
    if (!membership || membership.deactivatedAt || membership.role !== 'owner') {
      throw new ExecutorError(
        EXECUTOR_ERROR_CODES.SCOPE_ENTITLEMENT_DENIED,
        'Only an active organization owner may break-glass revoke an executor.',
      )
    }
  } else {
    const access = await resolveExecutorHumanAccess(
      tx,
      executor.organizationId,
      actorUserId,
      executor,
    )
    if (!canManageExecutor(executor, access)) {
      throw new ExecutorError(
        EXECUTOR_ERROR_CODES.SCOPE_ENTITLEMENT_DENIED,
        'You cannot manage this executor.',
      )
    }
  }
  const status = nextExecutorLifecycleStatus(executor.status, input.action)
  const updated = await tx.executor.update({
    where: { id: executor.id },
    data: {
      status,
      statusDetail: input.action === 'revoke'
        ? 'Executor access was revoked.'
        : input.action === 'drain'
          ? 'Executor is draining active work.'
          : input.action === 'pause'
            ? 'Executor is paused.'
            : 'Awaiting authenticated executor connection.',
      authorizationRevision: { increment: 1 },
      // Pause, drain, revoke, and resume are all session-fencing transitions.
      // A daemon with an existing VM must stop it before it can reconnect.
      activeConnectionEpoch: { increment: 1 },
    },
    select: { authorizationRevision: true, status: true },
  })
  await tx.executorSession.updateMany({
    where: { executorId: executor.id, status: { in: ['pending', 'active'] } },
    data: { status: 'stopped' },
  })
  // The same fence ends every conversation lease on the machine: a paused,
  // draining or revoked executor carries nobody's follow-ups. Resuming ends
  // nothing — pausing already ended them all, and it does not bring one back:
  // the person launches again.
  if (input.action !== 'resume') {
    await endExecutorConversationLeasesInTransaction(tx, {
      actor: executorLeaseAuditActor(actorContext),
      endedByUserId: actorUserId,
      reason: LIFECYCLE_END_REASON[input.action],
      where: { executorId: executor.id },
    })
  }
  // Pausing or revoking the machine closes every coding session on it, not
  // only those a lease still covered. A drain closes fewer, but not none:
  // the leases it ends above each close their holder's sessions, in-flight
  // turns included (`lease_ended`), and only sessions no live lease covered
  // are left running.
  if (input.action === 'pause' || input.action === 'revoke') {
    await closeExecutorCodingSessionsInTransaction(tx, {
      executorId: executor.id, reason: LIFECYCLE_END_REASON[input.action], requestedByUserId: actorUserId,
    })
  }
  return updated
}

/** Internal to the prepare/confirm access-change transaction. */
export const reviewExecutorDescriptorInTransaction = async (
  tx: Prisma.TransactionClient,
  actorContext: AuthorizedActionContext,
  input: { executorId: string; revision: number; status: 'active' | 'disabled' },
): Promise<void> => {
  await requireManagedExecutor(tx, actorContext, input.executorId)
  const actorUserId = requireHumanActor(actorContext)
  const [revision, latest] = await Promise.all([
    tx.executorCapabilityRevision.findFirst({
      where: { executorId: input.executorId, revision: input.revision },
      select: { descriptor: true, id: true, reviewStatus: true },
    }),
    tx.executorCapabilityRevision.findFirst({
      where: { executorId: input.executorId },
      orderBy: { revision: 'desc' },
      select: { revision: true },
    }),
  ])
  if (!revision || !latest || !actorUserId) {
    throw new ExecutorError(EXECUTOR_ERROR_CODES.NOT_FOUND, 'Executor descriptor not found.')
  }
  const requiredCurrentStatus = input.status === 'active' ? 'pending_review' : 'active'
  if (latest.revision !== input.revision || revision.reviewStatus !== requiredCurrentStatus) {
    throw new ExecutorError(
      EXECUTOR_ERROR_CODES.STATE_TRANSITION_INVALID,
      'This descriptor proposal is no longer current for review.',
    )
  }
  await tx.executorCapabilityRevision.update({
    where: { id: revision.id },
    data: {
      reviewStatus: input.status,
      reviewedAt: new Date(),
      reviewedByUserId: actorUserId,
    },
  })
  // A changed reviewed descriptor can narrow a live browser operation. Fence
  // the outbound daemon connection so the next control poll ends that VM.
  await tx.executor.update({
    where: { id: input.executorId },
    data: { activeConnectionEpoch: { increment: 1 } },
  })
  await tx.executorSession.updateMany({
    where: { executorId: input.executorId, status: { in: ['pending', 'active'] } },
    data: { status: 'stopped' },
  })
  // A review that leaves the machine without the local-apps pair — disabling
  // the live policy, or activating one that no longer names both keys — ends
  // every lease on it. One that keeps the pair leaves them: their existing
  // bindings are fenced by the revision check, and the next carry binds the
  // new revision afresh.
  const reviewed = ExecutorCapabilityDescriptorSchema.safeParse(revision.descriptor)
  const keepsLocalApps = input.status === 'active'
    && reviewed.success
    && EXECUTOR_LOCAL_APPS_OPERATION_KEYS.every((key) => reviewed.data.operationKeys.includes(key))
  if (!keepsLocalApps) {
    await endExecutorConversationLeasesInTransaction(tx, {
      actor: executorLeaseAuditActor(actorContext),
      endedByUserId: actorUserId,
      reason: 'descriptor_narrowed',
      where: { executorId: input.executorId },
    })
  }
}
