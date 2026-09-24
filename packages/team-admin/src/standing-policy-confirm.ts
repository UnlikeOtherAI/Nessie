import type { Prisma } from '@prisma/client'
import {
  assessStandingPolicyMachine,
  endStandingPolicyInTransaction,
  EXECUTOR_ERROR_CODES,
  ExecutorError,
  lockExecutorMutation,
  queueTicketWorkForConfirmedPolicyInTransaction,
  setExecutorAgentWholeSuiteGrantInTransaction,
  setPrivateAssignmentInTransaction,
  standingPolicyLimitsOf,
  standingPolicyTermsDigest,
  standingPolicyTermsOf,
  writeStandingPolicyAudit,
} from '@nessie/executor-manage'
import {
  StandingPolicyHostProfileSchema,
  StandingPolicyPinnedTermsSchema,
  type AuthorizedActionContext,
  type ExecutorStandingPolicyAccessChange,
} from '@nessie/schemas'

import { applyExecutorAgentPolicyChange } from './executor-agent-tool-policy.js'
import { loadStandingPolicyTrigger, StandingPolicyRefusal } from './standing-policy-trigger.js'
import { captureScheduledLaunchOrigin } from './trigger-launch-origin.js'

/**
 * Confirming a standing policy's one card, inside the executor access-change
 * continuation's transaction and under its single fresh verification
 * (docs/plans/2026-09-23-ticket-driven-agents/machine-access.md → "Prepare
 * and confirm").
 *
 * Everything the card showed is checked again first — the trigger still
 * digests to what was pinned, every machine still qualifies with the same
 * digests and the same authorization revision, the author can still edit the
 * board and is standing in a session whose origin can be captured — and any
 * difference refuses the whole confirmation as stale. Then, per machine: the
 * agent's private assignment, the whole-suite grant, and the executor tools
 * in the agent's tool policy. Then the policy: the one it replaces ends
 * (handing its tickets over), it goes live with the author's origin, and the
 * tickets that waited for machine access queue under it. One failure rolls
 * all of it back with the continuation's claim.
 */

const stale = (message: string): ExecutorError => new ExecutorError(EXECUTOR_ERROR_CODES.ACCESS_CHANGE_STALE, message)

