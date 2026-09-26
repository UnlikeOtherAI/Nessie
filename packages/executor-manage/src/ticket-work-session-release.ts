import { Prisma } from '@prisma/client'
import { ticketWorkCodingSessionContext, type ExecutorCodingSessionCloseReason } from '@nessie/schemas'

import { requestExecutorCodingSessionCloseForSessionsInTransaction } from './executor-coding-session-closes.js'
import { ticketWorkSessionOriginsOf } from './ticket-work-session-origins.js'

/**
 * A ticket's coding sessions, closed by the platform
 * (docs/standards/ticket-work.md → "Teardown, limits and session closes are
 * the platform's"; docs/standards/ticket-work-machine-access.md).
 *
 * A close request is session-scoped, on **the session's own** machine and
 * named by its ticket's owner context under the policy it was started under
 * (`session_origins`), whichever machine the record holds now — so nothing
 * else of its author's is named, and a record handed to another machine
 * leaves nothing open on the first. A session from before origins were kept
 * closes on the record's machine, under its policy.
 *
 * A record that leaves the machine its sessions run on — unpinned, or pinned
 * to another (T5) — also forgets them (`releaseTicketWorkSessionsInTransaction`):
 * they leave `session_ids`, so a heartbeat of that machine wakes the record
 * for none of them and none of them counts as the ticket's own live session
 * wherever the work goes next. Their `session_origins` entries stay: the
 * heartbeat's cost intake charges a released session until its machine
 * reports it closed (`ticket-work-heartbeat-costs.ts`).
 */

type SessionRecord = {
  agentId: string
  executorId: string | null
  id: string
  policyId: string | null
  sessionIds: readonly string[]
  taskId: string
}

export const closeTicketWorkSessionsInTransaction = async (
  tx: Prisma.TransactionClient,
  records: readonly SessionRecord[],
  reason: ExecutorCodingSessionCloseReason,
  requestedByUserId: string | null,
): Promise<void> => {
  const withSessions = records.filter((record) => record.sessionIds.length > 0)
  if (withSessions.length === 0) return
  const stored = new Map((await tx.agentTicketWork.findMany({
    where: { id: { in: withSessions.map((record) => record.id) } },
    select: { id: true, sessionOrigins: true },
  })).map((row) => [row.id, ticketWorkSessionOriginsOf(row.sessionOrigins)]))
  type Group = { agentId: string; executorId: string; policyId: string; sessionIds: string[]; taskId: string }
  const groups = new Map<string, Group>()
  for (const record of withSessions) {
    const origins = stored.get(record.id) ?? {}
    for (const sessionId of record.sessionIds) {
      const executorId = origins[sessionId]?.executorId ?? record.executorId
      const policyId = origins[sessionId]?.policyId ?? record.policyId
      if (!executorId || !policyId) continue
      const key = `${record.id}:${executorId}:${policyId}`
      const group = groups.get(key)
        ?? { agentId: record.agentId, executorId, policyId, sessionIds: [], taskId: record.taskId }
      group.sessionIds.push(sessionId)
      groups.set(key, group)
    }
  }
  if (groups.size === 0) return
  const authors = new Map((await tx.executorStandingPolicy.findMany({
    where: { id: { in: [...new Set([...groups.values()].map((group) => group.policyId))] } },
    select: { authorUserId: true, id: true },
  })).map((policy) => [policy.id, policy.authorUserId]))
  for (const group of groups.values()) {
    const actorUserId = authors.get(group.policyId)
    if (!actorUserId) continue
    await requestExecutorCodingSessionCloseForSessionsInTransaction(tx, {
      executorId: group.executorId,
      owner: {
        actorUserId,
        agentId: group.agentId,
        contextId: ticketWorkCodingSessionContext(group.policyId, group.taskId),
      },
      reason,
      requestedByUserId,
      sessionIds: group.sessionIds,
    })
  }
}

/**
 * These sessions leave the record's live set: no report of them wakes it again, nor counts as its own.
 * Their origins stay, so what they go on costing until their close is confirmed is still charged.
 */
export const forgetTicketWorkSessionsInTransaction = async (
  tx: Pick<Prisma.TransactionClient, '$executeRaw'>,
  input: { sessionIds: readonly string[]; workId: string },
): Promise<void> => {
  for (const sessionId of new Set(input.sessionIds)) {
    await tx.$executeRaw(Prisma.sql`
      UPDATE agent_ticket_work SET session_ids = array_remove(session_ids, ${sessionId}), updated_at = now()
      WHERE id = ${input.workId}::uuid`)
  }
}

/** Close the sessions these records started, each on its own machine, and forget them: each record is leaving it. */
export const releaseTicketWorkSessionsInTransaction = async (
  tx: Prisma.TransactionClient,
  records: readonly SessionRecord[],
  reason: ExecutorCodingSessionCloseReason,
  requestedByUserId: string | null,
): Promise<void> => {
  await closeTicketWorkSessionsInTransaction(tx, records, reason, requestedByUserId)
  for (const record of records) {
    await forgetTicketWorkSessionsInTransaction(tx, { sessionIds: record.sessionIds, workId: record.id })
  }
}
