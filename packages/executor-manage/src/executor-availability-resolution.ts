import { randomBytes } from 'node:crypto'

import type { PrismaClient } from '@prisma/client'
import {
  ExecutorCapabilityDescriptorSchema,
  ExecutorCandidateHandleSchema,
  type AuthorizedActionContext,
  type ExecutorAvailabilityResponse,
  type ImplementedExecutorOperationKey,
} from '@nessie/schemas'

import { requireHumanActor } from './executor-access.js'
import { executorCandidateHandleDigest } from './executor-candidate-handle.js'
import {
  resolveExecutorAvailability,
  type ExecutorAvailabilityDecision,
} from './availability.js'
import { EXECUTOR_ERROR_CODES, ExecutorError } from './executor-errors.js'
import { ensureExecutorLogicalTools } from './executor-logical-tools.js'
import { resolveExecutorScopeFacts } from './executor-scope-facts.js'

const CANDIDATE_TTL_MS = 5 * 60 * 1_000

type AvailabilityContext = {
  projectId: string | null
  projectMember: boolean
  runId: string | null
}

type AvailabilityRequest = {
  agentId: string
  /** Internal callers may pin a server-derived executor identity. Public API
   * contracts never accept this field, so browsers and models still receive
   * only opaque candidates. */
  executorId?: string
  operationKeys: ImplementedExecutorOperationKey[]
  projectId?: string
  runId?: string
}

const booleanRecord = (value: unknown): Record<string, boolean> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(
        Object.entries(value as Record<string, unknown>).filter(
          (entry): entry is [string, boolean] => typeof entry[1] === 'boolean',
        ),
      )
    : {}

const resolveContext = async (
  prisma: PrismaClient,
  actorUserId: string,
  organizationId: string,
  input: AvailabilityRequest,
): Promise<AvailabilityContext> => {
  if (input.runId) {
    const run = await prisma.run.findFirst({
      where: { id: input.runId, agentId: input.agentId },
      select: {
        id: true,
        triggerMessage: { select: { userId: true } },
        thread: { select: { channel: { select: { organizationId: true, projectId: true } } } },
      },
    })
    const projectId = run?.thread.channel.projectId ?? null
    if (!run || run.thread.channel.organizationId !== organizationId || run.triggerMessage?.userId !== actorUserId || (
      input.projectId !== undefined && input.projectId !== projectId
    )) {
      throw new ExecutorError(
        EXECUTOR_ERROR_CODES.SCOPE_ENTITLEMENT_DENIED,
        'The executor availability context is not owned by the requesting user.',
      )
    }
    const membership = projectId
      ? await prisma.projectMember.findFirst({
          where: { projectId, userId: actorUserId, project: { organizationId } },
          select: { id: true },
        })
      : null
    return { projectId, projectMember: Boolean(membership), runId: run.id }
  }

  const projectMember = input.projectId
    ? await prisma.projectMember.findFirst({
        where: {
          projectId: input.projectId,
          userId: actorUserId,
          project: { organizationId },
        },
        select: { id: true },
      })
    : null
  return {
    projectId: input.projectId ?? null,
    projectMember: Boolean(projectMember),
    runId: null,
  }
}

const explanation = (
  decision: ExecutorAvailabilityDecision,
): ExecutorAvailabilityResponse['explanations'][number] | null =>
  decision.available ? null : { readiness: 'unavailable', reason: decision.reason }

/**
 * Resolve and persist opaque candidates. The response contains no executor id
 * or label: a future run binding must consume its one-use handle and recheck
 * the recorded authorization and capability revision under the binding lock.
 */
