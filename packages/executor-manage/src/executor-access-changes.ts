import { randomBytes, randomUUID } from 'node:crypto'
import { Prisma, type PrismaClient } from '@prisma/client'
import {
  ExecutorStandingPolicyAccessChangeSchema,
  ImplementedExecutorOperationKeySchema,
  type AuthorizedActionContext,
  type ExecutorStandingPolicyAccessChange,
  type ImplementedExecutorOperationKey,
} from '@nessie/schemas'

import {
  lockExecutorMutation,
  removePrivateAssignmentInTransaction,
  requireManagedExecutor,
  setExecutorAgentOperationGrantInTransaction,
  setExecutorAgentWholeSuiteGrantInTransaction,
  setPrivateAssignmentInTransaction,
} from './executor-access-mutations.js'
import {
  EXECUTOR_CONTINUATION_TTL_MS,
  executorContinuationSubjectDigest,
  executorContinuationValuesMatch,
  hashExecutorContinuationValue,
} from './executor-continuation-security.js'
import { listLiveExecutorLeaseRefs, type ExecutorLeaseRef } from './executor-conversation-lease.js'
import { EXECUTOR_ERROR_CODES, ExecutorError } from './executor-errors.js'
import { closeExecutorReviewCards, type ClosedExecutorReviewCard } from './executor-review-cards.js'
import { setExecutorAgentAccessInTransaction } from './executor-agent-access.js'
import {
  reviewExecutorDescriptorInTransaction,
  transitionExecutorLifecycleInTransaction,
  type ExecutorLifecycleAction,
} from './executor-lifecycle.js'

export type ExecutorAccessChange =
  | { kind: 'agent_executor_access'; agentId: string; state: 'allowed' | 'denied' }
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
      operationKey: ImplementedExecutorOperationKey
      state: 'allowed' | 'denied'
    }
  | {
      /**
       * The whole suite this executor offers, in one prepared change.
       *
       * It names no operation key: "access to an executor" is access to
       * everything on it, so the set is derived from the active capability
       * revision when the change is applied, never picked by whoever prepared
       * it.
       */
      kind: 'agent_executor_grant'
      agentId: string
      state: 'allowed' | 'denied'
    }
  | {
      kind: 'lifecycle'
      action: ExecutorLifecycleAction
    }
  | {
      kind: 'descriptor_review'
      revision: number
      status: 'active' | 'disabled'
    }
  /**
   * A trigger's standing machine access: one confirmation for every pool
   * machine's assignment, grant and tool enablement and the policy itself
   * (docs/standards/ticket-work.md). It is applied by the confirming
   * service's `applyPolicy`, never by `applyChange`: the policy, its
   * trigger and its ticket work are not this package's to write.
   */
  | ExecutorStandingPolicyAccessChange

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

export const requiresFreshExecutorVerification = (change: ExecutorAccessChange): boolean =>
  change.kind === 'private_assignment'
  || (change.kind === 'agent_operation_grant' && change.state === 'allowed')
  // The same rule as one operation, for the same reason: widening what an
  // agent may reach on somebody's machine is the moment to re-prove the human.
  || (change.kind === 'agent_executor_grant' && change.state === 'allowed')
  || (change.kind === 'agent_executor_access' && change.state === 'allowed')
  // Disconnecting or deleting a machine is deliberately absent: it only takes
  // access away, the daemon's next connection is refused, and the machine can
  // pair again. A kill switch must never be harder to reach than what it stops.
  || (change.kind === 'descriptor_review' && change.status === 'active')
  // A standing policy lets colleagues start commands on the machine as its
  // owner: the widest thing this door confirms.
  || change.kind === 'standing_policy'

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
    && ImplementedExecutorOperationKeySchema.safeParse(change.operationKey).success
    && (change.state === 'allowed' || change.state === 'denied')
  ) {
    return stored as StoredAccessChange
  }
  if (
    (change.kind === 'agent_executor_grant' || change.kind === 'agent_executor_access')
    && typeof change.agentId === 'string'
    && (change.state === 'allowed' || change.state === 'denied')
  ) {
    return stored as StoredAccessChange
  }
  if (
    change.kind === 'lifecycle'
    && ['pause', 'resume', 'drain', 'revoke', 'remove'].includes(change.action)
  ) {
    return stored as StoredAccessChange
  }
  if (change.kind === 'standing_policy' && ExecutorStandingPolicyAccessChangeSchema.safeParse(change).success) {
    return stored as StoredAccessChange
  }
  if (
    change.kind === 'descriptor_review'
    && Number.isInteger(change.revision)
    && change.revision > 0
    && (change.status === 'active' || change.status === 'disabled')
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
  if (change.kind === 'agent_executor_access') {
    return setExecutorAgentAccessInTransaction(tx, actorContext, {
      executorId, agentId: change.agentId, state: change.state,
    })
  }
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
  if (change.kind === 'agent_executor_grant') {
    return setExecutorAgentWholeSuiteGrantInTransaction(tx, actorContext, {
      executorId,
      agentId: change.agentId,
      state: change.state,
    })
  }
  if (change.kind === 'standing_policy') {
    // Its effects were the confirming service's (`applyPolicy`), which the
    // confirm refuses to go without; this machine's revision is what they left.
    const executor = await tx.executor.findUniqueOrThrow({
      where: { id: executorId },
      select: { authorizationRevision: true },
    })
    return executor.authorizationRevision
  }
  if (change.kind === 'descriptor_review') {
    await reviewExecutorDescriptorInTransaction(tx, actorContext, {
      executorId,
      revision: change.revision,
      status: change.status,
    })
    const executor = await tx.executor.findUnique({
      where: { id: executorId },
      select: { authorizationRevision: true },
    })
    if (!executor) {
      throw new ExecutorError(EXECUTOR_ERROR_CODES.NOT_FOUND, 'Executor not found.')
    }
    return executor.authorizationRevision
  }
  const result = await transitionExecutorLifecycleInTransaction(tx, actorContext, {
    executorId,
    action: change.action,
  })
  return result.authorizationRevision
}

