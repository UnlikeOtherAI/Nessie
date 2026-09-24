import type { Prisma, PrismaClient } from '@prisma/client'
import {
  enforceTicketWorkLimitsInTransaction,
  lockStandingPolicyRow,
  requeueStrandedTicketWorkInTransaction,
  resumeTicketWorkOnItsMachineInTransaction,
  ticketWorkMachineOnline,
} from '@nessie/executor-manage'
import type { TicketTriggerDeliveryPayload } from '@nessie/schemas'
import { lockTicketForWork } from '@nessie/team-admin'

import { ticketWorkConfigOf } from './ticket-work-kickoff.js'
import { queueTicketWorkRun, stopTicketWorkAtWakeLimit } from './ticket-work-run.js'
import { lockThreadRunSlot } from '../run/thread-serialization.js'

/**
 * The sweep's steps for work waiting on its own offline machine (T5;
 * docs/standards/ticket-work-machine-access.md → "A machine that goes away"):
 *
 * - **Back online** (`resumeWorkWhoseMachineIsBack`): the machine is heard from
 *   again — its heartbeat enqueued the sweep — so the work is `active` on it
 *   once more and the agent gets one `machine_back_online` wake, bound to it,
 *   with a delivered `machine` delivery. Its limits are checked first, as at
 *   every wake. Machine access paused meanwhile: the work waits for access
 *   instead and the machine is freed, with no wake.
 * - **Stayed away** (`requeueWorkStrandedOffline`): past the trigger's
 *   `waitingMachineHours`, the work is taken off it and queued again for
 *   another machine of the pool; the dequeue that follows wakes it there.
 *
 * Each record is decided under the locks every wake of it takes, in the one
 * order — its policy's row (shared, so a suspension or an end waits for the
 * decision that read it live, and is read after it), its ticket, then its
 * thread's run slot, then the record — and re-read there, so a wake of the record that already resumed it, a second
 * sweep, or the machine coming back a moment before leaves nothing to do.
 */

const PAGE = 100

const BACK_ONLINE_TEXT = 'The machine working this ticket is back online, so its work resumes on it and you are bound to '
  + 'it again. Anything that happened on the ticket while it was away is on the ticket and in this thread: read it '
  + 'first. Then read the coding session with coding_session_wait: its turn may have ended, or been interrupted when '
  + 'the machine went away. Never name the machine on the ticket or in this thread.'

const WAITING_SELECT = {
  agentId: true, id: true, organizationId: true, policyId: true, projectId: true, taskId: true, threadId: true,
  triggerId: true,
  executor: { select: { lastSeenAt: true, removedAt: true, status: true } },
  trigger: { select: { agentId: true, config: true, enabled: true, id: true, status: true } },
} as const satisfies Prisma.AgentTicketWorkSelect

type Waiting = Prisma.AgentTicketWorkGetPayload<{ select: typeof WAITING_SELECT }>

const backOnline = async (prisma: PrismaClient, record: Waiting, now: Date): Promise<boolean> => {
  const trigger = record.trigger!
  return prisma.$transaction(async (tx) => {
    if (record.policyId) await lockStandingPolicyRow(tx, record.policyId)
    await lockTicketForWork(tx, record.taskId)
    await lockThreadRunSlot(tx, { agentId: record.agentId, threadId: record.threadId })
    const [ended] = await enforceTicketWorkLimitsInTransaction(tx, { now, where: { id: record.id } })
    if (ended) return false
    if (await resumeTicketWorkOnItsMachineInTransaction(tx, { now, workId: record.id }) !== 'resumed') return false
    const payload: TicketTriggerDeliveryPayload = {
      eventType: 'machine_back_online', originKind: 'system', outcome: 'follow', taskId: record.taskId,
      wakeReason: 'machine_back_online', workId: record.id,
    }
    const delivery = await tx.agentTriggerDelivery.create({
      data: {
        dedupeKey: `machine:${record.id}:${now.toISOString()}`, deliveredAt: now, payload, source: 'machine',
        status: 'delivered', triggerId: trigger.id,
      },
      select: { id: true },
    })
    const work = { ...record, triggerId: trigger.id }
    const outcome = await queueTicketWorkRun(tx, {
      work,
      trigger: {
        agentId: trigger.agentId!, config: trigger.config, id: trigger.id, organizationId: record.organizationId,
      },
      event: {
        at: now.toISOString(), reason: 'machine_back_online', summary: 'its machine is back online', text: BACK_ONLINE_TEXT,
      },
      deliveryId: delivery.id,
    })
    if (outcome.kind === 'over_limit') {
      await stopTicketWorkAtWakeLimit(tx, { work, wakesUsed: outcome.wakesUsed })
      await tx.agentTriggerDelivery.update({
        where: { id: delivery.id },
        data: { errorMessage: 'limit_wakes', payload: { ...payload, outcome: 'skipped', skipReason: 'limit_wakes' }, status: 'skipped' },
      })
    }
    return true
  })
}

const strandedOffline = (prisma: PrismaClient, record: Waiting, now: Date): Promise<boolean> =>
  prisma.$transaction(async (tx) => {
    if (record.policyId) await lockStandingPolicyRow(tx, record.policyId)
    await lockTicketForWork(tx, record.taskId)
    await lockThreadRunSlot(tx, { agentId: record.agentId, threadId: record.threadId })
    return requeueStrandedTicketWorkInTransaction(tx, {
      now, waitingMachineHours: ticketWorkConfigOf(record.trigger?.config).waitingMachineHours, workId: record.id,
    })
  })

/** Every record waiting for its machine, a page at a time, each decided on its own. */
const eachWaiting = async (
  prisma: PrismaClient,
  decide: (record: Waiting) => Promise<boolean>,
): Promise<number> => {
  let moved = 0
  for (let after: string | null = null; ;) {
    const page: Waiting[] = await prisma.agentTicketWork.findMany({
      where: {
        executorId: { not: null }, stateReason: 'machine_offline', status: 'waiting_machine', triggerId: { not: null },
        ...(after ? { id: { gt: after } } : {}),
      },
      orderBy: { id: 'asc' },
      take: PAGE,
      select: WAITING_SELECT,
    })
    for (const record of page) {
      // A disabled trigger ends its work as it is switched off; one in error wakes none of it.
      if (!record.trigger?.agentId || !record.trigger.enabled || record.trigger.status !== 'active') continue
      try {
        if (await decide(record)) moved += 1
      } catch (error) {
        console.error('[worker.ticket-work-sweep] machine return failed', JSON.stringify({ workId: record.id }), error)
      }
    }
    if (page.length < PAGE) break
    after = page[page.length - 1]!.id
  }
  return moved
}

export const resumeWorkWhoseMachineIsBack = (prisma: PrismaClient, deps: { now: Date }): Promise<number> =>
  eachWaiting(prisma, (record) => (ticketWorkMachineOnline(record.executor, deps.now)
    ? backOnline(prisma, record, deps.now)
    : Promise.resolve(false)))

export const requeueWorkStrandedOffline = (prisma: PrismaClient, deps: { now: Date }): Promise<number> =>
  eachWaiting(prisma, (record) => {
    if (ticketWorkMachineOnline(record.executor, deps.now)) return Promise.resolve(false)
    // It cannot have waited longer than its machine has been quiet: skip the transaction until then.
    const hours = ticketWorkConfigOf(record.trigger?.config).waitingMachineHours
    const quietSince = record.executor?.lastSeenAt?.getTime() ?? 0
    if (deps.now.getTime() - quietSince < hours * 3_600_000) return Promise.resolve(false)
    return strandedOffline(prisma, record, deps.now)
  })
