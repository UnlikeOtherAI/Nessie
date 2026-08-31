import { Prisma, type PrismaClient } from '@prisma/client'
import {
  ExecutorCapabilityDescriptorSchema,
  ExecutorCandidateHandleSchema,
  ImplementedExecutorOperationKeySchema,
  type ImplementedExecutorOperationKey,
} from '@nessie/schemas'

import { resolveExecutorAvailability } from './availability.js'
import { executorCandidateHandleDigest } from './executor-candidate-handle.js'
import { EXECUTOR_ERROR_CODES, ExecutorError } from './executor-errors.js'
import { ensureExecutorLogicalTools } from './executor-logical-tools.js'
import { resolveExecutorScopeFacts } from './executor-scope-facts.js'

export type ExecutorBindingInput = {
  actorUserId: string
  candidateHandle: string
  operationKey: ImplementedExecutorOperationKey
  runId: string
}

export type ExecutorBindingBundleInput = Omit<ExecutorBindingInput, 'operationKey'> & {
  operationKeys: ImplementedExecutorOperationKey[]
}

export type ExecutorBindingRecord = {
  bindingId: string
  capabilityRevision: number
  executorId: string
  fence: string
  operationKey: ImplementedExecutorOperationKey
  runId: string
}

const BROWSER_RUN_OPERATION_KEYS = ['browser.open', 'browser.observe'] as const
const CODING_RUN_OPERATION_KEYS = ['coding.launch', 'coding.observe'] as const
const CODING_RUN_BUNDLE = ['coding.launch', 'coding.observe', 'workspace.review', 'sandbox.stop'] as const

const isBrowserRunOperation = (operationKey: ImplementedExecutorOperationKey): boolean =>
  BROWSER_RUN_OPERATION_KEYS.includes(operationKey as typeof BROWSER_RUN_OPERATION_KEYS[number])

const isCodingRunOperation = (operationKey: ImplementedExecutorOperationKey): boolean =>
  CODING_RUN_OPERATION_KEYS.includes(operationKey as typeof CODING_RUN_OPERATION_KEYS[number])

const isIsolatedRunOperation = (operationKey: ImplementedExecutorOperationKey): boolean =>
  isBrowserRunOperation(operationKey) || isCodingRunOperation(operationKey)