export const resolveExecutorAvailabilityCandidates = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  input: AvailabilityRequest,
  now = new Date(),
): Promise<ExecutorAvailabilityResponse> => {
  const actorUserId = requireHumanActor(actorContext)
  if (!actorUserId) {
    throw new ExecutorError(
      EXECUTOR_ERROR_CODES.SCOPE_ENTITLEMENT_DENIED,
      'Executor availability requires a human requester.',
    )
  }
  const organizationId = actorContext.tenant.organizationId
  const [membership, agent] = await Promise.all([
    prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId: actorUserId } },
      select: { deactivatedAt: true },
    }),
    prisma.agent.findFirst({
      where: { id: input.agentId, organizationId },
      select: { id: true, toolPolicy: true },
    }),
  ])
  if (!membership || membership.deactivatedAt || !agent) {
    throw new ExecutorError(
      EXECUTOR_ERROR_CODES.SCOPE_ENTITLEMENT_DENIED,
      'The requested executor availability target is not available.',
    )
  }

  const [context, logicalTools] = await Promise.all([
    resolveContext(prisma, actorUserId, organizationId, input),
    ensureExecutorLogicalTools(prisma, organizationId),
  ])
  const executors = await prisma.executor.findMany({
    where: {
      organizationId,
      ...(input.executorId ? { id: input.executorId } : {}),
      OR: [
        { scopeKind: 'organization' },
        ...(context.projectId ? [{ projectId: context.projectId, scopeKind: 'project' as const }] : []),
        {
          privateAssignments: {
            some: { principalKind: 'user', userId: actorUserId },
          },
          scopeKind: 'private',
        },
      ],
    },
    include: {
      capabilityRevisions: {
        orderBy: { revision: 'desc' },
        take: 1,
      },
      operationGrants: {
        where: { agentId: agent.id, operationKey: { in: input.operationKeys } },
        select: { operationKey: true, state: true },
      },
      privateAssignments: {
        where: {
          OR: [
            { principalKind: 'user', userId: actorUserId },
            { agentId: agent.id, principalKind: 'agent' },
          ],
        },
        select: { agentId: true, principalKind: true, role: true, userId: true },
      },
    },
  })
  const policy = booleanRecord(agent.toolPolicy)
  const explanations = new Map<string, ExecutorAvailabilityResponse['explanations'][number]>()
  const prepared: Array<{
    authorizationRevision: number
    capabilityRevisionId: string
    executorId: string
    operationKeys: ImplementedExecutorOperationKey[]
    scopeKind: 'private' | 'project' | 'organization'
  }> = []

  for (const executor of executors) {
    const latest = executor.capabilityRevisions[0]
    const descriptor = latest
      ? ExecutorCapabilityDescriptorSchema.safeParse(latest.descriptor)
      : null
    const grants = new Map(executor.operationGrants.map((grant) => [
      grant.operationKey,
      grant.state,
    ]))
    const readyKeys: ImplementedExecutorOperationKey[] = []
    for (const operationKey of input.operationKeys) {
      const decision = resolveExecutorAvailability({
        descriptorApproved: latest?.reviewStatus === 'active' && Boolean(descriptor?.success),
        executorStatus: executor.status,
        localPolicyAllows: Boolean(descriptor?.success
          && descriptor.data.operationKeys.includes(operationKey)),
        logicalToolAllowed: policy[logicalTools.get(operationKey) ?? ''] === true,
        operationGrantState: grants.get(operationKey) ?? null,
        scope: resolveExecutorScopeFacts(executor, actorUserId, agent.id, context),
      })
      if (decision.available) {
        readyKeys.push(operationKey)
      } else {
        const unavailable = explanation(decision)
        if (unavailable) explanations.set(unavailable.reason, unavailable)
      }
    }
    if (latest && readyKeys.length > 0) {
      prepared.push({
        authorizationRevision: executor.authorizationRevision,
        capabilityRevisionId: latest.id,
        executorId: executor.id,
        operationKeys: readyKeys,
        scopeKind: executor.scopeKind,
      })
    }
  }

  const expiresAt = new Date(now.getTime() + CANDIDATE_TTL_MS)
  await prisma.executorAvailabilityCandidate.deleteMany({
    where: {
      actorUserId,
      agentId: agent.id,
      // A consumed choice is the durable provenance for an ExecutorBinding.
      // Do not sweep it while an existing run can still dispatch against that
      // binding; expiry only makes an *unconsumed* choice unusable.
      consumedAt: null,
      expiresAt: { lte: now },
    },
  })
  const candidates = await Promise.all(prepared.map(async (entry) => {
    const handle = ExecutorCandidateHandleSchema.parse(randomBytes(32).toString('base64url'))
    await prisma.executorAvailabilityCandidate.create({
      data: {
        actorUserId,
        agentId: agent.id,
        authorizationRevision: entry.authorizationRevision,
        capabilityRevisionId: entry.capabilityRevisionId,
        executorId: entry.executorId,
        expiresAt,
        handleDigest: executorCandidateHandleDigest(handle),
        operationKeys: entry.operationKeys,
        projectId: context.projectId,
        runId: context.runId,
      },
    })
    return {
      expiresAt: expiresAt.toISOString(),
      handle,
      operationKeys: entry.operationKeys,
      readiness: 'ready' as const,
      scopeKind: entry.scopeKind,
    }
  }))
  return { candidates, explanations: [...explanations.values()] }
}
