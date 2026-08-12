import { Prisma, type PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

import {
  canManageExecutor,
  requireHumanActor,
  resolveExecutorHumanAccess,
} from './executor-access.js'
import { EXECUTOR_ERROR_CODES, ExecutorError } from './executor-errors.js'

export type ExecutorMutationClient = PrismaClient | Prisma.TransactionClient

type ManagedExecutor = {
  id: string
  organizationId: string
  projectId: string | null
  scopeKind: 'private' | 'project' | 'organization'
  authorizationRevision: number
}

export const lockExecutorMutation = async (
  tx: Prisma.TransactionClient,
  executorId: string,
): Promise<void> => {
  await tx.$executeRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${`executor:${executorId}`}, 0))
  `)
}

export const requireManagedExecutor = async (
  prisma: ExecutorMutationClient,
  actorContext: AuthorizedActionContext,
  executorId: string,
): Promise<ManagedExecutor> => {
  const actorUserId = requireHumanActor(actorContext)
  const executor = actorUserId
    ? await prisma.executor.findFirst({
        where: { id: executorId, organizationId: actorContext.tenant.organizationId },
        select: {
          authorizationRevision: true,
          id: true,
          organizationId: true,
          projectId: true,
          scopeKind: true,
        },
      })
    : null
  if (!executor || !actorUserId) {
    throw new ExecutorError(EXECUTOR_ERROR_CODES.NOT_FOUND, 'Executor not found.')
  }
  const access = await resolveExecutorHumanAccess(
    prisma,
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
  return executor
}

const nextAuthorizationRevision = async (
  tx: Prisma.TransactionClient,
  executorId: string,
): Promise<number> => {
  const executor = await tx.executor.update({
    where: { id: executorId },
    // An access mutation must fence an already live browser as well as future
    // command creation. The daemon's next signed poll observes the changed
    // connection epoch and stops all local guest sessions before reconnecting.
    data: {
      activeConnectionEpoch: { increment: 1 },
      authorizationRevision: { increment: 1 },
    },
    select: { authorizationRevision: true },
  })
  // The daemon receives the epoch fence and stops its VM before it reconnects;
  // persist the matching control-plane outcome immediately so a Sessions view
  // never advertises a browser as usable after a human access decision.
  await tx.executorSession.updateMany({
    where: { executorId, status: { in: ['pending', 'active'] } },
    data: { status: 'stopped' },
  })
  return executor.authorizationRevision
}

export type PrivateAssignmentMutation = {
  executorId: string
  assignment:
    | { principalKind: 'user'; userId: string; role: 'use' | 'admin' }
    | { principalKind: 'agent'; agentId: string; role: 'use' }
}

export const setPrivateAssignmentInTransaction = async (
  tx: Prisma.TransactionClient,
  actorContext: AuthorizedActionContext,
  input: PrivateAssignmentMutation,
): Promise<number> => {
  const executor = await requireManagedExecutor(tx, actorContext, input.executorId)
  if (executor.scopeKind !== 'private') {
    throw new ExecutorError(
      EXECUTOR_ERROR_CODES.SCOPE_INVALID,
      'Private assignments are valid only for private executors.',
    )
  }
  const existing = await tx.executorPrivateAssignment.findFirst({
    where: input.assignment.principalKind === 'user'
      ? { executorId: executor.id, principalKind: 'user', userId: input.assignment.userId }
      : { executorId: executor.id, principalKind: 'agent', agentId: input.assignment.agentId },
  })
  if (
    existing?.principalKind === 'user'
    && existing.role === 'admin'
    && input.assignment.principalKind === 'user'
    && input.assignment.role !== 'admin'
  ) {
    const remainingAdmins = await tx.executorPrivateAssignment.count({
      where: {
        executorId: executor.id,
        principalKind: 'user',
        role: 'admin',
        NOT: { id: existing.id },
      },
    })
    if (remainingAdmins === 0) {
      throw new ExecutorError(
        EXECUTOR_ERROR_CODES.PRIVATE_FINAL_ADMIN_REQUIRED,
        'A private executor must retain at least one human administrator.',
      )
    }
  }
  if (input.assignment.principalKind === 'user') {
    await tx.executorPrivateAssignment.upsert({
      where: {
        executorId_userId: {
          executorId: executor.id,
          userId: input.assignment.userId,
        },
      },
      create: {
        executorId: executor.id,
        principalKind: 'user',
        userId: input.assignment.userId,
        role: input.assignment.role,
      },
      update: { role: input.assignment.role },
    })
  } else {
    await tx.executorPrivateAssignment.upsert({
      where: {
        executorId_agentId: {
          executorId: executor.id,
          agentId: input.assignment.agentId,
        },
      },
      create: {
        executorId: executor.id,
        principalKind: 'agent',
        agentId: input.assignment.agentId,
        role: 'use',
      },
      update: { role: 'use' },
    })
  }
  return nextAuthorizationRevision(tx, executor.id)
}

export const setPrivateAssignment = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  input: PrivateAssignmentMutation,
): Promise<number> => prisma.$transaction(async (tx) => {
  await lockExecutorMutation(tx, input.executorId)
  return setPrivateAssignmentInTransaction(tx, actorContext, input)
})

export type PrivateAssignmentRemoval = {
  executorId: string
  principal: { principalKind: 'user'; userId: string } | { principalKind: 'agent'; agentId: string }
}

export const removePrivateAssignmentInTransaction = async (
  tx: Prisma.TransactionClient,
  actorContext: AuthorizedActionContext,
  input: PrivateAssignmentRemoval,
): Promise<number> => {
  const executor = await requireManagedExecutor(tx, actorContext, input.executorId)
  if (executor.scopeKind !== 'private') {
    throw new ExecutorError(
      EXECUTOR_ERROR_CODES.SCOPE_INVALID,
      'Private assignments are valid only for private executors.',
    )
  }
  const existing = await tx.executorPrivateAssignment.findFirst({
    where: input.principal.principalKind === 'user'
      ? { executorId: executor.id, principalKind: 'user', userId: input.principal.userId }
      : { executorId: executor.id, principalKind: 'agent', agentId: input.principal.agentId },
  })
  if (!existing) return executor.authorizationRevision
  if (existing.principalKind === 'user' && existing.role === 'admin') {
    const remainingAdmins = await tx.executorPrivateAssignment.count({
      where: {
        executorId: executor.id,
        principalKind: 'user',
        role: 'admin',
        NOT: { id: existing.id },
      },
    })
    if (remainingAdmins === 0) {
      throw new ExecutorError(
        EXECUTOR_ERROR_CODES.PRIVATE_FINAL_ADMIN_REQUIRED,
        'A private executor must retain at least one human administrator.',
      )
    }
  }
  if (existing.principalKind === 'agent' && existing.agentId) {
    await tx.executorAgentOperationGrant.deleteMany({
      where: { executorId: executor.id, agentId: existing.agentId },
    })
  }
  await tx.executorPrivateAssignment.delete({ where: { id: existing.id } })
  return nextAuthorizationRevision(tx, executor.id)
}

export const removePrivateAssignment = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  input: PrivateAssignmentRemoval,
): Promise<number> => prisma.$transaction(async (tx) => {
  await lockExecutorMutation(tx, input.executorId)
  return removePrivateAssignmentInTransaction(tx, actorContext, input)
})

export type AgentOperationGrantMutation = {
  executorId: string
  agentId: string
  operationKey: string
  state: 'allowed' | 'denied'
}

export const setExecutorAgentOperationGrantInTransaction = async (
  tx: Prisma.TransactionClient,
  actorContext: AuthorizedActionContext,
  input: AgentOperationGrantMutation,
): Promise<number> => {
  const executor = await requireManagedExecutor(tx, actorContext, input.executorId)
  const actorUserId = requireHumanActor(actorContext)
  if (!actorUserId) {
    throw new ExecutorError(EXECUTOR_ERROR_CODES.SCOPE_ENTITLEMENT_DENIED, 'Human access required.')
  }
  if (executor.scopeKind === 'private' && input.state === 'allowed') {
    const agentAssignment = await tx.executorPrivateAssignment.findFirst({
      where: {
        executorId: executor.id,
        principalKind: 'agent',
        agentId: input.agentId,
        role: 'use',
      },
      select: { id: true },
    })
    if (!agentAssignment) {
      throw new ExecutorError(
        EXECUTOR_ERROR_CODES.SCOPE_ENTITLEMENT_DENIED,
        'A private executor operation may be granted only to an assigned agent.',
      )
    }
  }
  const authorizationRevision = await nextAuthorizationRevision(tx, executor.id)
  await tx.executorAgentOperationGrant.upsert({
    where: {
      executorId_agentId_operationKey: {
        executorId: executor.id,
        agentId: input.agentId,
        operationKey: input.operationKey,
      },
    },
    create: {
      executorId: executor.id,
      agentId: input.agentId,
      operationKey: input.operationKey,
      state: input.state,
      authorizationRevision,
      updatedByUserId: actorUserId,
    },
    update: {
      state: input.state,
      authorizationRevision,
      updatedByUserId: actorUserId,
    },
  })
  return authorizationRevision
}

export const setExecutorAgentOperationGrant = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  input: AgentOperationGrantMutation,
): Promise<number> => prisma.$transaction(async (tx) => {
  await lockExecutorMutation(tx, input.executorId)
  return setExecutorAgentOperationGrantInTransaction(tx, actorContext, input)
})
