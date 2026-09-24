import { Prisma } from '@prisma/client'
import { enqueueQueueJob } from '@nessie/db'
import {
  EXECUTOR_CODING_SESSION_REPORT_MAXIMUM,
  EXECUTOR_CODING_SESSIONS_MCP_SERVER_NAME,
  TICKET_WORK_LIVE_STATUSES,
  TICKET_WORK_SESSION_TOPIC,
  type ExecutorCodingSessionSummary,
  type ExecutorLocalMcpReport,
  type TicketWorkSessionJobPayload,
} from '@nessie/schemas'

import { reportedExecutorCodingSessions } from './executor-coding-session-closes.js'
import { executorHeartbeatCutoff } from './executor-liveness.js'
import { enqueueTicketWorkSweep } from './executor-standing-policy-pool.js'

/**
 * The heartbeat's ticket-work intake (T5; docs/plans/2026-09-23-ticket-driven-agents/ticket-work.md
 * → "Session wakes (T5)"; docs/standards/ticket-work-machine-access.md). It runs inside the
 * heartbeat transaction, which already holds the machine's connection lock, so two reports of
 * one machine are never compared at once.
 *
 * **Session wakes.** The previous and the new `codingSessions` are compared for the sessions a
 * live work record names, and a `ticket-work.session` job is enqueued — idempotent on
 * `session:<sessionId>:<turn>:<status>`, so a repeated report wakes nothing twice — when:
 *
 * - the turn went up and the session is not `starting` or `working`. The turn a report shows
 *   ended is its `turn`, or the one before while a turn is still in progress, so a fast turn
 *   that began and ended between two reports (`waiting_for_input` turn 3, then turn 4) wakes
 *   exactly once, and a slow one (`working` turn 4, then `waiting_for_input` turn 4) too;
 * - it entered `interrupted` or `failed`, or reports itself `closed`;
 * - it is missing from a report that has the field, having been in the previous one: closed.
 *   A report at its row cap may have left it out, so there a missing session is unknown, not
 *   closed; and a report without the field infers nothing at all.
 *
 * A closed session leaves the record's live set (`sessionIds`) at once, so the next kickoff's
 * state block and the ticket's coding tools never name it, and the pool dispatcher is enqueued:
 * the ticket's session quota on the machine has room again.
 *
 * **A machine back.** A machine reporting while a record waits for it (`waiting_machine`,
 * `machine_offline`) enqueues the sweep, which resumes that work with a `machine_back_online`
 * wake; and a machine coming online — offline or unheard-from before this heartbeat, or
 * claiming a new connection — enqueues it when a live policy's queue waits on its pool.
 */

type WakingStatus = TicketWorkSessionJobPayload['status']

export type TicketWorkSessionWake = { reason?: string; sessionId: string; status: WakingStatus; turn: number }

const IN_PROGRESS: ReadonlySet<string> = new Set(['starting', 'working'])

/** The newest turn a report shows ended: its `turn`, or the one before while a turn runs. */
const endedTurnOf = (summary: ExecutorCodingSessionSummary): number | null => {
  if (summary.turn === undefined) return null
  return IN_PROGRESS.has(summary.status) ? summary.turn - 1 : summary.turn
}

/**
 * Which of the named sessions wake, and which closed, from two reports' sessions. `next` is
 * null when the new report does not carry the field. Pure: the transaction below reads and
 * writes around it.
 */
export const ticketWorkSessionWakes = (input: {
  named: ReadonlySet<string>
  next: readonly ExecutorCodingSessionSummary[] | null
  observed: ReadonlyMap<string, number>
  previous: readonly ExecutorCodingSessionSummary[]
}): { closed: string[]; wakes: TicketWorkSessionWake[] } => {
  const closed: string[] = []
  const wakes: TicketWorkSessionWake[] = []
  if (input.next === null) return { closed, wakes }
  const before = new Map(input.previous.map((session) => [session.sessionId, session]))
  const after = new Map(input.next.map((session) => [session.sessionId, session]))
  const complete = input.next.length < EXECUTOR_CODING_SESSION_REPORT_MAXIMUM
  for (const sessionId of input.named) {
    const was = before.get(sessionId)
    const now = after.get(sessionId)
    const lastKnownTurn = now?.turn ?? was?.turn ?? input.observed.get(sessionId) ?? 0
    if (!now) {
      // Only a session this machine listed can go missing from it, and only from a list
      // that could have held it.
      if (was && was.status !== 'closed' && complete) {
        closed.push(sessionId)
        wakes.push({ sessionId, status: 'closed', turn: lastKnownTurn })
      }
      continue
    }
    if (now.status === 'closed') {
      if (was?.status !== 'closed') {
        closed.push(sessionId)
        wakes.push({ sessionId, status: 'closed', turn: lastKnownTurn })
      }
      continue
    }
    if (IN_PROGRESS.has(now.status)) continue
    const baseline = (was ? endedTurnOf(was) : null) ?? input.observed.get(sessionId) ?? 0
    const turnEnded = now.turn !== undefined && now.turn > baseline
    const entered = was?.status !== now.status && (now.status === 'interrupted' || now.status === 'failed')
    if (turnEnded || entered) {
      wakes.push({
        sessionId,
        status: now.status as WakingStatus,
        turn: lastKnownTurn,
        ...(now.reason ? { reason: now.reason } : {}),
      })
    }
  }
  return { closed, wakes }
}

