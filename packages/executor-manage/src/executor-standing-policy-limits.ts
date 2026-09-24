import { Prisma } from '@prisma/client'
import {
  StandingPolicyPinnedTermsSchema,
  TICKET_WORK_LIVE_STATUSES,
  type TicketWorkStateReason,
} from '@nessie/schemas'

import { enqueueTicketWorkSweep } from './executor-standing-policy-pool.js'
import { ticketWorkActiveMs } from './ticket-work-clock.js'
import { endTicketWork, writeTicketWorkThreadRow } from './ticket-work-records.js'
import { closeTicketWorkSessionsInTransaction } from './ticket-work-session-release.js'

/**
 * A ticket's work limits under its standing policy, enforced by the platform
 * and never the model (docs/plans/2026-09-23-ticket-driven-agents/ticket-work.md
 * → "Limits"; docs/standards/ticket-work-machine-access.md):
 *
 * - `ticketHours` against the record's hours clock (`ticket-work-clock.ts`):
 *   `activeMs` plus the stretch running now. The clock runs only while the
 *   record is `active` with no open question, so time `queued`,
 *   `waiting_machine`, `parked` (a person reviewing) or waiting for a
 *   person's answer is never counted.
 * - `ticketUsd` against `costUsd`: the coding cost the machine reported for
 *   each of the ticket's sessions since it was last counted — on its
 *   heartbeat (`ticket-work-heartbeat-costs.ts`) and in every coding answer
 *   that carries one (a send, a status read, a review) — and every Nessie
 *   run's own cost.
 * - `dailyUsd` against the policy's spend this UTC day
 *   (`executor_standing_policy_daily_spend`), which every addition to a
 *   record's cost also adds to. It fails only work that is running (`active`)
 *   with `limit_cost`, a spend limit, and says it was the day's: T1 gave
 *   `limit_daily` to the trigger's `startsPerDay`. Queued, parked or waiting
 *   work that did not spend it is left waiting, and a pickup or a dequeue on
 *   a spent day queues with `queued_daily_limit` instead
 *   (`placeTicketWorkOnMachineInTransaction`).
 *
 * Checked at every wake (the wake and the binder), in the heartbeat intake,
 * and by the sweep. Over a limit, the record fails with the limit's reason,
 * the ticket gets a `work_ended` row, the thread a "Stopped" row, and its
 * sessions session-scoped closes (`work_limit`), in one transaction.
 */

export type TicketWorkLimitBreach = {
  limit: 'dailyUsd' | 'ticketHours' | 'ticketUsd'
  reason: Extract<TicketWorkStateReason, 'limit_hours' | 'limit_cost'>
}

export type TicketWorkLimitState = {
  activeMs: number
  costUsd: number
  dailyUsd: number
  limits: { dailyUsd: number; ticketHours: number; ticketUsd: number }
}

type Client = Prisma.TransactionClient | Pick<Prisma.TransactionClient,
  'agentTicketWork' | 'executorStandingPolicy' | 'executorStandingPolicyDailySpend'>

export const utcDay = (at: Date): Date => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()))

/** Where a record stands against its policy's limits; null when no policy binds its work. */
export const loadTicketWorkLimitState = async (
  client: Client,
  input: { workId: string; now?: Date },
): Promise<TicketWorkLimitState | null> => {
  const now = input.now ?? new Date()
  const work = await client.agentTicketWork.findUnique({
    where: { id: input.workId },
    select: {
      activeMs: true, clockStartedAt: true, costUsd: true, policyId: true,
      policy: { select: { pinnedTerms: true } },
    },
  })
  if (!work?.policyId || !work.policy) return null
  const terms = StandingPolicyPinnedTermsSchema.safeParse(work.policy.pinnedTerms)
  if (!terms.success) return null
  const daily = await client.executorStandingPolicyDailySpend.findUnique({
    where: { policyId_day: { day: utcDay(now), policyId: work.policyId } },
    select: { costUsd: true },
  })
  return {
    activeMs: Number(ticketWorkActiveMs(work, now)),
    costUsd: Number(work.costUsd),
    dailyUsd: Number(daily?.costUsd ?? 0),
    limits: {
      dailyUsd: terms.data.limits.dailyUsd,
      ticketHours: terms.data.limits.ticketHours,
      ticketUsd: terms.data.limits.ticketUsd,
    },
  }
}

