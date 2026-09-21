import type { Prisma } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import {
  executorGrantedOperationKeys, removePrivateAssignmentInTransaction, requireManagedExecutor,
  setExecutorAgentWholeSuiteGrantInTransaction, setPrivateAssignmentInTransaction,
  type AgentExecutorGrantMutation,
} from './executor-access-mutations.js'

/** The private roster and operation grants commit with the same continuation.
 * Existing mutations retain their authorization checks and connection fences. */
export const setExecutorAgentAccessInTransaction = async (
  tx: Prisma.TransactionClient, actor: AuthorizedActionContext, input: AgentExecutorGrantMutation,
): Promise<number> => {
  const executor = await requireManagedExecutor(tx, actor, input.executorId)
  if (executor.scopeKind !== 'private') return setExecutorAgentWholeSuiteGrantInTransaction(tx, actor, input)
  if (input.state === 'allowed') {
    await setPrivateAssignmentInTransaction(tx, actor, {
      executorId: input.executorId,
      assignment: { principalKind: 'agent', agentId: input.agentId, role: 'use' },
    })
    return setExecutorAgentWholeSuiteGrantInTransaction(tx, actor, input)
  }
  if ((await executorGrantedOperationKeys(tx, input.executorId, input.agentId)).length > 0) {
    await setExecutorAgentWholeSuiteGrantInTransaction(tx, actor, input)
  }
  return removePrivateAssignmentInTransaction(tx, actor, {
    executorId: input.executorId, principal: { principalKind: 'agent', agentId: input.agentId },
  })
}
