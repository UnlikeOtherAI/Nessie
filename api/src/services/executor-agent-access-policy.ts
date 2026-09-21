import type { Prisma } from '@prisma/client'
import {
  ensureExecutorLogicalTools, executorGrantedOperationKeys, executorOperationKeysHeldElsewhere,
  resolveExecutorWholeSuiteOperationKeys, type ExecutorAccessChange,
} from '@nessie/executor-manage'
import { ImplementedExecutorOperationKeySchema, type ImplementedExecutorOperationKey } from '@nessie/schemas'
import { acquireAgentToolPolicyLock, mergeAgentToolPolicy, mutateAgentToolPolicyInTransaction } from '@nessie/team-admin'

/** The logical tool policy is per agent and organisation; the grant is per
 * executor. Denial preserves keys this same agent still holds elsewhere. */
export const applyExecutorAgentPolicyChange = async (
  prisma: Prisma.TransactionClient, input: {
    change: ExecutorAccessChange; executorId: string; organizationId: string; actorUserId: string
  },
): Promise<void> => {
  const { change, executorId, organizationId, actorUserId } = input
  if (change.kind !== 'agent_operation_grant' && change.kind !== 'agent_executor_grant'
    && change.kind !== 'agent_executor_access') return
  // Serialize the held-elsewhere read with grants on this agent's other
  // executors. Locking only at the final policy write would use a stale read.
  await acquireAgentToolPolicyLock(prisma, change.agentId)
  const keys = change.kind === 'agent_operation_grant'
    ? [ImplementedExecutorOperationKeySchema.parse(change.operationKey)]
    : change.state === 'allowed'
      ? await resolveExecutorWholeSuiteOperationKeys(prisma, executorId)
      : await executorGrantedOperationKeys(prisma, executorId, change.agentId)
  if (keys.length === 0) return
  const tools = await ensureExecutorLogicalTools(prisma, organizationId)
  const heldElsewhere = change.state === 'allowed'
    ? new Set<ImplementedExecutorOperationKey>()
    : await executorOperationKeysHeldElsewhere(prisma, {
        agentId: change.agentId, excludeExecutorId: executorId, organizationId,
      })
  const policyKeys: string[] = []
  for (const key of keys) {
    if (heldElsewhere.has(key)) continue
    const toolRegistryEntryId = tools.get(key)
    if (!toolRegistryEntryId) throw new Error('Executor logical tool registry is incomplete.')
    policyKeys.push(toolRegistryEntryId)
  }
  if (policyKeys.length === 0) return
  // These registry entries are created above from the fixed executor catalog,
  // never MCP/DeepWater entries. Reuse its exact agent authority and policy
  // mutation lock in this transaction, without opening an independent one.
  await mutateAgentToolPolicyInTransaction(prisma, {
    agentId: change.agentId, actorUserId, organizationId,
    update: (current) => mergeAgentToolPolicy(current, policyKeys, change.state === 'allowed'),
  })
}
