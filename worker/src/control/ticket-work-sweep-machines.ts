import type { PrismaClient } from '@prisma/client'
import {
  endStandingPoliciesInTransaction,
  enforceTicketWorkLimitsInTransaction,
  executorCodingSessionOwnerKey,
  reportedExecutorCodingSessions,
} from '@nessie/executor-manage'
import { resolveLiveEntitlementDecision, type ResolveLiveEntitlementsDeps } from '@nessie/runtime'
import {
  ScheduledTriggerLaunchOriginSchema,
  TICKET_WORK_LIVE_STATUSES,
  ticketWorkCodingSessionContext,
} from '@nessie/schemas'

import { dequeueTicketWork } from './ticket-work-dequeue.js'
import { requeueWorkStrandedOffline, resumeWorkWhoseMachineIsBack } from './ticket-work-machine-return.js'

/**
 * The sweep's machine half (docs/standards/ticket-work-machine-access.md →
 * "The sweep's machine half"), run by `runTicketWorkSweep` each minute and
 * whenever a transaction that may free a machine enqueues it:
 *
 * - **Authors UOA no longer lists.** UOA has no removal feed, so each author
 *   of a live, suspended or preparing policy is asked again with the identity
 *   captured at confirmation. An answer that does not list them — or no way to
 *   ask — ends every such policy of theirs (`author_left_organization`), with
 *   its session closes and `executor.policy.ended`, in one transaction. An
 *   outage ends nothing: the binder refuses every wake meanwhile, failing
 *   closed on its own.
 * - **Limits on work nobody wakes.** Every live record under a policy is
 *   checked against its hours clock and spend, as a wake and the heartbeat
 *   intake check them.
 * - **A machine back, or gone too long** (T5, `ticket-work-machine-return.ts`):
 *   work waiting for its own machine resumes on it with a
 *   `machine_back_online` wake, or — past the trigger's `waitingMachineHours`
 *   — is queued again for another machine of its pool.
 * - **The dequeue** (T5, `ticket-work-dequeue.ts`): each free machine of a
 *   live pool takes the queued record first in line across every policy that
 *   shares it — the one that last worked there, then priority, then age —
 *   after the policy's digests, the ticket's column and its mover are checked
 *   again.
 */

type SweepDeps = { entitlements?: ResolveLiveEntitlementsDeps; now: Date }

const PAGE = 50

/** End the policies of authors UOA no longer places in their organisation. */
export const endPoliciesOfDepartedAuthors = async (prisma: PrismaClient, deps: SweepDeps): Promise<number> => {
  const policies = await prisma.executorStandingPolicy.findMany({
    where: { status: { in: ['preparing', 'live', 'suspended'] } },
    select: { authorOrigin: true, authorUserId: true, organizationId: true },
    orderBy: { createdAt: 'asc' },
  })
  const authors = new Map<string, { authorOrigin: unknown; authorUserId: string; organizationId: string }>()
  for (const policy of policies) {
    const key = `${policy.organizationId}:${policy.authorUserId}`
    // The confirmed policy's origin names the UOA identity to ask with.
    if (!authors.has(key) || policy.authorOrigin) authors.set(key, policy)
  }
  let ended = 0
  for (const author of authors.values()) {
    const origin = ScheduledTriggerLaunchOriginSchema.safeParse(author.authorOrigin)
    const decision = await resolveLiveEntitlementDecision(prisma, {
      allowStoredIdentity: true,
      organizationId: author.organizationId,
      userId: author.authorUserId,
      ...(origin.success && origin.data.uoaIdentity ? { uoaIdentity: origin.data.uoaIdentity } : {}),
    }, deps.entitlements).catch((error: unknown) => {
      console.error('[worker.ticket-work-sweep] author re-check failed', JSON.stringify({ userId: author.authorUserId }), error)
      return { status: 'unavailable' as const }
    })
    if (decision.status !== 'denied') continue
    ended += (await prisma.$transaction((tx) => endStandingPoliciesInTransaction(tx, {
      actor: { userId: null },
      reason: 'author_left_organization',
      where: { authorUserId: author.authorUserId, organizationId: author.organizationId },
    }))).length
  }
  return ended
}

/** Fail every live record under a policy that is over one of its limits, a page at a time. */
export const enforceLimitsOnLiveWork = async (prisma: PrismaClient, deps: SweepDeps): Promise<number> => {
  let ended = 0
  for (let after: string | null = null; ;) {
    const page: Array<{ id: string }> = await prisma.agentTicketWork.findMany({
      where: {
        policyId: { not: null },
        status: { in: [...TICKET_WORK_LIVE_STATUSES] },
        ...(after ? { id: { gt: after } } : {}),
      },
      orderBy: { id: 'asc' },
      take: PAGE,
      select: { id: true },
    })
    if (page.length === 0) break
    ended += (await prisma.$transaction((tx) => enforceTicketWorkLimitsInTransaction(tx, {
      now: deps.now, where: { id: { in: page.map((row) => row.id) } },
    }))).length
    if (page.length < PAGE) break
    after = page[page.length - 1]!.id
  }
  return ended
}

/**
 * Whether any of the ticket's own coding sessions is mid-turn, as its machine
 * last reported: a quiet wake would only interrupt the work it waits for.
 */
export const ticketSessionWorking = (record: {
  agentId: string
  executor: { localMcp: unknown } | null
  executorId: string | null
  policy: { authorUserId: string } | null
  policyId: string | null
  taskId: string
}): boolean => {
  if (!record.executorId || !record.policyId || !record.policy || !record.executor) return false
  const ownerKey = executorCodingSessionOwnerKey(record.executorId, {
    actorUserId: record.policy.authorUserId,
    agentId: record.agentId,
    contextId: ticketWorkCodingSessionContext(record.policyId, record.taskId),
  })
  return reportedExecutorCodingSessions(record.executor.localMcp)
    .some((session) => session.ownerKey === ownerKey && session.status === 'working')
}

/**
 * The machine half, each step on its own: one failing never keeps the others
 * from running. Work whose machine came back resumes before the dequeue, and
 * work taken off a machine that stayed away joins the queue before it, so the
 * dequeue that follows sees both.
 */
export const sweepStandingMachineAccess = async (prisma: PrismaClient, deps: SweepDeps): Promise<void> => {
  const steps: Array<[string, () => Promise<unknown>]> = [
    ['authors', () => endPoliciesOfDepartedAuthors(prisma, deps)],
    ['limits', () => enforceLimitsOnLiveWork(prisma, deps)],
    ['back online', () => resumeWorkWhoseMachineIsBack(prisma, deps)],
    ['stranded', () => requeueWorkStrandedOffline(prisma, deps)],
    ['dequeue', () => dequeueTicketWork(prisma, deps)],
  ]
  for (const [step, run] of steps) {
    await run().catch((error: unknown) => {
      console.error('[worker.ticket-work-sweep] machine step failed', JSON.stringify({ step }), error)
    })
  }
}