/**
 * The continuation a prepared change is confirmed through: its token, its
 * expiry, its subject digest and, where the change needs it, the fresh
 * verification it will ask for. The one place one is minted, for the
 * per-machine changes below and for a standing policy's composite one, which
 * hangs off its first pool machine and pins every machine's revision itself.
 */
export const createExecutorAccessChangeContinuationInTransaction = async (
  tx: Prisma.TransactionClient,
  input: {
    actorUserId: string
    authorizationRevision: number
    change: ExecutorAccessChange
    executorId: string
    requiresFreshVerification: boolean
  },
): Promise<PreparedExecutorAccessChange> => {
  const confirmationToken = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + EXECUTOR_CONTINUATION_TTL_MS)
  const revisions: StoredAccessChange = {
    authorizationRevision: input.authorizationRevision,
    change: input.change,
    requiresFreshVerification: input.requiresFreshVerification,
  }
  const subjectDigest = executorContinuationSubjectDigest({
    actorUserId: input.actorUserId,
    executorId: input.executorId,
    revisions,
  })
  const continuation = await tx.executorContinuation.create({
    data: {
      executorId: input.executorId,
      subject: 'access_change',
      actorUserId: input.actorUserId,
      subjectDigest,
      revisions: revisions as unknown as Prisma.InputJsonValue,
      confirmationTokenHash: hashExecutorContinuationValue(confirmationToken),
      verificationChallengeId: input.requiresFreshVerification ? randomUUID() : null,
      expiresAt,
    },
    select: { id: true },
  })
  return {
    accessChangeId: continuation.id,
    confirmationToken,
    executorId: input.executorId,
    expiresAt,
    requiresFreshVerification: input.requiresFreshVerification,
  }
}

