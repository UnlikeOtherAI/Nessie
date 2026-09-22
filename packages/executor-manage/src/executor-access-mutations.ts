import { Prisma, type PrismaClient } from '@prisma/client'
import {
  ExecutorCapabilityDescriptorSchema,
  ImplementedExecutorOperationKeySchema,
  executorWholeSuiteOperationKeys,
  type AuthorizedActionContext,
  type ImplementedExecutorOperationKey,
} from '@nessie/schemas'

import {
  canManageExecutor,
  requireHumanActor,
  resolveExecutorHumanAccess,
} from './executor-access.js'
import {
  EXECUTOR_LOCAL_APPS_OPERATION_KEYS,
  endExecutorConversationLeasesInTransaction,
  executorLeaseAuditActor,
} from './executor-conversation-lease.js'
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

/** Withdrawn or narrowed access ends the leases it covered, with the fence. */
const endLeasesForRevokedAccess = async (
  tx: Prisma.TransactionClient,
  actorContext: AuthorizedActionContext,
  where: { executorId: string; agentId?: string; actorUserId?: string },
): Promise<void> => {
  await endExecutorConversationLeasesInTransaction(tx, {
    actor: executorLeaseAuditActor(actorContext),
    endedByUserId: requireHumanActor(actorContext),
    reason: 'access_revoked',
    where,
  })
}

/**
 * The agent assignment a private executor requires before anything may be
 * granted on it. Shared by the per-operation grant and the whole-suite one so
 * the narrower scope cannot be reached through the wider door.
 */
