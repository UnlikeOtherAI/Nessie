import { Prisma, type PrismaClient, type RunStatus } from '@prisma/client'
import {
  TICKET_WORK_LIVE_STATUSES,
  TICKET_WORK_SWEEP_TOPIC,
  TICKET_WORK_THREAD_MESSAGE_TOPIC,
  TicketChangedStoredConfigSchema,
  TicketWorkThreadMessageJobPayloadSchema,
  TRIGGER_TICKET_DISPATCH_TOPIC,
  TriggerTicketDispatchJobPayloadSchema,
  type TicketWorkSweepJobPayload,
} from '@nessie/schemas'

import { dispatchTicketThreadMessage } from './ticket-thread-message-dispatch.js'
import { dispatchTicketEvent } from './ticket-trigger-dispatch.js'
import { settleTicketDelivery } from './ticket-trigger-settle.js'
import { createTicketWorkSeam } from './ticket-work.js'
import { ticketWorkConfigOf } from './ticket-work-kickoff.js'
import { stopTicketWorkAtWakeLimit } from './ticket-work-run.js'
import type { TicketWorkSeam } from './ticket-work-seam.js'
import type { RetryContext } from './trigger-run.js'
import { enqueueQueueJob } from '../queue.js'
import { lockThreadRunSlot } from '../run/thread-serialization.js'

/**
 * `ticket-work.sweep`: the platform's periodic look at every live work record
 * (docs/standards/ticket-work.md → "Reminders, the quiet wake and the
 * sweep"). One job a minute, idempotent by its bucket, so every worker may
 * enqueue it and one runs. It
 *
 * - **ends work over its wake limit** — a record whose `wakesPerTicket` a
 *   person lowered below the wakes it already used fails `limit_wakes`, with
 *   its `work_ended` row and its thread's stop row, as a wake past the limit
 *   does (`startsPerDay` is decided at each pickup, so no live record is ever
 *   over it);
 * - **sends the quiet wake** — an `active` record with no pending reminder, no
 *   open question, no run in flight and no wake for the trigger's
 *   `quietWakeMinutes` is woken with reason `quiet`, counted against its wake
 *   limit. No coding session can be working yet (they come with machine
 *   access), so none is checked;
 * - **recovers a lost dispatch job** — a `trigger.ticket.dispatch` or
 *   `ticket-work.thread-message` job the queue gave up on (its worker died
 *   holding it, or it failed at every attempt) is dispatched once more. Each
 *   dispatcher decides at most once per (trigger, event), so a job that did
 *   settle changes nothing, and a person's move whose job was lost still
 *   starts its work.
 *
 * Later PRs make it the pool dispatcher too (T4, T5).
 */

export const TICKET_WORK_SWEEP_INTERVAL_MS = 60_000

/** Lost jobs older than this are left alone: the moment they spoke of has passed. */
const LOST_JOB_HORIZON_MS = 24 * 60 * 60 * 1000
const LOST_JOB_RECOVERED = 'recovered_by_ticket_work_sweep'

export type SweepRecordFacts = {
  status: string
  wakeCount: number
  wakeLimit: number
  lastWakeAt: Date | null
  startedAt: Date
  awaitingAnswerAt: Date | null
  pendingReminders: number
  quietWakeMinutes: number | null
}

/** What the sweep does with one live record, decided from its facts alone. */
export const decideTicketWorkSweep = (record: SweepRecordFacts, now: Date): 'over_limit' | 'quiet' | null => {
  if (record.wakeCount > record.wakeLimit) return 'over_limit'
  if (record.status !== 'active' || record.quietWakeMinutes === null) return null
  // Something is already scheduled, or a person owes an answer: not quiet.
  if (record.awaitingAnswerAt !== null || record.pendingReminders > 0) return null
  const since = record.lastWakeAt ?? record.startedAt
  return now.getTime() - since.getTime() >= record.quietWakeMinutes * 60_000 ? 'quiet' : null
}

const IN_FLIGHT_RUN_STATUSES: RunStatus[] = ['pending', 'running', 'waiting_approval', 'waiting_input']

type LiveRecord = Awaited<ReturnType<typeof loadLiveRecords>>[number]

const loadLiveRecords = (prisma: PrismaClient, limit: number) =>
  prisma.agentTicketWork.findMany({
    where: { status: { in: [...TICKET_WORK_LIVE_STATUSES] }, triggerId: { not: null } },
    orderBy: [{ lastWakeAt: { sort: 'asc', nulls: 'first' } }, { startedAt: 'asc' }],
    take: limit,
    select: {
      id: true,
      organizationId: true,
      taskId: true,
      projectId: true,
      threadId: true,
      agentId: true,
      triggerId: true,
      status: true,
      wakeCount: true,
      lastWakeAt: true,
      startedAt: true,
      awaitingAnswerAt: true,
      _count: { select: { reminders: { where: { status: 'pending' } } } },
      trigger: {
        select: { id: true, agentId: true, config: true, targetChannelId: true, enabled: true, status: true },
      },
    },
  })

