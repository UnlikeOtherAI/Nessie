import { Prisma, type PrismaClient } from '@prisma/client'
import type { TicketTriggerDeliveryPayload, TicketTriggerSkipReason } from '@nessie/schemas'

import type { TicketTriggerDecision } from './ticket-trigger-decision.js'
import type { TicketWorkSeamOutcome } from './ticket-work-seam.js'
import { recordTriggerRunFailure, upsertDelivery, type RetryContext } from './trigger-run.js'

/**
 * One ticket-trigger decision as exactly one `agent_trigger_deliveries` row
 * (docs/standards/ticket-work.md): skipped with its reason, or delivered
 * beside what the work seam did, in one transaction. A throw rolls both back
 * and leaves a failed, retryable row instead — through the same
 * `recordTriggerRunFailure` a trigger fire uses, so a classified authority
 * loss also moves the trigger's health. Shared by the `TaskEvent` dispatcher
 * and the work thread's message dispatcher.
 */

export type SettledDecision = Exclude<TicketTriggerDecision, { kind: 'ignore' }>

/** What every delivery payload says about the thing it decided. */
export type DeliveryBase = Omit<TicketTriggerDeliveryPayload, 'outcome' | 'skipReason' | 'wakeReason' | 'workId' | 'untrusted'>

export const deliveryPayload = (
  base: DeliveryBase,
  decision: SettledDecision,
): TicketTriggerDeliveryPayload => {
  if (decision.kind === 'skip') return { ...base, outcome: 'skipped', skipReason: decision.reason }
  return {
    ...base,
    outcome: decision.kind,
    wakeReason: decision.wakeReason,
    ...('workId' in decision ? { workId: decision.workId } : {}),
    ...(decision.kind === 'follow' && decision.untrusted ? { untrusted: true } : {}),
  }
}

const markSkipped = (
  tx: Prisma.TransactionClient,
  deliveryId: string,
  payload: TicketTriggerDeliveryPayload,
  reason: TicketTriggerSkipReason,
) =>
  tx.agentTriggerDelivery.update({
    where: { id: deliveryId },
    // The reason is on the row an operator reads, as a webhook skip's is.
    data: { status: 'skipped', errorMessage: reason, nextRetryAt: null, payload },
  })

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'

export type SeamAct = (tx: Prisma.TransactionClient, deliveryId: string) => Promise<TicketWorkSeamOutcome>

export const settleTicketDelivery = async (
  prisma: PrismaClient,
  input: {
    triggerId: string
    dedupeKey: string
    base: DeliveryBase
    decision: SettledDecision
    /** The seam call for a start or a wake; absent for a skip. */
    act?: SeamAct
    retry?: RetryContext
  },
): Promise<void> => {
  const { decision, dedupeKey, triggerId } = input
  if (!input.retry) {
    // At-least-once: a replayed job finds its row and does nothing twice.
    const existing = await prisma.agentTriggerDelivery.findFirst({
      where: { triggerId, dedupeKey },
      select: { id: true },
    })
    if (existing) return
  }
  const payload = deliveryPayload(input.base, decision)
  try {
    await prisma.$transaction(async (tx) => {
      const delivery = await upsertDelivery(tx, {
        dedupeKey,
        payload,
        retry: input.retry,
        source: decision.source,
        triggerId,
      })
      if (decision.kind === 'skip') {
        await markSkipped(tx, delivery.id, payload, decision.reason)
        return
      }
      if (!input.act) throw new Error('A start or a wake is settled with its work-seam call.')
      const outcome = await input.act(tx, delivery.id)
      if (outcome.outcome === 'refused') {
        const refused = deliveryPayload(input.base, { kind: 'skip', source: decision.source, reason: outcome.reason })
        await markSkipped(tx, delivery.id, refused, outcome.reason)
        return
      }
      await tx.agentTriggerDelivery.update({
        where: { id: delivery.id },
        data: {
          status: 'delivered',
          deliveredAt: new Date(),
          errorMessage: null,
          payload: { ...payload, workId: outcome.workId },
        },
      })
      await tx.agentTrigger.update({ where: { id: triggerId }, data: { lastFiredAt: new Date() } })
    })
  } catch (error) {
    // Another worker settled the same event for this trigger first.
    if (!input.retry && isUniqueViolation(error)) return
    await recordTriggerRunFailure(prisma, {
      dedupeKey,
      error,
      payload,
      retry: input.retry,
      source: decision.source,
      triggerId,
    })
  }
}
