import type { PrismaClient } from '@prisma/client'
import { AuthorizedActionContextSchema, type RunExecuteJobPayload } from '@nessie/schemas'

import { resolveExecutorAvailabilityCandidates } from './executor-availability-resolution.js'
import { bindExecutorCandidateBundleInTransaction } from './executor-binding.js'
import { EXECUTOR_LOCAL_APPS_OPERATION_KEYS } from './executor-conversation-lease.js'
import { ExecutorError } from './executor-errors.js'
import {
  checkStandingPolicyBindingFacts,
  type StandingPolicyBinderDeps,
  type StandingPolicyRefusalReason,
} from './executor-standing-policy-binding-checks.js'
import { enforceTicketWorkLimitsInTransaction } from './executor-standing-policy-limits.js'
import { recordStandingPolicyBound, recordStandingPolicyRefused } from './executor-standing-policy-binding-audit.js'

export {
  STANDING_POLICY_REFUSAL_SENTENCES,
  type StandingPolicyBinderDeps,
  type StandingPolicyRefusalReason,
} from './executor-standing-policy-binding-checks.js'

/**
 * `bindStandingPolicyExecutor`: every `ticket.work` wake whose record is
 * `active` with a pinned machine is bound afresh, and every check runs again
 * (docs/plans/2026-09-23-ticket-driven-agents/machine-access.md → "Binding at
 * each wake"; docs/standards/ticket-work-machine-access.md). The seven checks
 * are `checkStandingPolicyBindingFacts`; only when all of them hold is a fresh
 * candidate resolved, pinned to that machine with the policy's author as the
 * person, and bound — the ordinary binder re-checks the grants, revision and
 * scope under the executor lock — with the policy and the record named on the
 * bindings, which the dispatch fence reads for every command.
 *
 * A refusal is an outcome, never a throw: it writes `executor.run.policy_refused`
 * and a delivery row, and the run goes on with no machine, told why. A limit
 * the record is over ends it here, as the wake would have.
 */

export type StandingPolicyBinding =
  /** No active record with a pinned machine: nothing to bind. */
  | { kind: 'not_applicable' }
  | { kind: 'bound' | 'already_bound'; bindingIds: string[]; executorId: string; policyId: string; workId: string }
  | { kind: 'refused'; policyId: string | null; reason: StandingPolicyRefusalReason; workId: string }

export const bindStandingPolicyExecutor = async (
  prisma: PrismaClient,
  run: { job: RunExecuteJobPayload; runId: string },
  work: { workId: string },
  deps: StandingPolicyBinderDeps,
  now = new Date(),
): Promise<StandingPolicyBinding> => {
  const record = await prisma.agentTicketWork.findUnique({
    where: { id: work.workId },
    select: {
      agentId: true, executorId: true, id: true, organizationId: true, policyId: true, projectId: true,
      startedByEventId: true, startedByUserId: true, status: true, taskId: true, threadId: true, triggerId: true,
    },
  })
  if (!record || record.status !== 'active' || !record.executorId) return { kind: 'not_applicable' }
  const existing = await prisma.executorBinding.findMany({
    where: { runId: run.runId },
    select: { executorId: true, id: true, standingPolicyId: true, ticketWorkId: true },
  })
  if (existing.length > 0) {
    // A re-driven job: its earlier attempt already bound, or bound nothing of ours.
    const ours = existing.every((binding) => binding.ticketWorkId === record.id && binding.standingPolicyId)
    return ours
      ? {
          bindingIds: existing.map((binding) => binding.id), executorId: existing[0]!.executorId, kind: 'already_bound',
          policyId: existing[0]!.standingPolicyId!, workId: record.id,
        }
      : { kind: 'not_applicable' }
  }
  const refuse = async (reason: StandingPolicyRefusalReason): Promise<StandingPolicyBinding> => {
    await recordStandingPolicyRefused(prisma, { job: run.job, reason, record, runId: run.runId })
    return { kind: 'refused', policyId: record.policyId, reason, workId: record.id }
  }
  const checked = await checkStandingPolicyBindingFacts(prisma, { job: run.job, record, runId: run.runId }, deps, now)
  if (!checked.ok) {
    if (checked.reason === 'limit_reached') {
      await prisma.$transaction((tx) => enforceTicketWorkLimitsInTransaction(tx, { now, where: { id: record.id } }))
    }
    return refuse(checked.reason)
  }
  const { policy } = checked
  const executorId = record.executorId
  // The author is the person the candidate is made for. The binder alone
  // stands in for them, and only to ask for this one machine.
  const authorContext = AuthorizedActionContextSchema.parse({
    actionContext: { requestId: `standing-policy:${policy.id}:${run.runId}` },
    actor: { actorId: policy.authorUserId, actorType: 'user' },
    tenant: { organizationId: record.organizationId },
  })
  try {
    const availability = await resolveExecutorAvailabilityCandidates(prisma, authorContext, {
      agentId: record.agentId,
      executorId,
      operationKeys: [...EXECUTOR_LOCAL_APPS_OPERATION_KEYS],
      projectId: record.projectId,
    }, now)
    const candidate = availability.candidates.find((entry) => (
      EXECUTOR_LOCAL_APPS_OPERATION_KEYS.every((key) => entry.operationKeys.includes(key))
    ))
    if (!candidate) return refuse('machine_unavailable')
    const bindingIds = await prisma.$transaction(async (tx) => {
      const bound = await bindExecutorCandidateBundleInTransaction(tx, {
        actorUserId: policy.authorUserId,
        candidateHandle: candidate.handle,
        operationKeys: [...EXECUTOR_LOCAL_APPS_OPERATION_KEYS],
        runId: run.runId,
        standing: { kickoffMessageId: run.job.messageId },
      }, now)
      const ids = bound.map((binding) => binding.bindingId)
      // Under the executor lock the binder took: a fence that ended the policy
      // or moved the record a moment ago is seen here, and nothing is bound.
      const [current, currentWork] = await Promise.all([
        tx.executorStandingPolicy.findUnique({ where: { id: policy.id }, select: { status: true } }),
        tx.agentTicketWork.findUnique({ where: { id: record.id }, select: { executorId: true, status: true } }),
      ])
      if (current?.status !== 'live' || currentWork?.status !== 'active' || currentWork.executorId !== executorId) {
        throw new StandingPolicyChangedDuringBind()
      }
      await tx.executorBinding.updateMany({
        where: { id: { in: ids } },
        data: { standingPolicyId: policy.id, ticketWorkId: record.id },
      })
      await recordStandingPolicyBound(tx, { bindingIds: ids, job: run.job, policy, record, runId: run.runId })
      return ids
    })
    return { bindingIds, executorId, kind: 'bound', policyId: policy.id, workId: record.id }
  } catch (error) {
    if (error instanceof StandingPolicyChangedDuringBind) return refuse('policy_not_live')
    if (!(error instanceof ExecutorError)) throw error
    return refuse('machine_unavailable')
  }
}

class StandingPolicyChangedDuringBind extends Error {}