const sweepFacts = (record: LiveRecord): SweepRecordFacts => {
  const config = ticketWorkConfigOf(record.trigger?.config)
  return {
    status: record.status,
    wakeCount: record.wakeCount,
    wakeLimit: config.limits.wakesPerTicket,
    lastWakeAt: record.lastWakeAt,
    startedAt: record.startedAt,
    awaitingAnswerAt: record.awaitingAnswerAt,
    pendingReminders: record._count.reminders,
    quietWakeMinutes: config.quietWakeMinutes,
  }
}

type QuietOptions = { seam?: TicketWorkSeam; retry?: RetryContext; now?: Date }

/**
 * One quiet wake, deduped on `quiet:<workId>:<the wake it followed>`. Its
 * claim re-reads the record under the thread's run slot — the lock every wake
 * of the record takes first — and writes no delivery at all when something
 * woke or scheduled it in the meantime. Also the delivery-retry poller's arm
 * for a failed quiet delivery, which claims nothing and wakes live work.
 */
export const sendQuietWake = async (
  prisma: PrismaClient,
  workId: string,
  options: QuietOptions = {},
): Promise<void> => {
  const now = options.now ?? new Date()
  const record = await prisma.agentTicketWork.findUnique({
    where: { id: workId },
    select: {
      id: true,
      organizationId: true,
      taskId: true,
      projectId: true,
      threadId: true,
      agentId: true,
      status: true,
      lastWakeAt: true,
      startedAt: true,
      trigger: { select: { id: true, agentId: true, config: true, targetChannelId: true } },
    },
  })
  const trigger = record?.trigger
  const config = TicketChangedStoredConfigSchema.safeParse(trigger?.config)
  if (!record || !trigger?.agentId || !config.success || record.status !== 'active') {
    if (options.retry?.reuseDeliveryId) {
      await prisma.agentTriggerDelivery.updateMany({
        where: { id: options.retry.reuseDeliveryId, status: 'failed' },
        data: { status: 'skipped', errorMessage: 'no_longer_applies', nextRetryAt: null },
      })
    }
    return
  }
  const agentId = trigger.agentId
  const quietMinutes = ticketWorkConfigOf(trigger.config).quietWakeMinutes
  const followed = record.lastWakeAt ?? record.startedAt
  const seam = options.seam ?? createTicketWorkSeam(prisma)
  await settleTicketDelivery(prisma, {
    triggerId: trigger.id,
    dedupeKey: `quiet:${record.id}:${followed.toISOString()}`,
    base: { taskId: record.taskId, eventType: 'quiet', originKind: 'system' },
    decision: { kind: 'follow', source: 'quiet', workId: record.id, wakeReason: 'quiet', untrusted: false },
    ...(options.retry
      ? { retry: options.retry }
      : {
          claim: async (tx) => {
            await lockThreadRunSlot(tx, { agentId, threadId: record.threadId })
            const fresh = await tx.agentTicketWork.findUnique({
              where: { id: record.id },
              select: {
                status: true,
                lastWakeAt: true,
                awaitingAnswerAt: true,
                _count: { select: { reminders: { where: { status: 'pending' } } } },
              },
            })
            const inFlight = await tx.run.count({
              where: { agentId, threadId: record.threadId, status: { in: IN_FLIGHT_RUN_STATUSES } },
            })
            return fresh !== null && fresh.status === 'active' && fresh.awaitingAnswerAt === null
              && fresh._count.reminders === 0 && inFlight === 0
              && (fresh.lastWakeAt?.getTime() ?? null) === (record.lastWakeAt?.getTime() ?? null)
              && quietMinutes !== null
          },
        }),
    act: (tx, deliveryId) => seam.wakeTicketWork(tx, {
      trigger: {
        id: trigger.id,
        agentId,
        organizationId: record.organizationId,
        targetChannelId: trigger.targetChannelId,
        config: config.data,
      },
      task: { id: record.taskId, projectId: record.projectId },
      event: { id: record.id, eventType: 'quiet', createdAt: now, kind: 'quiet' },
      workId: record.id,
      reason: 'quiet',
      untrusted: false,
      machineLess: false,
      resumes: false,
      deliveryId,
    }),
  })
}

