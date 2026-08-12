import { Prisma, type PrismaClient } from '@prisma/client'
import {
  ExecutorCapabilityDescriptorSchema,
  ExecutorCandidateHandleSchema,
  ExecutorOperationKeySchema,
  type ExecutorOperationKey,
} from '@nessie/schemas'

import { resolveExecutorAvailability } from './availability.js'
import { executorCandidateHandleDigest } from './executor-candidate-handle.js'
import { EXECUTOR_ERROR_CODES, ExecutorError } from './executor-errors.js'
import { ensureExecutorLogicalTools } from './executor-logical-tools.js'
import { resolveExecutorScopeFacts } from './executor-scope-facts.js'

export type ExecutorBindingInput = {
  actorUserId: string
  candidateHandle: string
  operationKey: ExecutorOperationKey
  runId: string
}

export type ExecutorBindingRecord = {
  bindingId: string
  capabilityRevision: number
  executorId: string
  fence: string
  operationKey: ExecutorOperationKey
  runId: string
}

const lockBinding = async (
  tx: Prisma.TransactionClient,
  runId: string,
  operationKey: ExecutorOperationKey,
): Promise<void> => {
  await tx.$executeRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`executor-binding:${runId}:${operationKey}`}, 0)
    )
  `)
}

const lockExecutor = async (
  tx: Prisma.TransactionClient,
  executorId: string,
): Promise<void> => {
  await tx.$executeRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${`executor:${executorId}`}, 0))
  `)
}

const booleanRecord = (value: unknown): Record<string, boolean> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(
        Object.entries(value as Record<string, unknown>).filter(
          (entry): entry is [string, boolean] => typeof entry[1] === 'boolean',
        ),
      )
    : {}

const candidateError = (code: 'CANDIDATE_EXPIRED' | 'CANDIDATE_INVALID', message: string): never => {
  throw new ExecutorError(EXECUTOR_ERROR_CODES[code], message)
}

/**
 * Consume a server-issued availability choice and pin it to one run operation.
 *
 * The candidate is intentionally the only selection input. Every mutable
 * authorization fact is re-read while the run/operation and executor locks are
 * held, then the executor's separate binding fence advances atomically.
 */
