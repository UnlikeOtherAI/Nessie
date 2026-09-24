import type { Prisma, PrismaClient } from '@prisma/client'
import { agentClosedTicketWorkSessions } from '@nessie/executor-manage'
import {
  TicketChangedStoredConfigSchema,
  type TicketWorkSessionJobPayload,
  type TicketWorkWakeReason,
} from '@nessie/schemas'

import { settleTicketDelivery, type DeliveryBase } from './ticket-trigger-settle.js'
import { createTicketWorkSeam } from './ticket-work.js'
import type { TicketWorkSeam } from './ticket-work-seam.js'
import type { RetryContext } from './trigger-run.js'
import { lockThreadRunSlot } from '../run/thread-serialization.js'

/**
 * `ticket-work.session`: one of a ticket's own coding sessions ended a turn,
 * was interrupted, failed or closed, as its machine's heartbeat reported it
 * (docs/plans/2026-09-23-ticket-driven-agents/ticket-work.md → "Session wakes
 * (T5)"; the intake is `ticket-work-session-intake.ts` in executor-manage).
 *
 * The record is woken through the ticket-work seam — so its limits, its
 * machine, the target channel and the wake budget are checked as for any
 * other wake, and the wake counts against `wakesPerTicket` — with the reason
 * the status names and one line of what happened. Exactly one delivery row per
 * report of it, deduped on the job's own key, `session:<id>:<turn>:<status>`.
 * It is skipped (`no_longer_applies`, the row says so) when the record is no
 * longer `active` — parked, queued, waiting for its machine or ended — when a
 * turn-ended wake's turn, or a later one, was already seen to end by a wait or
 * review of the agent's own (`lastObservedTurn`), and when a closed session is
 * one the agent closed itself: the agent knows, and a second wake would only
 * repeat it. An interruption or a failure always wakes. All of it is read
 * under the thread's run slot, the lock the tools' observation writes under —
 * and a wait that sees the turn while this wake still pends behind its run
 * withdraws it (`ticket-work-session-withdraw.ts`).
 *
 * Nothing the session said reaches the wake: only its turn, its status and a
 * categorical reason. The agent reads the rest with its coding tools.
 */

const REASON_OF: Record<TicketWorkSessionJobPayload['status'], TicketWorkWakeReason> = {
  waiting_for_input: 'session_turn_ended',
  interrupted: 'session_interrupted',
  failed: 'session_failed',
  closed: 'session_closed',
}

/** "turn 4 ended", "interrupted: max_turn_minutes", "failed", "closed" — the wake row's one line. */
export const ticketWorkSessionWakeSummary = (wake: Pick<TicketWorkSessionJobPayload, 'reason' | 'status' | 'turn'>): string => {
  switch (wake.status) {
    case 'waiting_for_input': return `the coding session's turn ${wake.turn} ended`
    case 'interrupted': return `the coding session was interrupted${wake.reason ? `: ${wake.reason}` : ''}`
    case 'failed': return `the coding session failed${wake.reason ? `: ${wake.reason}` : ''}`
    case 'closed': return 'the coding session closed'
  }
}

/** What the reason codes an interruption carries mean for the next step: the plan's glossary. */
const INTERRUPTED_BECAUSE: Readonly<Record<string, string>> = {
  max_turn_minutes: 'It hit its per-turn time limit and can resume: send it "continue".',
  host_lost: 'Its machine restarted under it: send it "continue where you left off".',
}

const wakeText = (wake: TicketWorkSessionJobPayload): string => {
  switch (wake.status) {
    case 'waiting_for_input':
      return `This ticket's coding session ended turn ${wake.turn} and waits for its next instruction. Read what it `
        + 'said with coding_session_wait, then send it what the work needs next, or check the pull request.'
    case 'interrupted':
      return `This ticket's coding session was interrupted in turn ${wake.turn}${wake.reason ? ` (${wake.reason})` : ''}. `
        + (INTERRUPTED_BECAUSE[wake.reason ?? ''] ?? 'Read what it said with coding_session_wait before you decide.')
    case 'failed':
      return `This ticket's coding session failed${wake.reason ? ` (${wake.reason})` : ''} and cannot continue. Start `
        + 'a new session whose brief says what was already done, and the pull request if there is one.'
    case 'closed':
      return 'This ticket\'s coding session closed. If the work still needs a coding agent, start a new session whose '
        + 'brief says what was already done.'
  }
}

