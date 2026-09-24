import type { Prisma, PrismaClient } from '@prisma/client'
import {
  assessStandingPolicyMachine,
  closeExecutorReviewCards,
  createExecutorAccessChangeContinuationInTransaction,
  endStandingPolicyInTransaction,
  lockExecutorMutation,
  standingPolicyTermsDigest,
  standingPolicyTermsOf,
  loadStandingPolicyAgentPin,
  writeStandingPolicyAudit,
  type StandingPolicyMachineAssessment,
} from '@nessie/executor-manage'
import {
  ExecutorStandingPolicyPrepareInputSchema,
  StandingPolicyPinnedTermsSchema,
  type AgentCardSpec,
  type AuthorizedActionContext,
  type ExecutorStandingPolicyAccessChange,
  type ExecutorStandingPolicyPrepareInput,
  type StandingPolicyHostProfile,
} from '@nessie/schemas'

import { buildStandingPolicyCard } from './standing-policy-card.js'
import { changedStandingPolicyTerms } from './standing-policy-terms.js'
import {
  countStandingPolicyBoardEditors,
  loadStandingPolicyTrigger,
  StandingPolicyRefusal,
} from './standing-policy-trigger.js'

/**
 * Preparing a trigger's standing machine access: one card, one confirmation
 * (docs/plans/2026-09-23-ticket-driven-agents/machine-access.md → "Prepare
 * and confirm"; docs/standards/ticket-work.md).
 *
 * The trigger's author alone, for their own machines. Every machine is
 * checked and each one that cannot take the work is refused with its reason,
 * so nothing is prepared on a pool the author did not get. What passes is
 * written as a `preparing` policy — its pinned terms and digest, its host
 * profile, its pool with each machine's digests — replacing any card still
 * out for the trigger, and one executor access-change continuation pins every
 * machine's authorization revision. The token it mints goes back to the
 * caller: a person's own browser may hold it; an assistant's tool discards it
 * unseen and posts the card, whose Review mints the one that confirms.
 */

export type PreparedStandingPolicy = {
  accessChangeId: string
  card: AgentCardSpec
  confirmationToken: string
  expiresAt: Date
  policyId: string
}

const refuseMachines = (assessments: readonly StandingPolicyMachineAssessment[]): void => {
  const refused = assessments.flatMap((assessment) => assessment.ok ? [] : [assessment])
  if (refused.length === 0) return
  throw new StandingPolicyRefusal(
    `${refused.length === assessments.length ? 'No machine you named' : 'Not every machine you named'} can take `
    + `this trigger's work:\n${refused.map((machine) => `- ${machine.sentence}`).join('\n')}`,
    refused.map(({ executorId, label, reason, sentence }) => ({ executorId, label, reason, sentence })),
  )
}

/** The previous binding policy's terms and pool, so the card can say what changed. */
const changesSince = async (
  tx: Prisma.TransactionClient,
  input: {
    executorIds: readonly string[]
    profile: StandingPolicyHostProfile
    terms: ReturnType<typeof standingPolicyTermsOf>
    triggerId: string
  },
): Promise<string[] | null> => {
  const previous = await tx.executorStandingPolicy.findFirst({
    where: { status: { in: ['live', 'suspended'] }, triggerId: input.triggerId },
    select: { executors: { select: { executorId: true } }, hostProfile: true, pinnedTerms: true },
  })
  if (!previous || !input.terms) return null
  const pinned = StandingPolicyPinnedTermsSchema.safeParse(previous.pinnedTerms)
  const changes = pinned.success ? changedStandingPolicyTerms(pinned.data, input.terms) : ['the trigger']
  const before = previous.executors.map((row) => row.executorId).sort().join(',')
  if (before !== [...input.executorIds].sort().join(',')) changes.unshift('the machines')
  const profile = previous.hostProfile as Partial<StandingPolicyHostProfile> | null
  if (profile?.allowAnyCommand !== input.profile.allowAnyCommand) changes.push('running any command without asking')
  if ([...(profile?.allowedRootNames ?? [])].sort().join(',') !== [...input.profile.allowedRootNames].sort().join(',')) {
    changes.push('the coding roots')
  }
  return changes
}

/** The card still out for this trigger ends, and so does its continuation, so it can never be confirmed. */
const replaceOutstandingCard = async (
  tx: Prisma.TransactionClient,
  input: { actorUserId: string; requestId: string; triggerId: string },
): Promise<void> => {
  const outstanding = await tx.executorStandingPolicy.findFirst({
    where: { status: 'preparing', triggerId: input.triggerId },
    select: { id: true },
  })
  if (!outstanding) return
  await endStandingPolicyInTransaction(tx, {
    actor: { requestId: input.requestId, userId: input.actorUserId },
    policyId: outstanding.id,
    reason: 'replaced',
  })
  const continuations = await tx.executorContinuation.findMany({
    where: {
      revisions: { equals: outstanding.id, path: ['change', 'policyId'] },
      status: 'pending',
      subject: 'access_change',
    },
    select: { actorUserId: true, id: true },
  })
  for (const continuation of continuations) {
    await tx.executorContinuation.update({ where: { id: continuation.id }, data: { status: 'expired' } })
    await closeExecutorReviewCards(tx, {
      actorUserId: continuation.actorUserId, continuationId: continuation.id, outcome: 'expired',
    })
  }
}

