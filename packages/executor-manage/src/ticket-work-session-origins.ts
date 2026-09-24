import type { Prisma } from '@prisma/client'
import { TicketWorkSessionOriginSchema, type TicketWorkSessionOrigin } from '@nessie/schemas'

import { reportedExecutorCodingSessions } from './executor-coding-session-closes.js'

/**
 * Where and when each of a ticket's coding sessions started
 * (`agent_ticket_work.session_origins`; docs/standards/ticket-work-machine-access.md
 * → "Session isolation"): its machine, the policy whose owner context it was
 * started under, and the moment the worker recorded it.
 *
 * - A session is closed on **its own** machine under its own policy's owner
 *   context, whichever machine the record holds now: a record handed to
 *   another machine after its policy was re-confirmed leaves nothing open on
 *   the first (`closeTicketWorkSessionsInTransaction`).
 * - A recorded session counts as **live** unless a report the machine took
 *   after it was recorded says otherwise (`liveTicketWorkSessions`). The
 *   machine reports on its heartbeat, so a session started a moment ago is in
 *   no report yet; reading "not in the report" as "closed" let a weak model
 *   start a second session for the same ticket.
 */

/** The stored origins, each entry checked on its own: an unreadable one is as if absent. */
export const ticketWorkSessionOriginsOf = (value: unknown): Record<string, TicketWorkSessionOrigin> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const origins: Record<string, TicketWorkSessionOrigin> = {}
  for (const [sessionId, entry] of Object.entries(value)) {
    const origin = TicketWorkSessionOriginSchema.safeParse(entry)
    if (origin.success) origins[sessionId] = origin.data
  }
  return origins
}

/** One entry to merge into `session_origins` (`session_origins || <this>`). */
export const ticketWorkSessionOriginEntry = (
  sessionId: string,
  origin: { executorId: string; policyId: string; startedAt: Date },
): Prisma.InputJsonObject => ({
  [sessionId]: { executorId: origin.executorId, policyId: origin.policyId, startedAt: origin.startedAt.toISOString() },
})

export type LiveTicketWorkSession = {
  sessionId: string
  /** As the machine last reported it; `starting` for one recorded since that report. */
  status: string
  turn: number | null
}

/**
 * The ticket's sessions that are live on this machine: each recorded session
 * started here (or with no origin on record, from before origins were kept),
 * open in the machine's last report — or missing from a report taken before
 * it was recorded. A session this ticket's owner key holds that the record
 * missed (a start whose answer was lost) is live while the report shows it
 * open. A session started on another machine is never live here.
 */
export const liveTicketWorkSessions = (input: {
  executorId: string
  localMcp: unknown
  localMcpObservedAt: Date | null
  origins: Record<string, TicketWorkSessionOrigin>
  ownerKey: string
  sessionIds: readonly string[]
}): LiveTicketWorkSession[] => {
  const reported = new Map(reportedExecutorCodingSessions(input.localMcp)
    .filter((session) => session.ownerKey === input.ownerKey)
    .map((session) => [session.sessionId, session]))
  // The sessions as of when the bridge was last read: a report whose bridge went unasked keeps the
  // sessions, and the time, of the last one that asked it (`withLastKnownCodingSessions`, T5).
  const bridgeAt = Array.isArray(input.localMcp)
    ? Date.parse(String((input.localMcp as Array<{ codingSessions?: unknown; observedAt?: unknown; server?: unknown }>)
      .find((status) => status.codingSessions !== undefined)?.observedAt ?? ''))
    : Number.NaN
  const reportAt = input.localMcpObservedAt?.getTime() ?? null
  const reportedAt = reportAt !== null && Number.isFinite(bridgeAt) ? Math.min(reportAt, bridgeAt) : reportAt
  const live: LiveTicketWorkSession[] = []
  for (const sessionId of input.sessionIds) {
    const origin = input.origins[sessionId]
    if (origin && origin.executorId !== input.executorId) continue
    const session = reported.get(sessionId)
    if (session) {
      if (session.status !== 'closed') live.push({ sessionId, status: session.status, turn: session.turn ?? null })
      continue
    }
    const startedAt = origin ? Date.parse(origin.startedAt) : null
    const reportPredatesIt = reportedAt === null || (startedAt !== null && startedAt >= reportedAt)
    // No origin and a report that does not list it: from before origins were kept, and gone.
    if (reportPredatesIt && (origin || input.localMcp == null)) live.push({ sessionId, status: 'starting', turn: null })
  }
  for (const [sessionId, session] of reported) {
    if (!input.sessionIds.includes(sessionId) && session.status !== 'closed') {
      live.push({ sessionId, status: session.status, turn: session.turn ?? null })
    }
  }
  return live
}

/**
 * The machine a record last worked on: the one it holds, else the one its
 * newest coding session was started on, while that machine is in the pool.
 * Null for a record with no machine of its own. The record goes back to it
 * first, and waits for it only while it could take the record back
 * (docs/standards/ticket-work-machine-access.md → "The dequeue").
 */
export const homeMachineOf = (
  work: { executorId: string | null; sessionOrigins: unknown },
  pool: ReadonlySet<string>,
): string | null => {
  if (work.executorId && pool.has(work.executorId)) return work.executorId
  const newest = Object.values(ticketWorkSessionOriginsOf(work.sessionOrigins))
    .filter((origin) => pool.has(origin.executorId))
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0]
  return newest?.executorId ?? null
}
