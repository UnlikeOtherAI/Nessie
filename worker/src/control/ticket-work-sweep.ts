import { Prisma, type PrismaClient, type RunStatus } from '@prisma/client'
import type { ResolveLiveEntitlementsDeps } from '@nessie/runtime'
import {
  TICKET_WORK_LIVE_STATUSES,
  TICKET_WORK_SESSION_TOPIC,
  TICKET_WORK_SWEEP_TOPIC,
  TICKET_WORK_THREAD_MESSAGE_TOPIC,
  TicketChangedStoredConfigSchema,
  TicketWorkSessionJobPayloadSchema,
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
import { dispatchTicketWorkSession } from './ticket-work-session-wake.js'
import { stopTicketWorkAtWakeLimit } from './ticket-work-run.js'
import { sweepStandingMachineAccess, ticketSessionWorking } from './ticket-work-sweep-machines.js'
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
 *   limit — nor while one of the ticket's own coding sessions is mid-turn
 *   on its machine, as the machine last reported (T4);
 * - **recovers a lost dispatch job** — a `trigger.ticket.dispatch`,
 *   `ticket-work.thread-message` or (T5) `ticket-work.session` job the queue
 *   gave up on (its worker died
 *   holding it, or it failed at every attempt) is dispatched once more. Each
 *   dispatcher decides at most once per (trigger, event), so a job that did
 *   settle changes nothing, and a person's move whose job was lost still
 *   starts its work.
 *
 * - **(T4, T5) runs the machine half** (`ticket-work-sweep-machines.ts`): it
 *   ends the policies of authors UOA no longer lists, stops work over its
 *   hours or spend that nobody wakes, resumes work whose machine came back
 *   and moves work off one that stayed away past `waitingMachineHours`, and
 *   dequeues — each free machine takes the first queued record in line across
 *   every policy that shares it. Every transaction that may free a machine
 *   enqueues this job, so it is the pool dispatcher as well as the backstop.
 */

export const TICKET_WORK_SWEEP_INTERVAL_MS = 60_000

/** Lost jobs older than this are left alone: the moment they spoke of has passed. */
const LOST_JOB_HORIZON_MS = 24 * 60 * 60 * 1000
/** Appended to a lost job's own error, never in place of it: the reason it died stays readable. */
const LOST_JOB_RECOVERED = '[recovered by ticket-work.sweep]'

export type SweepRecordFacts = {
  status: string
  wakeCount: number
  wakeLimit: number
  lastWakeAt: Date | null
  startedAt: Date
  awaitingAnswerAt: Date | null
  pendingReminders: number
  quietWakeMinutes: number | null
  /** When the agent's newest run in the work thread finished, if one has. */
  lastRunFinishedAt: Date | null
  /** One of the ticket's own coding sessions is mid-turn, as its machine last reported (T4). */
  sessionWorking?: boolean
}

/** What the sweep does with one live record, decided from its facts alone. */
export const decideTicketWorkSweep = (record: SweepRecordFacts, now: Date): 'over_limit' | 'quiet' | null => {
  if (record.wakeCount > record.wakeLimit) return 'over_limit'
  if (record.status !== 'active' || record.quietWakeMinutes === null) return null
  // Something is already scheduled, a person owes an answer, or the coding
  // agent is working: not quiet.
  if (record.awaitingAnswerAt !== null || record.pendingReminders > 0 || record.sessionWorking) return null
  // Quiet since the last thing that happened: the wake, or — a run that took
  // a while — the moment the run it started finished.
  const woken = (record.lastWakeAt ?? record.startedAt).getTime()
  const since = Math.max(woken, record.lastRunFinishedAt?.getTime() ?? 0)
  return now.getTime() - since >= record.quietWakeMinutes * 60_000 ? 'quiet' : null
}

const IN_FLIGHT_RUN_STATUSES: RunStatus[] = ['pending', 'running', 'waiting_approval', 'waiting_input']

type LiveRecord = Awaited<ReturnType<typeof loadLiveRecords>>[number]

/**
 * One page of live records, in id order after `after`. The sweep walks every
 * page each time, so no status — parked work waiting days for review, say —
 * can crowd the records it has to wake out of the window.
 */
const loadLiveRecords = (prisma: PrismaClient, input: { after: string | null; take: number }) =>
  prisma.agentTicketWork.findMany({
    where: {
      status: { in: [...TICKET_WORK_LIVE_STATUSES] },
      triggerId: { not: null },
      ...(input.after ? { id: { gt: input.after } } : {}),
    },
    orderBy: { id: 'asc' },
    take: input.take,
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
      executorId: true,
      policyId: true,
      executor: { select: { lastSeenAt: true, localMcp: true, status: true } },
      policy: { select: { authorUserId: true } },
      _count: { select: { reminders: { where: { status: 'pending' } } } },
      trigger: {
        select: { id: true, agentId: true, config: true, targetChannelId: true, enabled: true, status: true },
      },
    },
  })

