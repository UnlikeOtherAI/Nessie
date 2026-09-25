import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import type { ExecutorCapabilityDescriptor } from '@nessie/schemas'
import { nextAuthorizationRevision } from './executor-access-mutations.js'
import {
  endExecutorConversationLeasesInTransaction, EXECUTOR_LOCAL_APPS_OPERATION_KEYS, type ExecutorLeaseRef,
} from './executor-conversation-lease.js'
import { suspendStandingPolicyInTransaction } from './executor-standing-policy-lifecycle.js'

/** A changed signed report takes effect immediately and fences the superseded runtime. */
export const applyExecutorCapabilityUpdate = async (
  tx: Prisma.TransactionClient, executorId: string, descriptor: ExecutorCapabilityDescriptor,
): Promise<ExecutorLeaseRef[]> => {
  await nextAuthorizationRevision(tx, executorId)
  const requestId = randomUUID()
  const endedLeases = !EXECUTOR_LOCAL_APPS_OPERATION_KEYS.every((key) => descriptor.operationKeys.includes(key))
    ? await endExecutorConversationLeasesInTransaction(tx, {
      actor: { actorType: 'system', actorId: executorId, requestId }, endedByUserId: null,
      reason: 'descriptor_narrowed', where: { executorId },
    }) : []
  const policies = await tx.executorStandingPolicyExecutor.findMany({
    where: { executorId, policy: { status: 'live' } },
    select: { policyId: true, descriptorConfigDigest: true, localPolicyDigest: true },
  })
  for (const policy of policies) {
    if (policy.descriptorConfigDigest === descriptor.codingSessions?.configDigest
      && policy.localPolicyDigest === descriptor.localPolicyDigest) continue
    await suspendStandingPolicyInTransaction(tx, {
      actor: { requestId, userId: null }, policyId: policy.policyId, reason: 'descriptor_changed',
      detail: { executorId, revision: descriptor.revision },
    })
  }
  return endedLeases
}
