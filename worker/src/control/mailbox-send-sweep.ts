import type { PrismaClient } from '@prisma/client'
import { writeAuditEntry } from '@nessie/db'
import { resolveStaleMailboxSendDispatches } from '@nessie/team-admin'

/**
 * A crashed SMTP dispatch has crossed the provider boundary. Settle it once
 * after the claim window rather than making a future replay send another copy.
 */
export const sweepStaleMailboxSendActions = async (
  prisma: PrismaClient,
  deps: { now?: () => Date } = {},
): Promise<number> => {
  const stale = await resolveStaleMailboxSendDispatches(prisma, deps)
  for (const action of stale) {
    try {
      await writeAuditEntry(prisma, {
        action: 'email.send_failed',
        actorId: 'mailbox-send-sweep',
        actorType: 'system',
        metadata: { status: 'delivery_unknown' },
        organizationId: action.organizationId,
        outcome: 'error',
        requestId: `mailbox-send-sweep:${action.id}`,
        resourceId: action.id,
        resourceType: 'mailbox_send_action',
      })
    } catch {
      // The state is already terminal. Audit unavailability must not re-open a
      // provider call or prevent the rest of the stale batch from settling.
      console.error('[worker.mailbox-send-sweep] failed to write audit transition')
    }
  }
  return stale.length
}