export const prepareExecutorAccessChange = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  input: { executorId: string; change: ExecutorAccessChange },
): Promise<PreparedExecutorAccessChange> => prisma.$transaction(async (tx) => {
  // A standing policy is prepared by its trigger's author through its own
  // door, which checks the trigger and every pool machine first.
  if (input.change.kind === 'standing_policy') {
    throw new ExecutorError(EXECUTOR_ERROR_CODES.SCOPE_INVALID, 'Prepare machine access from its trigger.')
  }
  await lockExecutorMutation(tx, input.executorId)
  const executor = await requireManagedExecutor(tx, actorContext, input.executorId)
  return createExecutorAccessChangeContinuationInTransaction(tx, {
    actorUserId: actorContext.actor.actorId,
    authorizationRevision: executor.authorizationRevision,
    change: input.change,
    executorId: executor.id,
    requiresFreshVerification: requiresFreshExecutorVerification(input.change)
      || (input.change.kind === 'agent_executor_access' && executor.scopeKind === 'private'),
  })
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
  applyPolicy?: (
    tx: Prisma.TransactionClient, input: { executorId: string; change: ExecutorAccessChange },
  ) => Promise<void>,
): Promise<{
  authorizationRevision: number
  closedReviewCards: ClosedExecutorReviewCard[]
  endedLeases: ExecutorLeaseRef[]
  executorId: string
}> =>
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
      || !executorContinuationValuesMatch(
        hashExecutorContinuationValue(input.confirmationToken),
        continuation.confirmationTokenHash,
      )
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
    if (!stored || (stored.change.kind === 'standing_policy' && !applyPolicy)) {
      throw new ExecutorError(EXECUTOR_ERROR_CODES.ACCESS_CHANGE_STALE, 'Access change is invalid.')
    }
    const expectedDigest = executorContinuationSubjectDigest({
      actorUserId: continuation.actorUserId,
      executorId: continuation.executorId,
      revisions: stored,
    })
    if (!executorContinuationValuesMatch(expectedDigest, continuation.subjectDigest)) {
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
    // Confirmation and rejection compete for this pending row. Claim before
    // any policy/grant effects; a failed mutation rolls the claim back as well.
    const claimed = await tx.executorContinuation.updateMany({
      where: { id: continuation.id, status: 'pending' },
      data: { status: 'consumed', consumedAt: new Date() },
    })
    if (claimed.count !== 1) {
      throw new ExecutorError(EXECUTOR_ERROR_CODES.ACCESS_CHANGE_STALE, 'Access change is no longer pending.')
    }
    // Whichever door confirmed it, the chat card that opened its review is done.
    const closedReviewCards = await closeExecutorReviewCards(tx, {
      actorUserId: continuation.actorUserId,
      continuationId: continuation.id,
      outcome: 'confirmed',
    })
    // Whichever of the grant, roster, lifecycle or review paths the change
    // takes may end conversation leases with its fence. The executor lock is
    // held throughout, so the live set before and after differs by exactly
    // those, and the route tells their holders once this commits.
    const liveLeases = await listLiveExecutorLeaseRefs(tx, executor.id)
    // Route-owned policy effects share this validated continuation transaction;
    // invalid tokens, stale authority or a failed access mutation write nothing.
    await applyPolicy?.(tx, { executorId: executor.id, change: stored.change })
    const authorizationRevision = await applyChange(
      tx,
      actorContext,
      executor.id,
      stored.change,
    )
    const stillLive = new Set(
      liveLeases.length > 0 ? (await listLiveExecutorLeaseRefs(tx, executor.id)).map((lease) => lease.id) : [],
    )
    return {
      authorizationRevision,
      closedReviewCards,
      endedLeases: liveLeases.filter((lease) => !stillLive.has(lease.id)),
      executorId: executor.id,
    }
  })

export const rejectExecutorAccessChange = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  input: { accessChangeId: string; confirmationToken: string },
  /** The confirming service's own clean-up of a rejected change, in this transaction. */
  onRejected?: (
    tx: Prisma.TransactionClient, input: { executorId: string; change: ExecutorAccessChange },
  ) => Promise<void>,
): Promise<{ closedReviewCards: ClosedExecutorReviewCard[]; executorId: string }> => prisma.$transaction(async (tx) => {
  const continuation = await tx.executorContinuation.findUnique({
    where: { id: input.accessChangeId },
    select: {
      actorUserId: true,
      confirmationTokenHash: true,
      executorId: true,
      id: true,
      revisions: true,
      status: true,
    },
  })
  if (
    !continuation
    || continuation.actorUserId !== actorContext.actor.actorId
    || !executorContinuationValuesMatch(
      hashExecutorContinuationValue(input.confirmationToken),
      continuation.confirmationTokenHash,
    )
  ) {
    throw new ExecutorError(EXECUTOR_ERROR_CODES.ACCESS_CHANGE_NOT_FOUND, 'Access change not found.')
  }
  if (continuation.status !== 'pending') {
    throw new ExecutorError(EXECUTOR_ERROR_CODES.ACCESS_CHANGE_STALE, 'Access change is no longer pending.')
  }
  const rejected = await tx.executorContinuation.updateMany({
    where: { id: continuation.id, status: 'pending' },
    data: { status: 'rejected', consumedAt: new Date() },
  })
  if (rejected.count !== 1) {
    throw new ExecutorError(EXECUTOR_ERROR_CODES.ACCESS_CHANGE_STALE, 'Access change is no longer pending.')
  }
  const closedReviewCards = await closeExecutorReviewCards(tx, {
    actorUserId: continuation.actorUserId,
    continuationId: continuation.id,
    outcome: 'rejected',
  })
  const stored = parseStoredAccessChange(continuation.revisions)
  if (stored) await onRejected?.(tx, { executorId: continuation.executorId, change: stored.change })
  return { closedReviewCards, executorId: continuation.executorId }
})
