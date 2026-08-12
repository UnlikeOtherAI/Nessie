import { randomBytes, randomUUID } from 'node:crypto'

import { Prisma, type PrismaClient } from '@prisma/client'
import { type AuthorizedActionContext } from '@nessie/schemas'

import { requireHumanActor } from './executor-access.js'
import { lockExecutorMutation } from './executor-access-mutations.js'
import { bindExecutorCandidateInTransaction } from './executor-binding.js'
import { createExecutorCommand, readExecutorCommandResult } from './executor-commands.js'
import {
  EXECUTOR_CONTINUATION_TTL_MS,
  executorContinuationSubjectDigest,
  executorContinuationValuesMatch,
  hashExecutorContinuationValue,
} from './executor-continuation-security.js'
import { EXECUTOR_ERROR_CODES, ExecutorError } from './executor-errors.js'
import { parseExecutorWorkspaceReviewResult } from './executor-workspace-reviews.js'

const PROMOTION_COMMAND_TTL_MS = 2 * 60 * 1_000

type StoredWorkspacePromotion = {
  agentId: string
  authorizationRevision: number
  changeCount: number
  manifestDigest: string
  reviewCommandId: string
  reviewResultDigest: string
  runId: string
}

export type PreparedWorkspacePromotion = {
  changeCount: number
  confirmationToken: string
  executorId: string
  expiresAt: Date
  manifestDigest: string
  promotionId: string
  runId: string
}

export type WorkspacePromotionForUser = Omit<PreparedWorkspacePromotion, 'confirmationToken'> & {
  agentId: string
  requiresFreshVerification: true
  status: string
}

const isDigest = (value: unknown): value is string =>
  typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)

const isId = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)

const parseStoredPromotion = (value: unknown): StoredWorkspacePromotion | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const stored = value as Partial<StoredWorkspacePromotion>
  if (
    !isId(stored.agentId)
    || !Number.isInteger(stored.authorizationRevision)
    || !Number.isInteger(stored.changeCount)
    || stored.changeCount! < 0
    || !isDigest(stored.manifestDigest)
    || !isId(stored.reviewCommandId)
    || !isDigest(stored.reviewResultDigest)
    || !isId(stored.runId)
  ) return null
  return stored as StoredWorkspacePromotion
}

const subjectDigest = (
  actorUserId: string,
  executorId: string,
  promotion: StoredWorkspacePromotion,
): string => executorContinuationSubjectDigest({ actorUserId, executorId, promotion })

const originatingReview = async (
  prisma: PrismaClient,
  encryptionSecret: string,
  actorContext: AuthorizedActionContext,
  reviewCommandId: string,
): Promise<{
  agentId: string
  changeCount: number
  executorId: string
  manifestDigest: string
  resultDigest: string
  runId: string
} | null> => {
  const actorUserId = requireHumanActor(actorContext)
  if (!actorUserId) return null
  const command = await prisma.executorCommand.findFirst({
    where: {
      id: reviewCommandId,
      state: 'result_acknowledged',
      binding: {
        operationKey: 'workspace.review',
        run: {
          triggerMessage: { userId: actorUserId },
          thread: { channel: { organizationId: actorContext.tenant.organizationId } },
        },
      },
    },
    select: {
      id: true,
      resultDigest: true,
      binding: {
        select: {
          executorId: true,
          runId: true,
          run: { select: { agentId: true } },
        },
      },
    },
  })
  if (!command?.resultDigest) return null
  const result = await readExecutorCommandResult(prisma, encryptionSecret, command.id)
  const parsed = result ? parseExecutorWorkspaceReviewResult(result) : null
  if (!parsed) return null
  return {
    agentId: command.binding.run.agentId,
    changeCount: parsed.changes.length,
    executorId: command.binding.executorId,
    manifestDigest: parsed.manifestDigest,
    resultDigest: command.resultDigest,
    runId: command.binding.runId,
  }
}

