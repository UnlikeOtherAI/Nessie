import { Prisma, type PrismaClient } from '@prisma/client'
import type { AgentTriggerActivityRecord, RunStatus } from '@nessie/schemas'

import { ACTIVE_RUN_STATUSES } from './run-access.js'

/**
 * What each of an agent's triggers is doing right now.
 *
 * **A trigger's execution is a run, and a run is never ambiguous.** Firing a
 * trigger writes an `AgentTriggerDelivery`; the run it starts carries both
 * `triggerId` and a `triggerDeliveryId` that the database keeps unique. So two
 * simultaneous executions of one trigger are simply two rows, each nameable by
 * its own delivery — there is nothing to disambiguate by timestamp, and no
 * reason for a surface to reduce them to a boolean. This returns the list; the
 * caller renders its length.
 *
 * Liveness is read from `ACTIVE_RUN_STATUSES`, the same set `GET
 * /api/runs/active` and the continuation guard use, so "still working" cannot
 * come to mean two different things in two places. `waiting_approval` and
 * `waiting_input` are in it deliberately: a run parked on an approval or a card
 * still holds its (agent, thread) slot and its work is unfinished, so its
 * trigger is still busy.
 */

type TerminalOutcome = NonNullable<AgentTriggerActivityRecord['lastOutcome']>

type LatestFinishedRow = {
  trigger_id: string
  status: TerminalOutcome
  finished_at: Date | null
}

const isTerminalOutcome = (status: RunStatus): status is TerminalOutcome =>
  status === 'completed' || status === 'failed' || status === 'cancelled'

/**
 * The newest finished run per trigger, in one pass. `DISTINCT ON` rides the
 * existing `runs (trigger_id, created_at)` index; fetching "the last N runs"
 * and picking in JavaScript would silently drop a quiet trigger whose noisy
 * neighbour filled the window.
 */
const findLatestFinishedRunByTrigger = async (
  prisma: PrismaClient,
  triggerIds: string[],
): Promise<Map<string, { finishedAt: Date | null; status: TerminalOutcome }>> => {
  if (triggerIds.length === 0) return new Map()

  const rows = await prisma.$queryRaw<LatestFinishedRow[]>(Prisma.sql`
    SELECT DISTINCT ON (r.trigger_id)
      r.trigger_id,
      r.status::text AS status,
      COALESCE(r.finished_at, r.started_at, r.created_at) AS finished_at
    FROM "runs" r
    WHERE r.trigger_id IN (${Prisma.join(
      triggerIds.map((triggerId) => Prisma.sql`${triggerId}::uuid`),
    )})
      AND r.status IN ('completed', 'failed', 'cancelled')
    ORDER BY r.trigger_id, r.created_at DESC, r.id DESC
  `)

  return new Map(
    rows.map((row) => [row.trigger_id, { finishedAt: row.finished_at, status: row.status }]),
  )
}

export const listAgentTriggerActivity = async (
  prisma: PrismaClient,
  agentId: string,
): Promise<AgentTriggerActivityRecord[]> => {
  const triggers = await prisma.agentTrigger.findMany({
    where: { agentId },
    select: { id: true },
    orderBy: [{ createdAt: 'asc' }],
  })
  const triggerIds = triggers.map((trigger) => trigger.id)
  if (triggerIds.length === 0) return []

  const [activeRuns, latestFinished] = await Promise.all([
    prisma.run.findMany({
      where: { status: { in: ACTIVE_RUN_STATUSES }, triggerId: { in: triggerIds } },
      select: {
        id: true,
        startedAt: true,
        status: true,
        triggerDeliveryId: true,
        triggerId: true,
      },
      orderBy: [{ createdAt: 'asc' }],
    }),
    findLatestFinishedRunByTrigger(prisma, triggerIds),
  ])

  const runningByTrigger = new Map<string, AgentTriggerActivityRecord['running']>()
  for (const run of activeRuns) {
    if (!run.triggerId) continue
    const entries = runningByTrigger.get(run.triggerId) ?? []
    entries.push({
      deliveryId: run.triggerDeliveryId,
      runId: run.id,
      startedAt: run.startedAt?.toISOString() ?? null,
      status: run.status,
    })
    runningByTrigger.set(run.triggerId, entries)
  }

  return triggerIds.map((triggerId) => {
    const finished = latestFinished.get(triggerId)
    return {
      lastFinishedAt: finished?.finishedAt?.toISOString() ?? null,
      // A status the enum does not name is dropped rather than coerced: an
      // unknown outcome must not render as success.
      lastOutcome: finished && isTerminalOutcome(finished.status) ? finished.status : null,
      running: runningByTrigger.get(triggerId) ?? [],
      triggerId,
    }
  })
}