export const confirmStandingPolicyInTransaction = async (
  tx: Prisma.TransactionClient,
  input: {
    actorContext: AuthorizedActionContext
    change: ExecutorStandingPolicyAccessChange
    /** Whether this deployment signs Ledger calls, which the captured origin must then be able to. */
    ledgerSigningConfigured: boolean
  },
): Promise<void> => {
  const { actorContext, change } = input
  const authorUserId = actorContext.actor.actorId
  const organizationId = actorContext.tenant.organizationId
  const requestId = actorContext.actionContext.requestId
  const policy = await tx.executorStandingPolicy.findUnique({
    where: { id: change.policyId },
    select: {
      agentId: true, authorUserId: true, executors: { orderBy: { position: 'asc' } }, hostProfile: true,
      organizationId: true, pinnedTerms: true, status: true, triggerDigest: true, triggerId: true,
    },
  })
  if (!policy || policy.status !== 'preparing' || policy.authorUserId !== authorUserId
    || policy.organizationId !== organizationId || policy.triggerId !== change.triggerId
    || policy.agentId !== change.agentId) {
    throw stale('This machine access is no longer waiting for your confirmation. Set it up again.')
  }
  const pinned = StandingPolicyPinnedTermsSchema.safeParse(policy.pinnedTerms)
  const profile = StandingPolicyHostProfileSchema.safeParse(policy.hostProfile)
  if (!pinned.success || !profile.success) throw stale('This machine access is invalid. Set it up again.')
  let trigger
  try {
    trigger = await loadStandingPolicyTrigger(tx, { authorUserId, organizationId, triggerId: change.triggerId })
  } catch (error) {
    if (error instanceof StandingPolicyRefusal) throw stale(error.message)
    throw error
  }
  const terms = standingPolicyTermsOf(trigger.row, standingPolicyLimitsOf(pinned.data))
  if (!terms || standingPolicyTermsDigest(terms) !== policy.triggerDigest) {
    throw stale('The trigger changed after this was prepared. Set up machine access again to see what changed.')
  }
  for (const row of [...policy.executors].sort((left, right) => left.executorId.localeCompare(right.executorId))) {
    await lockExecutorMutation(tx, row.executorId)
  }
  for (const row of policy.executors) {
    const pinnedRevision = change.executors.find((entry) => entry.executorId === row.executorId)
    const machine = await assessStandingPolicyMachine(tx, {
      allowAnyCommand: profile.data.allowAnyCommand,
      allowedRootNames: profile.data.allowedRootNames,
      authorUserId,
      executorId: row.executorId,
      organizationId,
      requireOnline: false,
      ticketUsd: pinned.data.limits.ticketUsd,
    })
    if (!machine.ok) throw stale(machine.sentence)
    if (!pinnedRevision || machine.authorizationRevision !== pinnedRevision.authorizationRevision
      || machine.descriptorConfigDigest !== row.descriptorConfigDigest
      || machine.localPolicyDigest !== row.localPolicyDigest) {
      throw stale(`${machine.label} changed after this was prepared. Set up machine access again.`)
    }
  }
  const origin = captureScheduledLaunchOrigin({
    actorContext, ledgerSigningConfigured: input.ledgerSigningConfigured,
  })
  if (origin.kind !== 'captured') {
    throw new ExecutorError(EXECUTOR_ERROR_CODES.SCOPE_ENTITLEMENT_DENIED, origin.kind === 'no_team'
      ? 'Confirm this from a signed-in session in one of your teams.'
      : 'Confirm this from a session signed in through your organisation\'s sign-in, so its work can be signed.')
  }
  for (const row of policy.executors) {
    await setPrivateAssignmentInTransaction(tx, actorContext, {
      assignment: { agentId: policy.agentId, principalKind: 'agent', role: 'use' },
      executorId: row.executorId,
    })
    await setExecutorAgentWholeSuiteGrantInTransaction(tx, actorContext, {
      agentId: policy.agentId, executorId: row.executorId, state: 'allowed',
    })
    await applyExecutorAgentPolicyChange(tx, {
      actorUserId: authorUserId,
      change: { agentId: policy.agentId, kind: 'agent_executor_grant', state: 'allowed' },
      executorId: row.executorId,
      organizationId,
    })
  }
  const replaced = await tx.executorStandingPolicy.findFirst({
    where: { status: { in: ['live', 'suspended'] }, triggerId: change.triggerId },
    select: { id: true },
  })
  if (replaced) {
    await endStandingPolicyInTransaction(tx, {
      actor: { requestId, userId: authorUserId }, handOverTo: change.policyId, policyId: replaced.id, reason: 'replaced',
    })
  }
  await tx.executorStandingPolicy.update({
    where: { id: change.policyId },
    data: {
      authorOrigin: origin.launchOrigin as unknown as Prisma.InputJsonValue,
      confirmedAt: new Date(),
      status: 'live',
    },
  })
  const queued = await queueTicketWorkForConfirmedPolicyInTransaction(tx, {
    by: authorUserId, policyId: change.policyId, triggerId: change.triggerId,
  })
  await writeStandingPolicyAudit(tx, {
    action: 'executor.policy.confirmed',
    actor: { requestId, userId: authorUserId },
    metadata: {
      agentId: policy.agentId,
      hostProfile: profile.data,
      limits: pinned.data.limits,
      pool: policy.executors.map((row) => ({
        descriptorConfigDigest: row.descriptorConfigDigest,
        executorId: row.executorId,
        localPolicyDigest: row.localPolicyDigest,
        position: row.position,
      })),
      queued,
      ...(replaced ? { replacedPolicyId: replaced.id } : {}),
      triggerDigest: policy.triggerDigest,
      triggerId: change.triggerId,
    },
    organizationId,
    policyId: change.policyId,
  })
}

/** A rejected card ends the policy it prepared, as the person who turned it down. */
export const rejectStandingPolicyInTransaction = async (
  tx: Prisma.TransactionClient,
  input: { actorContext: AuthorizedActionContext; change: ExecutorStandingPolicyAccessChange },
): Promise<void> => {
  const policy = await tx.executorStandingPolicy.findUnique({
    where: { id: input.change.policyId },
    select: { status: true },
  })
  if (policy?.status !== 'preparing') return
  await endStandingPolicyInTransaction(tx, {
    actor: { requestId: input.actorContext.actionContext.requestId, userId: input.actorContext.actor.actorId },
    policyId: input.change.policyId,
    reason: 'person',
  })
}
