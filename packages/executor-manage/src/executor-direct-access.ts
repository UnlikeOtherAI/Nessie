import type { Prisma, PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import { writeAuditEntryInTransaction } from '@nessie/db'
import { lockExecutorMutation, requireManagedExecutor } from './executor-access-mutations.js'
import { setExecutorAgentAccessInTransaction } from './executor-agent-access.js'
import { listLiveExecutorLeaseRefs } from './executor-conversation-lease.js'

/** The explicit Add/Remove button authorizes the change; there is no review continuation. */
export const setExecutorAgentAccess = async (
  prisma: PrismaClient, actor: AuthorizedActionContext,
  input: { executorId: string; agentId: string; state: 'allowed' | 'denied' },
  applyPolicy: (tx: Prisma.TransactionClient) => Promise<void>,
) => prisma.$transaction(async (tx) => {
  await lockExecutorMutation(tx, input.executorId)
  await requireManagedExecutor(tx, actor, input.executorId)
  const leases = await listLiveExecutorLeaseRefs(tx, input.executorId)
  await applyPolicy(tx)
  const authorizationRevision = await setExecutorAgentAccessInTransaction(tx, actor, input)
  await writeAuditEntryInTransaction(tx, {
    action: 'executor.agent_access.updated', actorId: actor.actor.actorId, actorType: 'user',
    organizationId: actor.tenant.organizationId, outcome: 'success',
    requestId: actor.actionContext.requestId, resourceType: 'executor', resourceId: input.executorId,
    metadata: { agentId: input.agentId, state: input.state },
  })
  const remaining = new Set((await listLiveExecutorLeaseRefs(tx, input.executorId)).map((entry) => entry.id))
  return { authorizationRevision, endedLeases: leases.filter((entry) => !remaining.has(entry.id)) }
})
