import type { PrismaClient } from '@prisma/client'
import {
  endStandingPoliciesInTransaction,
  enforceTicketWorkLimitsInTransaction,
  executorCodingSessionOwnerKey,
  executorHeartbeatCutoff,
  reportedExecutorCodingSessions,
} from '@nessie/executor-manage'
import { resolveLiveEntitlementDecision, type ResolveLiveEntitlementsDeps } from '@nessie/runtime'
import {
  ScheduledTriggerLaunchOriginSchema,
  TICKET_WORK_LIVE_STATUSES,
  ticketWorkCodingSessionContext,
} from '@nessie/schemas'
import { lockTicketForWork } from '@nessie/team-admin'

import { dequeueTicketWork } from './ticket-work-dequeue.js'
import { holdTicketWorkBeforeWake } from './ticket-work-machine.js'
import { requeueWorkStrandedOffline, resumeWorkWhoseMachineIsBack } from './ticket-work-machine-return.js'
import { lockThreadRunSlot } from '../run/thread-serialization.js'

/**
 * The sweep's machine half (docs/standards/ticket-work-machine-access.md →
 * "The sweep's machine half"), run by `runTicketWorkSweep` each minute, and —
 * its last three steps alone — whenever a transaction that may free a machine
 * enqueues it:
 *
 * - **Authors UOA no longer lists.** UOA has no removal feed, so each author
 *   of a live, suspended or preparing policy is asked again with the identity
 *   captured at confirmation, and — when that identity no longer answers (a
 *   new token version, another active team) — with their current stored UOA
 *   link. Only a definite "not a member" ends every such policy of theirs
 *   (`author_left_organization`), with its session closes and
 *   `executor.policy.ended`, in one transaction: UOA answering through a live
 *   link that they are not in the organisation, or a local organisation that
 *   no longer lists them. An outage, or no identity left to ask with, ends
 *   nothing: the binder refuses every wake meanwhile, failing closed on its
 *   own.
 * - **Work on a machine that went away.** An `active` record whose machine
 *   has not heartbeated inside the freshness window waits for it
 *   (`waiting_machine`, `machine_offline`), its hours clock paused, as a wake
 *   would have left it — so an offline machine's work stops counting hours
 *   whether or not anything wakes it.
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
    const captured = origin.success ? origin.data.uoaIdentity : undefined
    const ask = (uoaIdentity: typeof captured) => resolveLiveEntitlementDecision(prisma, {
      allowStoredIdentity: true,
      organizationId: author.organizationId,
      userId: author.authorUserId,
      ...(uoaIdentity ? { uoaIdentity } : {}),
    }, deps.entitlements).catch((error: unknown) => {
      console.error('[worker.ticket-work-sweep] author re-check failed', JSON.stringify({ userId: author.authorUserId }), error)
      return { status: 'unavailable' as const }
    })
    let decision = await ask(captured)
    // The identity captured at confirmation may be stale: ask again through their current link.
    if (decision.status === 'denied' && captured) decision = await ask(undefined)
    if (decision.status !== 'denied' || !await answeredNotAMember(prisma, author)) continue
    ended += (await prisma.$transaction((tx) => endStandingPoliciesInTransaction(tx, {
      actor: { userId: null },
      reason: 'author_left_organization',
      where: { authorUserId: author.authorUserId, organizationId: author.organizationId },
    }))).length
  }
  return ended
}

/**
 * Whether a denial is UOA's own answer that the author is not in the
 * organisation — through a stored link that can still ask — or a local
 * organisation's roster; never "nobody could be asked".
 */
const answeredNotAMember = async (
  prisma: PrismaClient,
  author: { authorUserId: string; organizationId: string },
): Promise<boolean> => {
  const organization = await prisma.organization.findUnique({
    where: { id: author.organizationId }, select: { externalOrgId: true },
  })
  if (!organization?.externalOrgId) return true
  // The link the live check asks through when no captured identity answers (`uoa-live-entitlements.ts`).
  const link = await prisma.productAccountLink.findUnique({
    where: { organizationId_userId_productSlug: {
      organizationId: author.organizationId, productSlug: 'nessie', userId: author.authorUserId,
    } },
    select: { activeOrgId: true, activeTeamId: true, status: true, uoaSub: true, uoaTokenVersion: true },
  })
  return Boolean(link?.status === 'linked' && link.activeOrgId === organization.externalOrgId && link.activeTeamId
    && link.uoaSub && link.uoaTokenVersion !== null)
}

/**
 * Every `active` record whose machine is not heard from (offline, or no
 * heartbeat inside the freshness window) waits for it, under the locks every
 * wake takes in the one order: its ticket, its thread's run slot, then the
 * record (`holdTicketWorkBeforeWake`, which also stops one over a limit).
 */
export const pauseWorkOnSilentMachines = async (prisma: PrismaClient, deps: SweepDeps): Promise<number> => {
  const cutoff = executorHeartbeatCutoff(deps.now)
  const silent = await prisma.agentTicketWork.findMany({
    where: {
      executorId: { not: null },
      policyId: { not: null },
      status: 'active',
      executor: { OR: [{ status: { not: 'online' } }, { lastSeenAt: null }, { lastSeenAt: { lt: cutoff } }] },
    },
    select: { agentId: true, id: true, taskId: true, threadId: true, triggerId: true },
    take: PAGE,
  })
  let paused = 0
  for (const record of silent) {
    const held = await prisma.$transaction(async (tx) => {
      await lockTicketForWork(tx, record.taskId)
      await lockThreadRunSlot(tx, { agentId: record.agentId, threadId: record.threadId })
      return holdTicketWorkBeforeWake(tx, { now: deps.now, work: record })
    })
    if (held === 'machine_offline') paused += 1
  }
  return paused
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
 * last reported — and only while the machine is heard from: a report from a
 * machine that went silent says nothing about now, and would hold the quiet
 * wake back for good. A quiet wake would only interrupt the work it waits for.
 */
export const ticketSessionWorking = (record: {
  agentId: string
  executor: { lastSeenAt: Date | null; localMcp: unknown; status: string } | null
  executorId: string | null
  policy: { authorUserId: string } | null
  policyId: string | null
  taskId: string
}, now: Date): boolean => {
  if (!record.executorId || !record.policyId || !record.policy || !record.executor) return false
  if (record.executor.status !== 'online' || !record.executor.lastSeenAt
    || record.executor.lastSeenAt < executorHeartbeatCutoff(now)) return false
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
 * dequeue that follows sees both. A sweep a transaction enqueued because it may
 * have freed a machine (`machinesOnly`) runs those three alone: asking UOA after
 * every author and reading every live record's limits are the minute's tick's.
 */
export const sweepStandingMachineAccess = async (
  prisma: PrismaClient,
  deps: SweepDeps & { machinesOnly?: boolean },
): Promise<void> => {
  const steps: Array<[string, () => Promise<unknown>]> = [
    ...(deps.machinesOnly ? [] : [
      ['authors', () => endPoliciesOfDepartedAuthors(prisma, deps)],
      ['silent machines', () => pauseWorkOnSilentMachines(prisma, deps)],
      ['limits', () => enforceLimitsOnLiveWork(prisma, deps)],
    ] as Array<[string, () => Promise<unknown>]>),
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
