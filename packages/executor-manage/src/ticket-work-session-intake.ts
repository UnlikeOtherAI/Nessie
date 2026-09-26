import type { Prisma } from '@prisma/client'
import { enqueueQueueJob } from '@nessie/db'
import {
  EXECUTOR_CODING_SESSION_REPORT_MAXIMUM,
  EXECUTOR_CODING_SESSIONS_MCP_SERVER_NAME,
  TICKET_WORK_LIVE_STATUSES,
  TICKET_WORK_SESSION_TOPIC,
  ticketWorkCodingSessionContext,
  type ExecutorCodingSessionSummary,
  type ExecutorLocalMcpReport,
  type TicketWorkSessionJobPayload,
} from '@nessie/schemas'

import { reportedExecutorCodingSessions } from './executor-coding-session-closes.js'
import { executorCodingSessionOwnerKey } from './executor-coding-session-owner.js'
import { executorHeartbeatCutoff } from './executor-liveness.js'
import { enqueueTicketWorkSweep } from './executor-standing-policy-pool.js'
import { ticketWorkSessionOriginsOf } from './ticket-work-session-origins.js'
import { forgetTicketWorkSessionsInTransaction } from './ticket-work-session-release.js'

/**
 * The heartbeat's ticket-work intake (T5; docs/plans/2026-09-23-ticket-driven-agents/ticket-work.md
 * → "Session wakes (T5)"; docs/standards/ticket-work-machine-access.md). It runs inside the
 * heartbeat transaction, which already holds the machine's connection lock, so two reports of
 * one machine are never compared at once.
 *
 * **Only this machine's own tickets.** A report speaks for the machine that signed it, so it is
 * read only for the live records pinned to that machine in its organisation, and only for the
 * sessions recorded as started on that machine (`session_origins`) that it lists under their own
 * owner key (the author of the policy they were started under, the agent and the ticket's
 * context): another machine's report naming a record's session, or a session under any other
 * owner, wakes nothing and closes nothing.
 *
 * **Session wakes.** The previous and the new `codingSessions` are compared for those sessions,
 * and a `ticket-work.session` job is enqueued — idempotent on `session:<sessionId>:<turn>:<status>`,
 * so a repeated report wakes nothing twice — when:
 *
 * - the turn went up and the session is not `starting` or `working`. The turn a report shows
 *   ended is its `turn`, or the one before while a turn is still in progress, so a fast turn
 *   that began and ended between two reports (`waiting_for_input` turn 3, then turn 4) wakes
 *   exactly once, and a slow one (`working` turn 4, then `waiting_for_input` turn 4) too;
 * - it entered `interrupted` or `failed`, or reports itself `closed`;
 * - it is missing from a report that has the field, having been in the last report that had
 *   it: closed. A report at its row cap may have left it out, so there a missing session is
 *   unknown, not closed; and a report without the field infers nothing at all — nor does it
 *   erase what the last one said (`withLastKnownCodingSessions`).
 *
 * A closed session leaves the record's live set (`sessionIds`) at once, so the next kickoff's
 * state block and the ticket's coding tools never name it, and the pool dispatcher is enqueued:
 * the ticket's session quota on the machine has room again.
 *
 * **A machine back.** A machine reporting while a record waits for it (`waiting_machine`,
 * `machine_offline`) enqueues the sweep, which resumes that work with a `machine_back_online`
 * wake; and a machine coming online — offline or unheard-from before this heartbeat — enqueues it
 * when a live policy's queue waits on its pools. `claimExecutorConnection` calls the same enqueue
 * (`enqueueTicketWorkForMachineInTransaction`) when a claim brings an offline machine back.
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
 * null when the new report does not carry the field; `nextComplete` says whether the new list
 * could have held every session (it is below the row cap), which a caller that filtered it must
 * say from the whole list. Pure: the transaction below reads and writes around it.
 */