export const prepareStandingPolicy = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  rawInput: ExecutorStandingPolicyPrepareInput | Record<string, unknown>,
  options: { isOrganizationAdmin?: boolean } = {},
): Promise<PreparedStandingPolicy> => {
  const parsed = ExecutorStandingPolicyPrepareInputSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new StandingPolicyRefusal(parsed.error.issues.map((issue) => (
      `${issue.path.join('.') || 'input'}: ${issue.message}`
    )).join('; '))
  }
  const input = parsed.data
  if (actorContext.actor.actorType !== 'user') {
    throw new StandingPolicyRefusal('Only a person can set up machine access, for their own machines.')
  }
  const authorUserId = actorContext.actor.actorId
  const organizationId = actorContext.tenant.organizationId
  const requestId = actorContext.actionContext.requestId
  return prisma.$transaction(async (tx) => {
    const trigger = await loadStandingPolicyTrigger(tx, {
      authorUserId, organizationId, triggerId: input.triggerId,
      ...(options.isOrganizationAdmin === undefined ? {} : { isOrganizationAdmin: options.isOrganizationAdmin }),
    })
    for (const executorId of [...input.executorIds].sort()) await lockExecutorMutation(tx, executorId)
    const assessments = await Promise.all(input.executorIds.map((executorId) => assessStandingPolicyMachine(tx, {
      allowAnyCommand: input.allowAnyCommand,
      allowedRootNames: input.allowedRootNames ?? null,
      authorUserId,
      executorId,
      organizationId,
      requireOnline: true,
      ticketUsd: input.limits.ticketUsd,
    })))
    refuseMachines(assessments)
    const machines = assessments.flatMap((assessment) => assessment.ok ? [assessment] : [])
    const allowedRootNames = input.allowedRootNames
      ?? machines.map((machine) => machine.facts.rootNames)
        .reduce((shared, roots) => shared.filter((root) => roots.includes(root)))
        .sort()
    if (allowedRootNames.length === 0) {
      throw new StandingPolicyRefusal('These machines share no coding root. Name the roots ticket work may use.')
    }
    const agent = await loadStandingPolicyAgentPin(tx, trigger.agentId)
    const terms = standingPolicyTermsOf(trigger.row, input.limits, agent)
    if (!terms) throw new StandingPolicyRefusal('This trigger\'s configuration no longer holds together.')
    const hostProfile: StandingPolicyHostProfile = {
      allowAnyCommand: input.allowAnyCommand,
      allowedRootNames: [...allowedRootNames],
      codingAgents: ['claude'],
      machines: machines.map((machine) => machine.host),
    }
    const changes = await changesSince(tx, {
      executorIds: input.executorIds, profile: hostProfile, terms, triggerId: trigger.id,
    })
    await replaceOutstandingCard(tx, { actorUserId: authorUserId, requestId, triggerId: trigger.id })
    const triggerDigest = standingPolicyTermsDigest(terms)
    const policy = await tx.executorStandingPolicy.create({
      data: {
        agentId: trigger.agentId,
        authorUserId,
        executors: {
          create: machines.map((machine, position) => ({
            descriptorConfigDigest: machine.descriptorConfigDigest,
            executorId: machine.executorId,
            localPolicyDigest: machine.localPolicyDigest,
            position,
          })),
        },
        hostProfile: hostProfile as unknown as Prisma.InputJsonValue,
        organizationId,
        pinnedTerms: terms as unknown as Prisma.InputJsonValue,
        status: 'preparing',
        triggerDigest,
        triggerId: trigger.id,
      },
      select: { id: true },
    })
    const change: ExecutorStandingPolicyAccessChange = {
      agentId: trigger.agentId,
      executors: machines.map((machine) => ({
        authorizationRevision: machine.authorizationRevision, executorId: machine.executorId,
      })),
      kind: 'standing_policy',
      policyId: policy.id,
      summary: { machineLabels: machines.map((machine) => machine.label), triggerName: trigger.name },
      triggerId: trigger.id,
    }
    const first = machines[0]
    if (!first) throw new StandingPolicyRefusal('Name at least one machine.')
    const prepared = await createExecutorAccessChangeContinuationInTransaction(tx, {
      actorUserId: authorUserId,
      authorizationRevision: first.authorizationRevision,
      change,
      executorId: first.executorId,
      requiresFreshVerification: true,
    })
    await writeStandingPolicyAudit(tx, {
      action: 'executor.policy.prepared',
      actor: { requestId, userId: authorUserId },
      metadata: {
        accessChangeId: prepared.accessChangeId,
        agentId: trigger.agentId,
        executorIds: machines.map((machine) => machine.executorId),
        hostProfile,
        limits: terms.limits,
        triggerDigest,
        triggerId: trigger.id,
      },
      organizationId,
      policyId: policy.id,
    })
    const [board, columns, boardEditorCount, waitingTickets] = await Promise.all([
      tx.board.findUnique({ where: { id: terms.boardId }, select: { name: true } }),
      tx.boardColumn.findMany({
        where: { id: { in: terms.pickupColumnIds } }, orderBy: { position: 'asc' }, select: { name: true },
      }),
      countStandingPolicyBoardEditors(tx, { organizationId, projectId: trigger.projectId }),
      tx.agentTicketWork.count({
        where: {
          stateReason: { in: ['machine_access_not_set_up', 'machine_access_suspended'] },
          status: 'waiting_machine',
          triggerId: trigger.id,
        },
      }),
    ])
    const card = buildStandingPolicyCard({
      agentName: trigger.agentName,
      boardEditorCount,
      boardName: board?.name ?? 'the board',
      changes,
      expiresAt: prepared.expiresAt,
      hostProfile,
      pickupColumnNames: columns.map((column) => column.name),
      terms,
      triggerName: trigger.name,
      waitingTickets,
    })
    return {
      accessChangeId: prepared.accessChangeId,
      card,
      confirmationToken: prepared.confirmationToken,
      expiresAt: prepared.expiresAt,
      policyId: policy.id,
    }
  })
}