export const prepareExecutorWorkspacePromotion = async (
  prisma: PrismaClient,
  encryptionSecret: string,
  actorContext: AuthorizedActionContext,
  input: { reviewCommandId: string },
): Promise<PreparedWorkspacePromotion> => {
  const actorUserId = requireHumanActor(actorContext)
  if (!actorUserId) {
    throw new ExecutorError(
      EXECUTOR_ERROR_CODES.SCOPE_ENTITLEMENT_DENIED,
      'Workspace promotion requires a human requester.',
    )
  }
  const review = await originatingReview(prisma, encryptionSecret, actorContext, input.reviewCommandId)
  if (!review) {
    throw new ExecutorError(
      EXECUTOR_ERROR_CODES.PROMOTION_REVIEW_NOT_FOUND,
      'The reviewed workspace draft is unavailable.',
    )
  }
  return prisma.$transaction(async (tx) => {
    await lockExecutorMutation(tx, review.executorId)
    const executor = await tx.executor.findFirst({
      where: { id: review.executorId, organizationId: actorContext.tenant.organizationId },
      select: { authorizationRevision: true, id: true },
    })
    if (!executor) {
      throw new ExecutorError(EXECUTOR_ERROR_CODES.NOT_FOUND, 'Executor not found.')
    }
    const promotion: StoredWorkspacePromotion = {
      agentId: review.agentId,
      authorizationRevision: executor.authorizationRevision,
      changeCount: review.changeCount,
      manifestDigest: review.manifestDigest,
      reviewCommandId: input.reviewCommandId,
      reviewResultDigest: review.resultDigest,
      runId: review.runId,
    }
    const confirmationToken = randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.now() + EXECUTOR_CONTINUATION_TTL_MS)
    const continuation = await tx.executorContinuation.create({
      data: {
        actorUserId,
        confirmationTokenHash: hashExecutorContinuationValue(confirmationToken),
        executorId: executor.id,
        expiresAt,
        revisions: promotion as unknown as Prisma.InputJsonValue,
        subject: 'invocation',
        subjectDigest: subjectDigest(actorUserId, executor.id, promotion),
        verificationChallengeId: randomUUID(),
      },
      select: { id: true },
    })
    return {
      changeCount: promotion.changeCount,
      confirmationToken,
      executorId: executor.id,
      expiresAt,
      manifestDigest: promotion.manifestDigest,
      promotionId: continuation.id,
      runId: promotion.runId,
    }
  })
}

export const getExecutorWorkspacePromotionForUser = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  promotionId: string,
): Promise<WorkspacePromotionForUser | null> => {
  const actorUserId = requireHumanActor(actorContext)
  if (!actorUserId) return null
  const continuation = await prisma.executorContinuation.findFirst({
    where: {
      actorUserId,
      executor: { organizationId: actorContext.tenant.organizationId },
      id: promotionId,
      subject: 'invocation',
    },
    select: { executorId: true, expiresAt: true, id: true, revisions: true, status: true },
  })
  const promotion = continuation ? parseStoredPromotion(continuation.revisions) : null
  if (!continuation || !promotion) return null
  return {
    agentId: promotion.agentId,
    changeCount: promotion.changeCount,
    executorId: continuation.executorId,
    expiresAt: continuation.expiresAt,
    manifestDigest: promotion.manifestDigest,
    promotionId: continuation.id,
    requiresFreshVerification: true,
    runId: promotion.runId,
    status: continuation.status,
  }
}