const assertPrivateExecutorAgentAssignment = async (
  tx: Prisma.TransactionClient,
  executor: ManagedExecutor,
  agentId: string,
): Promise<void> => {
  const agentAssignment = await tx.executorPrivateAssignment.findFirst({
    where: {
      executorId: executor.id,
      principalKind: 'agent',
      agentId,
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
  // Removing a person or an agent from the roster ends the leases it held.
  await endLeasesForRevokedAccess(tx, actorContext, existing.principalKind === 'agent'
    ? { executorId: executor.id, agentId: existing.agentId ?? undefined }
    : { executorId: executor.id, actorUserId: existing.userId ?? undefined })
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
  operationKey: ImplementedExecutorOperationKey
  state: 'allowed' | 'denied'
}

export const setExecutorAgentOperationGrantInTransaction = async (
  tx: Prisma.TransactionClient,
  actorContext: AuthorizedActionContext,
  input: AgentOperationGrantMutation,
): Promise<number> => {
  const executor = await requireManagedExecutor(tx, actorContext, input.executorId)
  const operationKey = ImplementedExecutorOperationKeySchema.safeParse(input.operationKey)
  if (!operationKey.success) {
    throw new ExecutorError(
      EXECUTOR_ERROR_CODES.SCOPE_INVALID,
      'Only implemented executor operations can be granted.',
    )
  }
  const actorUserId = requireHumanActor(actorContext)
  if (!actorUserId) {
    throw new ExecutorError(EXECUTOR_ERROR_CODES.SCOPE_ENTITLEMENT_DENIED, 'Human access required.')
  }
  if (executor.scopeKind === 'private' && input.state === 'allowed') {
    await assertPrivateExecutorAgentAssignment(tx, executor, input.agentId)
  }
  const authorizationRevision = await nextAuthorizationRevision(tx, executor.id)
  await tx.executorAgentOperationGrant.upsert({
    where: {
      executorId_agentId_operationKey: {
        executorId: executor.id,
        agentId: input.agentId,
        operationKey: operationKey.data,
      },
    },
    create: {
      executorId: executor.id,
      agentId: input.agentId,
      operationKey: operationKey.data,
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
  if (
    input.state === 'denied'
    && (EXECUTOR_LOCAL_APPS_OPERATION_KEYS as readonly string[]).includes(operationKey.data)
  ) {
    await endLeasesForRevokedAccess(tx, actorContext, { executorId: executor.id, agentId: input.agentId })
  }
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

/**
 * The executor's live policy, defined exactly as enforcement defines it: the
 * LATEST revision, and only when that revision is `active`.
 *
 * Not "the highest-numbered active revision". Reviewing a revision never
 * demotes the one before it, so superseded `active` rows persist — and a query
 * that merely filters on `reviewStatus` happily returns one of them when the
 * latest revision is pending review or disabled. `executor-binding.ts` and
 * `executor-commands.ts` both require `revision.id === latest.id AND
 * reviewStatus === 'active'`, so anything looser grants against a policy the
 * daemon will not honour and, worse, reports a superseded policy as live to
 * the person authorising it.
 *
 * One definition, used by every new reader. A second answer to "which policy
 * is in force" is how the two drift apart.
 */
export const latestActiveCapabilityRevision = async (
  tx: Prisma.TransactionClient,
  executorId: string,
): Promise<{ descriptor: unknown; revision: number } | null> => {
  const latest = await tx.executorCapabilityRevision.findFirst({
    where: { executorId },
    orderBy: { revision: 'desc' },
    select: { descriptor: true, reviewStatus: true, revision: true },
  })
  if (!latest || latest.reviewStatus !== 'active') return null
  return { descriptor: latest.descriptor, revision: latest.revision }
}

/**
 * The operation keys the executor's live capability revision offers an agent:
 * what a person reviewed, kept to the implemented catalog and minus
 * `workspace.promote`.
 *
 * Read inside the applying transaction rather than captured when the change
 * was prepared. The stored change names no key at all, so a revision reviewed
 * in between decides the set — and the executor's `authorizationRevision`
 * fence already refuses a change prepared before that review.
 */
export const resolveExecutorWholeSuiteOperationKeys = async (
  tx: Prisma.TransactionClient,
  executorId: string,
): Promise<ImplementedExecutorOperationKey[]> => {
  const active = await latestActiveCapabilityRevision(tx, executorId)
  if (!active) return []
  const descriptor = ExecutorCapabilityDescriptorSchema.safeParse(active.descriptor)
  if (!descriptor.success) return []
  return executorWholeSuiteOperationKeys(descriptor.data.operationKeys)
}

/**
 * Every operation key this agent already holds a grant row for on this
 * executor, whatever its state.
 *
 * This is the revoke set, and it is deliberately NOT the live policy's set.
 * Rows outlive the revision that created them, so a revoke driven by the
 * current policy would leave a narrowed-away key sitting at `allowed`, ready
 * to take effect again the day a later revision re-adds it.
 */
export const executorGrantedOperationKeys = async (
  tx: Prisma.TransactionClient,
  executorId: string,
  agentId: string,
): Promise<ImplementedExecutorOperationKey[]> => {
  const rows = await tx.executorAgentOperationGrant.findMany({
    where: { executorId, agentId },
    select: { operationKey: true },
  })
  return rows
    .map((row) => ImplementedExecutorOperationKeySchema.safeParse(row.operationKey))
    .flatMap((parsed) => (parsed.success ? [parsed.data] : []))
}

/**
 * The operation keys this agent still holds on some OTHER executor.
 *
 * The logical executor tool policy is organisation-wide by design — one
 * `executor.<operation>` registry entry per organisation, never a per-machine
 * projection (`executor-logical-tools.ts`), because the machine is chosen
 * later by the availability authority. The per-machine half of the decision is
 * the grant row.
 *
 * That means revoking on one executor must not switch the shared policy entry
 * off: the agent's grants on every other machine are still live, and the
 * binding gate reads the policy entry with no executor dimension, so it would
 * refuse them all. A revoke is consent withdrawn for ONE machine.
 *
 * `excludeExecutorId` is load-bearing: the confirm route writes the policy half
 * before the grant rows are cleared, so the executor being revoked is still
 * holding `allowed` rows at the moment this is asked.
 */
export const executorOperationKeysHeldElsewhere = async (
  prisma: ExecutorMutationClient,
  input: { agentId: string; excludeExecutorId: string; organizationId: string },
): Promise<Set<ImplementedExecutorOperationKey>> => {
  const rows = await prisma.executorAgentOperationGrant.findMany({
    where: {
      agentId: input.agentId,
      executorId: { not: input.excludeExecutorId },
      state: 'allowed',
      executor: { organizationId: input.organizationId },
    },
    select: { operationKey: true },
  })
  const held = new Set<ImplementedExecutorOperationKey>()
  for (const row of rows) {
    const parsed = ImplementedExecutorOperationKeySchema.safeParse(row.operationKey)
    if (parsed.success) held.add(parsed.data)
  }
  return held
}

export type AgentExecutorGrantMutation = {
  agentId: string
  executorId: string
  state: 'allowed' | 'denied'
}

/**
 * One grant covering the whole suite this executor offers.
 *
 * The product rule is that access to an executor is access to everything on
 * it: an agent never holds a hand-picked subset, and a specialist agent never
 * issues one confirmation per operation key. So the set is derived and every
 * key is written under ONE authorization-revision bump.
 *
 * **Allow and deny are not symmetrical, deliberately.** Allowing writes the
 * live policy's keys. Denying clears EVERY grant row this agent holds on this
 * executor, not just the live policy's keys — a revision that narrowed since
 * the grant leaves rows for keys it no longer offers, and denying only the
 * current set would leave those sitting at `allowed`. They are dormant while
 * the narrow revision is live and re-arm the moment a later revision re-adds
 * the key, handing back file writes or command execution with no confirmation
 * and no fresh verification. A revoke has to mean revoked.
 *
 * That is also why the no-live-policy refusal applies to `allowed` only:
 * disabling an executor's only reviewed revision must never strand an existing
 * grant with no way to take it back.
 */
export const setExecutorAgentWholeSuiteGrantInTransaction = async (
  tx: Prisma.TransactionClient,
  actorContext: AuthorizedActionContext,
  input: AgentExecutorGrantMutation,
): Promise<number> => {
  const executor = await requireManagedExecutor(tx, actorContext, input.executorId)
  const actorUserId = requireHumanActor(actorContext)
  if (!actorUserId) {
    throw new ExecutorError(EXECUTOR_ERROR_CODES.SCOPE_ENTITLEMENT_DENIED, 'Human access required.')
  }
  if (executor.scopeKind === 'private' && input.state === 'allowed') {
    await assertPrivateExecutorAgentAssignment(tx, executor, input.agentId)
  }
  const operationKeys = input.state === 'allowed'
    ? await resolveExecutorWholeSuiteOperationKeys(tx, executor.id)
    : await executorGrantedOperationKeys(tx, executor.id, input.agentId)
  if (operationKeys.length === 0) {
    if (input.state === 'allowed') {
      throw new ExecutorError(
        EXECUTOR_ERROR_CODES.SCOPE_INVALID,
        'This executor has no active reviewed policy, so it offers no operations to grant.',
      )
    }
    throw new ExecutorError(
      EXECUTOR_ERROR_CODES.SCOPE_INVALID,
      'This agent holds no operation grant on this executor, so there is nothing to revoke.',
    )
  }
  const authorizationRevision = await nextAuthorizationRevision(tx, executor.id)
  for (const operationKey of operationKeys) {
    await tx.executorAgentOperationGrant.upsert({
      where: {
        executorId_agentId_operationKey: {
          executorId: executor.id,
          agentId: input.agentId,
          operationKey,
        },
      },
      create: {
        executorId: executor.id,
        agentId: input.agentId,
        operationKey,
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
  }
  if (input.state === 'denied') {
    await endLeasesForRevokedAccess(tx, actorContext, { executorId: executor.id, agentId: input.agentId })
  }
  return authorizationRevision
}

export const setExecutorAgentWholeSuiteGrant = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  input: AgentExecutorGrantMutation,
): Promise<number> => prisma.$transaction(async (tx) => {
  await lockExecutorMutation(tx, input.executorId)
  return setExecutorAgentWholeSuiteGrantInTransaction(tx, actorContext, input)
})
