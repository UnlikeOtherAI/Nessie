import { Prisma } from '@prisma/client'
import { ticketWorkCodingSessionContext, type ExecutorLocalMcpReport } from '@nessie/schemas'

import { reportedExecutorCodingSessions } from './executor-coding-session-closes.js'
import { executorCodingSessionOwnerKey } from './executor-coding-session-owner.js'
import { addTicketWorkCostInTransaction } from './executor-standing-policy-limits.js'
import { ticketWorkSessionOriginsOf } from './ticket-work-session-origins.js'

/**
 * The heartbeat's cost intake (docs/standards/ticket-work-machine-access.md →
 * "Server-side closes, limits and spend"): every coding session the machine
 * reports carries what it has cost so far (`totalCostUsd`), and each ticket's
 * sessions on this machine add what they cost since they were last counted to
 * the ticket's `costUsd` and its policy's day — whether or not a run reads the
 * session. A ticket whose agent started a session and ended its turn is still
 * charged while the coding agent works, so `ticketUsd` and `dailyUsd` stop it
 * on the machine's own report, in the same transaction.
 *
 * A session counts only for the ticket whose owner key filed it on this
 * machine: its own machine and policy (`session_origins`), else the record's.
 * A session the record let go of (T5: it left `session_ids` when the work left
 * its machine, or its agent closed it) keeps its origin, and is charged until
 * its machine stops reporting it — what it cost up to its close is the ticket's.
 * `session_costs` keeps the newest total per session, so this and the
 * worker's own reading of a coding answer (`recordTicketWorkSessionObservation`)
 * never count the same dollars twice.
 */

const numberMap = (value: Prisma.JsonValue | null | undefined): Record<string, number> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === 'number'))
}

/** Add the reported sessions' new cost to their tickets; the ids of the records it changed. */
export const recordTicketWorkHeartbeatCostsInTransaction = async (
  tx: Prisma.TransactionClient,
  input: { executorId: string; localMcp: ExecutorLocalMcpReport | undefined; now: Date },
): Promise<string[]> => {
  const costed = new Map(reportedExecutorCodingSessions(input.localMcp)
    .filter((session) => typeof session.totalCostUsd === 'number')
    .map((session) => [session.sessionId, session]))
  if (costed.size === 0) return []
  const reported = Prisma.sql`ARRAY[${Prisma.join([...costed.keys()])}]::text[]`
  const candidates = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id::text AS id FROM agent_ticket_work
    WHERE session_ids && ${reported} OR jsonb_exists_any(session_origins, ${reported})
    ORDER BY id`)
  const changed: string[] = []
  for (const { id } of candidates) {
    await tx.$queryRaw(Prisma.sql`SELECT id FROM agent_ticket_work WHERE id = ${id}::uuid FOR UPDATE`)
    const work = await tx.agentTicketWork.findUnique({
      where: { id },
      select: {
        agentId: true, executorId: true, policyId: true, sessionCosts: true, sessionIds: true, sessionOrigins: true,
        taskId: true,
      },
    })
    if (!work) continue
    const origins = ticketWorkSessionOriginsOf(work.sessionOrigins)
    const costs = numberMap(work.sessionCosts)
    const next = { ...costs }
    let delta = 0
    for (const sessionId of new Set([...work.sessionIds, ...Object.keys(origins)])) {
      const session = costed.get(sessionId)
      const policyId = origins[sessionId]?.policyId ?? work.policyId
      const machine = origins[sessionId]?.executorId ?? work.executorId
      if (!session || !policyId || machine !== input.executorId) continue
      const author = await tx.executorStandingPolicy.findUnique({
        where: { id: policyId }, select: { authorUserId: true },
      })
      if (!author || session.ownerKey !== executorCodingSessionOwnerKey(input.executorId, {
        actorUserId: author.authorUserId,
        agentId: work.agentId,
        contextId: ticketWorkCodingSessionContext(policyId, work.taskId),
      })) continue
      const total = session.totalCostUsd as number
      if (total > (costs[sessionId] ?? 0)) {
        delta += total - (costs[sessionId] ?? 0)
        next[sessionId] = total
      }
    }
    if (delta <= 0) continue
    await tx.agentTicketWork.update({ where: { id }, data: { sessionCosts: next } })
    await addTicketWorkCostInTransaction(tx, { deltaUsd: delta, now: input.now, workId: id })
    changed.push(id)
  }
  return changed
}
