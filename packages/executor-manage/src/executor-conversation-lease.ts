import { Prisma, type PrismaClient } from '@prisma/client'
import { writeAuditEntryInTransaction } from '@nessie/db'
import type { AuthorizedActionContext, ImplementedExecutorOperationKey } from '@nessie/schemas'

import { canManageExecutor, requireHumanActor, resolveExecutorHumanAccess } from './executor-access.js'
import { EXECUTOR_ERROR_CODES, ExecutorError } from './executor-errors.js'

/**
 * The conversation lease: a person's own follow-ups in the conversation they
 * launched local apps in keep that executor's local-apps pair, and nobody's
 * and nothing else's do (docs/plans/2026-09-22-executor-local-apps/
 * conversation-lease.md). This module owns the row's lifecycle — creation in
 * the launch transaction, every way it ends, and its expiry. Who may carry it
 * into a later run is `executor-lease-carry.ts`.
 *
 * Every transition takes the executor's advisory lock, the same one binding,
 * dispatch and every management change take, so "is this lease live?" is
 * answered coherently with the transition that ends it.
 */

/** The only bundle that ever carries across runs (full-actuation §7). */
export const EXECUTOR_LOCAL_APPS_OPERATION_KEYS = ['mcp.tools', 'mcp.call'] as const satisfies
  readonly ImplementedExecutorOperationKey[]
export const EXECUTOR_LEASE_IDLE_MS = 2 * 60 * 60 * 1_000
export const EXECUTOR_LEASE_ABSOLUTE_MS = 12 * 60 * 60 * 1_000

/** Mirrors the `executor_conversation_leases_ended_reason_known` CHECK. */
export type ExecutorLeaseEndReason =
  | 'person'
  | 'access_revoked'
  | 'executor_paused'
  | 'executor_drained'
  | 'executor_revoked'
  | 'descriptor_narrowed'
  | 'expired'
  | 'replaced'

/** Who a lease transition is recorded as in the audit chain. */
export type ExecutorLeaseAuditActor = {
  actorId: string
  actorType: 'user' | 'agent' | 'service' | 'system'
  requestId: string
}

/**
 * Whose lease it is and where: everything a change notice to its holder is
 * addressed by (`publishExecutorLeaseChanges`), and nothing about the machine.
 */
export type ExecutorLeaseRef = { actorUserId: string; id: string; organizationId: string; threadId: string }

export const EXECUTOR_LEASE_REF_SELECT = {
  actorUserId: true, id: true, organizationId: true, threadId: true,
} as const satisfies Prisma.ExecutorConversationLeaseSelect

type LeaseExpiry = { absoluteExpiresAt: Date; endedAt: Date | null; idleExpiresAt: Date }

export const isExecutorLocalAppsBundle = (operationKeys: readonly string[]): boolean =>
  operationKeys.length === EXECUTOR_LOCAL_APPS_OPERATION_KEYS.length
  && new Set(operationKeys).size === operationKeys.length
  && EXECUTOR_LOCAL_APPS_OPERATION_KEYS.every((key) => operationKeys.includes(key))

export const executorLeasePastExpiry = (lease: LeaseExpiry, now: Date): boolean =>
  lease.idleExpiresAt <= now || lease.absoluteExpiresAt <= now

/** Not ended and inside both windows — the one liveness rule, lazily applied. */
export const isExecutorLeaseLive = (lease: LeaseExpiry, now: Date): boolean =>
  lease.endedAt === null && !executorLeasePastExpiry(lease, now)

/** The moment the lease stops carrying unless it is used again first. */
export const executorLeaseExpiresAt = (lease: LeaseExpiry): Date =>
  lease.idleExpiresAt < lease.absoluteExpiresAt ? lease.idleExpiresAt : lease.absoluteExpiresAt

export const executorLeaseIdleExpiry = (lastUsedAt: Date): Date =>
  new Date(lastUsedAt.getTime() + EXECUTOR_LEASE_IDLE_MS)

export const executorLeaseAuditActor = (actorContext: AuthorizedActionContext): ExecutorLeaseAuditActor => ({
  actorId: actorContext.actor.actorId,
  actorType: 'user',
  requestId: actorContext.actionContext.requestId,
})