const numberMap = (value: Prisma.JsonValue | null | undefined): Map<string, number> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return new Map()
  return new Map(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === 'number'))
}

/** The bridge's sessions as this report states them, or null when it does not carry the field. */
const reportedSessionsOrNull = (report: ExecutorLocalMcpReport): readonly ExecutorCodingSessionSummary[] | null =>
  report.find((status) => status.server === EXECUTOR_CODING_SESSIONS_MCP_SERVER_NAME)?.codingSessions ?? null

const intakeSessionReport = async (
  tx: Prisma.TransactionClient,
  input: { localMcp: ExecutorLocalMcpReport; now: Date; previousLocalMcp: unknown },
): Promise<void> => {
  const next = reportedSessionsOrNull(input.localMcp)
  if (next === null) return
  const previous = reportedExecutorCodingSessions(input.previousLocalMcp)
  const seen = new Set([...previous, ...next].map((session) => session.sessionId))
  if (seen.size === 0) return
  const records = await tx.agentTicketWork.findMany({
    where: { sessionIds: { hasSome: [...seen] }, status: { in: [...TICKET_WORK_LIVE_STATUSES] } },
    select: { id: true, lastObservedTurn: true, organizationId: true, sessionIds: true },
  })
  let closedAny = false
  for (const record of records) {
    const { closed, wakes } = ticketWorkSessionWakes({
      named: new Set(record.sessionIds.filter((sessionId) => seen.has(sessionId))),
      next,
      observed: numberMap(record.lastObservedTurn),
      previous,
    })
    for (const wake of wakes) {
      const payload: TicketWorkSessionJobPayload = { organizationId: record.organizationId, workId: record.id, ...wake }
      await enqueueQueueJob(tx, {
        idempotencyKey: `session:${wake.sessionId}:${wake.turn}:${wake.status}`,
        payload,
        topic: TICKET_WORK_SESSION_TOPIC,
      })
    }
    for (const sessionId of closed) {
      await tx.$executeRaw(Prisma.sql`
        UPDATE agent_ticket_work SET session_ids = array_remove(session_ids, ${sessionId}), updated_at = now()
        WHERE id = ${record.id}::uuid`)
      closedAny = true
    }
  }
  if (closedAny) await enqueueTicketWorkSweep(tx, input.now)
}

/**
 * The machine is here: the sweep resumes the work waiting for it, and — when it has just come
 * online — places queued work on it. Nothing to do costs one indexed count.
 */
export const enqueueTicketWorkForMachineInTransaction = async (
  tx: Prisma.TransactionClient,
  input: { cameOnline: boolean; executorId: string; now: Date },
): Promise<void> => {
  // Only work the sweep would resume: a trigger switched off or in error keeps
  // its records and wakes none, and counting them would enqueue a sweep on
  // every heartbeat for as long as the machine stays up.
  const waiting = await tx.agentTicketWork.count({
    where: {
      executorId: input.executorId, stateReason: 'machine_offline', status: 'waiting_machine',
      trigger: { enabled: true, status: 'active' },
    },
  })
  if (waiting > 0) {
    await enqueueTicketWorkSweep(tx, input.now)
    return
  }
  if (!input.cameOnline) return
  const queuedOnItsPools = await tx.executorStandingPolicyExecutor.count({
    where: { executorId: input.executorId, policy: { status: 'live', ticketWork: { some: { status: 'queued' } } } },
  })
  if (queuedOnItsPools > 0) await enqueueTicketWorkSweep(tx, input.now)
}

/** Whether the machine was offline, or unheard-from long enough to count as offline, before this call. */
export const executorWasOffline = (
  executor: { lastSeenAt: Date | null; status: string },
  now: Date,
): boolean => executor.status === 'offline' || !executor.lastSeenAt || executor.lastSeenAt < executorHeartbeatCutoff(now)

/** The whole intake, as `reportExecutorHeartbeat` calls it after storing the report. */
export const intakeTicketWorkHeartbeatInTransaction = async (
  tx: Prisma.TransactionClient,
  input: {
    cameOnline: boolean
    executorId: string
    localMcp?: ExecutorLocalMcpReport
    now: Date
    previousLocalMcp: unknown
  },
): Promise<void> => {
  if (input.localMcp) {
    await intakeSessionReport(tx, {
      localMcp: input.localMcp, now: input.now, previousLocalMcp: input.previousLocalMcp,
    })
  }
  await enqueueTicketWorkForMachineInTransaction(tx, input)
}