const sweepFacts = (record: LiveRecord, lastRunFinishedAt: Date | null, now: Date): SweepRecordFacts => {
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
    lastRunFinishedAt,
    sessionWorking: record.status === 'active' && ticketSessionWorking(record, now),
  }
}

/** When each record's agent last finished a run in its work thread: where its quiet is measured from. */
const lastRunFinishes = async (prisma: PrismaClient, records: readonly LiveRecord[]): Promise<Map<string, Date>> => {
  const active = records.filter((record) => record.status === 'active')
  if (active.length === 0) return new Map()
  const rows = await prisma.run.groupBy({
    by: ['threadId', 'agentId'],
    where: { threadId: { in: active.map((record) => record.threadId) }, finishedAt: { not: null } },
    _max: { finishedAt: true },
  })
  const finished = new Map<string, Date>()
  for (const row of rows) if (row._max.finishedAt) finished.set(`${row.threadId}:${row.agentId}`, row._max.finishedAt)
  return finished
}

type QuietOptions = {
  seam?: TicketWorkSeam
  retry?: RetryContext
  now?: Date
  /**
   * A retry's quiet wake: the record's last wake when its quiet was measured,
   * from the delivery's payload. A retry that names none is settled.
   */
  followedWakeAt?: Date | null
}

/**
 * Whether the record is still quiet: active, no open question, no pending
 * reminder, no run in flight, and no wake since the one the quiet followed. A
 * question waiting for a person never costs a wake.
 */
const stillQuiet = async (
  tx: Pick<Prisma.TransactionClient, 'agentTicketWork' | 'run'>,
  input: { workId: string; agentId: string; threadId: string; followedWakeAt: Date | null },
): Promise<boolean> => {
  const fresh = await tx.agentTicketWork.findUnique({
    where: { id: input.workId },
    select: {
      status: true,
      lastWakeAt: true,
      awaitingAnswerAt: true,
      _count: { select: { reminders: { where: { status: 'pending' } } } },
    },
  })
  const inFlight = await tx.run.count({
    where: { agentId: input.agentId, threadId: input.threadId, status: { in: IN_FLIGHT_RUN_STATUSES } },
  })
  return fresh !== null && fresh.status === 'active' && fresh.awaitingAnswerAt === null
    && fresh._count.reminders === 0 && inFlight === 0
    && (fresh.lastWakeAt?.getTime() ?? null) === (input.followedWakeAt?.getTime() ?? null)
}

/** A retry that can no longer apply: its row settled, never retried again. */
const settleStaleQuietRetry = async (prisma: PrismaClient, retry: RetryContext | undefined): Promise<void> => {
  if (!retry?.reuseDeliveryId) return
  await prisma.agentTriggerDelivery.updateMany({
    where: { id: retry.reuseDeliveryId, status: 'failed' },
    data: { status: 'skipped', errorMessage: 'no_longer_applies', nextRetryAt: null },
  })
}