const lockBinding = async (
  tx: Prisma.TransactionClient,
  runId: string,
  operationKey: ImplementedExecutorOperationKey,
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

const lockRunBindings = async (
  tx: Prisma.TransactionClient,
  runId: string,
): Promise<void> => {
  await tx.$executeRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${`executor-binding-run:${runId}`}, 0))
  `)
}

const assertRunHasNoIsolatedBinding = async (
  tx: Prisma.TransactionClient,
  runId: string,
): Promise<void> => {
  const existing = await tx.executorBinding.findFirst({
    where: { runId, operationKey: { in: [...BROWSER_RUN_OPERATION_KEYS, ...CODING_RUN_OPERATION_KEYS] } },
    select: { id: true },
  })
  if (existing) {
    candidateError(
      'CANDIDATE_INVALID',
      'An isolated browser or coding run cannot receive additional executor bindings.',
    )
  }
}

const assertRunHasNoExecutorBinding = async (
  tx: Prisma.TransactionClient,
  runId: string,
): Promise<void> => {
  const existing = await tx.executorBinding.findFirst({
    where: { runId },
    select: { id: true },
  })
  if (existing) {
    candidateError(
      'CANDIDATE_INVALID',
      'An isolated browser or coding run cannot share its copy-on-write workspace with another executor binding.',
    )
  }
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
export const bindExecutorCandidateInTransaction = async (
  tx: Prisma.TransactionClient,
  input: ExecutorBindingInput,
  now = new Date(),
  consumeCandidate = true,
  allowIsolatedBundle = false,
): Promise<ExecutorBindingRecord> => {
  const candidateHandle = ExecutorCandidateHandleSchema.parse(input.candidateHandle)
  const operationKey = ImplementedExecutorOperationKeySchema.parse(input.operationKey)
  if (isIsolatedRunOperation(operationKey) && !allowIsolatedBundle) {
    return candidateError(
      'CANDIDATE_INVALID',
      'Browser and coding operations must be bound through their exact isolated run bundles.',
    )
  }
  const candidateHandleDigest = executorCandidateHandleDigest(candidateHandle)

  await lockRunBindings(tx, input.runId)
  if (!allowIsolatedBundle) await assertRunHasNoIsolatedBinding(tx, input.runId)
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

  if (consumeCandidate) {
    const consumed = await tx.executorAvailabilityCandidate.updateMany({
      where: { consumedAt: null, handleDigest: candidateHandleDigest },
      data: { consumedAt: now },
    })
    if (consumed.count !== 1) {
      return candidateError('CANDIDATE_INVALID', 'The executor choice has already been used.')
    }
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
}

export const bindExecutorCandidate = async (
  prisma: PrismaClient,
  input: ExecutorBindingInput,
  now = new Date(),
): Promise<ExecutorBindingRecord> =>
  prisma.$transaction((tx) => bindExecutorCandidateInTransaction(tx, input, now))

/**
 * Consume one opaque availability choice for a small, exact operation bundle.
 * The candidate is marked consumed only after every binding has revalidated;
 * a failure rolls the whole transaction back, so no partial toolset can reach
 * a run. The same candidate lock prevents two bundle launches from racing its
 * one-use provenance.
 */
export const bindExecutorCandidateBundleInTransaction = async (
  tx: Prisma.TransactionClient,
  input: ExecutorBindingBundleInput,
  now = new Date(),
): Promise<ExecutorBindingRecord[]> => {
  const candidateHandle = ExecutorCandidateHandleSchema.parse(input.candidateHandle)
  const operationKeys = [...new Set(input.operationKeys.map((key) => ImplementedExecutorOperationKeySchema.parse(key)))]
  if (operationKeys.length === 0 || operationKeys.length > 4 || operationKeys.length !== input.operationKeys.length) {
    return candidateError('CANDIDATE_INVALID', 'The executor operation bundle is invalid.')
  }
  const browserRequested = operationKeys.some(isBrowserRunOperation)
  const codingRequested = operationKeys.some(isCodingRunOperation)
  if (browserRequested && codingRequested) {
    return candidateError('CANDIDATE_INVALID', 'Browser and coding operations cannot share one executor run.')
  }
  if (browserRequested && (
    operationKeys.length !== 3
    || !operationKeys.includes('browser.open')
    || !operationKeys.includes('browser.observe')
    || !operationKeys.includes('sandbox.stop')
  )) {
    return candidateError(
      'CANDIDATE_INVALID',
      'Browser operations require their exact non-extensible run bundle.',
    )
  }
  if (codingRequested && (
    operationKeys.length !== CODING_RUN_BUNDLE.length
    || CODING_RUN_BUNDLE.some((operationKey) => !operationKeys.includes(operationKey))
  )) {
    return candidateError(
      'CANDIDATE_INVALID',
      'Coding operations require their exact non-extensible run bundle.',
    )
  }
  const candidateHandleDigest = executorCandidateHandleDigest(candidateHandle)
  await lockRunBindings(tx, input.runId)
  if (browserRequested || codingRequested) {
    await assertRunHasNoExecutorBinding(tx, input.runId)
  } else {
    await assertRunHasNoIsolatedBinding(tx, input.runId)
  }
  await tx.$executeRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`executor-binding-bundle:${input.runId}:${candidateHandleDigest}`}, 0)
    )
  `)
  const bindings: ExecutorBindingRecord[] = []
  for (const operationKey of operationKeys) {
    bindings.push(await bindExecutorCandidateInTransaction(
      tx,
      { ...input, candidateHandle, operationKey },
      now,
      false,
      browserRequested || codingRequested,
    ))
  }
  const consumed = await tx.executorAvailabilityCandidate.updateMany({
    where: { consumedAt: null, handleDigest: candidateHandleDigest },
    data: { consumedAt: now },
  })
  if (consumed.count !== 1) {
    return candidateError('CANDIDATE_INVALID', 'The executor choice has already been used.')
  }
  return bindings
}
