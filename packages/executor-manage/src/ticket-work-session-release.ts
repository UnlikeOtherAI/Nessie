import { Prisma } from '@prisma/client'
import { ticketWorkCodingSessionContext, type ExecutorCodingSessionCloseReason } from '@nessie/schemas'

import { requestExecutorCodingSessionCloseForSessionsInTransaction } from './executor-coding-session-closes.js'

/**
 * A ticket's coding sessions, closed by the platform
 * (docs/standards/ticket-work.md → "Teardown, limits and session closes are
 * the platform's"; docs/standards/ticket-work-machine-access.md).
 *
 * A close request is session-scoped, on the machine the record is pinned to,
 * and named by the ticket's owner context under the policy that pinned it, so
 * nothing else of its author's is named. A record that leaves that machine —
 * unpinned, or pinned to another (T5) — also forgets its sessions there
 * (`releaseTicketWorkSessionsInTransaction`): a heartbeat of that machine then
 * wakes the record for none of them, and none of them counts as the ticket's
 * own live session wherever the work goes next.
 */

type SessionRecord = {
  agentId: string
  executorId: string | null
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
  const withSessions = records.filter((record) => record.executorId && record.policyId && record.sessionIds.length > 0)
  if (withSessions.length === 0) return
  const authors = new Map((await tx.executorStandingPolicy.findMany({
    where: { id: { in: [...new Set(withSessions.map((record) => record.policyId as string))] } },
    select: { authorUserId: true, id: true },
  })).map((policy) => [policy.id, policy.authorUserId]))
  for (const record of withSessions) {
    const actorUserId = authors.get(record.policyId as string)
    if (!actorUserId) continue
    await requestExecutorCodingSessionCloseForSessionsInTransaction(tx, {
      executorId: record.executorId as string,
      owner: {
        actorUserId,
        agentId: record.agentId,
        contextId: ticketWorkCodingSessionContext(record.policyId as string, record.taskId),
      },
      reason,
      requestedByUserId,
      sessionIds: [...record.sessionIds],
    })
  }
}

/** These sessions leave the record's live set: no report of them wakes it again, nor counts as its own. */
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

/** Close the sessions these records started on their machine, and forget them: each record is leaving it. */
export const releaseTicketWorkSessionsInTransaction = async (
  tx: Prisma.TransactionClient,
  records: readonly (SessionRecord & { id: string })[],
  reason: ExecutorCodingSessionCloseReason,
  requestedByUserId: string | null,
): Promise<void> => {
  await closeTicketWorkSessionsInTransaction(tx, records, reason, requestedByUserId)
  for (const record of records) {
    await forgetTicketWorkSessionsInTransaction(tx, { sessionIds: record.sessionIds, workId: record.id })
  }
}
