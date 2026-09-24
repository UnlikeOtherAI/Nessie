import type { Prisma, PrismaClient } from '@prisma/client'
import { writeAuditEntryInTransaction } from '@nessie/db'
import type { RunExecuteJobPayload } from '@nessie/schemas'

import {
  STANDING_POLICY_REFUSAL_SENTENCES,
  type CheckedStandingPolicy,
  type StandingBindRecord,
  type StandingPolicyRefusalReason,
} from './executor-standing-policy-binding-checks.js'

/**
 * The binder's audit rows (docs/plans/2026-09-23-ticket-driven-agents/machine-access.md
 * → "Audit"). `executor.run.policy_bound` is written inside the bind's own
 * transaction, so a binding never exists without it; `executor.run.policy_refused`
 * is its own row, like `carry_refused`, beside a skipped delivery on the
 * trigger (`source: 'binding'`) that names the reason in words, and writing
 * either can never fail the run it describes.
 */

export const recordStandingPolicyBound = async (
  tx: Prisma.TransactionClient,
  input: {
    bindingIds: string[]
    job: RunExecuteJobPayload
    policy: CheckedStandingPolicy
    record: StandingBindRecord
    runId: string
  },
): Promise<void> => {
  const { policy, record } = input
  const pool = policy.executors.find((row) => row.executorId === record.executorId)
  await writeAuditEntryInTransaction(tx, {
    action: 'executor.run.policy_bound',
    actorId: record.agentId,
    actorType: 'agent',
    metadata: {
      authorUserId: policy.authorUserId,
      bindingIds: input.bindingIds,
      descriptorConfigDigest: pool?.descriptorConfigDigest ?? null,
      executorId: record.executorId,
      kickoffMessageId: input.job.messageId,
      localPolicyDigest: pool?.localPolicyDigest ?? null,
      // The move that started the work, and who made it: pickups start only
      // from a person's own session.
      moverOrigin: 'session',
      moverUserId: record.startedByUserId,
      policyId: policy.id,
      taskEventId: record.startedByEventId,
      taskId: record.taskId,
      triggerDigest: policy.triggerDigest,
      triggerId: record.triggerId,
      workId: record.id,
    } as Prisma.InputJsonValue,
    organizationId: record.organizationId,
    outcome: 'success',
    requestId: input.job.actorContext.actionContext.requestId,
    resourceId: input.runId,
    resourceType: 'executor_run',
  })
}

export const recordStandingPolicyRefused = async (
  prisma: PrismaClient,
  input: {
    job: RunExecuteJobPayload
    reason: StandingPolicyRefusalReason
    record: StandingBindRecord
    runId: string
  },
): Promise<void> => {
  const { record } = input
  try {
    await prisma.$transaction(async (tx) => {
      await writeAuditEntryInTransaction(tx, {
        action: 'executor.run.policy_refused',
        actorId: record.agentId,
        actorType: 'agent',
        metadata: {
          executorId: record.executorId,
          kickoffMessageId: input.job.messageId,
          policyId: record.policyId,
          reason: input.reason,
          taskId: record.taskId,
          triggerId: record.triggerId,
          workId: record.id,
        } as Prisma.InputJsonValue,
        organizationId: record.organizationId,
        outcome: 'denied',
        reason: input.reason,
        requestId: input.job.actorContext.actionContext.requestId,
        resourceId: input.runId,
        resourceType: 'executor_run',
      })
      if (!record.triggerId) return
      await tx.agentTriggerDelivery.createMany({
        data: [{
          dedupeKey: `binding:${input.runId}`,
          errorMessage: STANDING_POLICY_REFUSAL_SENTENCES[input.reason],
          payload: {
            kind: 'standing_policy_refused', reason: input.reason, runId: input.runId, taskId: record.taskId,
            workId: record.id,
          },
          source: 'binding',
          status: 'skipped',
          triggerId: record.triggerId,
        }],
        skipDuplicates: true,
      })
    })
  } catch (error) {
    console.warn('[standing-policy] could not record the bind refusal for run', input.runId, error)
  }
}
