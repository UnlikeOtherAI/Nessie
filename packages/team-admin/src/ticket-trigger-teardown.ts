import type { Prisma } from '@prisma/client'
import { TICKET_WORK_LIVE_STATUSES } from '@nessie/schemas'

import {
  closeTicketWorkSessionsInTransaction,
  endStandingPoliciesForTriggerInTransaction,
  type StandingPolicyActor,
} from './standing-policy-lifecycle.js'
import { endTicketWork } from './ticket-work-records.js'

/**
 * Disabling or deleting a trigger ends every live record it holds, with
 * `trigger_disabled`, in the transaction that disables or deletes it — the
 * delete ends them first, because `triggerId` is `SetNull` and a record that
 * lost its trigger could otherwise never end. Nothing wakes: the trigger that
 * would wake the agent is the thing being switched off.
 *
 * The same transaction closes the sessions those records started
 * (`trigger_changed`) and ends the trigger's standing machine access, card
 * and all, with `trigger_disabled` or `trigger_deleted`: re-enabling a trigger
 * takes a fresh confirmation (docs/standards/ticket-work.md). Every door that
 * switches a ticket trigger off comes through here — an edit, the Triggers
 * page's pause, a classified health failure, a delete, the agent's delete.
 */
export const endTicketWorkForTrigger = async (
  tx: Prisma.TransactionClient,
  input: {
    /** Who switched it off or deleted it; none when the platform did. */
    actor?: StandingPolicyActor
    reason?: 'trigger_deleted' | 'trigger_disabled'
    triggerId: string
  },
): Promise<number> => {
  const actor = input.actor ?? { userId: null }
  const live = await tx.agentTicketWork.findMany({
    where: { triggerId: input.triggerId, status: { in: [...TICKET_WORK_LIVE_STATUSES] } },
    select: {
      agentId: true, executorId: true, id: true, policyId: true, sessionIds: true, taskId: true, triggerId: true,
    },
  })
  await closeTicketWorkSessionsInTransaction(tx, live, 'trigger_changed', actor.userId)
  let ended = 0
  for (const work of live) {
    if (await endTicketWork(tx, { work, status: 'cancelled', reason: 'trigger_disabled', by: 'system' })) ended += 1
  }
  await endStandingPoliciesForTriggerInTransaction(tx, {
    actor, reason: input.reason ?? 'trigger_disabled', triggerId: input.triggerId,
  })
  return ended
}