export const ticketWorkSessionWakes = (input: {
  named: ReadonlySet<string>
  next: readonly ExecutorCodingSessionSummary[] | null
  nextComplete?: boolean
  observed: ReadonlyMap<string, number>
  previous: readonly ExecutorCodingSessionSummary[]
}): { closed: string[]; wakes: TicketWorkSessionWake[] } => {
  const closed: string[] = []
  const wakes: TicketWorkSessionWake[] = []
  if (input.next === null) return { closed, wakes }
  const before = new Map(input.previous.map((session) => [session.sessionId, session]))
  const after = new Map(input.next.map((session) => [session.sessionId, session]))
  const complete = input.nextComplete ?? input.next.length < EXECUTOR_CODING_SESSION_REPORT_MAXIMUM
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

/**
 * The report to store: this one, except that a bridge entry which did not carry its sessions —
 * its probe failed this time — keeps the sessions the last report that had them listed, with that
 * report's `observedAt`. Absent means not asked, never none, and the next report is compared with
 * what was last known; `liveTicketWorkSessions` reads the sessions as of when they were read.
 */
export const withLastKnownCodingSessions = (
  stored: unknown,
  next: ExecutorLocalMcpReport,
): ExecutorLocalMcpReport => {
  const bridge = next.find((status) => status.server === EXECUTOR_CODING_SESSIONS_MCP_SERVER_NAME)
  if (!bridge || bridge.codingSessions !== undefined) return next
  const last = reportedExecutorCodingSessions(stored)
  const lastBridge = Array.isArray(stored)
    ? (stored as Array<{ codingSessions?: unknown; observedAt?: unknown; server?: unknown }>)
      .find((status) => (
        status.server === EXECUTOR_CODING_SESSIONS_MCP_SERVER_NAME && status.codingSessions !== undefined))
    : undefined
  if (!lastBridge) return next
  // The sessions keep the moment they were read: a session recorded since then is in no report yet.
  const observedAt = typeof lastBridge.observedAt === 'string' ? lastBridge.observedAt : bridge.observedAt
  return next.map((status) => (status === bridge ? { ...status, codingSessions: [...last], observedAt } : status))
}

const intakeSessionReport = async (
  tx: Prisma.TransactionClient,
  input: { executorId: string; localMcp: ExecutorLocalMcpReport; now: Date; previousLocalMcp: unknown },
): Promise<void> => {
  const next = reportedSessionsOrNull(input.localMcp)
  if (next === null) return
  const previous = reportedExecutorCodingSessions(input.previousLocalMcp)
  const seen = new Set([...previous, ...next].map((session) => session.sessionId))
  if (seen.size === 0) return
  const executor = await tx.executor.findUnique({ where: { id: input.executorId }, select: { organizationId: true } })
  if (!executor) return
  const records = await tx.agentTicketWork.findMany({
    where: {
      executorId: input.executorId,
      organizationId: executor.organizationId,
      policyId: { not: null },
      sessionIds: { hasSome: [...seen] },
      status: { in: [...TICKET_WORK_LIVE_STATUSES] },
    },
    select: {
      agentId: true, id: true, lastObservedTurn: true, organizationId: true, policyId: true, sessionIds: true,
      sessionOrigins: true, taskId: true,
    },
  })
  const authors = new Map((await tx.executorStandingPolicy.findMany({
    where: { id: { in: [...new Set(records.flatMap((record) => [
      ...(record.policyId ? [record.policyId] : []),
      ...Object.values(ticketWorkSessionOriginsOf(record.sessionOrigins)).map((origin) => origin.policyId),
    ]))] } },
    select: { authorUserId: true, id: true },
  })).map((policy) => [policy.id, policy.authorUserId]))
  const nextComplete = next.length < EXECUTOR_CODING_SESSION_REPORT_MAXIMUM
  let closedAny = false
  for (const record of records) {
    const origins = ticketWorkSessionOriginsOf(record.sessionOrigins)
    // Each session's own owner key on this machine — its machine and policy as recorded when it
    // started (`session_origins`), else the record's: one started on another machine, or listed
    // under any other owner, is not this report's to speak for.
    const expected = new Map<string, string>()
    for (const sessionId of record.sessionIds) {
      const origin = origins[sessionId]
      const policyId = origin?.policyId ?? record.policyId
      const actorUserId = policyId ? authors.get(policyId) : undefined
      const elsewhere = origin !== undefined && origin.executorId !== input.executorId
      if (!seen.has(sessionId) || elsewhere || !policyId || !actorUserId) continue
      expected.set(sessionId, executorCodingSessionOwnerKey(input.executorId, {
        actorUserId, agentId: record.agentId, contextId: ticketWorkCodingSessionContext(policyId, record.taskId),
      }))
    }
    if (expected.size === 0) continue
    const own = (sessions: readonly ExecutorCodingSessionSummary[]) =>
      sessions.filter((session) => expected.get(session.sessionId) === session.ownerKey)
    const { closed, wakes } = ticketWorkSessionWakes({
      named: new Set(expected.keys()),
      next: own(next),
      nextComplete,
      observed: numberMap(record.lastObservedTurn),
      previous: own(previous),
    })
    for (const wake of wakes) {
      const payload: TicketWorkSessionJobPayload = { organizationId: record.organizationId, workId: record.id, ...wake }
      await enqueueQueueJob(tx, {
        idempotencyKey: `session:${wake.sessionId}:${wake.turn}:${wake.status}`,
        payload,
        topic: TICKET_WORK_SESSION_TOPIC,
      })
    }
    await forgetTicketWorkSessionsInTransaction(tx, { sessionIds: closed, workId: record.id })
    closedAny ||= closed.length > 0
  }
  if (closedAny) await enqueueTicketWorkSweep(tx, input.now)
}

/**
 * The machine is here: the sweep resumes the work waiting for it, and — when it has just come
 * online — places queued work on it. Only work the sweep would act on counts (a trigger that is
 * on, active and an agent's), so a record the sweep leaves alone never makes every heartbeat
 * enqueue it. Nothing to do costs one indexed count.
 */
export const enqueueTicketWorkForMachineInTransaction = async (
  tx: Prisma.TransactionClient,
  input: { cameOnline: boolean; executorId: string; now: Date },
): Promise<void> => {
  const waiting = await tx.agentTicketWork.count({
    where: {
      executorId: input.executorId, stateReason: 'machine_offline', status: 'waiting_machine',
      trigger: { agentId: { not: null }, enabled: true, status: 'active' },
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
      executorId: input.executorId, localMcp: input.localMcp, now: input.now, previousLocalMcp: input.previousLocalMcp,
    })
  }
  await enqueueTicketWorkForMachineInTransaction(tx, input)
}