/**
 * One quiet wake, deduped on `quiet:<workId>:<the wake it followed>`, whose
 * payload names that wake (`followedWakeAt`). Its claim takes the thread's
 * run slot — the lock every wake of the record takes before it writes — and
 * re-reads the record under it: something that woke or scheduled it in the
 * meantime means no delivery at all on a first attempt, and a settled row on
 * the delivery-retry poller's, which runs the very same claim.
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
      lastWakeAt: true,
      startedAt: true,
      trigger: { select: { id: true, agentId: true, config: true, targetChannelId: true } },
    },
  })
  const trigger = record?.trigger
  const config = TicketChangedStoredConfigSchema.safeParse(trigger?.config)
  const quietMinutes = ticketWorkConfigOf(trigger?.config).quietWakeMinutes
  const followedWakeAt = options.retry ? options.followedWakeAt : record?.lastWakeAt ?? null
  if (!record || !trigger?.agentId || !config.success || quietMinutes === null || followedWakeAt === undefined) {
    await settleStaleQuietRetry(prisma, options.retry)
    return
  }
  const agentId = trigger.agentId
  const followed = followedWakeAt ?? record.startedAt
  const seam = options.seam ?? createTicketWorkSeam(prisma)
  await settleTicketDelivery(prisma, {
    triggerId: trigger.id,
    dedupeKey: `quiet:${record.id}:${followed.toISOString()}`,
    base: {
      taskId: record.taskId, eventType: 'quiet', originKind: 'system',
      followedWakeAt: followedWakeAt?.toISOString() ?? null,
    },
    decision: { kind: 'follow', source: 'quiet', workId: record.id, wakeReason: 'quiet', untrusted: false },
    ...(options.retry ? { retry: options.retry } : {}),
    claim: async (tx) => {
      await lockThreadRunSlot(tx, { agentId, threadId: record.threadId })
      return stillQuiet(tx, { workId: record.id, agentId, threadId: record.threadId, followedWakeAt })
    },
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
    WHERE topic IN (${TRIGGER_TICKET_DISPATCH_TOPIC}, ${TICKET_WORK_THREAD_MESSAGE_TOPIC}, ${TICKET_WORK_SESSION_TOPIC})
      AND status = 'dead'
      AND enqueued_at >= ${since}
      AND position(${LOST_JOB_RECOVERED} in coalesce(error_message, '')) = 0
    ORDER BY enqueued_at ASC
    LIMIT ${limit}
  `)
  let recovered = 0
  for (const job of jobs) {
    // The claim: one sweep marks the job, and only the one whose mark landed
    // dispatches it. Another sweep that read the same job finds it marked.
    const claimed = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      UPDATE queue_jobs
      SET error_message = trim(coalesce(error_message, '') || ' ' || ${LOST_JOB_RECOVERED})
      WHERE id::text = ${job.id}
        AND status = 'dead'
        AND position(${LOST_JOB_RECOVERED} in coalesce(error_message, '')) = 0
      RETURNING id::text AS id`)
    if (claimed.length === 0) continue
    try {
      if (job.topic === TRIGGER_TICKET_DISPATCH_TOPIC) {
        await dispatchTicketEvent(prisma, TriggerTicketDispatchJobPayloadSchema.parse(job.payload))
      } else if (job.topic === TICKET_WORK_SESSION_TOPIC) {
        // A session's wake decides once per report of it, by its own key.
        await dispatchTicketWorkSession(prisma, TicketWorkSessionJobPayloadSchema.parse(job.payload))
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
  /**
   * `limit`: live records read a page; every page is read. `entitlements`: the UOA transport;
   * tests stand one in. `machinesOnly`: an enqueue by a transaction that may have freed a
   * machine — the machine steps alone (`sweepStandingMachineAccess`).
   */
  input: {
    now?: Date
    limit?: number
    machinesOnly?: boolean
    seam?: TicketWorkSeam
    entitlements?: ResolveLiveEntitlementsDeps
  } = {},
): Promise<void> => {
  const now = input.now ?? new Date()
  if (input.machinesOnly) {
    await sweepStandingMachineAccess(prisma, { machinesOnly: true, now })
    return
  }
  const take = input.limit ?? 200
  for (let after: string | null = null; ;) {
    const records = await loadLiveRecords(prisma, { after, take })
    await sweepPage(prisma, records, { now, ...(input.seam ? { seam: input.seam } : {}) })
    if (records.length < take) break
    after = records[records.length - 1]!.id
  }
  await recoverLostTicketJobs(prisma, now)
  await sweepStandingMachineAccess(prisma, { now, ...(input.entitlements ? { entitlements: input.entitlements } : {}) })
}

const sweepPage = async (
  prisma: PrismaClient,
  records: readonly LiveRecord[],
  input: { now: Date; seam?: TicketWorkSeam },
): Promise<void> => {
  const { now } = input
  const finished = await lastRunFinishes(prisma, records)
  for (const record of records) {
    // A disabled trigger ends its work as it is switched off; one still
    // enabled but in error keeps its records, and wakes none of them.
    if (!record.trigger?.enabled || record.trigger.status !== 'active') continue
    const facts = sweepFacts(record, finished.get(`${record.threadId}:${record.agentId}`) ?? null, now)
    const decision = decideTicketWorkSweep(facts, now)
    try {
      if (decision === 'over_limit') await endOverWakeLimit(prisma, record, facts.wakeLimit)
      if (decision === 'quiet') await sendQuietWake(prisma, record.id, { now, ...(input.seam ? { seam: input.seam } : {}) })
    } catch (error) {
      console.error('[worker.ticket-work-sweep] record failed', JSON.stringify({ workId: record.id, decision }), error)
    }
  }
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
