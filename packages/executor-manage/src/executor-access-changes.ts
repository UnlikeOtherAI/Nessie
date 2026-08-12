import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto'
import { Prisma, type PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

import {
  lockExecutorMutation,
  removePrivateAssignmentInTransaction,
  requireManagedExecutor,
  setExecutorAgentOperationGrantInTransaction,
  setPrivateAssignmentInTransaction,
} from './executor-access-mutations.js'
import { canonicalExecutorJson } from './executor-canonical-json.js'
import { EXECUTOR_ERROR_CODES, ExecutorError } from './executor-errors.js'
import {
  transitionExecutorLifecycleInTransaction,
  type ExecutorLifecycleAction,
} from './executor-lifecycle.js'

const ACCESS_CHANGE_TTL_MS = 10 * 60 * 1000

export type ExecutorAccessChange =
  | {
      kind: 'private_assignment'
      action: 'set'
      assignment:
        | { principalKind: 'user'; userId: string; role: 'use' | 'admin' }
        | { principalKind: 'agent'; agentId: string; role: 'use' }
    }
  | {
      kind: 'private_assignment'
      action: 'remove'
      principal:
        | { principalKind: 'user'; userId: string }
        | { principalKind: 'agent'; agentId: string }
    }
  | {
      kind: 'agent_operation_grant'
      agentId: string
      operationKey: string
      state: 'allowed' | 'denied'
    }
  | {
      kind: 'lifecycle'
      action: ExecutorLifecycleAction
    }

export type PreparedExecutorAccessChange = {
  accessChangeId: string
  confirmationToken: string
  executorId: string
  expiresAt: Date
  requiresFreshVerification: boolean
}

type StoredAccessChange = {
  authorizationRevision: number
  change: ExecutorAccessChange
  requiresFreshVerification: boolean
}

const hash = (value: string): string =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`

const tokenMatches = (token: string, expectedHash: string | null): boolean => {
  if (!expectedHash) return false
  const actual = Buffer.from(hash(token))
  const expected = Buffer.from(expectedHash)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

const digestMatches = (value: string, expected: string): boolean => {
  const actual = Buffer.from(value)
  const target = Buffer.from(expected)
  return actual.length === target.length && timingSafeEqual(actual, target)
}

export const requiresFreshExecutorVerification = (change: ExecutorAccessChange): boolean =>
  change.kind === 'private_assignment'
  || (change.kind === 'agent_operation_grant' && change.state === 'allowed')
  || (change.kind === 'lifecycle' && change.action === 'revoke')

const isPrincipal = (value: unknown): value is { principalKind: 'user'; userId: string } | {
  principalKind: 'agent'
  agentId: string
} => {
  if (typeof value !== 'object' || value === null) return false
  const principal = value as Record<string, unknown>
  return (principal.principalKind === 'user' && typeof principal.userId === 'string')
    || (principal.principalKind === 'agent' && typeof principal.agentId === 'string')
}

const isAssignment = (value: unknown): value is
  | { principalKind: 'user'; userId: string; role: 'use' | 'admin' }
  | { principalKind: 'agent'; agentId: string; role: 'use' } => {
  if (!isPrincipal(value)) return false
  const assignment = value as Record<string, unknown>
  return (assignment.principalKind === 'user'
    && (assignment.role === 'use' || assignment.role === 'admin'))
    || (assignment.principalKind === 'agent' && assignment.role === 'use')
}

const parseStoredAccessChange = (value: unknown): StoredAccessChange | null => {
  if (typeof value !== 'object' || value === null) return null
  const stored = value as Partial<StoredAccessChange>
  if (!Number.isInteger(stored.authorizationRevision) || !stored.change) return null
  const { change } = stored
  if (change.kind === 'private_assignment') {
    if (change.action === 'set' && isAssignment(change.assignment)) {
      return stored as StoredAccessChange
    }
    if (change.action === 'remove' && isPrincipal(change.principal)) {
      return stored as StoredAccessChange
    }
  }
  if (
    change.kind === 'agent_operation_grant'
    && typeof change.agentId === 'string'
    && typeof change.operationKey === 'string'
    && (change.state === 'allowed' || change.state === 'denied')
  ) {
    return stored as StoredAccessChange
  }
  if (
    change.kind === 'lifecycle'
    && ['pause', 'resume', 'drain', 'revoke'].includes(change.action)
  ) {
    return stored as StoredAccessChange
  }
  return null
}

const applyChange = async (
  tx: Prisma.TransactionClient,
  actorContext: AuthorizedActionContext,
  executorId: string,
  change: ExecutorAccessChange,
): Promise<number> => {
  if (change.kind === 'private_assignment') {
    return change.action === 'set'
      ? setPrivateAssignmentInTransaction(tx, actorContext, {
          executorId,
          assignment: change.assignment,
        })
      : removePrivateAssignmentInTransaction(tx, actorContext, {
          executorId,
          principal: change.principal,
        })
  }
  if (change.kind === 'agent_operation_grant') {
    return setExecutorAgentOperationGrantInTransaction(tx, actorContext, {
      executorId,
      agentId: change.agentId,
      operationKey: change.operationKey,
      state: change.state,
    })
  }
  const result = await transitionExecutorLifecycleInTransaction(tx, actorContext, {
    executorId,
    action: change.action,
  })
  return result.authorizationRevision
}

export const prepareExecutorAccessChange = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  input: { executorId: string; change: ExecutorAccessChange },
): Promise<PreparedExecutorAccessChange> => prisma.$transaction(async (tx) => {
  await lockExecutorMutation(tx, input.executorId)
  const executor = await requireManagedExecutor(tx, actorContext, input.executorId)
  const confirmationToken = randomBytes(32).toString('base64url')
  const verificationRequired = requiresFreshExecutorVerification(input.change)
  const expiresAt = new Date(Date.now() + ACCESS_CHANGE_TTL_MS)
  const revisions: StoredAccessChange = {
    authorizationRevision: executor.authorizationRevision,
    change: input.change,
    requiresFreshVerification: verificationRequired,
  }
  const subjectDigest = hash(canonicalExecutorJson({
    actorUserId: actorContext.actor.actorId,
    executorId: executor.id,
    revisions,
  }))
  const continuation = await tx.executorContinuation.create({
    data: {
      executorId: executor.id,
      subject: 'access_change',
      actorUserId: actorContext.actor.actorId,
      subjectDigest,
      revisions: revisions as unknown as Prisma.InputJsonValue,
      confirmationTokenHash: hash(confirmationToken),
      verificationChallengeId: verificationRequired ? randomUUID() : null,
      expiresAt,
    },
    select: { id: true },
  })
  return {
    accessChangeId: continuation.id,
    confirmationToken,
    executorId: executor.id,
    expiresAt,
    requiresFreshVerification: verificationRequired,
  }
})

export const getExecutorAccessChangeForUser = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  accessChangeId: string,
): Promise<{
  accessChangeId: string
  executorId: string
  change: ExecutorAccessChange
  expiresAt: Date
  requiresFreshVerification: boolean
  status: string
} | null> => {
  const continuation = await prisma.executorContinuation.findFirst({
    where: {
      id: accessChangeId,
      actorUserId: actorContext.actor.actorId,
      executor: { organizationId: actorContext.tenant.organizationId },
    },
    select: { executorId: true, expiresAt: true, id: true, revisions: true, status: true },
  })
  const stored = continuation ? parseStoredAccessChange(continuation.revisions) : null
  if (!continuation || !stored) return null
  return {
    accessChangeId: continuation.id,
    executorId: continuation.executorId,
    change: stored.change,
    expiresAt: continuation.expiresAt,
    requiresFreshVerification: stored.requiresFreshVerification,
    status: continuation.status,
  }
}

export const confirmExecutorAccessChange = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  input: {
    accessChangeId: string
    confirmationToken: string
    freshVerificationSatisfied: boolean
  },
): Promise<{ authorizationRevision: number; executorId: string }> =>
  prisma.$transaction(async (tx) => {
    const continuation = await tx.executorContinuation.findUnique({
      where: { id: input.accessChangeId },
      select: {
        actorUserId: true,
        confirmationTokenHash: true,
        executorId: true,
        expiresAt: true,
        id: true,
        revisions: true,
        status: true,
        subjectDigest: true,
        verificationChallengeId: true,
      },
    })
    if (
      !continuation
      || continuation.actorUserId !== actorContext.actor.actorId
      || !tokenMatches(input.confirmationToken, continuation.confirmationTokenHash)
    ) {
      throw new ExecutorError(EXECUTOR_ERROR_CODES.ACCESS_CHANGE_NOT_FOUND, 'Access change not found.')
    }
    await lockExecutorMutation(tx, continuation.executorId)
    if (continuation.status !== 'pending') {
      throw new ExecutorError(EXECUTOR_ERROR_CODES.ACCESS_CHANGE_STALE, 'Access change is no longer pending.')
    }
    if (continuation.expiresAt <= new Date()) {
      await tx.executorContinuation.update({
        where: { id: continuation.id },
        data: { status: 'expired' },
      })
      throw new ExecutorError(EXECUTOR_ERROR_CODES.ACCESS_CHANGE_EXPIRED, 'Access change has expired.')
    }
    const stored = parseStoredAccessChange(continuation.revisions)
    if (!stored) {
      throw new ExecutorError(EXECUTOR_ERROR_CODES.ACCESS_CHANGE_STALE, 'Access change is invalid.')
    }
    const expectedDigest = hash(canonicalExecutorJson({
      actorUserId: continuation.actorUserId,
      executorId: continuation.executorId,
      revisions: stored,
    }))
    if (!digestMatches(continuation.subjectDigest, expectedDigest)) {
      throw new ExecutorError(EXECUTOR_ERROR_CODES.ACCESS_CHANGE_STALE, 'Access change is invalid.')
    }
    if (
      stored.requiresFreshVerification
      && (!input.freshVerificationSatisfied || !continuation.verificationChallengeId)
    ) {
      throw new ExecutorError(
        EXECUTOR_ERROR_CODES.FRESH_VERIFICATION_REQUIRED,
        'Fresh verification is required to confirm this access change.',
      )
    }
    const executor = await requireManagedExecutor(tx, actorContext, continuation.executorId)
    if (executor.authorizationRevision !== stored.authorizationRevision) {
      throw new ExecutorError(
        EXECUTOR_ERROR_CODES.ACCESS_CHANGE_STALE,
        'Executor authorization changed; prepare the change again.',
      )
    }
    const authorizationRevision = await applyChange(
      tx,
      actorContext,
      executor.id,
      stored.change,
    )
    await tx.executorContinuation.update({
      where: { id: continuation.id },
      data: {
        status: 'consumed',
        consumedAt: new Date(),
      },
    })
    return { authorizationRevision, executorId: executor.id }
  })

export const rejectExecutorAccessChange = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  input: { accessChangeId: string; confirmationToken: string },
): Promise<{ executorId: string }> => prisma.$transaction(async (tx) => {
  const continuation = await tx.executorContinuation.findUnique({
    where: { id: input.accessChangeId },
    select: {
      actorUserId: true,
      confirmationTokenHash: true,
      executorId: true,
      id: true,
      status: true,
    },
  })
  if (
    !continuation
    || continuation.actorUserId !== actorContext.actor.actorId
    || !tokenMatches(input.confirmationToken, continuation.confirmationTokenHash)
  ) {
    throw new ExecutorError(EXECUTOR_ERROR_CODES.ACCESS_CHANGE_NOT_FOUND, 'Access change not found.')
  }
  if (continuation.status !== 'pending') {
    throw new ExecutorError(EXECUTOR_ERROR_CODES.ACCESS_CHANGE_STALE, 'Access change is no longer pending.')
  }
  await tx.executorContinuation.update({
    where: { id: continuation.id },
    data: { status: 'rejected', consumedAt: new Date() },
  })
  return { executorId: continuation.executorId }
})
