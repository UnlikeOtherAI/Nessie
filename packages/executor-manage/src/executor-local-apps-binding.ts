import type { Prisma, PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

import { resolveExecutorAvailabilityCandidates } from './executor-availability-resolution.js'
import { bindExecutorCandidateBundleInTransaction, type ExecutorBindingRecord } from './executor-binding.js'
import { EXECUTOR_LOCAL_APPS_OPERATION_KEYS } from './executor-conversation-lease.js'

export type PinnedLocalAppsBinding =
  /** The run already holds bindings; nothing was resolved or written. */
  | { kind: 'existing'; bindings: Array<{ executorId: string; id: string; leaseId: string | null }> }
  /** The pinned executor offered no candidate covering both keys. */
  | { kind: 'unavailable' }
  | { kind: 'bound'; bindings: ExecutorBindingRecord[] }

/**
 * Bind a run to the local-apps pair on one server-derived executor, by the same
 * route a person's launch takes: resolve a fresh opaque candidate for the
 * requesting person with the internal `executorId` pin, then consume it through
 * `bindExecutorCandidateBundleInTransaction`, so the person actor, trigger
 * author, grants, capability revision and organisation/project scope checks
 * all run again.
 *
 * The one implementation behind both server-side binders — the conversation
 * lease carrying a person's follow-up, and task-set search binding its
 * processor's machine. A run that already has bindings is answered, never
 * re-bound: a re-driven job resolves a new candidate digest and would otherwise
 * collide with its own earlier binding.
 *
 * `inBindTransaction` runs inside the binding transaction after the bundle is
 * bound — under the executor lock the binder took — so a caller's own writes
 * (a lease id, an audit row) commit or roll back with the bindings. Resolution
 * and binding refusals surface as the `ExecutorError`s they are.
 */
export const bindPinnedExecutorLocalApps = async (
  prisma: PrismaClient,
  input: {
    actorContext: AuthorizedActionContext
    actorUserId: string
    agentId: string
    executorId: string
    runId: string
  },
  inBindTransaction?: (tx: Prisma.TransactionClient, bindings: ExecutorBindingRecord[]) => Promise<void>,
  now = new Date(),
): Promise<PinnedLocalAppsBinding> => {
  const existing = await prisma.executorBinding.findMany({
    where: { runId: input.runId },
    select: { executorId: true, id: true, leaseId: true },
  })
  if (existing.length > 0) return { kind: 'existing', bindings: existing }
  const availability = await resolveExecutorAvailabilityCandidates(prisma, input.actorContext, {
    agentId: input.agentId,
    executorId: input.executorId,
    operationKeys: [...EXECUTOR_LOCAL_APPS_OPERATION_KEYS],
    runId: input.runId,
  }, now)
  const candidate = availability.candidates.find((entry) => (
    EXECUTOR_LOCAL_APPS_OPERATION_KEYS.every((key) => entry.operationKeys.includes(key))
  ))
  if (!candidate) return { kind: 'unavailable' }
  const bindings = await prisma.$transaction(async (tx) => {
    const bound = await bindExecutorCandidateBundleInTransaction(tx, {
      actorUserId: input.actorUserId,
      candidateHandle: candidate.handle,
      operationKeys: [...EXECUTOR_LOCAL_APPS_OPERATION_KEYS],
      runId: input.runId,
    }, now)
    await inBindTransaction?.(tx, bound)
    return bound
  })
  return { kind: 'bound', bindings }
}