export const confirmExecutorWorkspacePromotion = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  input: {
    candidateHandle: string
    confirmationToken: string
    encryptionSecret: string
    freshVerificationSatisfied: boolean
    promotionId: string
  },
): Promise<{ commandId: string; executorId: string; promotionId: string; runId: string }> => {
  const actorUserId = requireHumanActor(actorContext)
  if (!actorUserId) {
    throw new ExecutorError(
      EXECUTOR_ERROR_CODES.SCOPE_ENTITLEMENT_DENIED,
      'Workspace promotion requires a human requester.',
    )
  }
  return prisma.$transaction(async (tx) => {
    const continuation = await tx.executorContinuation.findUnique({
      where: { id: input.promotionId },
      select: {
        actorUserId: true,
        confirmationTokenHash: true,
        executorId: true,
        expiresAt: true,
        id: true,
        revisions: true,
        status: true,
        subject: true,
        subjectDigest: true,
        verificationChallengeId: true,
      },
    })
    if (
      !continuation
      || continuation.subject !== 'invocation'
      || continuation.actorUserId !== actorUserId
      || !executorContinuationValuesMatch(
        hashExecutorContinuationValue(input.confirmationToken),
        continuation.confirmationTokenHash,
      )
    ) {
      throw new ExecutorError(EXECUTOR_ERROR_CODES.PROMOTION_NOT_FOUND, 'Workspace promotion not found.')
    }
    await lockExecutorMutation(tx, continuation.executorId)
    if (continuation.status !== 'pending') {
      throw new ExecutorError(EXECUTOR_ERROR_CODES.PROMOTION_STALE, 'Workspace promotion is no longer pending.')
    }
    if (continuation.expiresAt <= new Date()) {
      await tx.executorContinuation.update({
        where: { id: continuation.id },
        data: { status: 'expired' },
      })
      throw new ExecutorError(EXECUTOR_ERROR_CODES.ACCESS_CHANGE_EXPIRED, 'Workspace promotion has expired.')
    }
    if (!input.freshVerificationSatisfied || !continuation.verificationChallengeId) {
      throw new ExecutorError(
        EXECUTOR_ERROR_CODES.FRESH_VERIFICATION_REQUIRED,
        'Fresh verification is required to promote a workspace draft.',
      )
    }
    const promotion = parseStoredPromotion(continuation.revisions)
    if (
      !promotion
      || !executorContinuationValuesMatch(
        subjectDigest(continuation.actorUserId, continuation.executorId, promotion),
        continuation.subjectDigest,
      )
    ) {
      throw new ExecutorError(EXECUTOR_ERROR_CODES.PROMOTION_STALE, 'Workspace promotion is invalid.')
    }
    const [executor, review] = await Promise.all([
      tx.executor.findFirst({
        where: { id: continuation.executorId, organizationId: actorContext.tenant.organizationId },
        select: { authorizationRevision: true, id: true },
      }),
      tx.executorCommand.findUnique({
        where: { id: promotion.reviewCommandId },
        select: {
          resultDigest: true,
          state: true,
          binding: {
            select: {
              executorId: true,
              operationKey: true,
              runId: true,
              run: {
                select: {
                  agentId: true,
                  triggerMessage: { select: { userId: true } },
                  thread: { select: { channel: { select: { organizationId: true } } } },
                },
              },
            },
          },
        },
      }),
    ])
    if (
      !executor
      || executor.authorizationRevision !== promotion.authorizationRevision
      || !review
      || review.state !== 'result_acknowledged'
      || review.resultDigest !== promotion.reviewResultDigest
      || review.binding.executorId !== executor.id
      || review.binding.operationKey !== 'workspace.review'
      || review.binding.runId !== promotion.runId
      || review.binding.run.agentId !== promotion.agentId
      || review.binding.run.triggerMessage?.userId !== actorUserId
      || review.binding.run.thread.channel.organizationId !== actorContext.tenant.organizationId
    ) {
      throw new ExecutorError(
        EXECUTOR_ERROR_CODES.PROMOTION_STALE,
        'The reviewed workspace draft or executor authorization changed; prepare it again.',
      )
    }
    const binding = await bindExecutorCandidateInTransaction(tx, {
      actorUserId,
      candidateHandle: input.candidateHandle,
      operationKey: 'workspace.promote',
      runId: promotion.runId,
    })
    const commandId = randomUUID()
    const approvalDigest = executorContinuationSubjectDigest({
      actorUserId,
      bindingFence: binding.fence,
      executorId: executor.id,
      manifestDigest: promotion.manifestDigest,
      promotionId: continuation.id,
      reviewCommandId: promotion.reviewCommandId,
      runId: promotion.runId,
    })
    const startedAt = new Date()
    const queueJob = await tx.queueJob.create({
      data: {
        idempotencyKey: `executor-promotion:${continuation.id}`,
        payload: { commandId },
        status: 'pending',
        topic: 'executor.command',
      },
      select: { id: true },
    })
    const toolCall = await tx.toolCall.create({
      data: {
        agentId: promotion.agentId,
        executorBindingId: binding.bindingId,
        inputSummary: `Promote reviewed workspace draft (${promotion.changeCount} changes).`,
        runId: promotion.runId,
        startedAt,
        toolName: 'executor.workspace.promote',
      },
      select: { id: true },
    })
    await createExecutorCommand(tx, {
      bindingId: binding.bindingId,
      commandId,
      encryptionSecret: input.encryptionSecret,
      expiresAt: new Date(startedAt.getTime() + PROMOTION_COMMAND_TTL_MS),
      payload: {
        args: {
          approvalDigest,
          manifestDigest: promotion.manifestDigest,
          promotionId: continuation.id,
        },
        runId: promotion.runId,
      },
      queueJobId: queueJob.id,
      toolCallId: toolCall.id,
    })
    await tx.executorContinuation.update({
      where: { id: continuation.id },
      data: { bindingId: binding.bindingId, consumedAt: startedAt, status: 'consumed' },
    })
    return {
      commandId,
      executorId: executor.id,
      promotionId: continuation.id,
      runId: promotion.runId,
    }
  })
}

export const rejectExecutorWorkspacePromotion = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  input: { confirmationToken: string; promotionId: string },
): Promise<{ executorId: string; promotionId: string }> => {
  const actorUserId = requireHumanActor(actorContext)
  if (!actorUserId) {
    throw new ExecutorError(
      EXECUTOR_ERROR_CODES.SCOPE_ENTITLEMENT_DENIED,
      'Workspace promotion requires a human requester.',
    )
  }
  return prisma.$transaction(async (tx) => {
    const continuation = await tx.executorContinuation.findUnique({
      where: { id: input.promotionId },
      select: {
        actorUserId: true,
        confirmationTokenHash: true,
        executorId: true,
        id: true,
        status: true,
        subject: true,
      },
    })
    if (
      !continuation
      || continuation.subject !== 'invocation'
      || continuation.actorUserId !== actorUserId
      || !executorContinuationValuesMatch(
        hashExecutorContinuationValue(input.confirmationToken),
        continuation.confirmationTokenHash,
      )
    ) {
      throw new ExecutorError(EXECUTOR_ERROR_CODES.PROMOTION_NOT_FOUND, 'Workspace promotion not found.')
    }
    if (continuation.status !== 'pending') {
      throw new ExecutorError(EXECUTOR_ERROR_CODES.PROMOTION_STALE, 'Workspace promotion is no longer pending.')
    }
    await tx.executorContinuation.update({
      where: { id: continuation.id },
      data: { consumedAt: new Date(), status: 'rejected' },
    })
    return { executorId: continuation.executorId, promotionId: continuation.id }
  })
}