const expiryAuditActor = (leaseId: string): ExecutorLeaseAuditActor => ({
  actorId: 'executor-lease-expiry',
  actorType: 'system',
  requestId: `executor-lease-expiry:${leaseId}`,
})

export const lockExecutorForLease = async (tx: Prisma.TransactionClient, executorId: string): Promise<void> => {
  await tx.$executeRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${`executor:${executorId}`}, 0))
  `)
}

export const writeExecutorLeaseAudit = (
  tx: Prisma.TransactionClient,
  input: {
    action: 'executor.lease.created' | 'executor.run.carried' | 'executor.run.carry_refused' | 'executor.lease.ended'
    actor: ExecutorLeaseAuditActor
    metadata: Record<string, unknown>
    organizationId: string
    /** A refused carry is `denied`, with its refusal reason; everything else succeeded. */
    outcome?: 'success' | 'denied'
    reason?: string
    resourceId: string
    resourceType: 'executor_conversation_lease' | 'executor_run'
  },
): Promise<void> => writeAuditEntryInTransaction(tx, {
  action: input.action,
  actorId: input.actor.actorId,
  actorType: input.actor.actorType,
  metadata: input.metadata as Prisma.InputJsonValue,
  organizationId: input.organizationId,
  outcome: input.outcome ?? 'success',
  reason: input.reason ?? null,
  requestId: input.actor.requestId,
  resourceId: input.resourceId,
  resourceType: input.resourceType,
})

/**
 * End every live lease the filter matches, inside the caller's transaction —
 * which is the transition that already fences sessions, so the lease and the
 * fence commit or roll back together. A lease that had already run out is
 * recorded as `expired`, not as whatever transition happened to find it.
 * The caller holds (or this takes) the executor lock of every lease matched;
 * filters are always scoped to one executor. Returns the leases this call
 * ended, for their holders' change notices once the caller has committed.
 */
export const endExecutorConversationLeasesInTransaction = async (
  tx: Prisma.TransactionClient,
  input: {
    actor: ExecutorLeaseAuditActor
    endedByUserId: string | null
    now?: Date
    reason: ExecutorLeaseEndReason
    where: Prisma.ExecutorConversationLeaseWhereInput & { executorId: string }
  },
): Promise<ExecutorLeaseRef[]> => {
  const now = input.now ?? new Date()
  await lockExecutorForLease(tx, input.where.executorId)
  const live = await tx.executorConversationLease.findMany({
    where: { ...input.where, endedAt: null },
    select: {
      absoluteExpiresAt: true, actorUserId: true, agentId: true, endedAt: true, executorId: true,
      id: true, idleExpiresAt: true, organizationId: true, threadId: true,
    },
  })
  const endedLeases: ExecutorLeaseRef[] = []
  for (const lease of live) {
    const expired = executorLeasePastExpiry(lease, now)
    const reason = expired ? 'expired' : input.reason
    const endedByUserId = expired ? null : input.endedByUserId
    const ended = await tx.executorConversationLease.updateMany({
      where: { id: lease.id, endedAt: null },
      data: { endedAt: now, endedByUserId, endedReason: reason },
    })
    if (ended.count !== 1) continue
    endedLeases.push({
      actorUserId: lease.actorUserId, id: lease.id, organizationId: lease.organizationId, threadId: lease.threadId,
    })
    await writeExecutorLeaseAudit(tx, {
      action: 'executor.lease.ended',
      actor: expired ? expiryAuditActor(lease.id) : input.actor,
      metadata: {
        agentId: lease.agentId,
        endedByUserId,
        executorId: lease.executorId,
        holderUserId: lease.actorUserId,
        leaseId: lease.id,
        reason,
        threadId: lease.threadId,
      },
      organizationId: lease.organizationId,
      resourceId: lease.id,
      resourceType: 'executor_conversation_lease',
    })
  }
  return endedLeases
}

/**
 * Called from `launchExecutorRun`'s transaction after the local-apps pair is
 * bound. A live lease the same person already holds for the same agent in the
 * same conversation is ended `replaced` first: the launch message is the new
 * root, and inside a conversation with that agent (a container thread whose
 * `agentId` is it) the whole thread is one conversation.
 */
export const createExecutorConversationLeaseInTransaction = async (
  tx: Prisma.TransactionClient,
  input: {
    actorContext: AuthorizedActionContext
    agentId: string
    bindingIds: string[]
    executorId: string
    launchRunId: string
    rootMessageId: string
    threadId: string
  },
  now = new Date(),
): Promise<{ absoluteExpiresAt: Date; id: string; idleExpiresAt: Date }> => {
  const actorUserId = requireHumanActor(input.actorContext)
  if (!actorUserId) {
    throw new ExecutorError(EXECUTOR_ERROR_CODES.SCOPE_ENTITLEMENT_DENIED, 'A conversation lease needs a human launcher.')
  }
  const organizationId = input.actorContext.tenant.organizationId
  const [bindings, thread] = await Promise.all([
    tx.executorBinding.findMany({
      where: { id: { in: input.bindingIds }, runId: input.launchRunId },
      select: { executorId: true, operationKey: true },
    }),
    tx.thread.findUnique({ where: { id: input.threadId }, select: { agentId: true } }),
  ])
  if (
    !thread
    || bindings.length !== input.bindingIds.length
    || bindings.some((binding) => binding.executorId !== input.executorId)
    || !isExecutorLocalAppsBundle(bindings.map((binding) => binding.operationKey))
  ) {
    throw new ExecutorError(EXECUTOR_ERROR_CODES.CANDIDATE_INVALID, 'A conversation lease covers exactly one local-apps launch.')
  }
  const actor = executorLeaseAuditActor(input.actorContext)
  const conversation = {
    actorUserId,
    agentId: input.agentId,
    threadId: input.threadId,
    ...(thread.agentId === input.agentId ? {} : { rootMessageId: input.rootMessageId }),
  }
  // Whichever executor the earlier launch reached: the one-live index is per
  // conversation, not per machine. Each is ended under its own executor lock.
  const replaced = await tx.executorConversationLease.findMany({
    where: { ...conversation, endedAt: null },
    select: { executorId: true },
  })
  for (const executorId of new Set(replaced.map((lease) => lease.executorId))) {
    await endExecutorConversationLeasesInTransaction(tx, {
      actor, endedByUserId: actorUserId, now, reason: 'replaced', where: { ...conversation, executorId },
    })
  }
  const lease = await tx.executorConversationLease.create({
    data: {
      absoluteExpiresAt: new Date(now.getTime() + EXECUTOR_LEASE_ABSOLUTE_MS),
      actorUserId,
      agentId: input.agentId,
      createdAt: now,
      executorId: input.executorId,
      idleExpiresAt: executorLeaseIdleExpiry(now),
      lastUsedAt: now,
      launchRunId: input.launchRunId,
      operationKeys: [...EXECUTOR_LOCAL_APPS_OPERATION_KEYS],
      organizationId,
      rootMessageId: input.rootMessageId,
      threadId: input.threadId,
    },
    select: { absoluteExpiresAt: true, id: true, idleExpiresAt: true },
  })
  await tx.executorBinding.updateMany({
    where: { id: { in: input.bindingIds } },
    data: { leaseId: lease.id },
  })
  await writeExecutorLeaseAudit(tx, {
    action: 'executor.lease.created',
    actor,
    metadata: {
      agentId: input.agentId,
      bindingIds: input.bindingIds,
      executorId: input.executorId,
      launchRunId: input.launchRunId,
      leaseId: lease.id,
      rootMessageId: input.rootMessageId,
      threadId: input.threadId,
    },
    organizationId,
    resourceId: lease.id,
    resourceType: 'executor_conversation_lease',
  })
  return lease
}

/**
 * End pressed on a lease: by the person who holds it, or by anyone who may
 * manage its executor. Everybody else gets "not found", so a lease id never
 * confirms that a lease — or a private executor — exists. Pressing End on a
 * lease that has already ended is not an error: `ended` is then false.
 */
export const endExecutorConversationLease = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  input: { leaseId: string },
  now = new Date(),
): Promise<{ ended: boolean; lease: ExecutorLeaseRef }> => prisma.$transaction(async (tx) => {
  const actorUserId = requireHumanActor(actorContext)
  const lease = actorUserId
    ? await tx.executorConversationLease.findFirst({
        where: { id: input.leaseId, organizationId: actorContext.tenant.organizationId },
        select: {
          ...EXECUTOR_LEASE_REF_SELECT,
          executor: { select: { id: true, projectId: true, scopeKind: true } },
          executorId: true,
        },
      })
    : null
  if (!lease || !actorUserId) {
    throw new ExecutorError(EXECUTOR_ERROR_CODES.NOT_FOUND, 'Executor lease not found.')
  }
  if (lease.actorUserId !== actorUserId) {
    const access = await resolveExecutorHumanAccess(
      tx, actorContext.tenant.organizationId, actorUserId, lease.executor,
    )
    if (!canManageExecutor(lease.executor, access)) {
      throw new ExecutorError(EXECUTOR_ERROR_CODES.NOT_FOUND, 'Executor lease not found.')
    }
  }
  const ended = await endExecutorConversationLeasesInTransaction(tx, {
    actor: executorLeaseAuditActor(actorContext),
    endedByUserId: actorUserId,
    now,
    reason: 'person',
    where: { executorId: lease.executorId, id: lease.id },
  })
  return {
    ended: ended.length === 1,
    lease: {
      actorUserId: lease.actorUserId, id: lease.id, organizationId: lease.organizationId, threadId: lease.threadId,
    },
  }
})

/**
 * The live leases on one executor, under the caller's executor lock. A
 * transition that ends leases somewhere below it — an access change reaching
 * the grant, roster, lifecycle or review code — reads this before and after,
 * and the difference is exactly what it ended: nothing else can end a lease
 * on that executor while the lock is held.
 */
export const listLiveExecutorLeaseRefs = (
  tx: Prisma.TransactionClient,
  executorId: string,
): Promise<ExecutorLeaseRef[]> => tx.executorConversationLease.findMany({
  where: { executorId, endedAt: null },
  select: EXECUTOR_LEASE_REF_SELECT,
})

/** Record the expiry of one lease that a lazy check found past its window. */
export const expireExecutorConversationLease = async (
  prisma: PrismaClient,
  lease: { executorId: string; id: string },
  now = new Date(),
): Promise<ExecutorLeaseRef[]> => prisma.$transaction(async (tx) => {
  await lockExecutorForLease(tx, lease.executorId)
  const current = await tx.executorConversationLease.findUnique({
    where: { id: lease.id },
    select: { absoluteExpiresAt: true, endedAt: true, idleExpiresAt: true },
  })
  if (!current || current.endedAt || !executorLeasePastExpiry(current, now)) return []
  return endExecutorConversationLeasesInTransaction(tx, {
    actor: expiryAuditActor(lease.id),
    endedByUserId: null,
    now,
    reason: 'expired',
    where: { executorId: lease.executorId, id: lease.id },
  })
})

/**
 * The maintenance sweep's half of expiry. Carry and dispatch already refuse a
 * lease past either window; this records the end (and its audit row) for the
 * leases nobody tried to use again, and returns them for their holders'
 * change notices. Bounded per pass.
 */
export const expireExecutorConversationLeases = async (
  prisma: PrismaClient,
  now = new Date(),
  limit = 100,
): Promise<ExecutorLeaseRef[]> => {
  const expired = await prisma.executorConversationLease.findMany({
    where: {
      endedAt: null,
      OR: [{ idleExpiresAt: { lte: now } }, { absoluteExpiresAt: { lte: now } }],
    },
    orderBy: { idleExpiresAt: 'asc' },
    select: { executorId: true, id: true },
    take: limit,
  })
  const ended: ExecutorLeaseRef[] = []
  for (const lease of expired) {
    ended.push(...await expireExecutorConversationLease(prisma, lease, now))
  }
  return ended
}

/**
 * Every executor command dispatched under a live lease moves its idle window.
 * A statement, not a read: it matches nothing for a binding without a lease,
 * or whose lease has already ended or run out.
 */
export const touchExecutorConversationLeaseForBinding = async (
  prisma: Pick<PrismaClient, 'executorConversationLease'> | Prisma.TransactionClient,
  bindingId: string,
  now = new Date(),
): Promise<void> => {
  await prisma.executorConversationLease.updateMany({
    where: {
      absoluteExpiresAt: { gt: now },
      bindings: { some: { id: bindingId } },
      endedAt: null,
      idleExpiresAt: { gt: now },
    },
    data: { idleExpiresAt: executorLeaseIdleExpiry(now), lastUsedAt: now },
  })
}
