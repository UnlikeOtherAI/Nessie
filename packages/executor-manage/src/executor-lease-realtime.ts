import type { PgRealtimeTransport } from '@nessie/runtime'
import { parseOrganizationId, parseThreadId, parseUserId } from '@nessie/schemas'

import type { ExecutorLeaseRef } from './executor-conversation-lease.js'

type Transport = Pick<PgRealtimeTransport, 'publishWs'>

/**
 * Tell each holder's own sessions that one of their conversation leases was
 * opened, used or ended, so the composer's indicator re-reads it.
 *
 * One publication per lease, on that holder's `user` scope and nothing else:
 * a lease names a machine the rest of the room may not know about, and the
 * hub gives a user scope priority over any channel scope beside it. The
 * payload is ids only (`executor.lease.changed`); the refetch is the read.
 * Called after the change has committed, never inside its transaction.
 */
export const publishExecutorLeaseChanges = async (
  transport: Transport,
  leases: readonly ExecutorLeaseRef[],
): Promise<void> => {
  for (const lease of leases) {
    await transport.publishWs([{
      kind: 'user',
      organizationId: parseOrganizationId(lease.organizationId),
      userId: parseUserId(lease.actorUserId),
    }], {
      event: 'executor.lease.changed',
      data: { leaseId: lease.id, threadId: parseThreadId(lease.threadId) },
    })
  }
}