/**
 * The limit a record is over, or null. The day's spend stops only running
 * work: `running: false` (queued, parked, waiting) leaves it to the
 * placement, which queues on a spent day.
 */
export const ticketWorkLimitBreachOf = (
  state: TicketWorkLimitState | null,
  options: { running?: boolean } = {},
): TicketWorkLimitBreach | null => {
  if (!state) return null
  if (state.activeMs >= state.limits.ticketHours * 3_600_000) return { limit: 'ticketHours', reason: 'limit_hours' }
  if (state.costUsd >= state.limits.ticketUsd) return { limit: 'ticketUsd', reason: 'limit_cost' }
  if (options.running !== false && state.dailyUsd >= state.limits.dailyUsd) {
    return { limit: 'dailyUsd', reason: 'limit_cost' }
  }
  return null
}

const dollars = (amount: number): string => `$${Number.isInteger(amount) ? amount : amount.toFixed(2)}`

/** The "Stopped: …" line for a limit, as the thread and the ticket say it. */
export const ticketWorkLimitSentence = (breach: TicketWorkLimitBreach, state: TicketWorkLimitState): string => {
  const again = 'Move the ticket out of and back into a start-work column to continue'
  switch (breach.limit) {
    case 'ticketHours':
      return `${state.limits.ticketHours} hours of work used. ${again}`
    case 'ticketUsd':
      return `${dollars(state.limits.ticketUsd)} of coding and run cost used. ${again}`
    case 'dailyUsd':
      return `this machine access spent its ${dollars(state.limits.dailyUsd)} for today, so the work stopped. `
        + `${again}: it waits in the queue until the day's spend resets at 00:00 UTC`
  }
}

/**
 * Add spend to a record, and to its policy's day, in one transaction. A
 * record no policy binds keeps its own total only.
 */
export const addTicketWorkCostInTransaction = async (
  tx: Prisma.TransactionClient,
  input: { deltaUsd: number; now?: Date; workId: string },
): Promise<void> => {
  if (!(input.deltaUsd > 0)) return
  const delta = new Prisma.Decimal(input.deltaUsd.toFixed(8))
  const work = await tx.agentTicketWork.update({
    where: { id: input.workId },
    data: { costUsd: { increment: delta } },
    select: { policyId: true },
  })
  if (!work.policyId) return
  const day = utcDay(input.now ?? new Date())
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO executor_standing_policy_daily_spend (policy_id, day, cost_usd, updated_at)
    VALUES (${work.policyId}::uuid, ${day.toISOString().slice(0, 10)}::date, ${delta}, now())
    ON CONFLICT (policy_id, day)
    DO UPDATE SET cost_usd = executor_standing_policy_daily_spend.cost_usd + EXCLUDED.cost_usd, updated_at = now()`)
}

export type EndedOnLimit = TicketWorkLimitBreach & { threadId: string; workId: string }

/**
 * Fail every live record the `where` names that is over one of its policy's
 * limits, with its closes, rows and dispatcher, in the caller's transaction.
 */
export const enforceTicketWorkLimitsInTransaction = async (
  tx: Prisma.TransactionClient,
  input: { now?: Date; where: Prisma.AgentTicketWorkWhereInput },
): Promise<EndedOnLimit[]> => {
  const now = input.now ?? new Date()
  const records = await tx.agentTicketWork.findMany({
    where: { ...input.where, policyId: { not: null }, status: { in: [...TICKET_WORK_LIVE_STATUSES] } },
    select: {
      agentId: true, executorId: true, id: true, policyId: true, sessionIds: true, status: true, taskId: true,
      threadId: true, triggerId: true,
    },
  })
  const ended: EndedOnLimit[] = []
  for (const record of records) {
    const state = await loadTicketWorkLimitState(tx, { now, workId: record.id })
    const breach = ticketWorkLimitBreachOf(state, { running: record.status === 'active' })
    if (!breach || !state) continue
    await closeTicketWorkSessionsInTransaction(tx, [record], 'work_limit', null)
    if (!await endTicketWork(tx, { by: 'system', reason: breach.reason, status: 'failed', work: record })) continue
    await writeTicketWorkThreadRow(tx, {
      threadId: record.threadId,
      event: { kind: 'stopped', reason: breach.reason, summary: ticketWorkLimitSentence(breach, state), workId: record.id },
    })
    ended.push({ ...breach, threadId: record.threadId, workId: record.id })
  }
  if (ended.length > 0) await enqueueTicketWorkSweep(tx, now)
  return ended
}
