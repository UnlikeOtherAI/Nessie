import type { PrismaClient } from '@prisma/client'
import { TicketTriggerDeliveryPayloadSchema } from '@nessie/schemas'

import { fireTicketWorkReminder } from './agent-reminder-fire.js'
import { reattemptTicketTriggerDelivery } from './ticket-trigger-dispatch.js'
import { sendQuietWake } from './ticket-work-sweep.js'

/**
 * The delivery-retry poller's arm for a `ticket_changed` trigger: one failed
 * delivery decided again by the door it came through. A reminder is woken
 * again from its row and a quiet wake from its record; a ticket event and a
 * thread message are decided again by their dispatchers.
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
  if (parsed.success && parsed.data.eventType === 'quiet' && parsed.data.workId) {
    await sendQuietWake(prisma, parsed.data.workId, { retry })
    return
  }
  await reattemptTicketTriggerDelivery(prisma, input)
}