/** A record over a wake limit a person lowered: stopped as a wake past the limit would stop it. */
const endOverWakeLimit = async (prisma: PrismaClient, record: LiveRecord, limit: number): Promise<void> => {
  await prisma.$transaction(async (tx) => {
    const fresh = await tx.agentTicketWork.findUnique({ where: { id: record.id }, select: { wakeCount: true } })
    if (!fresh || fresh.wakeCount <= limit) return
    await stopTicketWorkAtWakeLimit(tx, { work: record, wakesUsed: fresh.wakeCount })
  })
}

type LostJob = { id: string; topic: string; payload: unknown }

/**
 * The ticket dispatch jobs the queue gave up on, dispatched once more. A job
 * is marked recovered first, so a dispatch that throws again is not retried
 * every minute for a day.
 */
export const recoverLostTicketJobs = async (prisma: PrismaClient, now: Date, limit = 20): Promise<number> => {
  const since = new Date(now.getTime() - LOST_JOB_HORIZON_MS)
  const jobs = await prisma.$queryRaw<LostJob[]>(Prisma.sql`
    SELECT id::text AS id, topic, payload FROM queue_jobs
    WHERE topic IN (${TRIGGER_TICKET_DISPATCH_TOPIC}, ${TICKET_WORK_THREAD_MESSAGE_TOPIC})
      AND status = 'dead'
      AND enqueued_at >= ${since}
      AND error_message IS DISTINCT FROM ${LOST_JOB_RECOVERED}
    ORDER BY enqueued_at ASC
    LIMIT ${limit}
  `)
  let recovered = 0
  for (const job of jobs) {
    await prisma.$executeRaw(Prisma.sql`
      UPDATE queue_jobs SET error_message = ${LOST_JOB_RECOVERED} WHERE id::text = ${job.id} AND status = 'dead'`)
    try {
      if (job.topic === TRIGGER_TICKET_DISPATCH_TOPIC) {
        await dispatchTicketEvent(prisma, TriggerTicketDispatchJobPayloadSchema.parse(job.payload))
      } else {
        await dispatchTicketThreadMessage(prisma, TicketWorkThreadMessageJobPayloadSchema.parse(job.payload))
      }
      recovered += 1
    } catch (error) {
      console.error('[worker.ticket-work-sweep] lost job recovery failed', JSON.stringify({ jobId: job.id }), error)
    }
  }
  return recovered
}

export const runTicketWorkSweep = async (
  prisma: PrismaClient,
  input: { now?: Date; limit?: number; seam?: TicketWorkSeam } = {},
): Promise<void> => {
  const now = input.now ?? new Date()
  for (const record of await loadLiveRecords(prisma, input.limit ?? 200)) {
    // A disabled trigger ends its work as it is switched off; one still
    // enabled but in error keeps its records, and wakes none of them.
    if (!record.trigger?.enabled || record.trigger.status !== 'active') continue
    const facts = sweepFacts(record)
    const decision = decideTicketWorkSweep(facts, now)
    try {
      if (decision === 'over_limit') await endOverWakeLimit(prisma, record, facts.wakeLimit)
      if (decision === 'quiet') await sendQuietWake(prisma, record.id, { now, ...(input.seam ? { seam: input.seam } : {}) })
    } catch (error) {
      console.error('[worker.ticket-work-sweep] record failed', JSON.stringify({ workId: record.id, decision }), error)
    }
  }
  await recoverLostTicketJobs(prisma, now)
}

/**
 * Enqueue `ticket-work.sweep` once a minute. The idempotency key is the
 * minute's bucket, so every worker replica may tick and one job runs per
 * window; the job subscriber (`worker-subscriptions-integrations.ts`) runs it.
 */
export const enqueueTicketWorkSweep = (prisma: PrismaClient, at: Date = new Date()): Promise<boolean> => {
  const bucket = String(Math.floor(at.getTime() / TICKET_WORK_SWEEP_INTERVAL_MS))
  const payload: TicketWorkSweepJobPayload = { bucket }
  return enqueueQueueJob(prisma, {
    idempotencyKey: `${TICKET_WORK_SWEEP_TOPIC}:${bucket}`,
    payload,
    topic: TICKET_WORK_SWEEP_TOPIC,
  })
}

export const startTicketWorkSweep = (deps: { prisma: PrismaClient; abortSignal: AbortSignal }): (() => void) => {
  const timer = setInterval(() => {
    if (deps.abortSignal.aborted) return
    void enqueueTicketWorkSweep(deps.prisma).catch((error: unknown) => {
      console.error('[worker.ticket-work-sweep] enqueue failed', error)
    })
  }, TICKET_WORK_SWEEP_INTERVAL_MS)
  timer.unref()
  return () => clearInterval(timer)
}
