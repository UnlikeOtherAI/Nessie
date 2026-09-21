import { randomUUID } from 'node:crypto'
import { writeAuditEntryInTransaction } from '@nessie/db'
import type { PairingAudit } from '@nessie/executor-manage'

export const executorPairingAudit: PairingAudit = async (tx, event) => {
  await writeAuditEntryInTransaction(tx, {
    organizationId: event.organizationId,
    actorType: event.action === 'executor.pairing.claimed' ? 'user' : 'service',
    actorId: event.action === 'executor.pairing.claimed' ? event.userId : event.executorId,
    action: event.action, resourceType: 'executor', resourceId: event.executorId,
    outcome: 'success', requestId: randomUUID(),
  })
}
