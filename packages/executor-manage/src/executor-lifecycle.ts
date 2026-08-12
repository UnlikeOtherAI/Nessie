import { type PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

import {
  canManageExecutor,
  requireHumanActor,
  resolveExecutorHumanAccess,
} from './executor-access.js'
import {
  lockExecutorMutation,
  requireManagedExecutor,
} from './executor-access-mutations.js'
import { EXECUTOR_ERROR_CODES, ExecutorError } from './executor-errors.js'

export type ExecutorLifecycleAction = 'pause' | 'resume' | 'drain' | 'revoke'

const canBreakGlassRevoke = async (
  prisma: PrismaClient,
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
  const breakGlassRevoke = input.action === 'revoke'
    && await canBreakGlassRevoke(prisma, actorContext, input.executorId)
  if (!breakGlassRevoke) {
    const managed = await requireManagedExecutor(prisma, actorContext, input.executorId)
    if (!managed) {
      throw new ExecutorError(EXECUTOR_ERROR_CODES.NOT_FOUND, 'Executor not found.')
    }
  }
  return prisma.$transaction(async (tx) => {
    await lockExecutorMutation(tx, input.executorId)
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
        ...(input.action === 'revoke' ? { activeConnectionEpoch: { increment: 1 } } : {}),
      },
      select: { authorizationRevision: true, status: true },
    })
    return updated
  })
}

export const reviewExecutorDescriptor = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  input: { executorId: string; revision: number; status: 'active' | 'disabled' },
): Promise<void> => {
  await prisma.$transaction(async (tx) => {
    await lockExecutorMutation(tx, input.executorId)
    await requireManagedExecutor(tx, actorContext, input.executorId)
    const actorUserId = requireHumanActor(actorContext)
    const revision = await tx.executorCapabilityRevision.findFirst({
      where: { executorId: input.executorId, revision: input.revision },
      select: { id: true },
    })
    if (!revision || !actorUserId) {
      throw new ExecutorError(EXECUTOR_ERROR_CODES.NOT_FOUND, 'Executor descriptor not found.')
    }
    await tx.executorCapabilityRevision.update({
      where: { id: revision.id },
      data: {
        reviewStatus: input.status,
        reviewedAt: new Date(),
        reviewedByUserId: actorUserId,
      },
    })
  })
}