const observedTurn = (value: Prisma.JsonValue | null | undefined, sessionId: string): number | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const turn = (value as Record<string, unknown>)[sessionId]
  return typeof turn === 'number' ? turn : undefined
}

export const dispatchTicketWorkSession = async (
  prisma: PrismaClient,
  wake: TicketWorkSessionJobPayload,
  options: { now?: Date; retry?: RetryContext; seam?: TicketWorkSeam } = {},
): Promise<void> => {
  const record = await prisma.agentTicketWork.findUnique({
    where: { id: wake.workId },
    select: {
      agentId: true, id: true, organizationId: true, projectId: true, taskId: true, threadId: true,
      trigger: {
        select: { agentId: true, config: true, enabled: true, id: true, status: true, targetChannelId: true },
      },
    },
  })
  const trigger = record?.trigger
  // A record or trigger gone since the report: nothing to deliver against.
  if (!record || !trigger?.agentId) return
  const agentId = trigger.agentId
  const base: DeliveryBase = {
    eventType: 'session',
    originKind: 'system',
    session: {
      sessionId: wake.sessionId, status: wake.status, turn: wake.turn, ...(wake.reason ? { reason: wake.reason } : {}),
    },
    taskId: record.taskId,
  }
  const dedupeKey = `session:${wake.sessionId}:${wake.turn}:${wake.status}`
  const retry = options.retry ? { retry: options.retry } : {}
  const config = TicketChangedStoredConfigSchema.safeParse(trigger.config)
  // A trigger switched off ends its work; one in error keeps it and wakes none of it.
  const refusal = !config.success ? 'config_invalid' as const
    : !trigger.enabled || trigger.status !== 'active' ? 'trigger_disabled' as const
      : null
  if (refusal || !config.success) {
    await settleTicketDelivery(prisma, {
      base, decision: { kind: 'skip', reason: refusal ?? 'config_invalid', source: 'session' }, dedupeKey,
      triggerId: trigger.id, ...retry,
    })
    return
  }
  const seam = options.seam ?? createTicketWorkSeam(prisma)
  const reason = REASON_OF[wake.status]
  await settleTicketDelivery(prisma, {
    base,
    decision: { kind: 'follow', source: 'session', untrusted: false, wakeReason: reason, workId: record.id },
    dedupeKey,
    triggerId: trigger.id,
    ...retry,
    act: async (tx, deliveryId) => {
      await lockThreadRunSlot(tx, { agentId, threadId: record.threadId })
      const fresh = await tx.agentTicketWork.findUnique({
        where: { id: record.id }, select: { lastObservedTurn: true, status: true },
      })
      const seen = observedTurn(fresh?.lastObservedTurn, wake.sessionId)
      const alreadySeen = wake.status === 'waiting_for_input' && seen !== undefined && wake.turn <= seen
      const closedItself = wake.status === 'closed'
        && agentClosedTicketWorkSessions(fresh?.lastObservedTurn).includes(wake.sessionId)
      if (fresh?.status !== 'active' || alreadySeen || closedItself) {
        return { outcome: 'refused', reason: 'no_longer_applies' }
      }
      return seam.wakeTicketWork(tx, {
        deliveryId,
        event: {
          createdAt: options.now ?? new Date(),
          described: { summary: ticketWorkSessionWakeSummary(wake), text: wakeText(wake) },
          eventType: 'session',
          id: wake.sessionId,
          kind: 'session',
          session: { sessionId: wake.sessionId, turn: wake.turn },
        },
        machineLess: false,
        reason,
        resumes: false,
        task: { id: record.taskId, projectId: record.projectId },
        trigger: {
          agentId, config: config.data, id: trigger.id, organizationId: record.organizationId,
          targetChannelId: trigger.targetChannelId,
        },
        untrusted: false,
        workId: record.id,
      })
    },
  })
}
