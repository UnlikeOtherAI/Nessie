import { Prisma, type PrismaClient } from '@prisma/client'
import { bounceIsPermanent, type SesDeliveryEvent } from '@nessie/agent-mail'

/**
 * Bounce / complaint / delivery events from the SES configuration set.
 *
 * This consumer is P1, not P2: without it the suppression list stays empty and
 * the send path's refusal floor is inert — the deployment would keep mailing
 * addresses that already hard-bounced and burn its own sending reputation.
 *
 * Suppression is deployment-wide because reputation is per SES account. Only a
 * *permanent* bounce suppresses: a transient one is a full mailbox or a
 * greylist, and retiring that correspondent would be wrong tomorrow.
 */

export const applySesDeliveryEvent = async (
  prisma: PrismaClient,
  event: SesDeliveryEvent,
): Promise<{ updated: number; suppressed: number }> => {
  const deliveryState =
    event.kind === 'bounce' ? 'bounced' : event.kind === 'complaint' ? 'complained' : 'sent'

  // Match on the SES message id we recorded at dispatch. A message we never
  // sent (another product on the same account) simply matches nothing.
  const updated = await prisma.emailMessage.updateMany({
    data: { deliveryState },
    where: { direction: 'outbound', sesMessageId: event.sesMessageId },
  })

  let suppressed = 0
  const shouldSuppress = event.kind === 'complaint' || bounceIsPermanent(event)
  if (shouldSuppress) {
    for (const address of event.recipients) {
      try {
        await prisma.emailSuppression.create({
          data: {
            address: address.toLowerCase(),
            detail: event.bounceSubType ?? event.complaintType ?? null,
            occurredAt: new Date(event.occurredAt),
            reason: event.kind === 'complaint' ? 'complaint' : 'permanent_bounce',
          },
        })
        suppressed += 1
      } catch (error) {
        // Already suppressed — the earliest reason is the one worth keeping.
        if (
          error instanceof Prisma.PrismaClientKnownRequestError
          && error.code === 'P2002'
        ) {
          continue
        }
        throw error
      }
    }
  }

  return { suppressed, updated: updated.count }
}

/**
 * Retention: raw MIME in the inbound staging bucket is transport, not storage.
 * Objects are deleted once the message has been imported and the retention
 * window has passed; the parsed message and its FileService-stored attachments
 * are what persist.
 */
export const sweepInboundRetention = async (
  deps: {
    prisma: PrismaClient
    transport: { deleteInboundObject(key: string): Promise<void> }
    retentionDays: number
  },
  limit = 200,
): Promise<number> => {
  if (deps.retentionDays <= 0) return 0
  const cutoff = new Date(Date.now() - deps.retentionDays * 24 * 60 * 60 * 1000)
  const stale = await deps.prisma.emailMessage.findMany({
    orderBy: { createdAt: 'asc' },
    select: { id: true, s3ObjectKey: true },
    take: limit,
    where: { createdAt: { lt: cutoff }, direction: 'inbound', s3ObjectKey: { not: null } },
  })

  let deleted = 0
  for (const message of stale) {
    if (!message.s3ObjectKey) continue
    try {
      await deps.transport.deleteInboundObject(message.s3ObjectKey)
    } catch (error) {
      // A missing object is the expected steady state after a retry; anything
      // else is logged and retried on the next sweep.
      console.error('[agent-email.retention] object delete failed', {
        error,
        key: message.s3ObjectKey,
      })
      continue
    }
    // Clearing the key is what marks the object reclaimed, so the sweep is
    // idempotent and never re-walks the same rows forever.
    await deps.prisma.emailMessage.update({
      data: { s3ObjectKey: null },
      where: { id: message.id },
    })
    deleted += 1
  }
  return deleted
}