export const bindExecutorCandidate = async (
  prisma: PrismaClient,
  input: ExecutorBindingInput,
  now = new Date(),
): Promise<ExecutorBindingRecord> => {
  const candidateHandle = ExecutorCandidateHandleSchema.parse(input.candidateHandle)
  const operationKey = ExecutorOperationKeySchema.parse(input.operationKey)
  const candidateHandleDigest = executorCandidateHandleDigest(candidateHandle)

  return prisma.$transaction(async (tx) => {
    await lockBinding(tx, input.runId, operationKey)
    const existing = await tx.executorBinding.findUnique({
      where: { runId_operationKey: { operationKey, runId: input.runId } },
      include: { capabilityRevision: { select: { revision: true } } },
    })
    if (existing) {
      if (existing.candidateHandleDigest !== candidateHandleDigest) {
        throw new ExecutorError(
          EXECUTOR_ERROR_CODES.BINDING_CONFLICT,
          'This run operation is already bound to a different executor choice.',
        )
      }
      return {
        bindingId: existing.id,
        capabilityRevision: existing.capabilityRevision.revision,
        executorId: existing.executorId,
        fence: existing.fence.toString(),
        operationKey,
        runId: input.runId,
      }
    }

    const candidate = await tx.executorAvailabilityCandidate.findUnique({
      where: { handleDigest: candidateHandleDigest },
      include: {
        capabilityRevision: true,
        executor: {
          include: {
            capabilityRevisions: { orderBy: { revision: 'desc' }, take: 1 },
            operationGrants: { where: { operationKey }, select: { state: true } },
            privateAssignments: {
              select: { agentId: true, principalKind: true, role: true, userId: true },
            },
          },
        },
      },
    })
    if (!candidate) {
      return candidateError('CANDIDATE_INVALID', 'The executor choice is invalid.')
    }
    if (candidate.consumedAt || candidate.expiresAt <= now) {
      return candidateError('CANDIDATE_EXPIRED', 'The executor choice has expired.')
    }
    if (
      candidate.actorUserId !== input.actorUserId
      || (candidate.runId !== null && candidate.runId !== input.runId)
      || !candidate.operationKeys.includes(operationKey)
    ) {
      return candidateError('CANDIDATE_INVALID', 'The executor choice does not match this run operation.')
    }

    await lockExecutor(tx, candidate.executorId)
    // The executor lock makes all below reads coherent with management changes,
    // descriptor review, daemon fencing, and other bindings for this machine.
    const [executor, capabilityRevision, run, membership, logicalTools] = await Promise.all([
      tx.executor.findUnique({
        where: { id: candidate.executorId },
        include: {
          capabilityRevisions: { orderBy: { revision: 'desc' }, take: 1 },
          operationGrants: {
            where: { agentId: candidate.agentId, operationKey },
            select: { state: true },
          },
          privateAssignments: {
            select: { agentId: true, principalKind: true, role: true, userId: true },
          },
        },
      }),
      tx.executorCapabilityRevision.findUnique({
        where: { id: candidate.capabilityRevisionId },
        select: { descriptor: true, id: true, reviewStatus: true },
      }),
      tx.run.findUnique({
        where: { id: input.runId },
        select: {
          agentId: true,
          triggerMessage: { select: { userId: true } },
          thread: { select: { channel: { select: { organizationId: true, projectId: true } } } },
        },
      }),
      tx.organizationMember.findUnique({
        where: {
          organizationId_userId: {
            organizationId: candidate.executor.organizationId,
            userId: candidate.actorUserId,
          },
        },
        select: { deactivatedAt: true },
      }),
      ensureExecutorLogicalTools(tx, candidate.executor.organizationId),
    ])
    if (
      !run
      || run.agentId !== candidate.agentId
      || run.triggerMessage?.userId !== input.actorUserId
      || run.thread.channel.organizationId !== candidate.executor.organizationId
      || !membership
      || membership.deactivatedAt
      || !executor
      || !capabilityRevision
    ) {
      return candidateError('CANDIDATE_INVALID', 'The executor choice is no longer valid for this run.')
    }

    const projectId = run.thread.channel.projectId
    const projectMembership = projectId
      ? await tx.projectMember.findFirst({
          where: {
            projectId,
            project: { organizationId: candidate.executor.organizationId },
            userId: candidate.actorUserId,
          },
          select: { id: true },
        })
      : null
    const agent = await tx.agent.findFirst({
      where: { id: candidate.agentId, organizationId: candidate.executor.organizationId },
      select: { toolPolicy: true },
    })
    const latest = executor.capabilityRevisions[0]
    const descriptor = ExecutorCapabilityDescriptorSchema.safeParse(capabilityRevision.descriptor)
    const decision = resolveExecutorAvailability({
      descriptorApproved:
        capabilityRevision.reviewStatus === 'active'
        && capabilityRevision.id === latest?.id
        && descriptor.success,
      executorStatus: executor.status,
      localPolicyAllows: Boolean(descriptor.success && descriptor.data.operationKeys.includes(operationKey)),
      logicalToolAllowed: Boolean(
        agent && booleanRecord(agent.toolPolicy)[logicalTools.get(operationKey) ?? ''] === true,
      ),
      operationGrantState: executor.operationGrants[0]?.state ?? null,
      scope: resolveExecutorScopeFacts(
        executor,
        candidate.actorUserId,
        candidate.agentId,
        { projectId, projectMember: Boolean(projectMembership) },
      ),
    })
    if (
      executor.authorizationRevision !== candidate.authorizationRevision
      || !decision.available
    ) {
      return candidateError('CANDIDATE_INVALID', 'The executor choice is no longer authorized.')
    }

    const consumed = await tx.executorAvailabilityCandidate.updateMany({
      where: { consumedAt: null, handleDigest: candidateHandleDigest },
      data: { consumedAt: now },
    })
    if (consumed.count !== 1) {
      return candidateError('CANDIDATE_INVALID', 'The executor choice has already been used.')
    }
    const fencedExecutor = await tx.executor.update({
      where: { id: candidate.executorId },
      data: { nextBindingFence: { increment: 1 } },
      select: { nextBindingFence: true },
    })
    const binding = await tx.executorBinding.create({
      data: {
        authorizationRevision: candidate.authorizationRevision,
        candidateHandleDigest,
        capabilityRevisionId: candidate.capabilityRevisionId,
        executorId: candidate.executorId,
        fence: fencedExecutor.nextBindingFence,
        operationKey,
        runId: input.runId,
      },
      include: { capabilityRevision: { select: { revision: true } } },
    })
    return {
      bindingId: binding.id,
      capabilityRevision: binding.capabilityRevision.revision,
      executorId: binding.executorId,
      fence: binding.fence.toString(),
      operationKey,
      runId: input.runId,
    }
  })
}
