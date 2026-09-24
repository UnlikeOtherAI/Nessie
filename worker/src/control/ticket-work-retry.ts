import type { PrismaClient } from '@prisma/client'
import { TicketTriggerDeliveryPayloadSchema } from '@nessie/schemas'

import { fireTicketWorkReminder } from './agent-reminder-fire.js'
import { reattemptTicketTriggerDelivery } from './ticket-trigger-dispatch.js'
import { dispatchTicketWorkSession } from './ticket-work-session-wake.js'
import { sendQuietWake } from './ticket-work-sweep.js'

/**
 * The delivery-retry poller's arm for a `ticket_changed` trigger: one failed
 * delivery decided again by the door it came through. A reminder is woken
 * again from its row, a quiet wake from its record, and a coding session's
 * wake from the session its payload names; a ticket event and a thread
 * message are decided again by their dispatchers.
 */
export const reattemptTicketWorkDelivery = async (
  prisma: PrismaClient,
  input: {
    organizationId: string | null
    payload: unknown
    retryCount: number
    reuseDeliveryId: string
    triggerId: string
  },
): Promise<void> => {
  const parsed = TicketTriggerDeliveryPayloadSchema.safeParse(input.payload)
  const retry = { reuseDeliveryId: input.reuseDeliveryId, retryCount: input.retryCount }
  if (parsed.success && parsed.data.reminderId) {
    await fireTicketWorkReminder(prisma, parsed.data.reminderId, { retry })
    return
  }
  if (parsed.success && parsed.data.session && parsed.data.workId && input.organizationId) {
    await dispatchTicketWorkSession(prisma, {
      organizationId: input.organizationId, workId: parsed.data.workId, ...parsed.data.session,
    }, { retry })
    return
  }
  if (parsed.success && parsed.data.eventType === 'quiet' && parsed.data.workId) {
    const followed = parsed.data.followedWakeAt
    await sendQuietWake(prisma, parsed.data.workId, {
      retry,
      followedWakeAt: followed === undefined ? undefined : followed === null ? null : new Date(followed),
    })
    return
  }
  await reattemptTicketTriggerDelivery(prisma, input)
}
