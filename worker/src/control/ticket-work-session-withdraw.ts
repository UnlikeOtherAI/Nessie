import type { Prisma } from '@prisma/client'
import type { ObservedSessionTurn } from '@nessie/executor-manage'
import type { TicketWorkKickoffEvent } from '@nessie/schemas'

import { loadTicketWorkKickoffFacts, renderTicketWorkKickoff } from './ticket-work-kickoff.js'
import { findPendingKickoff, kickoffMetadata } from './ticket-work-run.js'

/**
 * A turn-ended session wake the agent no longer needs (T5;
 * docs/standards/ticket-work-machine-access.md → "Session wakes"): a wait or a
 * review of its own read that turn end while the wake still pended behind the
 * run making it. The session job that wrote the wake read the record before the
 * agent's run had seen the turn; without this, the next run would be told
 * again what the agent already acted on.
 *
 * Called from the tools' observation, under the thread's run slot — the lock
 * every wake folds or pends under, and every drain claims under — so the
 * kickoff is either still pending here or not written yet (and the job, which
 * reads the observed turn under the same lock, then writes none). Each seen
 * event leaves the kickoff: its delivery is written `skipped`
 * (`no_longer_applies`) and its `woken` row leaves the thread. A kickoff left
 * with nothing goes whole — its message and the pending row with it — and the
 * wake it counted against `wakesPerTicket` is given back. Returns how many
 * events were withdrawn.
 */

const seenBy = (seen: ObservedSessionTurn) => (event: TicketWorkKickoffEvent): boolean =>
  event.reason === 'session_turn_ended' && event.session?.sessionId === seen.sessionId
  && event.session.turn <= seen.turn

type WokenRowMetadata = { ticketWorkEvent?: { kind?: unknown; session?: { turn?: unknown }; workId?: unknown } }

export const withdrawSeenSessionWakes = async (
  tx: Prisma.TransactionClient,
  input: { agentId: string; seen: ObservedSessionTurn; threadId: string; workId: string },
): Promise<number> => {
  const pending = await findPendingKickoff(tx, input)
  const kickoff = pending ? kickoffMetadata(pending.metadata) : null
  if (!pending || !kickoff) return 0
  const withdrawn = kickoff.events.filter(seenBy(input.seen))
  if (withdrawn.length === 0) return 0
  const remaining = kickoff.events.filter((event) => !seenBy(input.seen)(event))

  for (const event of withdrawn) {
    const delivery = await tx.agentTriggerDelivery.findUnique({
      where: { id: event.session!.deliveryId }, select: { payload: true },
    })
    if (!delivery) continue
    const payload = delivery.payload && typeof delivery.payload === 'object' && !Array.isArray(delivery.payload)
      ? delivery.payload
      : {}
    await tx.agentTriggerDelivery.update({
      where: { id: event.session!.deliveryId },
      data: {
        errorMessage: 'no_longer_applies',
        payload: { ...payload, outcome: 'skipped', skipReason: 'no_longer_applies' },
        status: 'skipped',
      },
    })
  }
  const turns = new Set(withdrawn.map((event) => event.session!.turn))
  const rows = await tx.message.findMany({
    where: {
      role: 'system',
      threadId: input.threadId,
      metadata: { path: ['ticketWorkEvent', 'session', 'sessionId'], equals: input.seen.sessionId },
    },
    select: { id: true, metadata: true },
  })
  const woken = rows.filter((row) => {
    const event = (row.metadata as WokenRowMetadata | null)?.ticketWorkEvent
    return event?.kind === 'woken' && event.workId === input.workId && typeof event.session?.turn === 'number'
      && turns.has(event.session.turn)
  })
  if (woken.length > 0) await tx.message.deleteMany({ where: { id: { in: woken.map((row) => row.id) } } })

  if (remaining.length === 0) {
    await tx.runThreadPendingMessage.deleteMany({ where: { messageId: pending.messageId } })
    await tx.message.delete({ where: { id: pending.messageId } })
    await tx.agentTicketWork.update({ where: { id: input.workId }, data: { wakeCount: { decrement: 1 } } })
    return withdrawn.length
  }
  const work = await tx.agentTicketWork.findUniqueOrThrow({
    where: { id: input.workId }, select: { wakeCount: true, trigger: { select: { config: true } } },
  })
  const facts = await loadTicketWorkKickoffFacts(tx, {
    workId: input.workId,
    wakeNumber: kickoff.wakeNumber ?? work.wakeCount,
    trigger: { config: work.trigger?.config ?? null },
  })
  await tx.message.update({
    where: { id: pending.messageId },
    data: {
      content: renderTicketWorkKickoff(facts, remaining),
      metadata: { ticketWorkKickoff: { ...kickoff, events: remaining } } as Prisma.InputJsonValue,
    },
  })
  return withdrawn.length
}
