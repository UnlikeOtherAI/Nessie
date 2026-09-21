import type { PrismaClient } from '@prisma/client'
import {
  ensureExecutorLogicalTools, executorGrantedOperationKeys, executorOperationKeysHeldElsewhere,
  resolveExecutorWholeSuiteOperationKeys, type ExecutorAccessChange,
} from '@nessie/executor-manage'
import { ImplementedExecutorOperationKeySchema, type ImplementedExecutorOperationKey } from '@nessie/schemas'
import { setAgentToolPolicyForRegistryEntry } from './agent-tool-policy-registry.js'

/** The logical tool policy is per agent and organisation; the grant is per
 * executor. Denial preserves keys this same agent still holds elsewhere. */
export const applyExecutorAgentPolicyChange = async (
  prisma: PrismaClient, input: {
    change: ExecutorAccessChange; executorId: string; organizationId: string; actorUserId: string
  },
): Promise<void> => {
  const { change, executorId, organizationId, actorUserId } = input
  if (change.kind !== 'agent_operation_grant' && change.kind !== 'agent_executor_grant'
    && change.kind !== 'agent_executor_access') return
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
  // Policy first: a failed continuation can leave a logical grant without an
  // executor grant, which fails closed. The reverse could strand an approved
  // grant without the required matching policy update.
  for (const key of keys) {
    if (heldElsewhere.has(key)) continue
    const toolRegistryEntryId = tools.get(key)
    if (!toolRegistryEntryId) throw new Error('Executor logical tool registry is incomplete.')
    await setAgentToolPolicyForRegistryEntry(prisma, {
      agentId: change.agentId, actorUserId, enabled: change.state === 'allowed', organizationId, toolRegistryEntryId,
    })
  }
}
