import type { PrismaClient } from '@prisma/client'
import {
  claimBoardWatchNotification,
  resolveBoardWatchRecipients,
  type BoardWatchEvent,
} from '@nessie/team-admin'

import { wakeBoardWatcherAgent } from './board-watch-wake.js'

/**
 * Telling a board's watchers that a ticket moved.
 *
 * The rules that decide who hears anything live in
 * `@nessie/team-admin` `board-watch-notify.ts` — which boards show the task,
 * which watchers they carry, and which of those may actually read it. This is
 * the delivery half: it claims the telling so it happens once, then writes the
 * durable bell.
 *
 * The bell is durable rather than push-only for the reason the other alert
 * kinds state: somebody explicitly asked to be told, and a push at 06:00 is
 * missable. `eventKey` makes the row itself idempotent, so a retry that gets
 * past the claim still cannot double-ring.
 */

export type BoardWatchDelivery = 'sweep' | 'webhook'

export const notifyBoardWatchers = async (
  prisma: PrismaClient,
  events: BoardWatchEvent[],
  options: { delivery: BoardWatchDelivery },
): Promise<{ told: number }> => {
  if (events.length === 0) return { told: 0 }

  // Claim first. A sweep page and a webhook can both apply one change — the
  // notify runs after the apply transaction commits, so nothing else keys on
  // it — and both would otherwise tell the same people the same news.
  const claimed: BoardWatchEvent[] = []
  for (const event of events) {
    if (await claimBoardWatchNotification(prisma, event)) claimed.push(event)
  }
  if (claimed.length === 0) return { told: 0 }

  const recipients = await resolveBoardWatchRecipients(prisma, claimed)
  if (recipients.length === 0) return { told: 0 }

  const organizationId = claimed[0]!.organizationId
  const projectId = claimed[0]!.projectId

  // A sweep is reconciliation and may carry a backlog after an outage, so its
  // watchers hear one bell naming the board; a webhook is "this one changed
  // just now", which is the per-ticket case somebody actually asked for.
  const rows = recipients.flatMap((recipient) => {
    if (recipient.kind !== 'user') return []
    if (options.delivery === 'sweep') {
      return [{
        organizationId,
        userId: recipient.userId,
        kind: 'board_ticket_changed' as const,
        projectId,
        taskId: recipient.taskIds[0] ?? null,
        eventKey: `board-watch:sweep:${recipient.boardId}:${recipient.userId}:${claimed[0]!.fingerprint}`,
      }]
    }
    return recipient.taskIds.map((taskId) => ({
      organizationId,
      userId: recipient.userId,
      kind: 'board_ticket_changed' as const,
      projectId,
      taskId,
      eventKey: `board-watch:${taskId}:${recipient.userId}:${
        claimed.find((event) => event.taskId === taskId)?.fingerprint ?? ''
      }`,
    }))
  })

  const result = rows.length > 0
    ? await prisma.userAlert.createMany({ data: rows, skipDuplicates: true })
    : { count: 0 }

  // Agents are woken rather than told: an agent that cannot act on the news is
  // a mailing list. The wake takes the same per-(agent, thread) claim a chat
  // reply does, so a busy board costs one run at a time per agent — the ticket
  // that arrives mid-run is batched into the follow-up instead of racing it.
  let woken = 0
  for (const recipient of recipients) {
    if (recipient.kind !== 'agent') continue
    const board = await prisma.board.findUnique({
      where: { id: recipient.boardId },
      select: { name: true },
    })
    // One recipient's failure must not cancel the rest: the alerts are already
    // written, and a DM race is nothing the other watchers did wrong.
    let outcome: Awaited<ReturnType<typeof wakeBoardWatcherAgent>>
    try {
      outcome = await wakeBoardWatcherAgent(prisma, {
        addedByUserId: recipient.addedByUserId,
        agentId: recipient.agentId,
        boardId: recipient.boardId,
        boardName: board?.name ?? 'a board',
        channelId: recipient.channelId,
        launchOrigin: recipient.launchOrigin,
        organizationId,
        projectId,
        taskIds: recipient.taskIds,
        threadId: recipient.threadId,
      })
    } catch (cause) {
      console.error('[board-watch] wake failed', {
        agentId: recipient.agentId,
        boardId: recipient.boardId,
        error: cause instanceof Error ? cause.message : String(cause),
      })
      continue
    }
    if (outcome === 'unreachable') {
      // A watcher that can never fire looks exactly like a live one on the
      // settings page. Said out loud rather than counted as nothing.
      console.warn('[board-watch] agent watcher is unreachable', {
        agentId: recipient.agentId,
        boardId: recipient.boardId,
      })
      continue
    }
    woken += 1
  }

  return { told: result.count + woken }
}
